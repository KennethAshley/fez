import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SpendEntry } from "./log.js";

/**
 * Public wallet state mirrored into the extension-storage namespace
 * (~/.fez/extension-data/<STORAGE_NAME>.json) so the gui part — which
 * is webview-sandboxed and cannot read wallet.json or the jsonl log —
 * can render addresses, the endpoint, and the spend ledger via the
 * desktop's read-only api.storage seam.
 *
 * NOTHING SECRET LANDS HERE: addresses, endpoint, history — exactly
 * what the chain already shows. Writes are best-effort and silent: a
 * failed mirror must never break a transfer.
 */

// Must match the installed gui part's file stem in ~/.fez/gui-extensions
// (see install_package's ("gui","gui-extensions") copy in the desktop's
// lib.rs). Verified at implementation time.
export const STORAGE_NAME = "wallet";

const MAX_LOG = 500;

function file(): string {
  const dir = process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data");
  return path.join(dir, `${STORAGE_NAME}.json`);
}

type State = {
  addresses?: { treasury?: string; personas?: Record<string, string> };
  endpoint?: string;
  log?: SpendEntry[];
  [k: string]: unknown;
};

let chain: Promise<unknown> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = chain.then(op, op).catch(() => {});
  chain = next;
  return next as Promise<void>;
}

async function update(mutate: (s: State) => void): Promise<void> {
  return enqueue(async () => {
    const f = file();
    let state: State = {};
    try {
      state = JSON.parse(await fs.readFile(f, "utf8"));
    } catch { /* missing/corrupt reads as empty */ }
    mutate(state);
    try {
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, JSON.stringify(state, null, 2));
    } catch { /* best-effort — never break the caller */ }
  });
}

export function mirrorAddresses(u: { treasury?: string; persona?: { name: string; address: string } }): Promise<void> {
  return update((s) => {
    const a = (s.addresses ??= { personas: {} });
    a.personas ??= {};
    if (u.treasury) a.treasury = u.treasury;
    if (u.persona) a.personas[u.persona.name] = u.persona.address;
  });
}

export function mirrorEndpoint(endpoint: string): Promise<void> {
  return update((s) => {
    s.endpoint = endpoint;
  });
}

export function mirrorSpend(entry: SpendEntry): Promise<void> {
  return update((s) => {
    s.log = [...(s.log ?? []), entry].slice(-MAX_LOG);
  });
}
