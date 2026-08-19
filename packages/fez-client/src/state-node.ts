import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setStatePersistence, type StatePersistence } from "./workspace-state.js";

/**
 * File-backed state persistence for NODE hosts (TUI, CLI, tests) — kept
 * out of index.ts so browser bundles of @fez/client never see node:fs.
 * Node hosts call installNodeStatePersistence() before constructing
 * FezClient; FEZ_STATE_FILE still overrides for tests/harnesses.
 */
export function nodeStatePersistence(file?: string): StatePersistence {
  const stateFile = file ?? process.env.FEZ_STATE_FILE ?? path.join(os.homedir(), ".fez", "communities.json");
  return {
    exists: () => fs.existsSync(stateFile),
    read: () => {
      try {
        return fs.readFileSync(stateFile, "utf-8");
      } catch {
        return undefined;
      }
    },
    write: (text) => {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, text, "utf-8");
    },
  };
}

export function installNodeStatePersistence(file?: string): void {
  setStatePersistence(nodeStatePersistence(file));
}
