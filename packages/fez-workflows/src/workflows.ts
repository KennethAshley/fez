#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  RelayConnection,
  CapabilityClient,
  KIND_AGENT_METADATA,
  KIND_CHANNEL_MESSAGE,
  KIND_MEMBERSHIP,
  KIND_REACTION,
  KIND_WORKFLOW_RUN,
} from "@fez/protocol";
import { loadServiceKey, resolveChannels, parseThreadRef } from "./service-common.js";
import { loadDefs, isSay, parseDuration, resolveTemplate, type WorkflowDef } from "./defs.js";

/**
 * fez-workflows — Buzz's workflow engine (buzz-workflow crate),
 * decentralized: a standing service that makes multi-agent follow-ups
 * DETERMINISTIC. The reply event is the trigger, not the model's
 * obedience — "when researcher replies here, summon @reviewer" fires
 * whether or not researcher remembered to hand off.
 *
 * Definitions are YAML files (one per workflow) in ~/.fez/workflows or
 * FEZ_WORKFLOWS_DIR — see defs.ts for the vocabulary: message/reaction
 * triggers, sequential `say` steps (published into the trigger's
 * thread, @names p-tagged so they summon agents), and `wait_reaction`
 * approval gates (Buzz's RequestApproval with reactions as the
 * approval primitive).
 *
 * Every run publishes 47200 trace events (started, step_done,
 * waiting_approval, approved, timeout, done) so any client can render
 * what the automations did — Buzz's workflow_runs table, on the wire.
 *
 * Guard rails: triggers require channel membership (strangers never
 * fire automations), self-authored events never trigger (no self-
 * loops), published messages carry depth+1 and events at the chain cap
 * don't trigger (same loop guard as agents). Suspended approval gates
 * are in-memory — lost on restart, like Buzz's MVP interval state.
 *
 * Config (env):
 *   FEZ_WORKFLOWS_DIR  definitions directory (default ~/.fez/workflows)
 *   FEZ_AGENT_OWNER    owner pubkey — the default approver and `from: owner`
 */
const MAX_CHAIN_DEPTH = 5;
const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 3_600_000;

interface FezEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}

