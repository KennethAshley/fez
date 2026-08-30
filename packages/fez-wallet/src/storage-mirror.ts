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

// Must match this package's name — the desktop's gui loader namespace-locks
// api.storage to the registered extension name (gui-extensions.ts), which
// is the same name the gui part loads under from ~/.fez/packages/<name>.
// Verified at implementation time.
export const STORAGE_NAME = "wallet";

const MAX_LOG = 500;

function file(): string {
  const dir = process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data");
  return path.join(dir, `${STORAGE_NAME}.json`);
}

import type { Network } from "./networks.js";
export type { Network };

export interface WalletPrefs {
  network?: Network;
  thresholds?: Record<string, string>;
  /** GUI-editable x402 overrides (network flip, caps). A prefs value wins
   * over wallet.json's x402 block key-by-key — see config.ts's
   * x402Settings for the layering, including the rule that a prefs-level
   * network flip re-derives chainRef/usdcAddress/rpcUrl as a set. */
  x402?: {
    network?: string;
    chainRef?: string;
    usdcAddress?: string;
    rpcUrl?: string;
    dailyCapUsd?: number;
    autoApproveUnderUsd?: Record<string, number>;
  };
}

type State = {
  addresses?: { treasury?: string; personas?: Record<string, string> };
  endpoint?: string;
  /** Which network the endpoint (and hence the ledger) is actually
   * reading — mirrored alongside it so the gui part, which cannot read
   * config.ts, still knows which `logs` entry is live rather than
   * having to guess or show both at once. */
  network?: Network;
  logs?: Partial<Record<Network, SpendEntry[]>>;
  prefs?: WalletPrefs;
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

export function mirrorEndpoint(endpoint: string, network: Network): Promise<void> {
  return update((s) => {
    s.endpoint = endpoint;
    s.network = network;
  });
}

export function mirrorSpend(entry: SpendEntry): Promise<void> {
  return update((s) => {
    const logs = (s.logs ??= {});
    logs[entry.network] = [...(logs[entry.network] ?? []), entry].slice(-MAX_LOG);
  });
}

/** User preferences — the ONE subtree a gui part may write (spec §6).
 * This node-side write goes through the same serialized queue as the
 * ledger writes, so it cannot interleave with a spend FROM THIS PROCESS.
 * The panel's own write does not come through here at all: it goes to
 * the desktop's Rust command, which read-modify-writes the same file
 * from another process. Subtree scoping keeps that write off the ledger
 * keys; it cannot keep a concurrent whole-file write from losing an
 * update. */
export function mirrorPrefs(p: Partial<WalletPrefs>): Promise<void> {
  return update((s) => {
    s.prefs = { ...(s.prefs ?? {}), ...p };
  });
}

/** One x402 ledger row, mirrored verbatim from the append-only x402 spend
 * log — the panel renders events (signed, then settled/ambiguous), it
 * never infers state. Shape matches log.ts's X402LogEntry. */
export interface X402MirrorRow {
  ts: string;
  persona: string;
  url: string;
  payTo: string;
  usd: number;
  status: "signed" | "settled" | "ambiguous";
  txHash?: string;
  network: string;
}

export function mirrorX402Spend(row: X402MirrorRow): Promise<void> {
  return update((s) => {
    const log = (s.x402Log as X402MirrorRow[] | undefined) ?? [];
    s.x402Log = [...log, row].slice(-MAX_LOG);
  });
}

/** A persona's fundable EVM address — mirrored at derive time so the
 * panel can show it (copy/QR) without any key material ever landing here. */
export function mirrorEvmAddress(u: { name: string; address: string }): Promise<void> {
  return update((s) => {
    const a = (s.evmAddresses as Record<string, string> | undefined) ?? {};
    s.evmAddresses = { ...a, [u.name]: u.address };
  });
}

/** The resolved x402 settings snapshot (network/rpc/usdc/caps) — the
 * panel needs rpcUrl+usdcAddress for its read-only balance call and the
 * effective numbers for display. Nothing secret: all of this is config. */
export interface X402Meta {
  network: string;
  rpcUrl: string;
  usdcAddress: string;
  dailyCapUsd: number;
  autoApproveDefault: number;
}

export function mirrorX402Meta(meta: X402Meta): Promise<void> {
  return update((s) => {
    s.x402Meta = meta;
  });
}
