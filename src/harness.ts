import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, type McpServer } from "@agentclientprotocol/sdk";
import { notice } from "./notices.js";

/**
 * One activity event from a running harness turn — the raw material of the
 * observer stream (Buzz's two-audience model: reply text is channel-
 * visible; thoughts/tools are owner-only). text/thought carry ACCUMULATED
 * text (coalesced like onProgress); tool/plan events are discrete.
 */
export interface HarnessUpdate {
  type: "text" | "thought" | "tool" | "plan";
  /** Accumulated text so far (text/thought types). */
  text?: string;
  /** Tool call title (tool type). */
  title?: string;
  /** Tool call status (tool type, from tool_call_update). */
  status?: string;
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
  detect(): Promise<boolean>;
  /**
   * onProgress fires (throttled) with the accumulated text so far, before the call resolves.
   * mcpServers are the persona's resolved skills (see mcp-servers.ts) — a
   * harness that isn't ACP-based (or doesn't support MCP) is free to ignore
   * this; it's additive, not a required capability.
   * onUpdate fires with richer activity (thoughts, tool calls, plans) for
   * observer streams — also optional and additive.
   */
  invoke(
    instruction: string,
    cwd?: string,
    onProgress?: (textSoFar: string) => void,
    mcpServers?: McpServer[],
    onUpdate?: (update: HarnessUpdate) => void
  ): Promise<string>;
}

/**
 * Minimum gap between onProgress calls. Low enough that streaming a reply
 * into a live bubble reads as typing (pi-style); it gates a local render,
 * not network traffic.
 */
const PROGRESS_THROTTLE_MS = 150;

export interface TimeoutOptions {
  /** Abort if no session/update arrives for this long — the agent has gone silent. */
  idleMs: number;
  /** Abort after this long total, even if updates keep arriving. */
  maxMs: number;
}

const DEFAULT_TIMEOUTS: TimeoutOptions = { idleMs: 30_000, maxMs: 5 * 60_000 };

class HarnessTimeoutError extends Error {}

function spawnDetect(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Claude Code, spoken to over ACP (Agent Client Protocol) rather than
 * shelling out to `claude -p` — same mechanism Buzz uses. Requires the
 * separate `@agentclientprotocol/claude-agent-acp` adapter to be installed;
 * having the `claude` CLI itself is not sufficient.
 */
function claudeCodeHarness(): HarnessAdapter {
  const command = "claude-agent-acp";

  return {
    id: "claude-code",
    aliases: ["claude"],
    command,
    detect: () => spawnDetect(command, ["--version"]),

    async invoke(instruction, cwd = process.cwd(), onProgress, mcpServers, onUpdate) {
      const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });

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

        // Auto-approve tool-call permission requests. The user explicitly
        // invoked this from their own terminal (same trust level as running
        // `claude` interactively themselves) — but this is a real policy
        // choice, not a neutral default. Revisit before this is anything
        // other than a local single-user MVP.
        app.onRequest("session/request_permission", async ({ params }) => {
          const first = params.options[0];
          return { outcome: { outcome: "selected" as const, optionId: first.optionId } };
        });

        return await app.connectWith(stream, async (ctx) => {
          let builder = ctx.buildSession(cwd);
          for (const server of mcpServers ?? []) {
            builder = builder.withMcpServer(server);
          }
          const session = await builder.start();

          // Fire the prompt; drive completion through nextUpdate() rather than
          // awaiting prompt() directly so each update can reset the idle timer.
          // Unhandled here on purpose — completion surfaces as a "stop" message
          // from nextUpdate(), which is what the loop below actually waits on.
          session.prompt(instruction).catch(() => {});

          const { idleMs, maxMs } = DEFAULT_TIMEOUTS;
          const hardDeadline = Date.now() + maxMs;
          let text = "";
          let thought = "";
          let lastProgressAt = 0;
          let lastThoughtAt = 0;

          while (true) {
            const remaining = hardDeadline - Date.now();
            if (remaining <= 0) {
              throw new HarnessTimeoutError(
                `${command} hit the ${maxMs}ms hard deadline without finishing`
              );
            }

            let idleHandle: ReturnType<typeof setTimeout>;
            const idleTimeout = new Promise<never>((_, reject) => {
              idleHandle = setTimeout(
                () =>
                  reject(
                    new HarnessTimeoutError(
                      `${command} went silent for ${idleMs}ms mid-turn`
                    )
                  ),
                Math.min(idleMs, remaining)
              );
            });

            let message;
            try {
              message = await Promise.race([session.nextUpdate(), idleTimeout]);
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
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              update.content.type === "text"
            ) {
              text += update.content.text;
              const now = Date.now();
              if (onUpdate && now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
                onUpdate({ type: "text", text });
              }
            } else if (
              update.sessionUpdate === "agent_thought_chunk" &&
              update.content.type === "text"
            ) {
              thought += update.content.text;
              const now = Date.now();
              if (onUpdate && now - lastThoughtAt >= PROGRESS_THROTTLE_MS) {
                lastThoughtAt = now;
                onUpdate({ type: "thought", text: thought });
              }
            } else if (update.sessionUpdate === "tool_call") {
              onUpdate?.({ type: "tool", title: update.title, status: update.status ?? "started" });
            } else if (update.sessionUpdate === "tool_call_update") {
              onUpdate?.({
                type: "tool",
                title: update.title ?? undefined,
                status: update.status ?? undefined,
              });
            } else if (update.sessionUpdate === "plan") {
              onUpdate?.({ type: "plan" });
            }

            // Throttled, and fires on any update (not just text chunks) —
            // even a tool-call-only stretch should tell the caller "still
            // alive," not just go silent until the next text token.
            const now = Date.now();
            if (onProgress && now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
              lastProgressAt = now;
              onProgress(text);
            }
          }

          // Final flush: text that arrived inside the last throttle window
          // was never reported — a short reply could otherwise complete
          // with zero onProgress calls (bit for real: relay draft streaming
          // saw nothing for one-chunk replies).
          if (onProgress && text) onProgress(text);
          if (onUpdate && thought) onUpdate({ type: "thought", text: thought });
          if (onUpdate && text) onUpdate({ type: "text", text });

          return text;
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
export function registerBuiltinHarnesses(): void {
  registerHarness(claudeCodeHarness());
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
