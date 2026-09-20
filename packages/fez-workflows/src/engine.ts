import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Cron } from "croner";
import {
  KIND_AGENT_METADATA,
  KIND_CHANNEL_MESSAGE,
  KIND_MEMBERSHIP,
  KIND_REACTION,
  KIND_WORKFLOW_RUN,
  ROSTER_D,
} from "../../../src/protocol/kinds.js";
import { MAX_CHAIN_DEPTH } from "../../../src/protocol/limits.js";
import { parseThreadRef } from "../../fez-client/src/thread-ref.js";
import { isSay, isWait, isDelay, isDm, isReact, isWebhook, isJudge, isWaitUntil, isWake, parseDuration, resolveTemplate, type WorkflowDef } from "./defs.js";
import { evalCondition, type ExprValue } from "./expr.js";
import { DEFAULT_AT, judgeState, judgeStatements, judgeVars, type Ask } from "./judge.js";

/**
 * The workflow engine — Buzz's workflow engine (buzz-workflow crate),
 * decentralized: multi-agent follow-ups made DETERMINISTIC. The reply
 * event is the trigger, not the model's obedience — "when researcher
 * replies here, summon @reviewer" fires whether or not researcher
 * remembered to hand off.
 *
 * Host-agnostic on purpose. Two hosts exist: the standalone service
 * (workflows.ts, its own service key, `fez run`) and the desktop's
 * background worker (headless.ts, runs as the OWNER through the
 * extension API). Both hand the engine an EngineNostr; nothing here
 * knows about relays, keys, or processes.
 *
 * Guard rails: triggers require workspace membership (strangers never
 * fire automations); the engine's OWN posts never trigger (tracked by
 * event id, so an owner-identity host still sees the owner's other
 * events); published messages carry depth+1 and events at the chain
 * cap don't trigger (same loop guard as agents). Approval gates and
 * wait_until gates persist to stateFile and re-arm after a restart.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 3_600_000;

export interface FezEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}

type Template = { kind: number; tags: string[][]; content: string; created_at?: number };

/** What the engine needs from its host: a signing identity on the workspace relay. */
export interface EngineNostr {
  pubkey: string;
  publish(tmpl: Template): Promise<FezEvent>;
  subscribe(filters: Record<string, unknown>[], handler: (event: FezEvent) => void): () => void;
  query(filters: Record<string, unknown>[]): Promise<FezEvent[]>;
  sendDm(to: string, text: string, depth: number): Promise<void>;
  /**
   * Send an owner-encrypted control frame (kind 20005) to an agent — the
   * `wake:` step's silent summons. Only an owner-identity host can offer
   * this: agents authorize a frame by decrypting it under the owner key.
   */
  control?(to: string, frame: Record<string, unknown>): Promise<void>;
}

export interface EngineOptions {
  nostr: EngineNostr;
  /** Owner pubkey — the default approver and `from: owner`. */
  owner?: string;
  defs: WorkflowDef[];
  /** Judge for when/judge/wait_until; hosts refuse to start judged definitions without one. */
  ask?: Ask;
  stateFile: string;
  /** Resolve a def's channel spec (name or id) to channel ids. */
  channelIds(spec: string): Promise<string[]>;
}

export interface EngineHandle {
  channels: string[];
  stop(): void;
}

