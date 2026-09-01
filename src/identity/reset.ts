import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Factory reset — the ONE definition of what "fez's local state" is.
 *
 * Wiping by hand means remembering four places (keychain, ~/.fez, and
 * the desktop webview's two storage dirs) and the hand-rolled list goes
 * stale the first time state grows a new home. The plan function is the
 * list; the CLI and the desktop's Rust `factory_reset` both mirror it
 * (keep the Rust twin in step — it can't import this).
 *
 * The keychain sweep deletes EVERY account under fez's services, not
 * just the names index: agents hold their own keys ("agent:<name>"),
 * and an index that survived partial state loss can't be trusted to
 * name them all.
 */
export interface FactoryResetPlan {
  /** Directories removed outright. */
  dirs: string[];
  /** Keychain services swept clean — every account. macOS only. */
  keychainServices: string[];
}

export function factoryResetPlan(opts: { home?: string; platform?: NodeJS.Platform } = {}): FactoryResetPlan {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const dirs = [path.join(home, ".fez")];
  const keychainServices: string[] = [];
  if (platform === "darwin") {
    // The desktop webview's storage — the onboarding stamp/snapshot,
    // remembered relay set and display name live in localStorage, which
    // WebKit keeps under these two dirs, not under ~/.fez.
    dirs.push(
      path.join(home, "Library", "WebKit", "com.fez.desktop"),
      path.join(home, "Library", "Caches", "com.fez.desktop")
    );
    // "fez-keys" is identity (yours and your agents'); "fez-skill-env"
    // is skill secrets the desktop stored. Both are fez's to delete.
    keychainServices.push("fez-keys", "fez-skill-env");
  }
  return { dirs, keychainServices };
}

/**
 * Processes that would race the wipe by re-writing state on exit — the
 * desktop app and anything fez spawned out of ~/.fez. Returns matching
 * pattern descriptions (empty = safe to reset).
 */
export function fezProcessesRunning(home: string = os.homedir()): string[] {
  const patterns: [string, string][] = [
    ["fez.app/Contents/MacOS", "the fez desktop app"],
    [path.join(home, ".fez", "bin"), "a fez-spawned agent or relay"],
  ];
  const running: string[] = [];
  for (const [pattern, label] of patterns) {
    const r = spawnSync("pgrep", ["-f", pattern], { stdio: "ignore" });
    if (r.status === 0) running.push(label);
  }
  return running;
}

/**
 * Executes the plan. Irreversible — a deleted key cannot be reissued.
 * The CALLER owns confirmation; nothing here asks.
 */
export function executeFactoryReset(plan: FactoryResetPlan): { removed: string[]; keysDeleted: number } {
  let keysDeleted = 0;
  for (const service of plan.keychainServices) {
    // Loop until the service is empty: `security` deletes one match per
    // call and there is one entry per account.
    for (;;) {
      const r = spawnSync("security", ["delete-generic-password", "-s", service], { stdio: "ignore" });
      if (r.status !== 0) break;
      keysDeleted++;
    }
  }
  const removed: string[] = [];
  for (const dir of plan.dirs) {
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return { removed, keysDeleted };
}
