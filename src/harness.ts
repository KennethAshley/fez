import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

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
  invoke(instruction: string, cwd?: string): Promise<string>;
}

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

    async invoke(instruction, cwd = process.cwd()) {
      const child = spawn(command, [], { stdio: ["pipe", "pipe", "inherit"] });

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
          const session = await ctx.buildSession(cwd).start();

          // Fire the prompt; drive completion through nextUpdate() rather than
          // awaiting prompt() directly so each update can reset the idle timer.
          // Unhandled here on purpose — completion surfaces as a "stop" message
          // from nextUpdate(), which is what the loop below actually waits on.
          session.prompt(instruction).catch(() => {});

          const { idleMs, maxMs } = DEFAULT_TIMEOUTS;
          const hardDeadline = Date.now() + maxMs;
          let text = "";

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
                console.error(`${command} stopped with reason: ${message.stopReason}`);
              }
              break;
            }

            const { update } = message;
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              update.content.type === "text"
            ) {
              text += update.content.text;
            }
          }

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
