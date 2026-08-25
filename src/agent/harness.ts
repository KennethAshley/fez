import { fezHome } from "../shared/fez-home.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type McpServer } from "@agentclientprotocol/sdk";
import type { SystemPromptMode } from "./system-prompt.js";
import { notice } from "../cli/notices.js";
import { classifyToolCall, type RiskVerdict } from "./command-risk.js";

/**
 * One activity event from a running harness turn — the raw material of the
 * observer stream (Buzz's two-audience model: reply text is channel-
 * visible; thoughts/tools are owner-only). text/thought carry ACCUMULATED
 * text (coalesced like onProgress); tool/plan events are discrete.
 */
export interface HarnessUpdate {
  type: "text" | "thought" | "tool" | "plan" | "usage";
  /** Accumulated text so far (text/thought types). */
  text?: string;
  /** Tool call title (tool type). */
  title?: string;
  /** Tool call status (tool type, from tool_call_update). */
  status?: string;
  /** ACP ToolKind (read|edit|delete|move|search|execute|think|fetch|other) — lets renderers classify without parsing titles. */
  kind?: string;
  /** Correlates tool_call_update frames with their originating tool_call. */
  callId?: string;
  /** First file path the tool touches (from ACP locations). */
  path?: string;
  /** File modification for edit-class tools, truncated at the source (observer frames stay small). */
  diff?: { path: string; oldText?: string; newText: string };
  /** Token/cost figures when the harness surfaces them (usage type). Never estimated. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/**
 * A locally installed coding-agent harness (Claude Code, pi, ...) that Fez
 * can dispatch instructions to directly, without going through Nostr.
 */
export interface HarnessAdapter {
  id: string;
  aliases: string[];
  /** The binary this adapter spawns. */
  command: string;
  /**
   * How this harness can carry standing instructions. Declared, never
   * assumed: only "native" is a real privilege boundary, and claiming
   * one that isn't there would make `fez doctor` lie about whether an
   * agent can be talked out of its own rules.
   */
  systemPromptMode?: SystemPromptMode;
  detect(): Promise<boolean>;
  /**
   * onProgress fires (throttled) with the accumulated text so far, before the call resolves.
   * mcpServers are the persona's resolved skills (see mcp-servers.ts) — a
   * harness that isn't ACP-based (or doesn't support MCP) is free to ignore
   * this; it's additive, not a required capability.
   * onUpdate fires with richer activity (thoughts, tool calls, plans) for
   * observer streams — also optional and additive.
   * signal aborts the turn (steering: cancel in-flight, re-dispatch a
   * merged prompt — Buzz's model); invoke rejects with an error named
   * "AbortError" so callers can tell a steer from a failure.
   */
  invoke(
    instruction: string,
    cwd?: string,
    onProgress?: (textSoFar: string) => void,
    mcpServers?: McpServer[],
    onUpdate?: (update: HarnessUpdate) => void,
    signal?: AbortSignal
  ): Promise<string>;
  /**
   * Open a PERSISTENT session: one live harness process whose
   * conversation accumulates across prompt() calls — Buzz's per-channel
   * session model. The caller owns the lifecycle (close on breaker
   * trips, turn caps, idle reaping). Optional: adapters without it are
   * one-shot only and callers fall back to invoke().
   * timeouts (optional) size the per-prompt idle/hard deadlines — see
   * SESSION_TIMEOUTS for the defaults and their rationale.
   */
  openSession?(
    cwd: string,
    mcpServers?: McpServer[],
    timeouts?: TimeoutOptions,
    /** Standing instructions, delivered by this adapter's declared mode. */
    systemPrompt?: string
  ): Promise<HarnessSession>;
}

/** An image to hand the model this turn — base64 bytes + its mime type.
 * Sent as an ACP `image` content block; models without vision ignore it. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

/** A turn's input: bare text (the common case) or text plus images. A string
 * stays valid everywhere it was before — the object form is opt-in. */
export type PromptInput = string | { text: string; images?: PromptImage[] };

/** A live harness conversation. prompt() calls MUST be sequential (no overlap). */
export interface HarnessSession {
  /** False once the underlying process died or close() was called. */
  readonly alive: boolean;
  prompt(
    instruction: PromptInput,
    onProgress?: (textSoFar: string) => void,
    onUpdate?: (update: HarnessUpdate) => void,
    signal?: AbortSignal
  ): Promise<string>;
  close(): Promise<void>;
}

/**
 * Minimum gap between onProgress calls. Low enough that streaming a reply
 * into a live bubble reads as typing (pi-style); it gates a local render,
 * not network traffic.
 */
const PROGRESS_THROTTLE_MS = 150;

/**
 * pi-acp interleaves transport retry notices into agent_message chunks
 * ("Retrying (attempt 1/3, waiting 2s)...", "Retry finished, resuming.").
 * That's status, not reply — seen live posting as an agent's ENTIRE
 * channel message, which also broke the callback chain behind it.
 * Scrubbed at every emission point; accumulation stays raw so partial
 * chunks still concatenate.
 */
const HARNESS_NOISE = /Retrying \(attempt \d+\/\d+, waiting \d+s\)\.\.\.|Retry finished, resuming\.?/g;
function scrubNoise(text: string): string {
  return text.replace(HARNESS_NOISE, "").replace(/^[ \t]*\n/, "");
}

export interface TimeoutOptions {
  /** Abort if no session/update arrives for this long — the agent has gone silent. */
  idleMs: number;
  /** Abort after this long total, even if updates keep arriving. */
  maxMs: number;
}

/**
 * Timeout sizing is arithmetic, not taste (Buzz config.rs, learned from
 * real long-tool burns): ACP emits a tool_call at start and nothing again
 * until the tool finishes, so the idle window must EXCEED the longest
 * legitimate tool run — Claude Code's shell tool alone goes to 600s.
 * The old 30s idle killed any turn with a quiet 40s tool call.
 *
 * Sessions (standing agents doing real work): Buzz's numbers — 900s idle,
 * 2h hard cap. One-shot invoke (TUI local dispatch, interactive feel):
 * tighter but still above the shell-tool ceiling.
 * Per-persona override: extra.idleTimeoutS / extra.turnTimeoutS (seconds),
 * threaded through openSession by fez-acp.
 */
export const SESSION_TIMEOUTS: TimeoutOptions = { idleMs: 900_000, maxMs: 2 * 60 * 60_000 };
const ONE_SHOT_TIMEOUTS: TimeoutOptions = { idleMs: 300_000, maxMs: 30 * 60_000 };

class HarnessTimeoutError extends Error {}

/**
 * Pull the diff (if any) out of a tool call's content collection,
 * truncated hard: observer frames ride an encrypted relay wire with
 * size caps, and the working tree is the durable artifact anyway.
 */
const DIFF_SIDE_CAP = 1500;
function extractDiff(
  content: { type: string; path?: string; oldText?: string | null; newText?: string }[] | null | undefined
): { path: string; oldText?: string; newText: string } | undefined {
  const diff = content?.find((item) => item.type === "diff");
  if (!diff?.path || typeof diff.newText !== "string") return undefined;
  return {
    path: diff.path,
    oldText: diff.oldText != null ? diff.oldText.slice(0, DIFF_SIDE_CAP) : undefined,
    newText: diff.newText.slice(0, DIFF_SIDE_CAP),
  };
}

function spawnDetect(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Environment for spawned Claude instances — Buzz's model, arrived at
 * the hard way. Three modes:
 *
 * DEFAULT (shared): the user's own config and LOGIN, exactly like
 * running `claude` themselves (buzz-acp does the same — no second
 * session to create, no OAuth refresh race), plus
 * ENABLE_CLAUDEAI_MCP_SERVERS=false: the one leak that actually
 * mattered (claude.ai account connectors — Gmail, ditto, …) is killed
 * by env var alone, no config-dir isolation required (verified: 7
 * connectors → 0). Persona MCP servers arrive per ACP session as ever.
 *
 * FEZ_HARNESS_ISOLATE=1: the full clean room — fez-owned
 * CLAUDE_CONFIG_DIR, nothing global, its OWN login (one-time
 * `CLAUDE_CONFIG_DIR=~/.fez/harness/claude/shared claude /login`).
 * NEVER seed the user's token into it: refresh tokens rotate, and a
 * copied session races the user's real one until one of them dies —
 * that failure was observed live, mid-scenario.
 *
 * FEZ_HARNESS_INHERIT=1: raw environment, connectors and all.
 */
function isolatedClaudeEnv(): NodeJS.ProcessEnv {
  if (process.env.FEZ_HARNESS_INHERIT === "1") return process.env;
  if (process.env.FEZ_HARNESS_ISOLATE !== "1") {
    return { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
  }
  const dir = fezHome("harness", "claude", "shared");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const configFile = path.join(dir, ".claude.json");
    if (!fs.existsSync(configFile)) {
      const seed: Record<string, unknown> = {};
      try {
        const global = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf-8"));
        for (const key of ["oauthAccount", "hasCompletedOnboarding", "userID", "firstStartTime"]) {
          if (key in global) seed[key] = global[key];
        }
      } catch { /* no global config — fresh machine, claude will onboard */ }
      fs.writeFileSync(configFile, JSON.stringify(seed, null, 1), { mode: 0o600 });
    }
    // Config-dir isolation alone is NOT enough: MCP connectors attached to
    // the user's claude.ai ACCOUNT sync in with the login token itself
    // (measured: 7 "claude.ai <X>" servers appeared in a fresh dir the
    // moment auth was seeded). Disable account-connector sync for this
    // dir; persona-declared servers arrive via ACP session and stay live.
    const settingsFile = path.join(dir, "settings.json");
    if (!fs.existsSync(settingsFile)) {
      fs.writeFileSync(settingsFile, JSON.stringify({ disableClaudeAiConnectors: true }, null, 1), { mode: 0o600 });
    }
    // No token seeding — see the mode doc above.
  } catch {
    // Isolation is best-effort: a seeding failure falls back to inherited
    // config (the pre-isolation behavior) rather than a broken agent.
    return process.env;
  }
  // Belt and braces with settings.json's disableClaudeAiConnectors — the
  // env form covers a dir seeded before that setting existed.
  return { ...process.env, CLAUDE_CONFIG_DIR: dir, ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
}

/**
 * Generic ACP (Agent Client Protocol) harness — one implementation, any
 * engine with an ACP adapter binary (agentclientprotocol.com's whole
 * point). claude-code speaks it via @agentclientprotocol/claude-agent-acp
 * (same mechanism Buzz uses); pi speaks it via the community pi-acp
 * bridge (spawns `pi --mode rpc` underneath). New engines are a
 * descriptor here, not a protocol implementation.
 */
interface AcpDescriptor {
  id: string;
  aliases: string[];
  command: string;
  /** Environment for the spawned adapter — the engine-specific part. */
  env: () => NodeJS.ProcessEnv;
}

/**
 * Drive ONE prompt lifecycle on a live ACP session: fire the prompt,
 * consume updates (idle + hard timeouts, abort racing) until "stop",
 * return the accumulated text. Shared by one-shot invoke() and
 * persistent sessions — the loop is identical, only the session's
 * lifetime differs.
 */
/**
 * Consume what a dead turn is still producing.
 *
 * drivePrompt leaves its loop only on "stop". Every other exit — steer,
 * idle timeout, hard deadline — throws, and the prompt fired at the top
 * of it keeps running: the model finishes its answer and those updates
 * queue up. The next turn's loop then reads them first and accumulates
 * them into ITS text, so a reply arrives with the previous answer fused
 * onto the front, no separator. Drain to the dead turn's "stop" before
 * starting a new one.
 *
 * Bounded, because the abandoned turn may never stop (the harness itself
 * may be wedged, which is why we timed out). Giving up leaves the queue
 * dirty — but a bounded drain is strictly better than none, and the
 * session is recycled on the next hard failure anyway.
 */
export async function drainAbandonedTurn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ACP session updates are whatever the adapter sent; narrowing happens below.
  session: { nextUpdate(): Promise<any> },
  budgetMs = DRAIN_BUDGET_MS
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    let handle: ReturnType<typeof setTimeout>;
    const expiry = new Promise<"expired">((resolve) => {
      handle = setTimeout(() => resolve("expired"), deadline - Date.now());
    });
    try {
      const message = await Promise.race([session.nextUpdate(), expiry]);
      if (message === "expired") return;
      if (message.kind === "stop") return;
    } catch {
      return; // stream is done or broken; nothing left to inherit
    } finally {
      clearTimeout(handle!);
    }
  }
}

/** How long to wait for an abandoned turn to finish before giving up. */
const DRAIN_BUDGET_MS = 30_000;

async function drivePrompt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ACP session updates are whatever the adapter sent; narrowing happens below.
  session: { prompt(input: unknown): Promise<unknown>; nextUpdate(): Promise<any> },
  command: string,
  instruction: string,
  onProgress?: (textSoFar: string) => void,
  onUpdate?: (update: HarnessUpdate) => void,
  signal?: AbortSignal,
  timeouts: TimeoutOptions = ONE_SHOT_TIMEOUTS,
  images?: PromptImage[]
): Promise<string> {
  // With images, send an ACP content-block array (text first, then each
  // image block); the SDK passes it straight through. Without, a bare
  // string is the exact prior behavior. A model with no vision just ignores
  // the image blocks.
  const promptInput =
    images && images.length > 0
      ? [
          { type: "text", text: instruction },
          ...images.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType })),
        ]
      : instruction;
  // Fire the prompt; drive completion through nextUpdate() rather than
  // awaiting prompt() directly so each update can reset the idle timer.
  session.prompt(promptInput).catch(() => {});

  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      const err = new Error("turn aborted (steer)");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  abortPromise.catch(() => {});

  const { idleMs, maxMs } = timeouts;
  const hardDeadline = Date.now() + maxMs;
  let text = "";
  let thought = "";
  let lastProgressAt = 0;
  let lastThoughtAt = 0;
  let lastTextAt = 0;

  while (true) {
    const remaining = hardDeadline - Date.now();
    if (remaining <= 0) {
      throw new HarnessTimeoutError(`${command} hit the ${maxMs}ms hard deadline without finishing`);
    }

    let idleHandle: ReturnType<typeof setTimeout>;
    const idleTimeout = new Promise<never>((_, reject) => {
      idleHandle = setTimeout(
        () => reject(new HarnessTimeoutError(`${command} went silent for ${idleMs}ms mid-turn`)),
        Math.min(idleMs, remaining)
      );
    });

    let message;
    try {
      message = await Promise.race([session.nextUpdate(), idleTimeout, abortPromise]);
    } finally {
      clearTimeout(idleHandle!);
    }

    if (message.kind === "stop") {
      if (message.stopReason !== "end_turn") {
        notice(`${command} stopped with reason: ${message.stopReason}`);
      }
      break;
    }

    const { update } = message;
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      text += update.content.text;
      // Own timestamp — sharing lastProgressAt let frequent tool-call
      // ticks starve text frames.
      const now = Date.now();
      if (onUpdate && now - lastTextAt >= PROGRESS_THROTTLE_MS) {
        lastTextAt = now;
        onUpdate({ type: "text", text: scrubNoise(text) });
      }
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      thought += update.content.text;
      const now = Date.now();
      if (onUpdate && now - lastThoughtAt >= PROGRESS_THROTTLE_MS) {
        lastThoughtAt = now;
        onUpdate({ type: "thought", text: scrubNoise(thought) });
      }
    } else if (update.sessionUpdate === "tool_call") {
      onUpdate?.({
        type: "tool",
        callId: update.toolCallId,
        title: update.title,
        status: update.status ?? "pending",
        kind: update.kind ?? undefined,
        path: update.locations?.[0]?.path ?? undefined,
        diff: extractDiff(update.content),
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      onUpdate?.({
        type: "tool",
        callId: update.toolCallId,
        title: update.title ?? undefined,
        status: update.status ?? undefined,
        kind: update.kind ?? undefined,
        path: update.locations?.[0]?.path ?? undefined,
        diff: extractDiff(update.content),
      });
    } else if (update.sessionUpdate === "plan") {
      onUpdate?.({ type: "plan" });
    }

    // Usage sniffing: ACP doesn't standardize token counts, but several
    // adapters attach them to updates under obvious names. Forward what's
    // actually there — never estimate (Buzz's fail-closed usage rule).
    if (onUpdate) {
      const raw = (update as Record<string, unknown>).usage ?? (update as Record<string, unknown>).tokenUsage;
      if (raw && typeof raw === "object") {
        const u = raw as Record<string, unknown>;
        const num = (...keys: string[]) => {
          for (const key of keys) if (typeof u[key] === "number") return u[key] as number;
          return undefined;
        };
        const inputTokens = num("inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
        const outputTokens = num("outputTokens", "output_tokens", "completionTokens", "completion_tokens");
        const costUsd = num("costUsd", "cost_usd", "totalCostUsd", "total_cost_usd");
        if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) {
          onUpdate({ type: "usage", inputTokens, outputTokens, costUsd });
        }
      }
    }

    // Throttled, and fires on any update — even a tool-call-only stretch
    // should tell the caller "still alive."
    const now = Date.now();
    if (onProgress && now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
      lastProgressAt = now;
      onProgress(scrubNoise(text));
    }
  }

  // Final flush: text inside the last throttle window was never reported.
  const cleanText = scrubNoise(text);
  if (onProgress && cleanText) onProgress(cleanText);
  if (onUpdate && thought) onUpdate({ type: "thought", text: scrubNoise(thought) });
  if (onUpdate && cleanText) onUpdate({ type: "text", text: cleanText });

  return cleanText;
}

