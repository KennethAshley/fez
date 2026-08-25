import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * User preferences — ~/.fez/settings.json. Small and flat on purpose:
 * domain config stays in its own files (personas/*.md, workflows/*.yaml,
 * themes/*.json); this is only for preferences a person would otherwise
 * carry in shell exports. A GUI reads the same file.
 *
 * Precedence everywhere a setting applies:
 *   explicit flag  >  env var  >  settings.json  >  built-in default
 * The relay is the motivating case: it previously lived ONLY in
 * FEZ_RELAY, so a bare `fez` on a machine without the export silently
 * talked to a public relay.
 */

export interface FezSettings {
  /**
   * Legacy single relay. Still honoured — it's what every existing
   * install has — but `relays` is the real setting now.
   */
  relay?: string;
  /**
   * The relay set. Publishes fan out to all of them, reads are the
   * union: no single operator, including whoever runs the default, can
   * take your channels away or lose them for you. One entry behaves
   * exactly like the old single relay.
   */
  relays?: string[];
  /** Set once the first-run wizard has completed. */
  onboarded?: boolean;
  /**
   * Extensions allowed to run scheduled tasks inside the sentinel —
   * written by install/link when a package declares fez.parts.background.
   * An allowlist rather than "load everything": a TUI extension loaded
   * into the always-on process would do its foreground job twice.
   */
  backgroundExtensions?: string[];
  /**
   * What each extension was granted at install time, by name. The host
   * narrows the API to this list — an undeclared capability is absent,
   * not merely discouraged. Missing entry = the legacy read-only grant.
   */
  extensionPermissions?: Record<string, string[]>;
}

const SETTINGS_FILE = path.join(os.homedir(), ".fez", "settings.json");

export function loadSettings(): FezSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as FezSettings) : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch: Partial<FezSettings>): FezSettings {
  const merged = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 1) + "\n", { mode: 0o600 });
  return merged;
}

/**
 * Where a fresh install lands.
 *
 * This used to be a public nostr relay run by strangers, which meant a
 * default install published its channel messages — plaintext, since only
 * DMs are encrypted — to somebody else's box, with none of fez's
 * membership gating, because that gate is a fez-relay policy a generic
 * relay has never heard of. Unlisted is not private.
 *
 * A fez relay is not a requirement — any nostr relay carries the events —
 * but it is what makes the security model true, so it is what we default
 * to. `fez relay add/remove` changes it; running your own is a `docker
 * run` (deploy/Dockerfile).
 */
export const DEFAULT_RELAY = "wss://67-205-188-204.sslip.io";

/**
 * The hosted routing endpoint a fresh install points @fez at.
 *
 * Routing needs a small model, and a new machine has neither the model
 * nor a server for it. An orchestrator that quietly answers nothing is
 * worse than no orchestrator, so out of the box @fez borrows this one.
 *
 * It is a STARTER, not the architecture. Measured: hosted routes take
 * ~3.2s (12.5 tok/s generation on a 2-vCPU box) against ~90ms for the
 * same model on a laptop, and the box serves one request at a time —
 * so it does not scale, by construction. `fez router-install` moves
 * routing onto the user's own machine and rewrites the persona's one
 * `url:` line, which is the whole switch.
 */
export const HOSTED_ROUTER = "https://137-184-135-188.sslip.io/v1";

/**
 * The relay SET for this invocation, in precedence order:
 *   explicit flag > FEZ_RELAY > settings.relays > settings.relay > default
 *
 * Every source accepts a comma-separated list, so `-r a,b` and
 * `FEZ_RELAY=a,b` work without a second flag. Precedence replaces rather
 * than merges: someone passing -r is naming the relays they want, and
 * quietly adding their configured ones back is how you publish to a
 * relay you were deliberately avoiding.
 */
export function resolveRelays(explicit?: string | string[]): string[] {
  const split = (value: string) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  const fromExplicit = Array.isArray(explicit) ? explicit.filter(Boolean) : explicit ? split(explicit) : [];
  if (fromExplicit.length) return fromExplicit;
  if (process.env.FEZ_RELAY) {
    const fromEnv = split(process.env.FEZ_RELAY);
    if (fromEnv.length) return fromEnv;
  }
  const settings = loadSettings();
  const configured = (settings.relays ?? []).filter(Boolean);
  if (configured.length) return configured;
  return [settings.relay || DEFAULT_RELAY];
}

/**
 * The FIRST relay of the set — for the places that genuinely mean one:
 * a pairing QR that names where to meet, a line of status output, an
 * env var handed to a child process that hasn't been taught the list.
 */
export function resolveRelay(explicit?: string): string {
  return resolveRelays(explicit)[0];
}

/**
 * The global install counter is COMPANY-tier infrastructure — the fez
 * company's cross-relay index over signed 40201 receipts (npmjs.com to
 * fez's npm), distinct from any relay operator's storage. Until that
 * endpoint exists the default is empty: clients count from relay
 * receipts alone. The service is ready in infra/skill-counts/ — when
 * deployed, its URL becomes this default. settings.skillCountsUrl
 * overrides either way.
 */
export const DEFAULT_SKILL_COUNTS_URL = "https://fez-web-kohl.vercel.app/api/counts"; // company endpoint (re-points when the real domain lands)

export function resolveSkillCountsUrl(): string {
  const settings = loadSettings() as { skillCountsUrl?: string };
  return settings.skillCountsUrl ?? DEFAULT_SKILL_COUNTS_URL;
}
