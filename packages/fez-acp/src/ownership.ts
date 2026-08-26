/**
 * Single ownership of a persona — the presence heartbeat as the lock.
 * See docs/superpowers/specs/2026-08-26-agent-single-ownership-design.md.
 *
 * Pure protocol here; agent.ts supplies the relay-flavored IO. Beats
 * without an `instance` come from binaries predating the guard and are
 * invisible to it (decide: ignore) — they can't be reasoned about, and
 * yielding to a ghost would strand the persona.
 */

export interface PresenceBeat {
  instance?: string;
  phase?: "claim" | "steady";
  supersede?: boolean;
}

export type Verdict = "ignore" | "yield" | "defend" | "shutdown";

export function decide(
  mine: { nonce: string; phase: "claiming" | "steady"; takeOver: boolean },
  seen: PresenceBeat
): Verdict {
  if (!seen.instance || seen.instance === mine.nonce) return "ignore";
  // A supersede outranks phases: someone is explicitly taking this
  // persona over. Two superseders settle by nonce so exactly one lives.
  if (seen.supersede) {
    if (mine.takeOver && mine.nonce < seen.instance) return mine.phase === "steady" ? "defend" : "ignore";
    return mine.phase === "claiming" ? "yield" : "shutdown";
  }
  if (mine.phase === "claiming") {
    if (mine.takeOver) return "ignore"; // we supersede; nothing to yield to
    if (seen.phase === "steady") return "yield"; // live incumbent
    return mine.nonce < seen.instance ? "ignore" : "yield"; // claim vs claim
  }
  // steady:
  if (seen.phase === "claim") return "defend";
  return mine.nonce < seen.instance ? "defend" : "shutdown"; // split-brain
}

/**
 * A take-over is a transition, not a trait. Immunity to foreign supersedes
 * lasts exactly as long as the move itself — while supersede-carrying beats
 * remain to be sent. Once they are spent the instance is an ordinary
 * incumbent, so a LATER `--take-over` can move the persona again; sticky
 * immunity made the second move fail (old instance defended on nonce, new
 * one announced and then died to the incumbent's next plain beat).
 */
export function takeOverActive(takeOver: boolean, supersedeBeatsLeft: number): boolean {
  return takeOver && supersedeBeatsLeft > 0;
}

/** How long after entering steady a nonce-tie shutdown is forgiven. */
export const STEADY_GRACE_MS = 10_000;

/**
 * Dual-death guard: a just-superseded incumbent keeps beating for a moment
 * while it shuts down, and those plain steady beats can lose the winner the
 * steady/steady nonce tie — leaving nobody. For a short window after
 * entering steady, such a shutdown is ignored. An explicit supersede is
 * never graced: that is a human deliberately moving the persona.
 */
export function shutdownGraced(seen: PresenceBeat, msSinceSteady: number, graceMs = STEADY_GRACE_MS): boolean {
  return !seen.supersede && msSinceSteady < graceMs;
}

export interface OwnershipIO {
  publishBeat(extra: { phase: "claim" | "steady"; supersede?: boolean }): void;
  /** Beats from OTHER processes on this persona's key. Returns unsubscribe. */
  onBeat(cb: (beat: PresenceBeat) => void): () => void;
  sleep(ms: number): Promise<void>;
}

/** The boot gate: claim, listen one window, proceed or yield. */
export async function claimOwnership(
  io: OwnershipIO,
  opts: { nonce: string; takeOver: boolean; windowMs?: number }
): Promise<"proceed" | "yield"> {
  let verdict: "proceed" | "yield" = "proceed";
  const off = io.onBeat((beat) => {
    const v = decide({ nonce: opts.nonce, phase: "claiming", takeOver: opts.takeOver }, beat);
    if (v === "yield") verdict = "yield";
  });
  await Promise.resolve(); // Defer publish so all listeners register first
  io.publishBeat({ phase: "claim", ...(opts.takeOver ? { supersede: true } : {}) });
  await io.sleep(opts.windowMs ?? 5_000);
  off();
  return verdict;
}