/**
 * Tool-call gate. The ACP layer used to auto-approve EVERY permission
 * request on the theory that the user invoked the harness from their own
 * terminal — false once an agent runs unattended in a channel. Every
 * request is now classified (command-risk.ts); a host can install a
 * policy that decides what to do with the dangerous ones.
 *
 * No policy installed = the old behavior (allow), because the TUI case
 * really is "the user is right here" — but a dangerous call is logged
 * loudly instead of passing silently.
 */
export type RiskPolicy = (
  verdict: RiskVerdict,
  toolCall: { title?: string; kind?: string; rawInput?: unknown }
) => Promise<"allow" | "deny">;

let riskPolicy: RiskPolicy | undefined;
export function setRiskPolicy(policy: RiskPolicy | undefined): void {
  riskPolicy = policy;
}

/** Shared by both permission handlers — one gate, one policy, one audit line. */
async function decidePermission(params: {
  options: readonly unknown[];
  toolCall?: { title?: string; kind?: string; rawInput?: unknown };
}): Promise<{ outcome: { outcome: "selected"; optionId: string } }> {
  const options = params.options as { optionId: string; kind?: string }[];
  // Select by KIND, not position — options[0] is not reliably an allow
  // (observed live: an agent's `fez mem set` got auto-DENIED because the
  // first option was a reject variant).
  const pick = (want: "allow" | "reject") =>
    options.find((o) => o.kind === `${want}_once`) ??
    options.find((o) => String(o.kind ?? "").startsWith(want)) ??
    (want === "allow" ? options[0] : undefined);

  const verdict = classifyToolCall(params.toolCall ?? {});
  if (verdict.level === "dangerous") {
    if (riskPolicy) {
      const decision = await riskPolicy(verdict, params.toolCall ?? {}).catch(() => "deny" as const);
      if (decision === "deny") {
        const reject = pick("reject");
        // No reject option offered? Fail closed by selecting nothing usable
        // is not possible here, so log and allow — but say so out loud.
        if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
        console.warn(`⚠️  risk policy denied "${verdict.reason}" but the harness offered no reject option`);
      }
    } else {
      console.warn(`⚠️  allowing DANGEROUS tool call (${verdict.reason}) — no risk policy installed`);
    }
  }
  return { outcome: { outcome: "selected", optionId: pick("allow")!.optionId } };
}

