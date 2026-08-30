import os from "node:os";
import path from "node:path";

/** Where `ridges-jobs.json` (store.ts) lives — same `<PKG>_HOME ?? ~/.fez`
 * shape fez-wallet uses for its own on-disk state (FEZ_WALLET_HOME). */
export function ridgesDir(): string {
  return process.env.FEZ_RIDGES_HOME ?? path.join(os.homedir(), ".fez");
}
