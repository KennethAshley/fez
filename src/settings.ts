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
  /** Relay URL used when neither -r nor FEZ_RELAY is set. */
  relay?: string;
  /** Set once the first-run wizard has completed. */
  onboarded?: boolean;
  /**
   * Extensions allowed to run scheduled tasks inside the sentinel —
   * written by install/link when a package declares fez.parts.background.
   * An allowlist rather than "load everything": a TUI extension loaded
   * into the always-on process would do its foreground job twice.
   */
  backgroundExtensions?: string[];
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

export const DEFAULT_RELAY = "wss://relay.damus.io";

/** The relay for this invocation: explicit value > FEZ_RELAY > settings > default. */
export function resolveRelay(explicit?: string): string {
  return explicit || process.env.FEZ_RELAY || loadSettings().relay || DEFAULT_RELAY;
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