/**
 * Open a persistent ACP session: spawn the adapter once, build the
 * session, then PIN the connectWith scope open until close() — prompts
 * flow into the same conversation, so turn N remembers turns 1..N-1
 * (Buzz's per-channel session model; the cure for fresh-mind-per-turn).
 */
function openAcpSession(
  descriptor: AcpDescriptor,
  cwd: string,
  mcpServers?: McpServer[],
  timeouts: TimeoutOptions = SESSION_TIMEOUTS,
  systemPrompt?: string
): Promise<HarnessSession> {
  const { command } = descriptor;
  const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"], env: descriptor.env() });
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  return new Promise<HarnessSession>((resolveHandle, rejectHandle) => {
    let settled = false;
    let alive = true;
    let releaseScope!: () => void;
    const scopeHeld = new Promise<void>((r) => (releaseScope = r));

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    );
    const app = client({ name: "fez" });
    app.onRequest("session/request_permission", async ({ params }) => decidePermission(params as never));

    child.on("exit", () => {
      alive = false;
      releaseScope();
    });

    const run = app
      .connectWith(stream, async (ctx) => {
        // ACP's NewSessionRequest has no system-prompt field — cwd,
        // additionalDirectories, mcpServers, _meta, and nothing else. So
        // the standing prompt goes in _meta for any agent that reads it
        // (the spec's own extensibility hatch) and is ALSO prefixed onto
        // the first turn, because the spec says implementations must not
        // assume anything about _meta keys and most will ignore it.
        //
        // Belt and braces on purpose: an agent that honours _meta gets a
        // real frame, one that doesn't still gets the text. What neither
        // gets is a privilege boundary — see SystemPromptMode.
        // The object form takes a FULL NewSessionRequest, so mcpServers
        // must be present even when empty — omitting it left the SDK
        // iterating undefined and every session open failed with
        // "request.mcpServers is not iterable". The string form defaults
        // it; the object form does not.
        let builder = systemPrompt
          ? ctx.buildSession({ cwd, mcpServers: [], _meta: { "fez/systemPrompt": systemPrompt } } as never)
          : ctx.buildSession(cwd);
        for (const server of mcpServers ?? []) builder = builder.withMcpServer(server);
        const session = await builder.start();
        let pendingSystemPrompt = systemPrompt;
        // Set when a turn exits without its "stop" — the next prompt must
        // drain that turn's tail before it reads anything of its own.
        let dirty = false;

        const handle: HarnessSession = {
          get alive() {
            return alive;
          },
          async prompt(instruction, onProgress, onUpdate, signal) {
            if (!alive) throw new Error(`${command} session is closed`);
            try {
              const text = typeof instruction === "string" ? instruction : instruction.text;
              const images = typeof instruction === "string" ? undefined : instruction.images;
              // Prefix once, on the first turn only: the session is
              // persistent, so re-sending it every turn would be paying
              // for the same tokens forever to say the same thing.
              const framed = pendingSystemPrompt
                ? `${pendingSystemPrompt}\n\n---\n\n${text}`
                : text;
              pendingSystemPrompt = undefined;
              if (dirty) {
                dirty = false;
                await drainAbandonedTurn(session);
              }
              try {
                return await drivePrompt(session, command, framed, onProgress, onUpdate, signal, timeouts, images);
              } catch (err) {
                // Steer, timeout, deadline: the prompt is still running.
                dirty = true;
                throw err;
              }
            } catch (err) {
              // A failed prompt may leave the session mid-stream — the
              // caller decides whether to recycle; surface stderr context.
              if (err instanceof Error && stderrTail && !err.message.includes(stderrTail.slice(-40))) {
                err.message = `${err.message}${stderrTail ? ` (stderr: …${stderrTail.slice(-200)})` : ""}`;
              }
              throw err;
            }
          },
          async close() {
            alive = false;
            releaseScope();
            child.kill();
          },
        };
        settled = true;
        resolveHandle(handle);
        await scopeHeld; // hold the ACP scope open for the session's lifetime
      })
      .catch((err) => {
        alive = false;
        if (!settled) {
          settled = true;
          rejectHandle(
            new Error(`${command} session failed to open: ${err instanceof Error ? err.message : err}${stderrTail ? ` (stderr: …${stderrTail.slice(-200)})` : ""}`)
          );
        }
      })
      .finally(() => {
        alive = false;
        child.kill();
      });
    void run;
  });
}

