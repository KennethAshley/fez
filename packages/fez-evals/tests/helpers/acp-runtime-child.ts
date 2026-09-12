import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

// Isolate every core home lookup before importing it, including module constants.
if (!process.env.FEZ_TEST_HOME || process.env.FEZ_KEYSTORE !== "file") throw new Error("isolated test home required");
os.homedir = () => process.env.FEZ_TEST_HOME!;
syncBuiltinESMExports();

// Drive selected real runtime timers without waiting minutes or changing production clocks.
const intervals = new Map<ReturnType<typeof setInterval>, { ms: number; tick: () => void }>();
if (process.env.FEZ_TEST_MANUAL_INTERVAL) {
  const nativeInterval = globalThis.setInterval;
  const nativeClear = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    if (!process.env.FEZ_TEST_MANUAL_INTERVAL!.split(",").map(Number).includes(args[1]!)) return nativeInterval(...args);
    const timer = nativeInterval(() => {}, 2 ** 31 - 1);
    intervals.set(timer, { ms: args[1]!, tick: () => args[0](...args.slice(2)) });
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = (timer => {
    intervals.delete(timer as ReturnType<typeof setInterval>);
    nativeClear(timer);
  }) as typeof clearInterval;
}

const { registerHarness } = await import("../../../../src/index.js");
let nextSession = 0;
let nextPrompt = 0;
const pending = new Map<number, (reply: string, error?: string, costUsd?: number, partialText?: string) => void>();
process.on("message", (message: { id: number; reply?: string; error?: string; costUsd?: number; partialText?: string; tick?: boolean; intervalMs?: number }) => {
  if (message.tick) {
    for (const interval of intervals.values()) if (interval.ms === message.intervalMs) interval.tick();
    process.send?.({ type: "ticked" });
  } else pending.get(message.id)?.(message.reply ?? "fixture reply", message.error, message.costUsd, message.partialText);
});
registerHarness({
  id: "test-harness", aliases: [], command: "unused", detect: async () => true,
  invoke: async () => { throw new Error("expected a persistent session"); },
  openSession: async () => {
    const session = ++nextSession;
    let alive = true;
    return {
      get alive() { return alive; },
      close: async () => { alive = false; },
      prompt: async (instruction, _progress, onUpdate, signal) => {
        const id = ++nextPrompt;
        return new Promise<string>((resolve, reject) => {
          const aborted = () => process.send?.({ type: "aborted", id });
          signal?.addEventListener("abort", aborted, { once: true });
          pending.set(id, (reply, error, costUsd, partialText) => {
            pending.delete(id);
            signal?.removeEventListener("abort", aborted);
            if (costUsd !== undefined) onUpdate?.({ type: "usage", costUsd });
            if (partialText !== undefined) onUpdate?.({ type: "text", text: partialText });
            // The parent controls when cancellation finishes, to exercise cancel/steer races.
            if (signal?.aborted) reject(new DOMException("cancelled", "AbortError"));
            else if (error) reject(new Error(error));
            else resolve(reply);
          });
          process.send?.({ type: "prompt", id, session, instruction });
        });
      },
    };
  },
});
await (await import("../../../fez-acp/src/agent.js")).agentStarted;
process.send?.({ type: "ready" });
