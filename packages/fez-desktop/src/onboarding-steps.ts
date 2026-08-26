/**
 * The onboarding wizard's step machine, standalone: no React, no Tauri,
 * no CSS — so evals can import it directly instead of pulling in
 * Onboarding.tsx's whole dependency graph.
 *
 * Side doors (invite/pairing/restore/reconnect) aren't in the main
 * ORDER — they're detours off "welcome" that rejoin the main flow at
 * "harness" (via ReconnectStep). Buzz's flow ends at "team"; there is
 * no separate "done" step — TeamStep is the last screen.
 */
export type Step =
  | "welcome"
  | "invite"
  | "pairing"
  | "restore"
  | "reconnect"
  | "harness"
  | "defaults"
  | "community"
  | "profile"
  | "team";

const ORDER: Step[] = ["welcome", "harness", "defaults", "community", "profile", "team"];

export function nextStep(s: Step): Step {
  const i = ORDER.indexOf(s);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : s;
}

export function prevStep(s: Step): Step {
  const i = ORDER.indexOf(s);
  return i > 0 ? ORDER[i - 1] : s;
}
