import fs from "fs/promises";
import path from "path";
import os from "os";
import { pathToFileURL } from "url";
import { registerHarness, type HarnessAdapter } from "./harness.js";
import { setStatus } from "./status.js";

/**
 * API surface handed to extension files. Deliberately small — grows as
 * Fez grows, one method at a time (pi's ExtensionAPI has ~10x this after
 * years of use; starting minimal beats guessing at surface nobody needs yet).
 *
 * `ui.setStatus` is the rendering surface third-party extensions plug
 * into — same shape as pi's `ctx.ui.setStatus(key, value)`, which is how
 * extensions like pi-powerline-footer publish segments into a persistent
 * status bar without needing to know anything about terminal rendering
 * themselves. Fez's version renders into fez-tui's Footer.
 */
export interface FezExtensionAPI {
  registerHarness(adapter: HarnessAdapter): void;
  ui: {
    setStatus(key: string, value: string): void;
  };
}

export type FezExtension = (api: FezExtensionAPI) => void | Promise<void>;

const api: FezExtensionAPI = { registerHarness, ui: { setStatus } };

const EXTENSIONS_DIR = path.join(os.homedir(), ".fez", "extensions");

/**
 * Loads every extension in `dir` (default `~/.fez/extensions/`), the same
 * discovery pattern pi uses for `~/.pi/agent/extensions/`. Each file's
 * default export is called with the live FezExtensionAPI.
 *
 * .js/.mjs files always load. .ts files only load when the current process
 * has a TypeScript loader already active (e.g. running via `tsx`) — plain
 * `node dist/cli.js` cannot execute them natively. That's a real limitation,
 * not hidden: a failed import is reported per-file, not swallowed, and
 * loading continues with the remaining files either way.
 */
export async function loadExtensions(dir: string = EXTENSIONS_DIR): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // no extensions directory yet — nothing to load
  }

  for (const entry of entries) {
    if (!/\.(ts|js|mjs)$/.test(entry)) continue;
    const filePath = path.join(dir, entry);

    try {
      const mod = await import(pathToFileURL(filePath).href);
      const extension: FezExtension | undefined = mod.default;
      if (typeof extension !== "function") {
        console.error(`⚠️  ${entry} has no default export function — skipped`);
        continue;
      }
      await extension(api);
    } catch (err) {
      console.error(
        `⚠️  Failed to load extension ${entry}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
