import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

// Isolate every core home lookup before importing it, including module constants.
if (!process.env.FEZ_TEST_HOME || process.env.FEZ_KEYSTORE !== "file") throw new Error("isolated test home required");
os.homedir = () => process.env.FEZ_TEST_HOME!;
syncBuiltinESMExports();

const { registerHarness } = await import("../../../../src/index.js");
let nextSession = 0;
let nextPrompt = 0;
const pending = new Map<number, (reply: string, error?: string) => void>();
process.on("message", (message: { id: number; reply?: string; error?: string }) => {
  pending.get(message.id)?.(message.reply ?? "fixture reply", message.error);
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
      prompt: async (instruction, _progress, _update, signal) => {
        const id = ++nextPrompt;
        return new Promise<string>((resolve, reject) => {
          const aborted = () => process.send?.({ type: "aborted", id });
          signal?.addEventListener("abort", aborted, { once: true });
          pending.set(id, (reply, error) => {
            pending.delete(id);
            signal?.removeEventListener("abort", aborted);
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
await import("../../../fez-acp/src/agent.js");
const ready = setInterval(() => {
  if (process.listenerCount("SIGINT")) {
    clearInterval(ready);
    process.send?.({ type: "ready" });
  }
}, 10);
