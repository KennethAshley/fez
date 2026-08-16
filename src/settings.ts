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