export async function startWorkflowEngine(opts: EngineOptions): Promise<EngineHandle> {
  const { nostr, owner, defs, ask, stateFile } = opts;
  const myPubkey = nostr.pubkey;
  // Everything this engine publishes, by id — the self-loop guard.
  const ownIds = new Set<string>();
  const publish = async (tmpl: Template): Promise<FezEvent> => {
    const event = await nostr.publish(tmpl);
    ownIds.add(event.id);
    return event;
  };

  // Each def's channel spec resolves independently (a name may match
  // several channels; the def applies to all of them).
  const channelsByDef = new Map<WorkflowDef, string[]>();
  for (const def of defs) {
    channelsByDef.set(def, await opts.channelIds(def.channel));
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
  for (const event of (await nostr.query([{ kinds: [KIND_AGENT_METADATA] }])).sort((a, b) => a.created_at - b.created_at)) {
    absorbAgent(event);
  }

  // Membership is the workspace ROSTER — one owner-signed 47102 event
  // tagged ["d", "roster"] that covers every channel. This service used
  // to look for a roster per channel id, which flat workspaces never
  // publish, so nothing was ever a member and no trigger could fire.
  const memberships = new Map<string, { createdAt: number; members: Set<string> }>();
  function absorbMembership(event: FezEvent): void {
    if (event.tags.find((t) => t[0] === "d")?.[1] !== ROSTER_D) return;
    if (owner && event.pubkey !== owner) return; // only the owner's roster counts
    const members = new Set<string>(event.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
    for (const channelId of channels) {
      const existing = memberships.get(channelId);
      if (existing && event.created_at < existing.createdAt) continue;
      memberships.set(channelId, { createdAt: event.created_at, members });
    }
  }
  for (const event of await nostr.query([{ kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D] }])) absorbMembership(event);
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

  // Armed wait_until gates: thread messages are judged against them. The
  // durable record is the SuspendedRun (judgment set); this is the live
  // handle settleJudgment parks on, re-created on rehydration.
  interface PendingJudgment {
    rootId: string;
    channelId: string;
    allowedPubkey?: string; // undefined = any member of the channel
    statement: string;
    at: number;
    resolve: (event: FezEvent, value: number) => void;
  }
  const pendingJudgments: PendingJudgment[] = [];

  const publishTrace = (
    def: WorkflowDef,
    runId: string,
    trigger: FezEvent | undefined,
    channelId: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) => {
    void publish({
      kind: KIND_WORKFLOW_RUN,
      tags: [["h", channelId], ...(trigger ? [["e", trigger.id]] : []), ["workflow", def.name]],
      content: JSON.stringify({ workflow: def.name, run: runId, status, ...extra }),
    }).catch(() => {});
  };

  // ── Durable suspensions (GAPS item 14): a restart used to drop every
  // pending approval gate. Suspended runs now persist — enough context to
  // resume the step loop after the gate — and re-arm at boot with their
  // REMAINING timeout. Delays stay best-effort (a restart re-runs nothing).
  interface SuspendedRun {
    workflow: string;
    runId: string;
    stepIndex: number; // the wait_reaction / wait_until step we're parked on
    anchorId: string;
    emoji: string;
    from?: string;
    deadline: number; // epoch ms
    vars: Record<string, ExprValue>;
    rootId?: string;
    prevId?: string;
    triggerDepth: number;
    channelId: string;
    /** Present for a wait_until gate: the statement a thread message must satisfy. */
    judgment?: { statement: string; at: number };
  }
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
    trigger?: FezEvent;
  }

  /** trigger absent = a schedule fire: says start a fresh thread (the first say becomes the root). */
  async function runWorkflow(def: WorkflowDef, trigger: FezEvent | undefined, channelId: string): Promise<void> {
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
    publishTrace(def, runId, trigger, channelId, "started");
    await executeSteps(def, { runId, vars, rootId, prevId: trigger?.id, triggerDepth, channelId, trigger }, 0);
  }

  async function executeSteps(def: WorkflowDef, ctx: RunCtx, startIndex: number): Promise<void> {
    const { runId, vars, triggerDepth, channelId, trigger } = ctx;
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
          publishTrace(def, runId, trigger, channelId, "step_skipped", { step: stepNo, ...(error ? { detail: error } : {}) });
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
        const event = await publish({
          kind: KIND_CHANNEL_MESSAGE,
          tags: [
            ["h", channelId],
            ...(rootId ? [["e", rootId, "", "root"]] : []),
            ...(prevId ? [["e", prevId, "", "reply"]] : []),
            ["depth", String(triggerDepth + 1)],
            ["workflow", def.name], // clients render these as system output, not as the signer speaking
            ...mentions.map((pk) => ["p", pk]),
          ],
          content: text,
        });
        rootId ??= event.id; // a scheduled run's first say starts the thread
        prevId = event.id;
        output = event.id;
        console.log(`   💬 step ${stepNo}: ${text.slice(0, 70)}`);
        publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo });
      } else if (isWake(step)) {
        // The silent summons: an owner-encrypted control frame starts the
        // agent's turn in this thread and nothing is posted. Only an
        // owner-identity host can send one (agents authorize by decrypting
        // under the owner key), so the standalone service fails the run
        // loudly instead of quietly falling back to a visible summons.
        const to = resolvePrincipal(step.wake.agent);
        const problem = !to ? `cannot resolve agent "${step.wake.agent}"`
          : !nostr.control ? "this host cannot wake agents (needs the owner identity — run inside the desktop)"
          : !rootId ? "no thread to wake into" : undefined;
        if (problem) {
          console.error(`   ❌ step ${stepNo}: ${problem} — run abandoned`);
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: problem.slice(0, 120) });
          return;
        }
        const text = resolveTemplate(step.wake.text, vars as never);
        await nostr.control!(to!, { cmd: "wake", ts: Date.now(), channel: channelId, root: rootId!, reply: prevId ?? rootId!, depth: triggerDepth + 1, text });
        output = to!;
        console.log(`   ⏰ step ${stepNo}: woke ${step.wake.agent} — ${text.slice(0, 60)}`);
        publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo, woke: to });
      } else if (isDelay(step)) {
        const ms = parseDuration(step.delay, 0);
        console.log(`   ⏳ step ${stepNo}: delay ${step.delay}`);
        publishTrace(def, runId, trigger, channelId, "step_waiting", { step: stepNo, detail: step.delay });
        await new Promise((r) => setTimeout(r, ms));
        output = "";
        publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo });
      } else if (isDm(step)) {
        const to = step.dm.to === "owner" ? owner : resolvePrincipal(step.dm.to);
        if (!to) {
          console.error(`   ❌ step ${stepNo}: cannot resolve DM recipient "${step.dm.to}" — run abandoned`);
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: "unresolvable dm recipient" });
          return;
        }
        await nostr.sendDm(to, resolveTemplate(step.dm.message, vars as never), triggerDepth + 1);
        output = "sent";
        console.log(`   ✉️  step ${stepNo}: DM to ${pubkeyToName.get(to) ?? to.slice(0, 8)}`);
        publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo });
      } else if (isReact(step)) {
        const anchor = prevId;
        if (!anchor) {
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: "no message to react to" });
          return;
        }
        const emoji = step.react.emoji ?? "👍";
        await publish({ kind: KIND_REACTION, tags: [["e", anchor], ["h", channelId]], content: emoji });
        output = emoji;
        console.log(`   ${emoji} step ${stepNo}: reacted to ${anchor.slice(0, 8)}`);
        publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo });
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
          publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo, detail: `http ${response.status}` });
          if (!response.ok) {
            publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: `http ${response.status}` });
            return;
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(`   ❌ step ${stepNo}: webhook failed — ${reason}`);
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: reason.slice(0, 120) });
          return;
        }
      } else if (isJudge(step)) {
        // Judged values become variables for later `if:` conditions. A
        // judge failure skips this step loudly; conditions that reference
        // the missing variables then skip too (unknown variable = skip).
        try {
          const values = await judgeStatements(ask!, judgeState(vars), step.judge.ask);
          Object.assign(vars, judgeVars(values));
          output = JSON.stringify(values);
          console.log(`   ⚖️  step ${stepNo}: ${Object.entries(values).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ")}`);
          publishTrace(def, runId, trigger, channelId, "step_done", { step: stepNo, judged: values });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.log(`   ⤼  step ${stepNo}: skipped (judge error: ${reason})`);
          publishTrace(def, runId, trigger, channelId, "step_skipped", { step: stepNo, detail: `judge error: ${reason.slice(0, 120)}` });
          continue;
        }
      } else if (isWaitUntil(step)) {
        const gate = step.wait_until;
        if (!rootId) {
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: "no thread to wait on" });
          return;
        }
        const allowedPubkey = gate.from && gate.from !== "any" ? resolvePrincipal(gate.from) : undefined;
        if (gate.from && gate.from !== "any" && !allowedPubkey) {
          console.error(`   ❌ step ${stepNo}: cannot resolve wait_until.from "${gate.from}" — run abandoned`);
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: "unresolvable wait_until.from" });
          return;
        }
        const at = gate.at ?? DEFAULT_AT;
        const susp: SuspendedRun = {
          workflow: def.name, runId, stepIndex: index, anchorId: prevId ?? rootId, emoji: "", from: gate.from,
          deadline: Date.now() + parseDuration(gate.timeout, DEFAULT_APPROVAL_TIMEOUT_MS),
          vars, rootId, prevId, triggerDepth, channelId, judgment: { statement: gate.statement, at },
        };
        console.log(`   ⏸  step ${stepNo}: waiting until "${gate.statement}" ≥ ${at} (${gate.timeout ?? "24h"} timeout)`);
        publishTrace(def, runId, trigger, channelId, "waiting_judgment", { step: stepNo, statement: gate.statement, at });
        suspended.push(susp);
        saveSuspended();
        const settled = await settleJudgment(def, susp);
        if (!settled) return; // timed out — settleJudgment already traced + noticed
        prevId = settled.event.id;
        output = settled.event.id;
        console.log(`   ✅ step ${stepNo}: satisfied by ${vars["latest.author_name"]} (${settled.value.toFixed(2)})`);
      } else if (isWait(step)) {
        const gate = step.wait_reaction;
        if (!prevId) {
          // Unreachable by validation (schedule runs must say before
          // waiting), kept as a hard stop rather than an undefined anchor.
          publishTrace(def, runId, trigger, channelId, "failed", { step: stepNo, detail: "no message to anchor the approval to" });
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
        };
        console.log(`   ⏸  step ${stepNo}: waiting for ${susp.emoji} on ${susp.anchorId.slice(0, 8)} (${gate.timeout ?? "24h"} timeout)`);
        publishTrace(def, runId, trigger, channelId, "waiting_approval", { step: stepNo });
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
    publishTrace(def, runId, trigger, channelId, "done");
  }

  /**
   * Park on a suspended wait_until until a thread message satisfies its
   * statement, or the deadline passes. Same shape as settleGate: shared by
   * the live path and boot-time rehydration, so a restart re-arms the wait
   * with its remaining timeout instead of dropping the run. On success the
   * matching message fills the `latest.*` variables in susp.vars.
   */
  async function settleJudgment(def: WorkflowDef, susp: SuspendedRun): Promise<{ event: FezEvent; value: number } | undefined> {
    const dropSusp = () => {
      const i = suspended.indexOf(susp);
      if (i >= 0) suspended.splice(i, 1);
      saveSuspended();
    };
    const judgment = susp.judgment!;
    const allowedPubkey = susp.from && susp.from !== "any" ? resolvePrincipal(susp.from) : undefined;
    if (susp.from && susp.from !== "any" && !allowedPubkey) {
      console.error(`   ❌ ${def.name}: cannot resolve wait_until.from "${susp.from}" — run abandoned`);
      publishTrace(def, susp.runId, undefined, susp.channelId, "failed", { step: susp.stepIndex + 1, detail: "unresolvable wait_until.from" });
      dropSusp();
      return undefined;
    }
    const threadRoot = susp.rootId ?? susp.anchorId;
    const remainingMs = Math.max(0, susp.deadline - Date.now());
    const settled = await new Promise<{ event: FezEvent; value: number } | undefined>((resolve) => {
      const pending: PendingJudgment = {
        rootId: threadRoot, channelId: susp.channelId, allowedPubkey, statement: judgment.statement, at: judgment.at,
        resolve: (event, value) => { cleanup(); resolve({ event, value }); },
      };
      const timer = setTimeout(() => { cleanup(); resolve(undefined); }, remainingMs);
      const cleanup = () => {
        clearTimeout(timer);
        const i = pendingJudgments.indexOf(pending);
        if (i >= 0) pendingJudgments.splice(i, 1);
      };
      pendingJudgments.push(pending);
    });
    dropSusp();
    if (!settled) {
      console.log(`   ⏱  ${def.name}: wait_until timed out — run abandoned`);
      publishTrace(def, susp.runId, undefined, susp.channelId, "timeout", { step: susp.stepIndex + 1 });
      void publish({
        kind: KIND_CHANNEL_MESSAGE,
        tags: [["h", susp.channelId], ["e", threadRoot, "", "root"], ...(susp.prevId ? [["e", susp.prevId, "", "reply"]] : []), ["depth", String(susp.triggerDepth + 1)], ["workflow", def.name]],
        content: `⏱ workflow **${def.name}**: nothing in this thread satisfied "${judgment.statement}" in time — remaining steps skipped.`,
      }).catch(() => {});
      return undefined;
    }
    susp.vars["latest.text"] = settled.event.content;
    susp.vars["latest.author"] = settled.event.pubkey;
    susp.vars["latest.author_name"] = pubkeyToName.get(settled.event.pubkey) ?? settled.event.pubkey.slice(0, 8);
    susp.vars["latest.id"] = settled.event.id;
    publishTrace(def, susp.runId, undefined, susp.channelId, "step_done", { step: susp.stepIndex + 1, value: settled.value, by: settled.event.pubkey });
    return settled;
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
      publishTrace(def, susp.runId, undefined, susp.channelId, "failed", { step: susp.stepIndex + 1, detail: "unresolvable approver" });
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
      publishTrace(def, susp.runId, undefined, susp.channelId, "timeout", { step: susp.stepIndex + 1 });
      void publish({
        kind: KIND_CHANNEL_MESSAGE,
        tags: [
          ["h", susp.channelId],
          ...(susp.rootId ? [["e", susp.rootId, "", "root"]] : []),
          ["e", susp.anchorId, "", "reply"],
          ["depth", String(susp.triggerDepth + 1)],
          ["workflow", def.name],
        ],
        content: `⏱ workflow **${def.name}**: approval (${susp.emoji}) timed out — remaining steps skipped.`,
      }).catch(() => {});
      return undefined;
    }
    console.log(`   ✅ ${def.name}: approved by ${pubkeyToName.get(approver) ?? approver.slice(0, 8)}`);
    publishTrace(def, susp.runId, undefined, susp.channelId, "approved", { step: susp.stepIndex + 1, by: approver });
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
    console.log(`♻️  re-arming suspended ${susp.workflow} run ${susp.runId.slice(0, 8)} (${susp.judgment ? "wait_until" : "gate"} at step ${susp.stepIndex + 1})`);
    void (async () => {
      let vars: Record<string, ExprValue>;
      let prevId = susp.prevId;
      if (susp.judgment) {
        const settled = await settleJudgment(def, susp);
        if (!settled) return;
        vars = susp.vars; // settleJudgment filled latest.*
        prevId = settled.event.id;
      } else {
        const approver = await settleGate(def, susp);
        if (!approver) return;
        vars = { ...susp.vars, approved_by: pubkeyToName.get(approver) ?? approver.slice(0, 8) };
      }
      await executeSteps(
        def,
        { runId: susp.runId, vars, rootId: susp.rootId, prevId, triggerDepth: susp.triggerDepth, channelId: susp.channelId },
        susp.stepIndex + 1
      );
    })().catch((err) => console.error(`❌ resumed ${susp.workflow} failed:`, err instanceof Error ? err.message : err));
  }

  const seenTriggers = new Set<string>();
  function handleEvent(event: FezEvent): void {
    if (event.kind === KIND_MEMBERSHIP) return absorbMembership(event);
    if (event.kind === KIND_AGENT_METADATA) return absorbAgent(event);
    if (ownIds.has(event.id)) return; // never self-trigger — by id, so an owner-identity host still sees the owner's other events

    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId) return;

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

    // Does this thread message settle a wait_until? Judged per pending
    // gate; a failed judgment just leaves the gate armed for the next one.
    if (event.kind === KIND_CHANNEL_MESSAGE && pendingJudgments.length > 0) {
      const root = parseThreadRef(event.tags).rootId ?? event.id;
      for (const pending of [...pendingJudgments]) {
        if (pending.channelId !== channelId || pending.rootId !== root) continue;
        if (pending.allowedPubkey && event.pubkey !== pending.allowedPubkey) continue;
        void judgeStatements(ask!, { message: { author: pubkeyToName.get(event.pubkey) ?? event.pubkey.slice(0, 8), text: event.content } }, { until: pending.statement })
          .then(({ until }) => {
            console.log(JSON.stringify({ wait_until: pending.statement, value: until, bar: pending.at, event: event.id }));
            if (until >= pending.at && pendingJudgments.includes(pending)) pending.resolve(event, until);
          })
          .catch((err) => console.warn(`⚠️  wait_until judgment failed (gate stays armed): ${err instanceof Error ? err.message : err}`));
      }
    }

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
      void (async () => {
        // `when:` — the semantic filter. One judge call per candidate
        // event; below the bar or on any judge failure the run does not
        // fire, and the value is logged either way so the bar can be tuned.
        if (trig.on === "message" && trig.when) {
          const bar = trig.when_at ?? DEFAULT_AT;
          let value: number | undefined, error: string | undefined;
          try {
            value = (await judgeStatements(ask!, { message: { author: pubkeyToName.get(event.pubkey) ?? event.pubkey.slice(0, 8), text: event.content } }, { when: trig.when })).when;
          } catch (err) { error = err instanceof Error ? err.message : String(err); }
          console.log(JSON.stringify({ workflow: def.name, when: trig.when, value, bar, event: event.id, ...(error ? { error } : {}) }));
          if (value === undefined || value < bar) return;
        }
        await runWorkflow(def, event, channelId);
      })().catch((err) => {
        console.error(`❌ ${def.name} run failed:`, err instanceof Error ? err.message : err);
      });
    }
  }

  const unsubscribe = nostr.subscribe(
    [
      { kinds: [KIND_CHANNEL_MESSAGE, KIND_REACTION], "#h": channels, since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_MEMBERSHIP], "#d": [ROSTER_D], since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) },
    ],
    (event) => handleEvent(event)
  );

  // ── Schedules — Buzz's Schedule trigger: croner drives cron patterns,
  // setInterval drives `every`. Best-effort like Buzz's MVP: last-fired
  // state is in-memory, fires missed while the service is down are not
  // replayed. A scheduled run used to need channel→community metadata
  // resolved up front; the workspace is the relay now, so the channel
  // id is the whole address and a fire can never be skipped for want of
  // a lookup.
  const scheduleHandles: { stop(): void }[] = [];
  for (const def of defs) {
    if (def.trigger.on !== "schedule") continue;
    const fire = () => {
      for (const channelId of channelsByDef.get(def)!) {
        void runWorkflow(def, undefined, channelId).catch((err) => {
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

  console.log(`🟢 workflows: ${defs.length} workflow(s) across ${channels.length} channel(s) as ${myPubkey.slice(0, 8)}…${owner ? "" : " | ⚠️ owner unset — owner-approved gates cannot resolve"}`);
  for (const def of defs) {
    const trig = def.trigger;
    const detail =
      trig.on === "schedule"
        ? ` (${trig.cron ?? `every ${trig.every}`})`
        : `${trig.from ? ` from ${trig.from}` : ""}${trig.filter ? ` ~ /${trig.filter}/i` : ""}${trig.when ? ` when "${trig.when.slice(0, 40)}…"` : ""}`;
    console.log(`   • ${def.name}: on ${trig.on}${detail} → ${def.steps.length} step(s) in #${def.channel}`);
  }

  return {
    channels,
    stop() {
      for (const handle of scheduleHandles) handle.stop();
      unsubscribe();
    },
  };
}
