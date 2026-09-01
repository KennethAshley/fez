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
const ALL: Step[] = [...ORDER, "invite", "pairing", "restore", "reconnect"];

/** Guard for step names read back from persistence — a renamed or
 * removed step in a stale snapshot must fall back to the front door,
 * not crash the wizard into a step that no longer exists. */
export function isStep(s: unknown): s is Step {
  return typeof s === "string" && (ALL as string[]).includes(s);
}

export function nextStep(s: Step): Step {
  const i = ORDER.indexOf(s);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : s;
}

export function prevStep(s: Step): Step {
  const i = ORDER.indexOf(s);
  return i > 0 ? ORDER[i - 1] : s;
}

/**
 * What "get started" should do about identity. set_identity REFUSES to
 * overwrite (an existing identity is never silently replaced from the
 * GUI), so the button must be safe to click twice: backing out of the
 * harness step and starting again used to mint a second key, collide
 * with the first, and error the wizard's main path into a dead end.
 * Keep what the wizard already holds; adopt what the keychain holds;
 * mint only when there is truly nothing.
 */
export function identityPlan(
  held: string | undefined,
  stored: string | undefined
): { action: "keep" } | { action: "adopt"; hex: string } | { action: "mint" } {
  if (held) return { action: "keep" };
  const hex = stored?.trim().toLowerCase();
  if (hex && /^[0-9a-f]{64}$/.test(hex)) return { action: "adopt", hex };
  return { action: "mint" };
}
