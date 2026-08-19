#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  RelayConnection,
  CapabilityClient,
  KIND_AGENT_METADATA,
  KIND_CHANNEL,
  KIND_CHANNEL_MESSAGE,
  KIND_MEMBERSHIP,
  KIND_REACTION,
  KIND_WORKFLOW_RUN,
  resolveRelays,
} from "@fez/protocol";
import { Cron } from "croner";
import { loadServiceKey, resolveChannels, parseThreadRef } from "./service-common.js";
import { loadDefs, isSay, isWait, isDelay, isDm, isReact, isWebhook, parseDuration, resolveTemplate, type WorkflowDef } from "./defs.js";
import { evalCondition, type ExprValue } from "./expr.js";

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
  const relayUrls = resolveRelays();
  const dir = process.env.FEZ_WORKFLOWS_DIR || path.join(os.homedir(), ".fez", "workflows");
  const owner = process.env.FEZ_AGENT_OWNER;

  const defs = loadDefs(dir);
  if (defs.length === 0) {
    console.error(`No workflow definitions in ${dir} — add a .yaml file (see packages/fez-workflows/README.md)`);
    process.exit(1);
  }

  const client = new CapabilityClient({ relay: relayUrls, privateKey: loadServiceKey("workflows") });
  // Workflows watch h-tagged channel messages, and a membership-gated
  // relay delivers those only over a NIP-42-authed connection. Without
  // the signer this process connects fine, subscribes fine, and simply
  // never receives anything — a service that looks healthy and does
  // nothing, which is the hardest kind of broken to notice.
  const relay = new RelayConnection({ urls: relayUrls, authSigner: client.authSigner });
  await relay.connect();
  const myPubkey = client.getPubkey();

  // Each def's channel spec resolves independently (a name may match
  // several channels; the def applies to all of them).
  const channelsByDef = new Map<WorkflowDef, string[]>();
  for (const def of defs) {
    channelsByDef.set(def, await resolveChannels(relay, [def.channel], relayUrls.join(", ")));
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
    trigger: FezEvent | undefined,
    channelId: string,
    communityId: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) => {
    void relay
      .publish(
        client.signEvent({
          kind: KIND_WORKFLOW_RUN,
          tags: [
            ["h", channelId],
            ["c", communityId],
            ...(trigger ? [["e", trigger.id]] : []),
            ["workflow", def.name],
          ],
          content: JSON.stringify({ workflow: def.name, run: runId, status, ...extra }),
        })
      )
      .catch(() => {});
  };

  // ── Durable suspensions (GAPS item 14): a restart used to drop every
  // pending approval gate. Suspended runs now persist — enough context to
  // resume the step loop after the gate — and re-arm at boot with their
  // REMAINING timeout. Delays stay best-effort (a restart re-runs nothing).
  interface SuspendedRun {
    workflow: string;
    runId: string;
    stepIndex: number; // the wait_reaction step we're parked on
    anchorId: string;
    emoji: string;
    from?: string;
    deadline: number; // epoch ms
    vars: Record<string, ExprValue>;
    rootId?: string;
    prevId?: string;
    triggerDepth: number;
    channelId: string;
    communityId: string;
  }
  const stateFile = process.env.FEZ_WORKFLOWS_STATE || path.join(os.homedir(), ".fez", "workflows-state.json");
  let suspended: SuspendedRun[] = [];
  try {
    suspended = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch { /* first run */ }
  const saveSuspended = () => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(suspended, null, 1));
    } catch (err) {
      console.warn(`⚠️  couldn't persist workflow state: ${err instanceof Error ? err.message : err}`);
    }
  };

  interface RunCtx {
    runId: string;
    vars: Record<string, ExprValue>;
    rootId?: string;
    prevId?: string;
    triggerDepth: number;
    channelId: string;
    communityId: string;
    trigger?: FezEvent;
  }

  /** trigger absent = a schedule fire: says start a fresh thread (the first say becomes the root). */
  async function runWorkflow(def: WorkflowDef, trigger: FezEvent | undefined, channelId: string, communityId: string): Promise<void> {
    const runId = crypto.randomUUID();
    const triggerDepth = trigger ? Number(trigger.tags.find((t) => t[0] === "depth")?.[1] ?? 0) : 0;
    const vars: Record<string, ExprValue> = {
      now: new Date().toISOString(),
      ...(trigger
        ? {
            "trigger.text": trigger.content,
            "trigger.author": trigger.pubkey,
            "trigger.author_name": pubkeyToName.get(trigger.pubkey) ?? trigger.pubkey.slice(0, 8),
            "trigger.id": trigger.id,
          }
        : {}),
    };
    // All say steps thread under the trigger: shared root, each replying
    // to the previous message — the chain reads as a conversation.
    const rootId = trigger ? parseThreadRef(trigger.tags).rootId ?? trigger.id : undefined;

    console.log(`▶️  ${def.name} run ${runId.slice(0, 8)} (${trigger ? `trigger ${trigger.id.slice(0, 8)} by ${vars["trigger.author_name"]}` : "scheduled"})`);
    publishTrace(def, runId, trigger, channelId, communityId, "started");
    await executeSteps(def, { runId, vars, rootId, prevId: trigger?.id, triggerDepth, channelId, communityId, trigger }, 0);
  }

  async function executeSteps(def: WorkflowDef, ctx: RunCtx, startIndex: number): Promise<void> {
    const { runId, vars, triggerDepth, channelId, communityId, trigger } = ctx;
    let { rootId, prevId } = ctx;

    for (const [index, step] of def.steps.entries()) {
      if (index < startIndex) continue;
      const stepNo = index + 1;
      // `if:` — false skips the step (not the run), Buzz's semantics. An
      // expression that errors also skips, loudly: silently running a
      // gated step on a broken condition is the worse failure mode.
      if (step.if) {
        let verdict = false;
        let error: string | undefined;
        try {
          verdict = evalCondition(step.if, vars);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (!verdict) {
          console.log(`   ⤼  step ${stepNo}: skipped (${error ? `if error: ${error}` : `if false: ${step.if}`})`);
          publishTrace(def, runId, trigger, channelId, communityId, "step_skipped", { step: stepNo, ...(error ? { detail: error } : {}) });
          continue;
        }
      }
      let output: string | undefined;
      if (isSay(step)) {
        const text = resolveTemplate(step.say, vars as never);
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
            ...(rootId ? [["e", rootId, "", "root"]] : []),
            ...(prevId ? [["e", prevId, "", "reply"]] : []),
            ["depth", String(triggerDepth + 1)],
            ...mentions.map((pk) => ["p", pk]),
          ],
          content: text,
        });
        await relay.publish(event);
        rootId ??= event.id; // a scheduled run's first say starts the thread
        prevId = event.id;
        output = event.id;
        console.log(`   💬 step ${stepNo}: ${text.slice(0, 70)}`);
        publishTrace(def, runId, trigger, channelId, communityId, "step_done", { step: stepNo });
      } else if (isDelay(step)) {
        const ms = parseDuration(step.delay, 0);
        console.log(`   ⏳ step ${stepNo}: delay ${step.delay}`);
        publishTrace(def, runId, trigger, channelId, communityId, "step_waiting", { step: stepNo, detail: step.delay });
        await new Promise((r) => setTimeout(r, ms));
        output = "";
        publishTrace(def, runId, trigger, channelId, communityId, "step_done", { step: stepNo });
      } else if (isDm(step)) {
        const to = step.dm.to === "owner" ? owner : resolvePrincipal(step.dm.to);
        if (!to) {
          console.error(`   ❌ step ${stepNo}: cannot resolve DM recipient "${step.dm.to}" — run abandoned`);
          publishTrace(def, runId, trigger, channelId, communityId, "failed", { step: stepNo, detail: "unresolvable dm recipient" });
          return;
        }
        const { toPeer, toSelf } = client.wrapDm(to, resolveTemplate(step.dm.message, vars as never), triggerDepth + 1);
        await relay.publish(toPeer);
        await relay.publish(toSelf);
        output = "sent";
        console.log(`   ✉️  step ${stepNo}: DM to ${pubkeyToName.get(to) ?? to.slice(0, 8)}`);
        publishTrace(def, runId, trigger, channelId, communityId, "step_done", { step: stepNo });
      } else if (isReact(step)) {
        const anchor = prevId;
        if (!anchor) {
          publishTrace(def, runId, trigger, channelId, communityId, "failed", { step: stepNo, detail: "no message to react to" });
          return;
        }
        const emoji = step.react.emoji ?? "👍";
        await relay.publish(
          client.signEvent({ kind: KIND_REACTION, tags: [["e", anchor], ["h", channelId], ["c", communityId]], content: emoji })
        );
        output = emoji;
        console.log(`   ${emoji} step ${stepNo}: reacted to ${anchor.slice(0, 8)}`);
        publishTrace(def, runId, trigger, channelId, communityId, "step_done", { step: stepNo });
      } else if (isWebhook(step)) {
        const w = step.webhook;
        const method = w.method ?? (w.body ? "POST" : "GET");
        const timeoutMs = parseDuration(w.timeout, 10_000);
        try {
          const response = await fetch(w.url, {
            method,
            signal: AbortSignal.timeout(timeoutMs),
            ...(w.body
              ? { body: resolveTemplate(w.body, vars as never), headers: { "content-type": "application/json" } }
              : {}),
          });
          output = (await response.text()).slice(0, 2_000);
          console.log(`   🌐 step ${stepNo}: ${method} ${w.url} → ${response.status}`);
          publishTrace(def, runId, trigger, channelId, communityId, "step_done", { step: stepNo, detail: `http ${response.status}` });
          if (!response.ok) {
            publishTrace(def, runId, trigger, channelId, communityId, "failed", { step: stepNo, detail: `http ${response.status}` });
            return;
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`   ❌ step ${stepNo}: webhook failed — ${reason}`);
          publishTrace(def, runId, trigger, channelId, communityId, "failed", { step: stepNo, detail: reason.slice(0, 120) });
          return;
        }
      } else if (isWait(step)) {
        const gate = step.wait_reaction;
        if (!prevId) {
          // Unreachable by validation (schedule runs must say before
          // waiting), kept as a hard stop rather than an undefined anchor.
          publishTrace(def, runId, trigger, channelId, communityId, "failed", { step: stepNo, detail: "no message to anchor the approval to" });
          return;
        }
        const susp: SuspendedRun = {
          workflow: def.name,
          runId,
          stepIndex: index,
          anchorId: prevId,
          emoji: gate.emoji ?? "👍",
          from: gate.from,
          deadline: Date.now() + parseDuration(gate.timeout, DEFAULT_APPROVAL_TIMEOUT_MS),
          vars,
          rootId,
          prevId,
          triggerDepth,
          channelId,
          communityId,
        };
        console.log(`   ⏸  step ${stepNo}: waiting for ${susp.emoji} on ${susp.anchorId.slice(0, 8)} (${gate.timeout ?? "24h"} timeout)`);
        publishTrace(def, runId, trigger, channelId, communityId, "waiting_approval", { step: stepNo });
        suspended.push(susp);
        saveSuspended();
        const approver = await settleGate(def, susp);
        if (!approver) return; // timed out — settleGate already traced + noticed
        vars["approved_by"] = pubkeyToName.get(approver) ?? approver.slice(0, 8);
      }
      if (step.id !== undefined && output !== undefined) {
        vars[`steps.${step.id}.output`] = output;
      }
    }
    console.log(`🏁 ${def.name} run ${runId.slice(0, 8)} done`);
    publishTrace(def, runId, trigger, channelId, communityId, "done");
  }

  /**
   * Park on a suspended approval gate until reaction/timeout. Shared by
   * the live path and the boot-time rehydration of persisted suspensions
   * — the gate survives restarts with its REMAINING timeout.
   */
  async function settleGate(def: WorkflowDef, susp: SuspendedRun): Promise<string | undefined> {
    const dropSusp = () => {
      const i = suspended.indexOf(susp);
      if (i >= 0) suspended.splice(i, 1);
      saveSuspended();
    };
    const allowedPubkey = susp.from === "any" ? undefined : resolvePrincipal(susp.from ?? "owner");
    if (susp.from !== "any" && !allowedPubkey) {
      console.error(`   ❌ ${def.name}: cannot resolve approver "${susp.from ?? "owner"}" — run abandoned`);
      publishTrace(def, susp.runId, undefined, susp.channelId, susp.communityId, "failed", { step: susp.stepIndex + 1, detail: "unresolvable approver" });
      dropSusp();
      return undefined;
    }
    const remainingMs = Math.max(0, susp.deadline - Date.now());
    const approver = await new Promise<string | undefined>((resolve) => {
      const pending: PendingApproval = {
        targetId: susp.anchorId,
        emoji: susp.emoji,
        allowedPubkey,
        channelId: susp.channelId,
        resolve: (pk) => { cleanup(); resolve(pk); },
      };
      const timer = setTimeout(() => { cleanup(); resolve(undefined); }, remainingMs);
      const cleanup = () => {
        clearTimeout(timer);
        const i = pendingApprovals.indexOf(pending);
        if (i >= 0) pendingApprovals.splice(i, 1);
      };
      pendingApprovals.push(pending);
    });
    dropSusp();
    if (!approver) {
      console.log(`   ⏱  ${def.name}: approval timed out — run abandoned`);
      publishTrace(def, susp.runId, undefined, susp.channelId, susp.communityId, "timeout", { step: susp.stepIndex + 1 });
      void relay
        .publish(
          client.signEvent({
            kind: KIND_CHANNEL_MESSAGE,
            tags: [
              ["h", susp.channelId],
              ["c", susp.communityId],
              ...(susp.rootId ? [["e", susp.rootId, "", "root"]] : []),
              ["e", susp.anchorId, "", "reply"],
              ["depth", String(susp.triggerDepth + 1)],
            ],
            content: `⏱ workflow **${def.name}**: approval (${susp.emoji}) timed out — remaining steps skipped.`,
          })
        )
        .catch(() => {});
      return undefined;
    }
    console.log(`   ✅ ${def.name}: approved by ${pubkeyToName.get(approver) ?? approver.slice(0, 8)}`);
    publishTrace(def, susp.runId, undefined, susp.channelId, susp.communityId, "approved", { step: susp.stepIndex + 1, by: approver });
    return approver;
  }

  // Rehydrate suspensions that survived a restart: re-arm each gate with
  // its remaining timeout; on approval the run continues from the step
  // AFTER the gate, exactly where it parked.
  for (const susp of [...suspended]) {
    const def = defs.find((d) => d.name === susp.workflow);
    if (!def || susp.stepIndex >= def.steps.length) {
      suspended.splice(suspended.indexOf(susp), 1);
      saveSuspended();
      continue;
    }
    console.log(`♻️  re-arming suspended ${susp.workflow} run ${susp.runId.slice(0, 8)} (gate at step ${susp.stepIndex + 1})`);
    void (async () => {
      const approver = await settleGate(def, susp);
      if (!approver) return;
      const vars = { ...susp.vars, approved_by: pubkeyToName.get(approver) ?? approver.slice(0, 8) };
      await executeSteps(
        def,
        { runId: susp.runId, vars, rootId: susp.rootId, prevId: susp.prevId, triggerDepth: susp.triggerDepth, channelId: susp.channelId, communityId: susp.communityId },
        susp.stepIndex + 1
      );
    })().catch((err) => console.error(`❌ resumed ${susp.workflow} failed:`, err instanceof Error ? err.message : err));
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
      if (trig.on === "schedule") continue; // fired by the scheduler, never by events
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

  // ── Schedules — Buzz's Schedule trigger: croner drives cron patterns,
  // setInterval drives `every`. Best-effort like Buzz's MVP: last-fired
  // state is in-memory, fires missed while the service is down are not
  // replayed. Scheduled runs need a community tag before any message
  // exists, so channel→community comes from 47101 metadata.
  const communityOf = new Map<string, string>();
  for (const event of await relay.query([{ kinds: [KIND_CHANNEL], "#d": channels }])) {
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    const c = event.tags.find((t) => t[0] === "c")?.[1];
    if (d && c) communityOf.set(d, c);
  }
  const scheduleHandles: { stop(): void }[] = [];
  for (const def of defs) {
    if (def.trigger.on !== "schedule") continue;
    const fire = () => {
      for (const channelId of channelsByDef.get(def)!) {
        const communityId = communityOf.get(channelId);
        if (!communityId) {
          console.warn(`⚠️  ${def.name}: no community metadata for channel ${channelId} — fire skipped`);
          continue;
        }
        void runWorkflow(def, undefined, channelId, communityId).catch((err) => {
          console.error(`❌ ${def.name} scheduled run failed:`, err instanceof Error ? err.message : err);
        });
      }
    };
    if (def.trigger.cron) {
      const job = new Cron(def.trigger.cron, fire);
      scheduleHandles.push({ stop: () => job.stop() });
    } else {
      const timer = setInterval(fire, parseDuration(def.trigger.every, 3_600_000));
      scheduleHandles.push({ stop: () => clearInterval(timer) });
    }
  }

  console.log(`🟢 fez-workflows: ${defs.length} workflow(s) across ${channels.length} channel(s) on ${relayUrls.join(", ")}`);
  for (const def of defs) {
    const trig = def.trigger;
    const detail =
      trig.on === "schedule"
        ? ` (${trig.cron ?? `every ${trig.every}`})`
        : `${trig.from ? ` from ${trig.from}` : ""}${trig.filter ? ` ~ /${trig.filter}/i` : ""}`;
    console.log(`   • ${def.name}: on ${trig.on}${detail} → ${def.steps.length} step(s) in #${def.channel}`);
  }
  console.log(`   Pubkey: ${myPubkey}${owner ? "" : " | ⚠️ FEZ_AGENT_OWNER unset — owner-approved gates cannot resolve"}`);

  process.on("SIGINT", () => {
    for (const handle of scheduleHandles) handle.stop();
    relay.disconnect();
    console.log(`\n🔴 fez-workflows stopped.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
