import type { HarnessAdapter, HarnessUpdate } from "@fezchat/protocol";

export interface HireUsage { costUsd: number; inputTokens: number; outputTokens: number; complete: boolean }

/** One paid attempt: retries can spend again after an uncertain provider failure. */
export async function runMeteredHire(opts: {
  harness: Pick<HarnessAdapter, "invoke" | "supportsCostMetering">;
  prompt: string;
  cwd: string;
  maxCostUsd: number;
  onProgress?: (text: string) => void;
  onUsage: (usage: HireUsage) => void;
}): Promise<string> {
  if (!Number.isFinite(opts.maxCostUsd) || opts.maxCostUsd <= 0) throw new Error("A positive hire budget is required");
  if (!opts.harness.supportsCostMetering) {
    opts.onUsage({ costUsd: 0, inputTokens: 0, outputTokens: 0, complete: true });
    throw new Error("Harness does not support metered hires");
  }
  const abort = new AbortController();
  let ready = false;
  let complete = false;
  let spent = 0;
  const update = (u: HarnessUpdate) => {
    if (u.type !== "usage") return;
    if (u.metering === "ready") { ready = true; return; }
    if (u.metering === "unavailable" || !ready) {
      if (!ready) opts.onUsage({ costUsd: 0, inputTokens: 0, outputTokens: 0, complete: true });
      throw new Error("Engine does not support metered hires");
    }
    if (![u.costUsd, u.inputTokens, u.outputTokens].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
      || u.costUsd! < spent) throw new Error("Engine cost meter failed");
    spent = u.costUsd!;
    complete = u.metering === "complete";
    opts.onUsage({ costUsd: spent, inputTokens: u.inputTokens!, outputTokens: u.outputTokens!, complete });
    // Provider usage arrives after a request. Cancellation prevents continued
    // work, but cannot undo the cost of an already in-flight request.
    if (spent >= opts.maxCostUsd) abort.abort();
  };
  const result = await opts.harness.invoke(opts.prompt, opts.cwd, opts.onProgress, undefined, update, abort.signal);
  if (!ready || !complete) throw new Error("Engine did not finish reporting its cost meter");
  if (abort.signal.aborted) throw new Error("Hire spending limit reached");
  return result;
}