function acpHarness(descriptor: AcpDescriptor): HarnessAdapter {
  const { command } = descriptor;

  return {
    id: descriptor.id,
    aliases: descriptor.aliases,
    command,
    detect: () => spawnDetect(command, ["--version"]),

    // ACP has no system-prompt field, so the honest declaration is
    // "meta": we put it where the spec allows and prefix it too, but
    // no agent is obliged to treat it as outranking the conversation.
    systemPromptMode: "meta" as const,
    openSession: (cwd, mcpServers, timeouts, systemPrompt) =>
      openAcpSession(descriptor, cwd, mcpServers, timeouts, systemPrompt),

    async invoke(instruction, cwd = process.cwd(), onProgress, mcpServers, onUpdate, signal) {
      const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"], env: descriptor.env() });

      // Without these, a write to a pipe whose reader already exited (e.g.
      // the process quitting mid-chain, with a persona subprocess still
      // running) emits an unhandled 'error' event and crashes the whole
      // Node process, not just this one call — this is what invoke() should
      // fail with, not what should take down the caller.
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});

      // Captured, not inherited: claude-agent-acp can print its own crash
      // trace to stderr when killed mid-write (e.g. we kill it on quit
      // while it's still mid-turn) — that's noise about the adapter's own
      // shutdown handling, not a Fez error, and inheriting it makes a
      // benign kill look like Fez crashed. Only surface it if invoke()
      // itself actually fails, as context for why.
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      try {
        const stream = ndJsonStream(
          Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
        );

        const app = client({ name: "fez" });

        // Classified, then gated by the host's risk policy (see
        // decidePermission) — an unattended agent no longer auto-approves
        // a destructive command just because the harness asked nicely.
        app.onRequest("session/request_permission", async ({ params }) => decidePermission(params as never));

        return await app.connectWith(stream, async (ctx) => {
          let builder = ctx.buildSession(cwd);
          for (const server of mcpServers ?? []) {
            builder = builder.withMcpServer(server);
          }
          const session = await builder.start();
          return await drivePrompt(session, command, instruction, onProgress, onUpdate, signal);
        });
      } finally {
        child.kill();
      }
    },
  };
}

