/**
 * The ONE home of the relay default. Four files used to carry their own
 * literal, and they disagreed: onboarding handed new users the hosted
 * relay while boot's fallback was `ws://localhost:7777` — so any path
 * that reached boot without localStorage (identity from the CLI, cleared
 * webview data) connected to a relay that exists only on a developer's
 * machine and sat on "reconnecting…" forever.
 *
 * The default is the hosted relay — mirrors src/settings.ts; the desktop
 * bundle deliberately doesn't depend on the CLI package. A generic public
 * relay carries the events but enforces none of fez's membership gating,
 * so channel content there is unlisted rather than private. Developers
 * point at a local relay with VITE_FEZ_RELAY=ws://localhost:7777.
 */
export const DEFAULT_RELAY = "wss://67-205-188-204.sslip.io";

/**
 * The relay set as its raw comma-separated string — env override, then
 * what the user saved, then the default. Stored under the single-relay
 * key so an existing install keeps working and adding a second relay is
 * editing one string rather than a migration.
 */
export function relayRaw(): string {
  return (
    (import.meta as { env?: Record<string, string> }).env?.VITE_FEZ_RELAY ??
    localStorage.getItem("fez-relay") ??
    DEFAULT_RELAY
  );
}

/** The relay set, split and cleaned. Never empty. */
export function relaySet(): string[] {
  const urls = relayRaw().split(",").map((u) => u.trim()).filter(Boolean);
  return urls.length ? urls : [DEFAULT_RELAY];
}
