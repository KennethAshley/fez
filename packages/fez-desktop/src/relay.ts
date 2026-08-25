/**
 * The ONE home of the relay default (see git history for the
 * four-disagreeing-literals era). The default is now the LOCAL workspace
 * relay the app spawns and claims for a fresh identity
 * (ensure_local_relay, Rust side) — a cold downloader lands in a
 * workspace they own, not on someone's hosted box where they aren't on
 * the roster and @fez ignores them. Existing installs are unaffected:
 * onboarding always wrote localStorage["fez-relay"], which outranks
 * this. Developers override with VITE_FEZ_RELAY.
 */
export const DEFAULT_RELAY = "ws://127.0.0.1:7777";

/**
 * Device pairing needs a relay BOTH machines can reach — a loopback
 * default cannot rendezvous. Pairing-only; never a workspace default.
 */
export const PAIRING_RELAY = "wss://67-205-188-204.sslip.io";

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