const registry: HarnessAdapter[] = [];

/**
 * Add a harness to the registry. This is the one entry point — built-in
 * harnesses (registerBuiltinHarnesses, below) and user extensions
 * (extensions.ts) call the exact same function, so nothing built in is
 * privileged over anything a third party registers.
 */
export function registerHarness(adapter: HarnessAdapter): void {
  if (registry.some((h) => h.id === adapter.id)) {
    console.error(`⚠️  Harness "${adapter.id}" is already registered — skipping duplicate`);
    return;
  }
  registry.push(adapter);
}

/** Registers Fez's own built-in harnesses. Called once at startup, before extensions load. */
/**
 * Turn-error classification — Buzz's taxonomy (buzz-acp is_auth_error),
 * fez-shaped. "auth" is matched with high-precision patterns because the
 * costs are asymmetric: retrying an auth error is pure waste (the token
 * won't self-repair between attempts; it delays the visible failure),
 * while classifying a transient blip as fatal merely skips a retry.
 */
export type TurnErrorKind = "auth" | "aborted" | "transient" | "fatal";

export function classifyTurnError(err: unknown): TurnErrorKind {
  if (err instanceof Error && err.name === "AbortError") return "aborted";
  const message = err instanceof Error ? err.message : String(err);
  if (/Re-authenticate|API Error: 401|oauth|authenticat|logged in/i.test(message)) return "auth";
  if (/timed? ?out|went silent|hard deadline|ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|socket|network|overloaded|529|rate.?limit|exited (with|before)|empty reply/i.test(message)) {
    return "transient";
  }
  return "fatal";
}

