import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fresh FEZ_WALLET_HOME + FEZ_EXTENSION_DATA_DIR pointed at a new tmp
 * dir, so wallet.json and the extension-storage mirror never bleed
 * between tests. Shared across config/storage-mirror/cli tests.
 */
export function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-prefs-"));
  process.env.FEZ_WALLET_HOME = dir;
  process.env.FEZ_EXTENSION_DATA_DIR = path.join(dir, "extension-data");
  return dir;
}
