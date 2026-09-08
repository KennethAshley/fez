/**
 * The waking window — the dead air Ken watched.
 *
 * "Start" returns as soon as the OS process launches, but everything
 * the GUI calls "the agent exists" (pubkey, face, online dot) arrives
 * later, when the agent's kind-47000 announcement comes back over the
 * relay. Between the two there was no feedback anywhere: the button
 * said done, the roster said nothing, then the agent popped in fully
 * formed. This module holds that in-between as a named state so the
 * profile row and the roster card can both show it.
 *
 * Module-level on purpose: the profile pane starts agents, the agents
 * page shows them, and neither owns the other. No timers here — the
 * components already re-render on their own ticks; they ask "how long
 * has this one been waking" and draw the answer.
 */

const waking = new Map<string, number>(); // persona name (lowercased) → started at, ms
const subs = new Set<() => void>();

/** After this long with no announcement, "waking" is honestly "stalled". */
export const WAKE_STALL_MS = 30_000;

export function markWaking(name: string, now = Date.now()): void {
  waking.set(name.toLowerCase(), now);
  for (const fn of subs) fn();
}

/** The agent announced (or died) — the window is over either way. */
export function clearWaking(name: string): void {
  if (waking.delete(name.toLowerCase())) for (const fn of subs) fn();
}

export function wakingSince(name: string): number | undefined {
  return waking.get(name.toLowerCase());
}

export function subscribeWaking(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/**
 * The words for the window, in one place — both surfaces must tell the
 * same story or the state reads as two different bugs.
 */
export function wakeLabel(name: string, now = Date.now()): { text: string; stalled: boolean } | undefined {
  const since = wakingSince(name);
  if (since === undefined) return undefined;
  const stalled = now - since > WAKE_STALL_MS;
  return stalled
    ? { text: "still waking — no announcement yet; check the relays", stalled: true }
    : { text: "waking — announcing to the relay…", stalled: false };
}