/**
 * invoke() with bounded retries for TRANSIENT failures only — auth and
 * fatal errors surface immediately, aborts pass through untouched.
 * Native so every consumer (TUI local dispatch, fez-acp agents, future
 * runtimes) shares one retry policy instead of growing their own.
 */
export async function invokeWithRetry(
  harness: HarnessAdapter,
  instruction: string,
  cwd?: string,
  onProgress?: (textSoFar: string) => void,
  mcpServers?: McpServer[],
  onUpdate?: (update: HarnessUpdate) => void,
  signal?: AbortSignal,
  attempts = 3
): Promise<string> {
  let delayMs = 2_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await harness.invoke(instruction, cwd, onProgress, mcpServers, onUpdate, signal);
    } catch (err) {
      if (classifyTurnError(err) !== "transient" || attempt >= attempts) throw err;
      console.warn(
        `↻ transient harness error (attempt ${attempt}/${attempts}), retrying in ${Math.round(delayMs / 1000)}s: ${err instanceof Error ? err.message : err}`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (signal?.aborted) {
        const abort = new Error("aborted during retry backoff");
        abort.name = "AbortError";
        throw abort;
      }
      delayMs *= 2.5;
    }
  }
}

let builtinsRegistered = false;
/**
 * Prefer a fez-OWNED binary in ~/.fez/bin over the system PATH. This is
 * where fez already keeps its bundled executables (llama-server, the git
 * credential helper) and where the bundled agent lands: a fresh machine
 * with no `pi`/`pi-acp` on PATH still runs the Built-in agent because fez
 * ships its own. Falls back to the bare name (PATH) when nothing's bundled,
 * so a dev with pi installed globally is unaffected.
 */
