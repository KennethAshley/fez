import type { MinerEntry } from "./state.js";

/**
 * A miner's timeline, in one line — turns a state diff into the reply
 * text the headless side posts into that miner's thread. Pure: the
 * caller supplies the previous snapshot (from `api.storage`) and today's
 * entry; this just decides what, if anything, is worth saying.
 *
 * Checked in the order a person would care about them: a fresh start or
 * stop is the loudest signal, then a reprovision (money moved), then a
 * new attention flag, then a plain exit while still meant to be running.
 * Only the FIRST match is returned — one line per tick, not a wall of
 * text when several things happened between polls.
 */
export function lifecycleMessage(prev: MinerEntry | undefined, next: MinerEntry): string | null {
  if (next.mode === "submission") {
    if (next.submissionError && next.submissionError !== prev?.submissionError) return `⚠ Submission status unavailable: ${next.submissionError}`;
    const s = next.submission;
    if (!s) return null;
    if (!prev?.submission || s.phase !== prev.submission.phase ||
        s.versions[0]?.id !== prev.submission.versions[0]?.id || s.activeVersionId !== prev.submission.activeVersionId) {
      return `Submission ${s.phase}: ${s.detail}`;
    }
    return null;
  }
  if (!prev) return next.desired === "running" ? "▶ started" : null;

  if (prev.desired !== "running" && next.desired === "running") return "▶ started";
  if (prev.desired === "running" && next.desired !== "running") return "■ stopped";

  const prevProvisions = prev.provisions?.length ?? 0;
  const nextProvisions = next.provisions?.length ?? 0;
  if (nextProvisions > prevProvisions) return "↻ reprovisioned — the pod was replaced";

  if (!prev.attention && next.attention) return `⚠ needs attention — ${next.attention}`;

  if (next.desired === "running" && next.lastExit && next.lastExit !== prev.lastExit) {
    return `✕ died — ${next.lastExit} — auto-restarting`;
  }

  return null;
}