async function main() {
  const relayUrl = process.env.FEZ_RELAY || "wss://relay.damus.io";
  const dir = process.env.FEZ_WORKFLOWS_DIR || path.join(os.homedir(), ".fez", "workflows");
  const owner = process.env.FEZ_AGENT_OWNER;

  const defs = loadDefs(dir);
  if (defs.length === 0) {
    console.error(`No workflow definitions in ${dir} — add a .yaml file (see packages/fez-workflows/README.md)`);
    process.exit(1);
  }

  const client = new CapabilityClient({ relay: relayUrl, privateKey: loadServiceKey("workflows") });
  const relay = new RelayConnection({ url: relayUrl });
  await relay.connect();
  const myPubkey = client.getPubkey();

  // Each def's channel spec resolves independently (a name may match
  // several channels; the def applies to all of them).
  const channelsByDef = new Map<WorkflowDef, string[]>();
  for (const def of defs) {
    channelsByDef.set(def, await resolveChannels(relay, [def.channel], relayUrl));
  }
  const channels = [...new Set([...channelsByDef.values()].flat())];

  // Roster from 47000 metadata — name→pubkey for `from:` matching and
  // @name p-tagging, pubkey→name for {{trigger.author_name}}.
  const nameToPubkey = new Map<string, { pubkey: string; updatedAt: number }>();
  const pubkeyToName = new Map<string, string>();
  function absorbAgent(event: FezEvent): void {
    try {
      const meta = JSON.parse(event.content) as { name?: string };
      if (!meta.name) return;
      const existing = nameToPubkey.get(meta.name);
      if (existing && event.created_at <= existing.updatedAt) return;
      nameToPubkey.set(meta.name, { pubkey: event.pubkey, updatedAt: event.created_at });
      pubkeyToName.set(event.pubkey, meta.name);
    } catch { /* not ours to parse */ }
  }
  for (const event of (await relay.query([{ kinds: [KIND_AGENT_METADATA] }])).sort((a, b) => a.created_at - b.created_at)) {
    absorbAgent(event);
  }

  const memberships = new Map<string, { createdAt: number; members: Set<string> }>();
  function absorbMembership(event: FezEvent): void {
    const channelId = event.tags.find((t) => t[0] === "d")?.[1];
    if (!channelId || !channels.includes(channelId)) return;
    const existing = memberships.get(channelId);
    if (existing && event.created_at < existing.createdAt) return;
    const members = new Set<string>(event.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
    memberships.set(channelId, { createdAt: event.created_at, members });
  }
  for (const event of await relay.query([{ kinds: [KIND_MEMBERSHIP], "#d": channels }])) absorbMembership(event);
  for (const channelId of channels) {
    if (!memberships.get(channelId)?.members.has(myPubkey)) {
      console.warn(`⚠️  Not a member of channel ${channelId} — workflow messages will be dropped by other clients until the creator runs /invite ${myPubkey} bot`);
    }
  }

  /**
   * `from:` / approval `from:` -> the pubkey(s) allowed. "owner" needs
   * FEZ_AGENT_OWNER; an agent name resolves via the roster; 64-hex
   * passes through; "any" (approvals) returns undefined = any member.
   */
  function resolvePrincipal(spec: string): string | undefined {
    if (spec === "owner") return owner;
    if (/^[0-9a-f]{64}$/i.test(spec)) return spec.toLowerCase();
    return nameToPubkey.get(spec)?.pubkey;
  }

  // Suspended approval gates: reaction events resolve them.
  interface PendingApproval {
    targetId: string;
    emoji?: string;
    allowedPubkey?: string; // undefined = any member of the channel
    channelId: string;
    resolve: (approver: string) => void;
  }
  const pendingApprovals: PendingApproval[] = [];

  const publishTrace = (
    def: WorkflowDef,
    runId: string,
    trigger: FezEvent,
    channelId: string,
    communityId: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) => {
    void relay
      .publish(
        client.signEvent({
          kind: KIND_WORKFLOW_RUN,
          tags: [["h", channelId], ["c", communityId], ["e", trigger.id], ["workflow", def.name]],
          content: JSON.stringify({ workflow: def.name, run: runId, status, ...extra }),
        })
      )
      .catch(() => {});
  };

  async function runWorkflow(def: WorkflowDef, trigger: FezEvent, channelId: string, communityId: string): Promise<void> {
    const runId = crypto.randomUUID();
    const triggerDepth = Number(trigger.tags.find((t) => t[0] === "depth")?.[1] ?? 0);
    const vars: Record<string, string> = {
      "trigger.text": trigger.content,
      "trigger.author": trigger.pubkey,
      "trigger.author_name": pubkeyToName.get(trigger.pubkey) ?? trigger.pubkey.slice(0, 8),
      "trigger.id": trigger.id,
    };
    // All say steps thread under the trigger: shared root, each replying
    // to the previous message — the chain reads as a conversation.
    const rootId = parseThreadRef(trigger.tags).rootId ?? trigger.id;
    let prevId = trigger.id;

    console.log(`▶️  ${def.name} run ${runId.slice(0, 8)} (trigger ${trigger.id.slice(0, 8)} by ${vars["trigger.author_name"]})`);
    publishTrace(def, runId, trigger, channelId, communityId, "started");

    for (const [index, step] of def.steps.entries()) {
      const stepNo = index + 1;
      if (isSay(step)) {
        const text = resolveTemplate(step.say, vars);
        // @names -> p tags: this is how a workflow summons an agent.
        const mentions = [...new Set(
          [...text.matchAll(/@([\w-]+)/g)]
            .map((m) => nameToPubkey.get(m[1])?.pubkey)
            .filter((pk): pk is string => !!pk)
        )];
        const event = client.signEvent({
          kind: KIND_CHANNEL_MESSAGE,
          tags: [
            ["h", channelId],
            ["c", communityId],
            ["e", rootId, "", "root"],
            ["e", prevId, "", "reply"],
            ["depth", String(triggerDepth + 1)],
            ...mentions.map((pk) => ["p", pk]),
          ],
          content: text,
        });
        await relay.publish(event);
        prevId = event.id;
        console.log(`   💬 step ${stepNo}: ${text.slice(0, 70)}`);
        publishTrace(def, runId, trigger, channelId, communityId, "step_done", { step: stepNo });
      } else {
        const gate = step.wait_reaction;
        const emoji = gate.emoji ?? "👍";
        const allowedPubkey = gate.from === "any" ? undefined : resolvePrincipal(gate.from ?? "owner");
        if (gate.from !== "any" && !allowedPubkey) {
          console.error(`   ❌ step ${stepNo}: cannot resolve approver "${gate.from ?? "owner"}" (owner needs FEZ_AGENT_OWNER; names need a 47000 announce) — run abandoned`);
          publishTrace(def, runId, trigger, channelId, communityId, "failed", { step: stepNo, detail: "unresolvable approver" });
          return;
        }
        const timeoutMs = parseDuration(gate.timeout, DEFAULT_APPROVAL_TIMEOUT_MS);
        console.log(`   ⏸  step ${stepNo}: waiting for ${emoji} on ${prevId.slice(0, 8)} (${gate.timeout ?? "24h"} timeout)`);
        publishTrace(def, runId, trigger, channelId, communityId, "waiting_approval", { step: stepNo });

        const approver = await new Promise<string | undefined>((resolve) => {
          const pending: PendingApproval = { targetId: prevId, emoji, allowedPubkey, channelId, resolve: (pk) => { cleanup(); resolve(pk); } };
          const timer = setTimeout(() => { cleanup(); resolve(undefined); }, timeoutMs);
          const cleanup = () => {
            clearTimeout(timer);
            const i = pendingApprovals.indexOf(pending);
            if (i >= 0) pendingApprovals.splice(i, 1);
          };
          pendingApprovals.push(pending);
        });

        if (!approver) {
          console.log(`   ⏱  step ${stepNo}: approval timed out — run abandoned`);
          publishTrace(def, runId, trigger, channelId, communityId, "timeout", { step: stepNo });
          void relay
            .publish(
              client.signEvent({
                kind: KIND_CHANNEL_MESSAGE,
                tags: [["h", channelId], ["c", communityId], ["e", rootId, "", "root"], ["e", prevId, "", "reply"], ["depth", String(triggerDepth + 1)]],
                content: `⏱ workflow **${def.name}**: approval (${emoji}) timed out — remaining steps skipped.`,
              })
            )
            .catch(() => {});
          return;
        }
        console.log(`   ✅ step ${stepNo}: approved by ${pubkeyToName.get(approver) ?? approver.slice(0, 8)}`);
        publishTrace(def, runId, trigger, channelId, communityId, "approved", { step: stepNo, by: approver });
      }
    }
    console.log(`🏁 ${def.name} run ${runId.slice(0, 8)} done`);
    publishTrace(def, runId, trigger, channelId, communityId, "done");
  }

  const seenTriggers = new Set<string>();
  function handleEvent(event: FezEvent): void {
    if (event.kind === KIND_MEMBERSHIP) return absorbMembership(event);
    if (event.kind === KIND_AGENT_METADATA) return absorbAgent(event);
    if (event.pubkey === myPubkey) return; // never self-trigger

    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId) return;

    if (event.kind === KIND_REACTION) {
      // First: does this reaction open an approval gate?
      for (const pending of [...pendingApprovals]) {
        if (pending.channelId !== channelId) continue;
        if (!event.tags.some((t) => t[0] === "e" && t[1] === pending.targetId)) continue;
        if (pending.emoji && event.content !== pending.emoji) continue;
        if (pending.allowedPubkey ? event.pubkey !== pending.allowedPubkey : !(memberships.get(channelId)?.members.has(event.pubkey) ?? false)) continue;
        pending.resolve(event.pubkey);
      }
    }

    // Then: trigger matching. Membership is non-negotiable; depth-capped
    // events don't trigger (loop guard shared with agents).
    if (!(memberships.get(channelId)?.members.has(event.pubkey) ?? false)) return;
    if (Number(event.tags.find((t) => t[0] === "depth")?.[1] ?? 0) >= MAX_CHAIN_DEPTH) return;

    for (const def of defs) {
      if (!channelsByDef.get(def)!.includes(channelId)) continue;
      const trig = def.trigger;
      if (trig.on === "message" && event.kind !== KIND_CHANNEL_MESSAGE) continue;
      if (trig.on === "reaction" && event.kind !== KIND_REACTION) continue;
      if (trig.on === "reaction" && trig.emoji && event.content !== trig.emoji) continue;
      if (trig.from) {
        const allowed = resolvePrincipal(trig.from);
        if (!allowed || event.pubkey !== allowed) continue;
      }
      if (trig.on === "message" && trig.filter && !new RegExp(trig.filter, "i").test(event.content)) continue;
      const key = `${def.name}:${event.id}`;
      if (seenTriggers.has(key)) continue;
      seenTriggers.add(key);
      void runWorkflow(def, event, channelId, communityId).catch((err) => {
        console.error(`❌ ${def.name} run failed:`, err instanceof Error ? err.message : err);
      });
    }
  }

  relay.subscribe(
    [
      { kinds: [KIND_CHANNEL_MESSAGE, KIND_REACTION], "#h": channels, since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_MEMBERSHIP], "#d": channels, since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) },
    ],
    (event) => handleEvent(event)
  );

  console.log(`🟢 fez-workflows: ${defs.length} workflow(s) across ${channels.length} channel(s) on ${relayUrl}`);
  for (const def of defs) {
    console.log(`   • ${def.name}: on ${def.trigger.on}${def.trigger.from ? ` from ${def.trigger.from}` : ""}${def.trigger.filter ? ` ~ /${def.trigger.filter}/i` : ""} → ${def.steps.length} step(s) in #${def.channel}`);
  }
  console.log(`   Pubkey: ${myPubkey}${owner ? "" : " | ⚠️ FEZ_AGENT_OWNER unset — owner-approved gates cannot resolve"}`);

  process.on("SIGINT", () => {
    relay.disconnect();
    console.log(`\n🔴 fez-workflows stopped.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