function fezBin(name: string): string {
  const owned = fezHome("bin", name);
  return fs.existsSync(owned) ? owned : name;
}

export function registerBuiltinHarnesses(): void {
  // Idempotent — the wizard, doctor, TUI, and services may each call it.
  if (builtinsRegistered) return;
  builtinsRegistered = true;
  // claude-code: Anthropic account required; env shapes the clean-vs-shared
  // config story (see isolatedClaudeEnv). pi: the bring-anything engine —
  // subscription OAuth, API keys, or fully local models; its config is its
  // own (~/.pi/agent), so the environment passes through untouched.
  registerHarness(acpHarness({ id: "claude-code", aliases: ["claude"], command: "claude-agent-acp", env: isolatedClaudeEnv }));
  // pi speaks ACP via the pi-acp bridge, which shells to `pi --mode rpc`.
  // Both prefer fez's bundled copies so the Built-in agent works with zero
  // install; PI_ACP_PI_COMMAND points the bundled bridge at the bundled pi
  // (else it would look for `pi` on a PATH that may not have one).
  registerHarness(
    acpHarness({
      id: "pi",
      aliases: [],
      command: fezBin("pi-acp"),
      env: () => {
        const ownedPi = fezHome("bin", "pi");
        return fs.existsSync(ownedPi) ? { ...process.env, PI_ACP_PI_COMMAND: ownedPi } : process.env;
      },
    })
  );
}

export function findHarness(name: string): HarnessAdapter | undefined {
  const normalized = name.toLowerCase();
  return registry.find((h) => h.id === normalized || h.aliases.includes(normalized));
}

export function listHarnesses(): HarnessAdapter[] {
  return [...registry];
}

/** Detect all registered harnesses. Runs detection in parallel. */
export async function detectHarnesses(): Promise<HarnessAdapter[]> {
  const results = await Promise.all(
    registry.map(async (h) => ((await h.detect()) ? h : null))
  );
  return results.filter((h): h is HarnessAdapter => h !== null);
}
