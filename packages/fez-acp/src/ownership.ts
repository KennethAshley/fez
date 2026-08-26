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
