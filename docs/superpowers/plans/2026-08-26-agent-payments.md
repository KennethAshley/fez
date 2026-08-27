# Agent Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can pay an agent belonging to someone else — resolving a channel name to an address, guarded by network, traced by a chain-verifiable receipt on the message that earned it.

**Architecture:** Three pure modules added to `@fezchat/wallet` (`resolve.ts`, `address-event.ts`, `receipt.ts`) with relay and chain access injected, so all of it is testable without either. `tools.ts` stays the wiring and grows no fourth responsibility. Network becomes a preference rather than an endpoint edit, which needs a webview→disk write seam in core; that seam is prefs-scoped and lands before the panel that uses it.

**Tech Stack:** TypeScript (NodeNext — relative imports need the `.js` suffix), vitest (run `npx vitest --run <path>` from the repo root), esbuild bundles (ESM for `mcp`/`cli`, IIFE + `--global-name=__fezExt` for `gui`), `@polkadot/api` for chain access, `nostr-tools` for events, Tauri v2 + Rust for the desktop seam.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-payments-design.md`

## Global Constraints

- **Commit style:** lowercase, subsystem prefix (`wallet:`, `desktop:`). **Never** add Claude co-author or session trailers.
- **TDD:** every task writes its failing test first and shows it fail before implementing.
- **Custody invariants must survive every task.** From the wallet README: the MCP server never reads the root mnemonic — `grep -rn '"root"' packages/fez-wallet/src | grep -v cli-commands` must stay empty; key selection comes only from `FEZ_AGENT_PERSONA`; the allowance balance is the hard cap.
- **Kinds:** `KIND_AGENT_PAYMENT_ADDRESS = 30175`, `KIND_PAYMENT_RECEIPT = 47040`. Both verified free against `src/protocol/kinds.ts`.
- **Amounts are integers.** Rao as `bigint` end to end; no float ever touches an amount. `parseAmount`/`formatAmount` in `src/chains/adapter.ts` are the only converters.
- **Test env seams:** `FEZ_WALLET_HOME` relocates `wallet.json` and the ledger; `FEZ_EXTENSION_DATA_DIR` relocates the mirror file; `FEZ_WALLET_STORE=file` forces the file key backend. Every test that touches disk sets them to a temp dir.
- **Networks:** `finney` → `wss://entrypoint-finney.opentensor.ai:443`, `test` → `wss://test.finney.opentensor.ai:443`.
- **No new dependencies.** Everything needed is already in `packages/fez-wallet/package.json`.
- The desktop bundles gui parts into `~/.fez/gui-extensions`; desktop Rust changes need a Tauri rebuild and the `/Applications` swap before they are visible.

---

### Task 1: Preferences — network and thresholds move out of `wallet.json`

**Files:**
- Modify: `packages/fez-wallet/src/storage-mirror.ts` (add `mirrorPrefs`)
- Modify: `packages/fez-wallet/src/config.ts`
- Test: `packages/fez-wallet/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Network = "test" | "finney"`
  - `interface WalletPrefs { network?: Network; thresholds?: Record<string, string> }`
  - `readPrefs(): WalletPrefs` — sync read of the mirror file's `prefs` object
  - `endpointFor(network: Network): string`
  - `loadConfig(): WalletConfig` — gains `network: Network`; `endpoints.tao` derived from `network` unless explicitly set
  - `migratePrefs(): void` — one-time move of legacy fields
  - `mirrorPrefs(p: Partial<WalletPrefs>): Promise<void>` (in `storage-mirror.ts`)

Reads are sync because `loadConfig()` is sync and called per tool invocation; writes go through `storage-mirror.ts`'s existing serialized queue so they cannot interleave with a ledger write.

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, endpointFor, readPrefs, migratePrefs } from "../src/config.js";
import { mirrorPrefs } from "../src/storage-mirror.js";

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-prefs-"));
  process.env.FEZ_WALLET_HOME = dir;
  process.env.FEZ_EXTENSION_DATA_DIR = path.join(dir, "extension-data");
  return dir;
}

describe("network preferences", () => {
  beforeEach(() => tmpHome());

  it("defaults to finney with its endpoint", () => {
    const c = loadConfig();
    expect(c.network).toBe("finney");
    expect(c.endpoints.tao).toBe("wss://entrypoint-finney.opentensor.ai:443");
  });

  it("derives the endpoint from a prefs network", async () => {
    await mirrorPrefs({ network: "test" });
    const c = loadConfig();
    expect(c.network).toBe("test");
    expect(c.endpoints.tao).toBe("wss://test.finney.opentensor.ai:443");
  });

  it("lets an explicit endpoint override the derived one", async () => {
    await mirrorPrefs({ network: "test" });
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({ endpoints: { tao: "ws://127.0.0.1:9944" } })
    );
    expect(loadConfig().endpoints.tao).toBe("ws://127.0.0.1:9944");
  });

  it("prefers a prefs threshold over the legacy wallet.json one", async () => {
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({ thresholds: { default: "0.5" } })
    );
    await mirrorPrefs({ thresholds: { default: "0.02" } });
    expect(loadConfig().thresholds.default).toBe("0.02");
  });

  it("migrates legacy thresholds and a recognised endpoint into prefs", async () => {
    const walletJson = path.join(process.env.FEZ_WALLET_HOME!, "wallet.json");
    fs.writeFileSync(
      walletJson,
      JSON.stringify({
        thresholds: { default: "0.5" },
        endpoints: { tao: "wss://test.finney.opentensor.ai:443" },
      })
    );
    migratePrefs();
    expect(readPrefs().thresholds).toEqual({ default: "0.5" });
    // A recognised endpoint becomes the network, so the selector can move it.
    expect(readPrefs().network).toBe("test");
    const after = JSON.parse(fs.readFileSync(walletJson, "utf-8"));
    expect(after.thresholds).toBeUndefined();
    expect(after.endpoints?.tao).toBeUndefined();
  });

  it("leaves an unrecognised endpoint alone when migrating", () => {
    const walletJson = path.join(process.env.FEZ_WALLET_HOME!, "wallet.json");
    fs.writeFileSync(walletJson, JSON.stringify({ endpoints: { tao: "ws://127.0.0.1:9944" } }));
    migratePrefs();
    expect(JSON.parse(fs.readFileSync(walletJson, "utf-8")).endpoints.tao).toBe("ws://127.0.0.1:9944");
  });

  it("maps both networks to their endpoints", () => {
    expect(endpointFor("test")).toBe("wss://test.finney.opentensor.ai:443");
    expect(endpointFor("finney")).toBe("wss://entrypoint-finney.opentensor.ai:443");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/config.test.ts`
Expected: FAIL — `endpointFor`, `readPrefs`, `migratePrefs`, `mirrorPrefs` are not exported.

- [ ] **Step 3: Add `mirrorPrefs` to `storage-mirror.ts`**

Extend the `State` type and add the writer, beside `mirrorSpend`:

```typescript
export type Network = "test" | "finney";

export interface WalletPrefs {
  network?: Network;
  thresholds?: Record<string, string>;
}

// …add to the existing `State` type:
//   prefs?: WalletPrefs;

/** User preferences — the ONE subtree a gui part may write (spec §6).
 * Goes through the same serialized queue as the ledger writes, so a
 * panel edit can never interleave with a spend. */
export function mirrorPrefs(p: Partial<WalletPrefs>): Promise<void> {
  return update((s) => {
    s.prefs = { ...(s.prefs ?? {}), ...p };
  });
}
```

- [ ] **Step 4: Implement the config side**

Rewrite `packages/fez-wallet/src/config.ts`'s middle section:

```typescript
import type { Network, WalletPrefs } from "./storage-mirror.js";

export type { Network, WalletPrefs };

const ENDPOINTS: Record<Network, string> = {
  finney: "wss://entrypoint-finney.opentensor.ai:443",
  test: "wss://test.finney.opentensor.ai:443",
};

export function endpointFor(network: Network): string {
  return ENDPOINTS[network];
}

function prefsFile(): string {
  const dir =
    process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data");
  return path.join(dir, "wallet.json");
}

/** Sync because loadConfig() is sync and runs per tool call. Writes go
 * through storage-mirror's queue; this only ever reads. */
export function readPrefs(): WalletPrefs {
  try {
    return (JSON.parse(fs.readFileSync(prefsFile(), "utf-8")).prefs ?? {}) as WalletPrefs;
  } catch {
    return {};
  }
}

export function loadConfig(): WalletConfig {
  let onDisk: Partial<WalletConfig> & { endpoints?: { tao?: string } } = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(configFile(), "utf-8"));
  } catch { /* missing/corrupt reads as defaults */ }
  const prefs = readPrefs();
  const network: Network = prefs.network ?? "finney";
  return {
    ...DEFAULTS,
    ...onDisk,
    network,
    // prefs wins; wallet.json's thresholds are legacy until migratePrefs runs.
    thresholds: { ...DEFAULTS.thresholds, ...onDisk.thresholds, ...prefs.thresholds },
    // An explicit endpoint always wins — local nodes and forks need it.
    endpoints: { tao: onDisk.endpoints?.tao ?? endpointFor(network) },
  };
}

/** One-time move of user-settable fields into prefs (spec §6: one home
 * per field). An endpoint that exactly matches a known network becomes
 * that network — otherwise the panel's selector could never move it. An
 * unrecognised endpoint is left alone: it is a deliberate override. */
export function migratePrefs(): void {
  const onDisk = (() => {
    try { return JSON.parse(fs.readFileSync(configFile(), "utf-8")); }
    catch { return undefined; }
  })();
  if (!onDisk) return;
  const moved: WalletPrefs = {};
  if (onDisk.thresholds) {
    moved.thresholds = onDisk.thresholds;
    delete onDisk.thresholds;
  }
  const known = (Object.entries(ENDPOINTS) as [Network, string][])
    .find(([, url]) => url === onDisk.endpoints?.tao);
  if (known) {
    moved.network = known[0];
    delete onDisk.endpoints.tao;
    if (Object.keys(onDisk.endpoints).length === 0) delete onDisk.endpoints;
  }
  if (Object.keys(moved).length === 0) return;
  const existing = readPrefs();
  const file = prefsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state: Record<string, unknown> = {};
  try { state = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { /* empty */ }
  state.prefs = { ...moved, ...existing }; // an existing pref already won
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  saveConfig(onDisk as WalletConfig);
}
```

Add `network: Network;` to the `WalletConfig` interface and `network: "finney"` to `DEFAULTS`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/config.test.ts packages/fez-wallet/tests/storage-mirror.test.ts`
Expected: PASS, including the pre-existing storage-mirror tests.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/config.ts packages/fez-wallet/src/storage-mirror.ts packages/fez-wallet/tests/config.test.ts
git commit -m "wallet: network and thresholds become preferences, not config

one home per field: the two things a person actually changes move into
the extension-data prefs subtree, and wallet.json keeps what the ceremony
owns. the endpoint stops being the thing you edit and becomes derived —
except when it's explicitly set, which is how a local node stays possible.
migration promotes a recognised endpoint to its network so the selector
can move it, and leaves an unrecognised one alone because that's someone
meaning it"
```

---

### Task 2: A ledger per network

**Files:**
- Modify: `packages/fez-wallet/src/log.ts`
- Modify: `packages/fez-wallet/src/storage-mirror.ts`
- Test: `packages/fez-wallet/tests/storage-mirror.test.ts`

**Interfaces:**
- Consumes: `Network` from Task 1.
- Produces:
  - `SpendEntry` gains `network: Network`
  - `appendLog(entry: SpendEntry): void` / `readLog(network: Network, limit: number): SpendEntry[]` — file is `wallet-log.<network>.jsonl`
  - `migrateLog(): void` — one-time rename of the legacy file
  - `mirrorSpend` keys the mirrored `log` by network: `logs: Record<Network, SpendEntry[]>`

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/storage-mirror.test.ts`:

```typescript
import { appendLog, readLog, migrateLog, type SpendEntry } from "../src/log.js";

function entry(over: Partial<SpendEntry> = {}): SpendEntry {
  return {
    ts: "2026-08-26T00:00:00.000Z",
    persona: "scout",
    to: "5Dest",
    amount: "0.05",
    asset: "TAO",
    txHash: "0xfeed",
    consent: "auto",
    network: "test",
    ...over,
  };
}

describe("per-network ledger", () => {
  beforeEach(() => tmpHome()); // same helper as Task 1

  it("keeps networks in separate files", () => {
    appendLog(entry({ network: "test", txHash: "0xtest" }));
    appendLog(entry({ network: "finney", txHash: "0xreal" }));
    expect(readLog("test", 10).map((e) => e.txHash)).toEqual(["0xtest"]);
    expect(readLog("finney", 10).map((e) => e.txHash)).toEqual(["0xreal"]);
  });

  it("reads a missing ledger as empty", () => {
    expect(readLog("finney", 10)).toEqual([]);
  });

  it("migrates the legacy log into the testnet ledger", () => {
    const home = process.env.FEZ_WALLET_HOME!;
    const legacy = { ...entry() } as Record<string, unknown>;
    delete legacy.network;
    fs.writeFileSync(path.join(home, "wallet-log.jsonl"), JSON.stringify(legacy) + "\n");
    migrateLog();
    expect(readLog("test", 10)).toHaveLength(1);
    expect(readLog("test", 10)[0].network).toBe("test");
    expect(fs.existsSync(path.join(home, "wallet-log.jsonl"))).toBe(false);
  });

  it("does not clobber an existing per-network ledger when migrating", () => {
    const home = process.env.FEZ_WALLET_HOME!;
    appendLog(entry({ txHash: "0xalready" }));
    fs.writeFileSync(path.join(home, "wallet-log.jsonl"), JSON.stringify(entry()) + "\n");
    migrateLog();
    expect(readLog("test", 10).map((e) => e.txHash)).toEqual(["0xalready"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/storage-mirror.test.ts`
Expected: FAIL — `readLog` takes one argument; `migrateLog` is not exported.

- [ ] **Step 3: Implement**

In `packages/fez-wallet/src/log.ts`:

```typescript
import type { Network } from "./storage-mirror.js";

export interface SpendEntry {
  ts: string;
  persona: string;
  to: string;
  amount: string;
  asset: string;
  txHash: string;
  memo?: string;
  consent: "auto" | "approved";
  network: Network;
  /** Set on inbound rows learned from a receipt (Task 10). */
  direction?: "in" | "out";
  /** The message this paid for, when it was a zap-shaped send. */
  forEvent?: string;
}

function home(): string {
  return process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez");
}

function logFile(network: Network): string {
  return path.join(home(), `wallet-log.${network}.jsonl`);
}

export function appendLog(entry: SpendEntry): void {
  const file = logFile(entry.network);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readLog(network: Network, limit: number): SpendEntry[] {
  try {
    const lines = fs.readFileSync(logFile(network), "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as SpendEntry);
  } catch {
    return [];
  }
}

/** The legacy single log holds only testnet rows — verified at planning
 * time (3 rows, all from the 2026-08-26 testnet e2e). Decided by that
 * fact, not by the current config, which has since moved. Refuses to
 * overwrite an existing testnet ledger. */
export function migrateLog(): void {
  const legacy = path.join(home(), "wallet-log.jsonl");
  if (!fs.existsSync(legacy)) return;
  const target = logFile("test");
  if (fs.existsSync(target)) {
    fs.rmSync(legacy);
    return;
  }
  const rows = fs
    .readFileSync(legacy, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ network: "test" as Network, ...(JSON.parse(l) as SpendEntry) }));
  fs.writeFileSync(target, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  fs.rmSync(legacy);
}
```

In `storage-mirror.ts`, replace the flat `log` with per-network logs:

```typescript
// State: replace `log?: SpendEntry[]` with
//   logs?: Partial<Record<Network, SpendEntry[]>>;

export function mirrorSpend(entry: SpendEntry): Promise<void> {
  return update((s) => {
    const logs = (s.logs ??= {});
    logs[entry.network] = [...(logs[entry.network] ?? []), entry].slice(-MAX_LOG);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/storage-mirror.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the call sites the type change breaks**

Run: `cd packages/fez-wallet && npx tsc --noEmit`
Add `network: config.network` to the `mirrorSpend`/`appendLog` calls in `src/tools.ts` and `src/cli-commands.ts` (`cmdFund`), and pass `config.network` to `readLog` in `walletHistory`. Re-run until clean.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/log.ts packages/fez-wallet/src/storage-mirror.ts packages/fez-wallet/src/tools.ts packages/fez-wallet/src/cli-commands.ts packages/fez-wallet/tests/storage-mirror.test.ts
git commit -m "wallet: a ledger per network, so play money stays out of the record

one log for two chains meant a testnet session and a real spend read the
same. the existing rows are all from the testnet e2e, so they migrate to
the test ledger by that fact rather than by asking the current config —
which has since moved and would have mislabelled every one of them"
```

---

### Task 3: `fez-wallet network`

**Files:**
- Modify: `packages/fez-wallet/src/cli-commands.ts`
- Modify: `packages/fez-wallet/src/cli.ts`
- Test: `packages/fez-wallet/tests/cli.test.ts`

**Interfaces:**
- Consumes: `endpointFor`, `mirrorPrefs`, `migratePrefs`, `migrateLog`.
- Produces: `cmdNetwork(io: CliIo, next?: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/cli.test.ts`:

```typescript
import { cmdNetwork } from "../src/cli-commands.js";
import { loadConfig } from "../src/config.js";

describe("fez-wallet network", () => {
  beforeEach(() => tmpHome());

  function io() {
    const lines: string[] = [];
    return { io: { print: (l: string) => lines.push(l) }, lines };
  }

  it("prints the current network when given no argument", async () => {
    const { io: i, lines } = io();
    await cmdNetwork(i);
    expect(lines.join("\n")).toContain("finney");
  });

  it("switches the network and reports the endpoint", async () => {
    const { io: i, lines } = io();
    await cmdNetwork(i, "test");
    expect(loadConfig().network).toBe("test");
    expect(lines.join("\n")).toContain("wss://test.finney.opentensor.ai:443");
  });

  it("rejects an unknown network without changing anything", async () => {
    const { io: i } = io();
    await expect(cmdNetwork(i, "mainnet")).rejects.toThrow(/test.*finney/);
    expect(loadConfig().network).toBe("finney");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/cli.test.ts`
Expected: FAIL — `cmdNetwork` is not exported.

- [ ] **Step 3: Implement**

In `cli-commands.ts`:

```typescript
import { loadConfig, saveConfig, assignEvmIndex, endpointFor, migratePrefs, type Network } from "./config.js";
import { mirrorAddresses, mirrorEndpoint, mirrorSpend, mirrorPrefs } from "./storage-mirror.js";
import { migrateLog } from "./log.js";

const NETWORKS: Network[] = ["test", "finney"];

export async function cmdNetwork(io: CliIo, next?: string): Promise<void> {
  migratePrefs();
  migrateLog();
  if (!next) {
    const c = loadConfig();
    io.print(`network: ${c.network}`);
    io.print(`endpoint: ${c.endpoints.tao}`);
    return;
  }
  if (!NETWORKS.includes(next as Network)) {
    throw new Error(`unknown network "${next}" — expected one of: ${NETWORKS.join(", ")}`);
  }
  await mirrorPrefs({ network: next as Network });
  const c = loadConfig();
  await mirrorEndpoint(c.endpoints.tao);
  io.print(`network: ${c.network}`);
  io.print(`endpoint: ${c.endpoints.tao}`);
  if (c.network !== "finney") io.print("⚠️  not mainnet — balances and sends are play money");
}
```

Wire it in `cli.ts` beside the existing commands, and add `network [test|finney]` to the usage text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Show the network in `status`**

In `cmdStatus`, before the treasury line:

```typescript
io.print(`network: ${config.network}${config.network === "finney" ? "" : "  ⚠️  play money"}`);
```

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/cli-commands.ts packages/fez-wallet/src/cli.ts packages/fez-wallet/tests/cli.test.ts
git commit -m "wallet: fez-wallet network, and status says which chain you're on

switching chains was editing a url in a json file, which is the kind of
thing you get wrong once and don't notice until the money is real. it's a
command now, and anything that isn't mainnet says so out loud"
```

---

### Task 4: The address event — kind 30175

**Files:**
- Create: `packages/fez-wallet/src/address-event.ts`
- Create: `packages/fez-wallet/tests/address-event.test.ts`
- Modify: `src/protocol/kinds.ts` (core)

**Interfaces:**
- Consumes: `Network`.
- Produces:
  - `buildAddressEvent(opts: { agentSecretHex: string; chain: string; network: Network; address: string }): SignedNostrEvent`
  - `parseAddressEvent(ev: SignedNostrEvent): { chain: string; network: Network; address: string } | undefined`
  - `addressFilter(pubkeys: string[], chain: string, network: Network): Filter`
  - `KIND_AGENT_PAYMENT_ADDRESS = 30175`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-wallet/tests/address-event.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  buildAddressEvent,
  parseAddressEvent,
  addressFilter,
  KIND_AGENT_PAYMENT_ADDRESS,
} from "../src/address-event.js";

const sk = bytesToHex(generateSecretKey());

describe("address event", () => {
  it("round-trips chain, network and address", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    expect(ev.kind).toBe(KIND_AGENT_PAYMENT_ADDRESS);
    expect(parseAddressEvent(ev)).toEqual({ chain: "tao", network: "test", address: "5Dq6" });
  });

  it("is addressable — the d tag is chain:network so it self-replaces", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    expect(ev.tags).toContainEqual(["d", "tao:test"]);
  });

  it("rejects an event with no address", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    expect(parseAddressEvent({ ...ev, content: "  " })).toBeUndefined();
  });

  it("rejects an unknown network rather than guessing", () => {
    const ev = buildAddressEvent({ agentSecretHex: sk, chain: "tao", network: "test", address: "5Dq6" });
    const tampered = { ...ev, tags: ev.tags.map((t) => (t[0] === "network" ? ["network", "beta"] : t)) };
    expect(parseAddressEvent(tampered)).toBeUndefined();
  });

  it("filters by author, kind and d tag", () => {
    const pk = getPublicKey(generateSecretKey());
    expect(addressFilter([pk], "tao", "finney")).toEqual({
      kinds: [KIND_AGENT_PAYMENT_ADDRESS],
      authors: [pk],
      "#d": ["tao:finney"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/address-event.test.ts`
Expected: FAIL — cannot find `../src/address-event.js`.

- [ ] **Step 3: Implement**

Create `packages/fez-wallet/src/address-event.ts`:

```typescript
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { Filter } from "nostr-tools";
import type { SignedNostrEvent } from "./consent.js";
import type { Network } from "./storage-mirror.js";

/**
 * Where an agent can be paid. Signed by the AGENT's own nostr key —
 * fez-acp owns the 47000 announce and cannot read the wallet keychain,
 * so this is the wallet's own event rather than a field on that one.
 *
 * Addressable (30000–39999 per NIP-01): the useful query is "the current
 * address for this agent on this chain and network", so it self-replaces.
 */
export const KIND_AGENT_PAYMENT_ADDRESS = 30175;

const NETWORKS = new Set<Network>(["test", "finney"]);

export function buildAddressEvent(opts: {
  agentSecretHex: string;
  chain: string;
  network: Network;
  address: string;
}): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: KIND_AGENT_PAYMENT_ADDRESS,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", `${opts.chain}:${opts.network}`],
        ["chain", opts.chain],
        ["network", opts.network],
      ],
      content: opts.address,
    },
    hexToBytes(opts.agentSecretHex)
  );
}

export function parseAddressEvent(
  ev: SignedNostrEvent
): { chain: string; network: Network; address: string } | undefined {
  if (ev.kind !== KIND_AGENT_PAYMENT_ADDRESS) return undefined;
  const tag = (k: string) => ev.tags.find((t) => t[0] === k)?.[1];
  const chain = tag("chain");
  const network = tag("network") as Network | undefined;
  const address = ev.content.trim();
  // An unknown network is refused rather than defaulted: defaulting here
  // would be the one place a mainnet address could pass as a testnet one.
  if (!chain || !network || !NETWORKS.has(network) || !address) return undefined;
  return { chain, network, address };
}

export function addressFilter(pubkeys: string[], chain: string, network: Network): Filter {
  return {
    kinds: [KIND_AGENT_PAYMENT_ADDRESS],
    authors: pubkeys,
    "#d": [`${chain}:${network}`],
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/address-event.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the kind in core**

In `src/protocol/kinds.ts`, beside `KIND_AGENT_ENGRAM` (line ~225):

```typescript
/** Where an agent can be paid — addressable, d = "<chain>:<network>",
 * content = the address. Published by the wallet extension and signed by
 * the agent's own key. */
export const KIND_AGENT_PAYMENT_ADDRESS = 30175;
```

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/address-event.ts packages/fez-wallet/tests/address-event.test.ts src/protocol/kinds.ts
git commit -m "wallet: an agent publishes where it can be paid (30175)

addressable so it self-replaces per chain and network, and signed by the
agent's own key rather than folded into the 47000 announce — fez-acp
publishes that one and can't read the wallet keychain. an unrecognised
network tag is refused rather than defaulted: defaulting is exactly where
a mainnet address would slip through as a testnet one"
```

---

### Task 5: Resolution — the fall-through

**Files:**
- Create: `packages/fez-wallet/src/resolve.ts`
- Create: `packages/fez-wallet/tests/resolve.test.ts`
- Modify: `packages/fez-wallet/src/consent.ts` (add `query` to `ConsentRelay`)

**Interfaces:**
- Consumes: `parseAddressEvent`, `addressFilter`, `readEntry`, `pairFromStored`.
- Produces:
  - `ConsentRelay` gains `query(filter: Filter): Promise<SignedNostrEvent[]>`
  - `interface Resolved { address: string; network?: Network; via: "local" | "agent" | "raw" }`
  - `resolveRecipient(to: string, deps: ResolveDeps): Promise<Resolved>`
  - `interface ResolveDeps { chain: string; network: Network; roster(): Promise<{ name: string; pubkey: string }[]>; addressEvents(filter: Filter): Promise<SignedNostrEvent[]>; localAddress(name: string): string | undefined }`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-wallet/tests/resolve.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { buildAddressEvent } from "../src/address-event.js";
import { resolveRecipient, type ResolveDeps } from "../src/resolve.js";

const chipSk = bytesToHex(generateSecretKey());
const chipPk = getPublicKey(Buffer.from(chipSk, "hex"));

function deps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    chain: "tao",
    network: "test",
    roster: async () => [{ name: "chip", pubkey: chipPk }],
    addressEvents: async () => [
      buildAddressEvent({ agentSecretHex: chipSk, chain: "tao", network: "test", address: "5Chip" }),
    ],
    localAddress: () => undefined,
    ...over,
  };
}

describe("resolveRecipient", () => {
  it("prefers a local persona", async () => {
    const r = await resolveRecipient("chip", deps({ localAddress: (n) => (n === "chip" ? "5Local" : undefined) }));
    expect(r).toEqual({ address: "5Local", via: "local" });
  });

  it("resolves a roster name to its published address", async () => {
    expect(await resolveRecipient("@chip", deps())).toEqual({
      address: "5Chip",
      network: "test",
      via: "agent",
    });
  });

  it("strips a leading @ for local names too", async () => {
    const r = await resolveRecipient("@chip", deps({ localAddress: (n) => (n === "chip" ? "5Local" : undefined) }));
    expect(r.via).toBe("local");
  });

  it("passes an unknown name through as a raw address", async () => {
    expect(await resolveRecipient("5F3sa2Whatever", deps())).toEqual({
      address: "5F3sa2Whatever",
      via: "raw",
    });
  });

  it("errors on an ambiguous name instead of picking", async () => {
    const otherPk = getPublicKey(generateSecretKey());
    await expect(
      resolveRecipient(
        "@chip",
        deps({ roster: async () => [{ name: "chip", pubkey: chipPk }, { name: "chip", pubkey: otherPk }] })
      )
    ).rejects.toThrow(/more than one/i);
  });

  it("says so when a known agent has published no address", async () => {
    await expect(resolveRecipient("@chip", deps({ addressEvents: async () => [] }))).rejects.toThrow(
      /chip hasn't published/i
    );
  });

  it("reports the payee's network so the caller can guard on it", async () => {
    const r = await resolveRecipient(
      "@chip",
      deps({
        network: "finney",
        addressEvents: async () => [
          buildAddressEvent({ agentSecretHex: chipSk, chain: "tao", network: "finney", address: "5Real" }),
        ],
      })
    );
    expect(r.network).toBe("finney");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/resolve.test.ts`
Expected: FAIL — cannot find `../src/resolve.js`.

- [ ] **Step 3: Implement**

Create `packages/fez-wallet/src/resolve.ts`:

```typescript
import type { Filter } from "nostr-tools";
import type { SignedNostrEvent } from "./consent.js";
import type { Network } from "./storage-mirror.js";
import { parseAddressEvent, addressFilter } from "./address-event.js";

/**
 * `to` is tried in order and falls through to today's behaviour. The
 * fall-through is load-bearing: a name this resolver does not recognise
 * goes to the chain verbatim, so paying something fez has never
 * integrated stays possible. This adds names; it never removes the raw
 * path. The only gates on a send are the amount threshold and the
 * new-payee card — never identity.
 */
export interface Resolved {
  address: string;
  /** Present only when the payee announced one — a raw address has none. */
  network?: Network;
  via: "local" | "agent" | "raw";
}

export interface ResolveDeps {
  chain: string;
  network: Network;
  roster(): Promise<{ name: string; pubkey: string }[]>;
  addressEvents(filter: Filter): Promise<SignedNostrEvent[]>;
  localAddress(name: string): string | undefined;
}

export async function resolveRecipient(to: string, deps: ResolveDeps): Promise<Resolved> {
  const name = to.startsWith("@") ? to.slice(1) : to;

  const local = deps.localAddress(name);
  if (local) return { address: local, via: "local" };

  const matches = (await deps.roster()).filter((m) => m.name === name);
  if (matches.length > 1) {
    // A name is not an identity — the npub is. Two owners may both run a
    // "chip", and picking one would be picking whose money moves.
    throw new Error(
      `"${name}" matches more than one agent here (${matches
        .map((m) => m.pubkey.slice(0, 12) + "…")
        .join(", ")}) — send to the address instead`
    );
  }
  if (matches.length === 1) {
    const events = await deps.addressEvents(addressFilter([matches[0].pubkey], deps.chain, deps.network));
    const parsed = events.map(parseAddressEvent).find(Boolean);
    if (!parsed) {
      throw new Error(`${name} hasn't published a ${deps.chain.toUpperCase()} address`);
    }
    return { address: parsed.address, network: parsed.network, via: "agent" };
  }

  return { address: to, via: "raw" };
}
```

In `consent.ts`, add to the `ConsentRelay` interface and to `poolRelay`'s returned object:

```typescript
// interface ConsentRelay — add:
  query(filter: Filter): Promise<SignedNostrEvent[]>;

// poolRelay's relay object — add:
    async query(filter: Filter) {
      return (await conn.query([filter] as never)) as SignedNostrEvent[];
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/resolve.test.ts packages/fez-wallet/tests/consent.test.ts`
Expected: PASS. If the existing consent tests construct a `ConsentRelay` literal, add a `query: async () => []` stub to each.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/resolve.ts packages/fez-wallet/src/consent.ts packages/fez-wallet/tests/resolve.test.ts packages/fez-wallet/tests/consent.test.ts
git commit -m "wallet: resolve a name to an address, and never gate on it

local persona, then roster name, then straight through as a raw address —
the last tier is the point. a resolver that could refuse an address is
the thing that breaks paying for something we haven't integrated yet, so
this one only ever adds names. an ambiguous name errors instead of
picking, because picking would be picking whose money moves"
```

---

### Task 6: Wire resolution and the network guard into `wallet_send`

**Files:**
- Modify: `packages/fez-wallet/src/tools.ts`
- Test: `packages/fez-wallet/tests/tools.test.ts`

**Interfaces:**
- Consumes: `resolveRecipient`, `ResolveDeps`, `Resolved`.
- Produces: `ToolDeps` gains `resolve?: (to: string) => Promise<Resolved>` (injected; defaults to the relay-backed resolver in `mcp.ts`).

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/tools.test.ts`:

```typescript
import { walletSend } from "../src/tools.js";

describe("cross-owner sends", () => {
  it("sends to the resolved address, not the typed name", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    await walletSend(
      { ...baseDeps(adapter), resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }) },
      { to: "@chip", amount: "0.001", asset: "TAO" }
    );
    expect(transfers[0].to).toBe("5Chip");
  });

  it("refuses a network mismatch before signing anything", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    await expect(
      walletSend(
        { ...baseDeps(adapter), resolve: async () => ({ address: "5Real", network: "finney", via: "agent" }) },
        { to: "@chip", amount: "0.001", asset: "TAO" }
      )
    ).rejects.toThrow(/you're on test.*chip is on finney/i);
    expect(transfers).toHaveLength(0);
  });

  it("allows a raw address, which carries no network to check", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    await walletSend(
      { ...baseDeps(adapter), resolve: async () => ({ address: "5Raw", via: "raw" }) },
      { to: "5Raw", amount: "0.001", asset: "TAO" }
    );
    expect(transfers[0].to).toBe("5Raw");
  });
});
```

Add a `baseDeps(adapter)` helper near the top of the file if one doesn't exist, returning the `ToolDeps` shape the existing tests already build (persona `scout`, `pair`, `config` with `network: "test"`, `now`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/tools.test.ts`
Expected: FAIL — `resolve` is not a `ToolDeps` field; `to` still passes through `resolveTo`.

- [ ] **Step 3: Implement**

In `tools.ts`, add `resolve?: (to: string) => Promise<Resolved>` to `ToolDeps` and replace the `resolveTo` call in `walletSend`:

```typescript
  // resolveTo stays as the local-only fallback for callers that inject no
  // resolver (the CLI, and every existing test).
  const resolved: Resolved = deps.resolve
    ? await deps.resolve(args.to)
    : { address: resolveTo(args.to), via: "local" };
  const to = resolved.address;

  // Before anything is signed: the guard that keeps a play session from
  // touching real TAO. A raw address announces no network and cannot be
  // checked — that is said out loud in the consent card rather than
  // allowed to look safe.
  if (resolved.network && resolved.network !== deps.config.network) {
    throw new Error(
      `you're on ${deps.config.network}, ${args.to} is on ${resolved.network} — nothing was sent`
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/tools.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Publish this agent's own address event (spec §2)**

Also in `mcp.ts`. Lazy and once per process — never at startup, which is
the `@polkadot` handshake trap fez-bittensor already paid for: heavy work
before the MCP handshake cost that server its attachment to the harness.

```typescript
/** Addressable, so republishing is a replace and needs no staleness
 * bookkeeping. Failure is silent by design — an agent that cannot
 * announce where to be paid must still be able to pay. */
let addressPublished = false;
async function publishOwnAddress(config: WalletConfig, pair: WalletPair, adapter: ChainAdapter) {
  if (addressPublished || !relays.length || !agentNostrKey) return;
  addressPublished = true;
  try {
    const relay = await poolRelay(relays, agentNostrKey);
    await relay.publish(
      buildAddressEvent({
        agentSecretHex: agentNostrKey,
        chain: adapter.chain,
        network: config.network,
        address: adapter.address(pair),
      })
    );
  } catch { /* announcing is not a precondition for paying */ }
}
```

Call it (unawaited — it must not delay the tool) at the end of `deps()`:
`void publishOwnAddress(config, pair, substrate);`

Add a test in `packages/fez-wallet/tests/address-event.test.ts` asserting
`buildAddressEvent` uses the adapter's own address, and verify by hand in
Task 15's two-machine run that each side sees the other's event.

- [ ] **Step 6: Build the real resolver in `mcp.ts`**

In `deps()`, after the relay is built:

```typescript
    resolve: relays.length
      ? async (to: string) => {
          const relay = await poolRelay(relays, agentNostrKey);
          return resolveRecipient(to, {
            chain: "tao",
            network: config.network,
            roster: async () => {
              const events = await relay.query({
                kinds: [KIND_AGENT_METADATA],
                ...(config.consentChannel ? { "#h": [config.consentChannel] } : {}),
              });
              return events.flatMap((ev) => {
                try {
                  const name = (JSON.parse(ev.content) as { name?: string }).name;
                  return name ? [{ name, pubkey: ev.pubkey }] : [];
                } catch {
                  return [];
                }
              });
            },
            addressEvents: (filter) => relay.query(filter),
            localAddress: (n) => {
              if (!isValidEntryName(n) || isReservedEntryName(n)) return undefined;
              const stored = readEntry(n);
              return stored ? pairFromStored(stored).address : undefined;
            },
          });
        }
      : undefined,
```

Add `const KIND_AGENT_METADATA = 47000;` beside the other kind constants in `consent.ts` and import it.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-wallet/src/tools.ts packages/fez-wallet/src/mcp.ts packages/fez-wallet/src/consent.ts packages/fez-wallet/tests/tools.test.ts packages/fez-wallet/tests/address-event.test.ts
git commit -m "wallet: send to an agent you don't hold the keys for

the name resolves through the roster to a published address, and the
payee's announced network is checked against ours before anything is
signed — that check is the whole reason testnet is safe to play on. a raw
address announces no network, so it can't be checked, and the card says
so rather than looking like it was"
```

---

### Task 7: The adapter learns which block it landed in

**Files:**
- Modify: `packages/fez-wallet/src/chains/adapter.ts`
- Modify: `packages/fez-wallet/src/chains/substrate.ts`
- Modify: `packages/fez-wallet/src/chains/evm.ts`
- Test: `packages/fez-wallet/tests/substrate.test.ts`

**Interfaces:**
- Produces:
  - `ChainAdapter.transfer` returns `{ txHash: string; blockRef?: string }`
  - `ChainAdapter.getTransfer?(blockRef: string, txHash: string): Promise<{ from: string; to: string; raw: bigint } | undefined>`

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/substrate.test.ts`, following the existing `apiFactory` fake pattern in that file:

```typescript
it("returns the block hash it landed in", async () => {
  const adapter = substrateAdapter({
    endpoint: "ws://fake",
    apiFactory: async () => fakeApi({ inBlock: "0xblock" }),
  });
  const result = await adapter.transfer(pair, "5Dest", { raw: 1n, decimals: 9, symbol: "TAO" });
  expect(result).toEqual({ txHash: "0xtx", blockRef: "0xblock" });
});

it("finds a transfer in its block and reports from/to/amount", async () => {
  const adapter = substrateAdapter({
    endpoint: "ws://fake",
    apiFactory: async () =>
      fakeApiWithBlock({
        blockHash: "0xblock",
        extrinsics: [{ hash: "0xtx", signer: "5From", args: ["5To", 5_000_000n] }],
      }),
  });
  expect(await adapter.getTransfer!("0xblock", "0xtx")).toEqual({
    from: "5From",
    to: "5To",
    raw: 5_000_000n,
  });
});

it("returns undefined when the block no longer has the extrinsic", async () => {
  const adapter = substrateAdapter({
    endpoint: "ws://fake",
    apiFactory: async () => fakeApiWithBlock({ blockHash: "0xblock", extrinsics: [] }),
  });
  expect(await adapter.getTransfer!("0xblock", "0xtx")).toBeUndefined();
});
```

Extend the file's existing fake-api helper so `signAndSend`'s callback carries `status.asInBlock` (returning `{ toHex: () => "0xblock" }`), and add `fakeApiWithBlock` exposing `rpc.chain.getBlock`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/substrate.test.ts`
Expected: FAIL — result has no `blockRef`; `getTransfer` is undefined.

- [ ] **Step 3: Implement**

In `adapter.ts`:

```typescript
export interface ChainAdapter {
  chain: string;
  assets: { symbol: string; decimals: number }[];
  address(pair: WalletPair): string;
  balance(address: string, asset: string): Promise<Amount>;
  /** `blockRef` is the block the transfer landed in — a plain block hash
   * on substrate. Carried so a receipt can be verified without an
   * indexer: substrate cannot look an extrinsic up by hash alone. */
  transfer(pair: WalletPair, to: string, amount: Amount): Promise<{ txHash: string; blockRef?: string }>;
  /** Undefined when the chain (or the retained history) can't answer.
   * Undefined means UNVERIFIABLE, never "invalid" — see spec §4. */
  getTransfer?(blockRef: string, txHash: string): Promise<{ from: string; to: string; raw: bigint } | undefined>;
}
```

In `substrate.ts`, resolve with the block hash:

```typescript
            } else if (r.status.isInBlock) {
              settle(() =>
                resolve({ txHash: r.txHash.toHex(), blockRef: r.status.asInBlock.toHex() })
              );
            }
```

and add the lookup:

```typescript
    async getTransfer(blockRef: string, txHash: string) {
      const a = await api();
      try {
        const block = await a.rpc.chain.getBlock(blockRef);
        for (const ex of block.block.extrinsics) {
          if (ex.hash.toHex() !== txHash) continue;
          const [dest, value] = ex.method.args;
          return {
            from: ex.signer.toString(),
            to: dest.toString(),
            raw: BigInt(value.toString()),
          };
        }
        return undefined;
      } catch {
        // Pruned, unreachable, or a block this node never had. The caller
        // must render this as unverifiable — not as a failed check.
        return undefined;
      }
    },
```

Leave `evm.ts` returning `{ txHash }` with no `blockRef` and no `getTransfer` — the stub stays a stub.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/substrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/chains/ packages/fez-wallet/tests/substrate.test.ts
git commit -m "wallet: carry the block a transfer landed in

substrate can't look an extrinsic up by hash alone, so a receipt that
named only the tx would need an indexer to check. the transfer already
settles at isInBlock, which means the block hash is sitting right there —
free, and enough to verify against a plain node. a lookup that can't
answer returns undefined, and undefined has to read as unverifiable
rather than as a failed check"
```

---

### Task 8: Receipts — kind 47040

**Files:**
- Create: `packages/fez-wallet/src/receipt.ts`
- Create: `packages/fez-wallet/tests/receipt.test.ts`
- Modify: `src/protocol/kinds.ts` (core)

**Interfaces:**
- Produces:
  - `KIND_PAYMENT_RECEIPT = 47040`
  - `buildReceipt(opts: { agentSecretHex: string; forEvent: string; payeePubkey?: string; channelId?: string; amount: Amount; chain: string; network: Network; txHash: string; blockRef?: string; memo?: string }): SignedNostrEvent`
  - `parseReceipt(ev: SignedNostrEvent): ParsedReceipt | undefined`
  - `verifyReceipt(r: ParsedReceipt, lookup): Promise<"verified" | "unverifiable" | "false">`

- [ ] **Step 1: Write the failing test**

Create `packages/fez-wallet/tests/receipt.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { buildReceipt, parseReceipt, verifyReceipt, KIND_PAYMENT_RECEIPT } from "../src/receipt.js";

const sk = bytesToHex(generateSecretKey());
const payee = getPublicKey(generateSecretKey());
const amount = { raw: 50_000_000n, decimals: 9, symbol: "TAO" };

function receipt(over: Partial<Parameters<typeof buildReceipt>[0]> = {}) {
  return buildReceipt({
    agentSecretHex: sk,
    forEvent: "msg1",
    payeePubkey: payee,
    channelId: "chan1",
    amount,
    chain: "tao",
    network: "test",
    txHash: "0xtx",
    blockRef: "0xblock",
    ...over,
  });
}

describe("payment receipt", () => {
  it("binds the payment to the message it paid for", () => {
    const ev = receipt();
    expect(ev.kind).toBe(KIND_PAYMENT_RECEIPT);
    expect(ev.tags).toContainEqual(["e", "msg1"]);
    expect(ev.tags).toContainEqual(["p", payee]);
    expect(ev.tags).toContainEqual(["h", "chan1"]);
  });

  it("carries the amount as an integer string, never a decimal", () => {
    expect(receipt().tags).toContainEqual(["amount", "50000000"]);
  });

  it("round-trips through parse", () => {
    const p = parseReceipt(receipt())!;
    expect(p.forEvent).toBe("msg1");
    expect(p.raw).toBe(50_000_000n);
    expect(p.network).toBe("test");
    expect(p.txHash).toBe("0xtx");
    expect(p.blockRef).toBe("0xblock");
  });

  it("verifies against the chain", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5Payer", to: "5Payee", raw: 50_000_000n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("verified");
  });

  it("calls a tampered amount false", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5Payer", to: "5Payee", raw: 1n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("false");
  });

  it("calls a payment to a different address false", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5Payer", to: "5Someone", raw: 50_000_000n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("false");
  });

  it("calls a pruned block unverifiable, NOT false", async () => {
    const p = parseReceipt(receipt())!;
    expect(await verifyReceipt(p, async () => undefined, { from: "5Payer", to: "5Payee" })).toBe(
      "unverifiable"
    );
  });

  it("calls a receipt with no block unverifiable", async () => {
    const p = parseReceipt(receipt({ blockRef: undefined }))!;
    expect(await verifyReceipt(p, async () => undefined, { from: "5Payer", to: "5Payee" })).toBe(
      "unverifiable"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/receipt.test.ts`
Expected: FAIL — cannot find `../src/receipt.js`.

- [ ] **Step 3: Implement**

Create `packages/fez-wallet/src/receipt.ts`:

```typescript
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { SignedNostrEvent } from "./consent.js";
import type { Network } from "./storage-mirror.js";
import type { Amount } from "./chains/adapter.js";

/**
 * A payment, bound to the message that earned it. Substrate transfers
 * carry no memo, so this link cannot live on-chain — it has to be an
 * off-chain event. Unlike a NIP-57 zap receipt it needs no trusted
 * signer: the transfer is public, so anyone can check this against the
 * block and a forgery fails.
 */
export const KIND_PAYMENT_RECEIPT = 47040;

export interface ParsedReceipt {
  payer: string;
  forEvent?: string;
  payee?: string;
  channelId?: string;
  raw: bigint;
  symbol: string;
  chain: string;
  network: Network;
  txHash: string;
  blockRef?: string;
  memo: string;
}

export function buildReceipt(opts: {
  agentSecretHex: string;
  forEvent?: string;
  payeePubkey?: string;
  channelId?: string;
  amount: Amount;
  chain: string;
  network: Network;
  txHash: string;
  blockRef?: string;
  memo?: string;
}): SignedNostrEvent {
  const tags: string[][] = [
    ["amount", opts.amount.raw.toString()],
    ["asset", opts.amount.symbol],
    ["chain", opts.chain],
    ["network", opts.network],
    ["tx", opts.txHash],
  ];
  if (opts.forEvent) tags.unshift(["e", opts.forEvent]);
  if (opts.payeePubkey) tags.push(["p", opts.payeePubkey]);
  if (opts.channelId) tags.push(["h", opts.channelId]);
  if (opts.blockRef) tags.push(["block", opts.blockRef]);
  return finalizeEvent(
    { kind: KIND_PAYMENT_RECEIPT, created_at: Math.floor(Date.now() / 1000), tags, content: opts.memo ?? "" },
    hexToBytes(opts.agentSecretHex)
  );
}

export function parseReceipt(ev: SignedNostrEvent): ParsedReceipt | undefined {
  if (ev.kind !== KIND_PAYMENT_RECEIPT) return undefined;
  const tag = (k: string) => ev.tags.find((t) => t[0] === k)?.[1];
  const amount = tag("amount");
  const txHash = tag("tx");
  const chain = tag("chain");
  const network = tag("network") as Network | undefined;
  if (!amount || !/^\d+$/.test(amount) || !txHash || !chain || !network) return undefined;
  return {
    payer: ev.pubkey,
    forEvent: tag("e"),
    payee: tag("p"),
    channelId: tag("h"),
    raw: BigInt(amount),
    symbol: tag("asset") ?? "TAO",
    chain,
    network,
    txHash,
    blockRef: tag("block"),
    memo: ev.content,
  };
}

/**
 * "unverifiable" is NOT "false". A pruned block, an unreachable node or a
 * receipt with no block reference all mean we could not look, and a UI
 * that renders those the same as a failed check is lying about which one
 * happened (spec §4).
 */
export async function verifyReceipt(
  r: ParsedReceipt,
  lookup: (blockRef: string, txHash: string) => Promise<{ from: string; to: string; raw: bigint } | undefined>,
  expected: { from: string; to: string }
): Promise<"verified" | "unverifiable" | "false"> {
  if (!r.blockRef) return "unverifiable";
  const onChain = await lookup(r.blockRef, r.txHash);
  if (!onChain) return "unverifiable";
  const matches =
    onChain.raw === r.raw && onChain.to === expected.to && onChain.from === expected.from;
  return matches ? "verified" : "false";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/receipt.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the kind in core**

In `src/protocol/kinds.ts`, beside `KIND_TURN_METRIC` (line ~37):

```typescript
/** A payment, e-tagged to the message it paid for. Signed by the payer;
 * verifiable by anyone against the block it names. */
export const KIND_PAYMENT_RECEIPT = 47040;
```

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet/src/receipt.ts packages/fez-wallet/tests/receipt.test.ts src/protocol/kinds.ts
git commit -m "wallet: a receipt binds a payment to the message that earned it (47040)

a transfer carries no memo, so the link has to live off-chain. unlike a
nip-57 zap receipt this one needs no trusted signer — the transfer is
public, so a forgery fails against the block. the distinction the whole
thing turns on: a pruned block is UNVERIFIABLE, not false, and the two
are separate return values so no ui can collapse them into one badge"
```

---

### Task 9: `wallet_send` gains `for`, and publishes the receipt

**Files:**
- Modify: `packages/fez-wallet/src/tools.ts`
- Modify: `packages/fez-wallet/src/mcp.ts`
- Test: `packages/fez-wallet/tests/tools.test.ts`

**Interfaces:**
- Consumes: `buildReceipt`, `Resolved`.
- Produces: `walletSend(deps, args: { to, amount, asset, memo?, for?: string })`

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/tools.test.ts`:

```typescript
import { parseReceipt } from "../src/receipt.js";

describe("receipts", () => {
  function relayCapturing(published: SignedNostrEvent[]) {
    const relay: ConsentRelay = {
      publish: async (ev) => { published.push(ev); },
      subscribe: () => () => {},
      query: async () => [],
    };
    return () => Promise.resolve(relay);
  }

  it("publishes a receipt e-tagged to the paid-for message", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    const published: SignedNostrEvent[] = [];
    await walletSend(
      {
        ...baseDeps(adapter),
        agentNostrKey,
        relay: relayCapturing(published),
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }),
      },
      { to: "@chip", amount: "0.001", asset: "TAO", for: "msg1" }
    );
    const r = published.map(parseReceipt).find(Boolean)!;
    expect(r.forEvent).toBe("msg1");
    expect(r.raw).toBe(1_000_000n);
    expect(r.txHash).toBe("0xfeed");
  });

  it("publishes no receipt when no message was named", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    const published: SignedNostrEvent[] = [];
    await walletSend(
      { ...baseDeps(adapter), agentNostrKey, relay: relayCapturing(published), resolve: async () => ({ address: "5Raw", via: "raw" }) },
      { to: "5Raw", amount: "0.001", asset: "TAO" }
    );
    expect(published.map(parseReceipt).filter(Boolean)).toHaveLength(0);
  });

  it("keeps the transfer when the receipt fails to publish, and says so", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    const failing: ConsentRelay = {
      publish: async () => { throw new Error("relay down"); },
      subscribe: () => () => {},
      query: async () => [],
    };
    const out = await walletSend(
      {
        ...baseDeps(adapter),
        agentNostrKey,
        relay: () => Promise.resolve(failing),
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent" }),
      },
      { to: "@chip", amount: "0.001", asset: "TAO", for: "msg1" }
    );
    expect(transfers).toHaveLength(1);
    expect(out).toMatch(/receipt/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/tools.test.ts`
Expected: FAIL — `for` is not accepted; no receipt is published.

- [ ] **Step 3: Implement**

In `walletSend`, after the transfer succeeds and the ledger row is written:

```typescript
  let receiptNote = "";
  if (args.for && deps.relay && deps.agentNostrKey) {
    try {
      const relay = await deps.relay();
      await relay.publish(
        buildReceipt({
          agentSecretHex: deps.agentNostrKey,
          forEvent: args.for,
          payeePubkey: resolved.payeePubkey,
          channelId: deps.config.consentChannel,
          amount,
          chain: a.chain,
          network: deps.config.network,
          txHash,
          blockRef,
          memo: args.memo,
        })
      );
    } catch {
      // The money moved; the note about it did not. Two separate facts,
      // and a failed event must never provoke a retried transfer.
      receiptNote = " (the receipt failed to publish — the transfer stands)";
    }
  }
```

Return the existing success string with `receiptNote` appended. Add `payeePubkey?: string` to `Resolved` and set it in `resolveRecipient`'s agent branch (`matches[0].pubkey`) — update the `via: "agent"` assertion in `resolve.test.ts` to expect it.

In `mcp.ts`, extend the `wallet_send` input schema:

```typescript
      for: z
        .string()
        .optional()
        .describe("Id of the message this pays for — the payment shows under it in chat."),
```

and thread it through: `walletSend(await deps(extra.signal), { to, amount, asset, memo, for: forEvent })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/`
Expected: PASS across the whole wallet suite.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/tools.ts packages/fez-wallet/src/mcp.ts packages/fez-wallet/tests/tools.test.ts packages/fez-wallet/tests/resolve.test.ts
git commit -m "wallet: name the message a payment is for, and publish the receipt

one optional argument the agent fills in and a human never types. a
failed publish leaves the transfer standing and says so — the money
moving and the note about it are separate facts, and conflating them is
how you end up retrying a transfer because an event didn't land"
```

---

### Task 10: Inbound receipts in `wallet_history`

**Files:**
- Modify: `packages/fez-wallet/src/tools.ts`
- Test: `packages/fez-wallet/tests/tools.test.ts`

**Interfaces:**
- Produces: `walletHistory` merges local outbound rows with inbound receipts p-tagging this agent, each labelled by verification state.

- [ ] **Step 1: Write the failing test**

```typescript
describe("wallet_history", () => {
  it("shows inbound receipts p-tagging me, marked unverified until checked", async () => {
    const { adapter } = fakeAdapter(0n);
    const incoming = buildReceipt({
      agentSecretHex: bytesToHex(generateSecretKey()),
      forEvent: "msg1",
      payeePubkey: agentPubkey, // baseDeps' agent nostr pubkey
      amount: { raw: 50_000_000n, decimals: 9, symbol: "TAO" },
      chain: "tao",
      network: "test",
      txHash: "0xin",
    });
    const relay: ConsentRelay = {
      publish: async () => {},
      subscribe: () => () => {},
      query: async () => [incoming],
    };
    const out = await walletHistory(
      { ...baseDeps(adapter), agentNostrKey, relay: () => Promise.resolve(relay) },
      { limit: 10 }
    );
    expect(out).toMatch(/0\.05 TAO/);
    expect(out).toMatch(/unverified/i);
  });

  it("still works with no relay at all", async () => {
    const { adapter } = fakeAdapter(0n);
    expect(await walletHistory({ ...baseDeps(adapter) }, { limit: 10 })).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/tools.test.ts`
Expected: FAIL — `walletHistory` is sync and reads only the local log.

- [ ] **Step 3: Implement**

Make `walletHistory` async, keep the local rows, and append inbound ones:

```typescript
export async function walletHistory(deps: ToolDeps, args: { limit?: number }): Promise<string> {
  const limit = args.limit ?? 20;
  const rows = readLog(deps.config.network, limit).map(
    (e) => `${e.ts}  ${e.direction === "in" ? "←" : "→"} ${e.to}  ${e.amount} ${e.asset}  (${e.consent})`
  );

  const inbound: string[] = [];
  if (deps.relay && deps.agentNostrKey) {
    try {
      const relay = await deps.relay();
      const me = getPublicKey(hexToBytes(deps.agentNostrKey));
      const events = await relay.query({ kinds: [KIND_PAYMENT_RECEIPT], "#p": [me], limit });
      for (const ev of events) {
        const r = parseReceipt(ev);
        if (!r || r.network !== deps.config.network) continue;
        // Not verified here: verification costs a chain round-trip per
        // row. Unverified is stated, never implied — an inbound row is
        // never counted as settled on the strength of the event alone.
        inbound.push(
          `${new Date(ev.created_at * 1000).toISOString()}  ← from ${r.payer.slice(0, 12)}…  ` +
            `${formatAmount({ raw: r.raw, decimals: 9, symbol: r.symbol })}  (unverified)`
        );
      }
    } catch {
      // A relay that won't answer costs you the inbound half, not the call.
    }
  }

  const all = [...rows, ...inbound];
  return all.length ? all.join("\n") : "no transfers yet";
}
```

Update `mcp.ts`'s `wallet_history` handler to `await` it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/tools.ts packages/fez-wallet/src/mcp.ts packages/fez-wallet/tests/tools.test.ts
git commit -m "wallet: history shows what came in, not just what went out

the chain can tell a payee its balance moved; it cannot tell it what for.
the receipts p-tagging an agent carry that, so they belong in its
history — labelled unverified, because verifying costs a chain round-trip
per row and an unverified row must never read as settled"
```

---

### Task 11: A card the first time you pay someone new

**Files:**
- Modify: `packages/fez-wallet/src/config.ts` (`knownPayees`)
- Modify: `packages/fez-wallet/src/tools.ts`
- Test: `packages/fez-wallet/tests/tools.test.ts`

**Interfaces:**
- Produces: `WalletConfig.knownPayees: string[]` (payee **pubkeys**, not names); `rememberPayee(config, pubkey): void`

- [ ] **Step 1: Write the failing test**

```typescript
describe("new payee consent", () => {
  it("asks the first time, even under the threshold", async () => {
    const { adapter, transfers } = fakeAdapter(1_000_000_000n);
    let asked = false;
    const relay = autoRelay((ev) => { asked = true; return "✅"; });
    await walletSend(
      {
        ...baseDeps(adapter),
        ownerPk,
        agentNostrKey,
        relay: () => Promise.resolve(relay.relay),
        resolve: async () => ({ address: "5Chip", network: "test", via: "agent", payeePubkey: "chippk" }),
      },
      { to: "@chip", amount: "0.0001", asset: "TAO" } // well under the 0.01 threshold
    );
    expect(asked).toBe(true);
    expect(transfers).toHaveLength(1);
  });

  it("does not ask again once that payee is known", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    let asks = 0;
    const relay = autoRelay(() => { asks++; return "✅"; });
    const deps = {
      ...baseDeps(adapter),
      ownerPk,
      agentNostrKey,
      relay: () => Promise.resolve(relay.relay),
      resolve: async () => ({ address: "5Chip", network: "test", via: "agent", payeePubkey: "chippk" }),
    };
    const args = { to: "@chip", amount: "0.0001", asset: "TAO" };
    await walletSend(deps, args);
    await walletSend(deps, args);
    expect(asks).toBe(1);
  });

  it("keys on the pubkey, not the name — a name is not an identity", async () => {
    const { adapter } = fakeAdapter(1_000_000_000n);
    let asks = 0;
    const relay = autoRelay(() => { asks++; return "✅"; });
    const base = { ...baseDeps(adapter), ownerPk, agentNostrKey, relay: () => Promise.resolve(relay.relay) };
    await walletSend(
      { ...base, resolve: async () => ({ address: "5A", network: "test", via: "agent", payeePubkey: "pkA" }) },
      { to: "@chip", amount: "0.0001", asset: "TAO" }
    );
    await walletSend(
      { ...base, resolve: async () => ({ address: "5B", network: "test", via: "agent", payeePubkey: "pkB" }) },
      { to: "@chip", amount: "0.0001", asset: "TAO" }
    );
    expect(asks).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/tools.test.ts`
Expected: FAIL — no card is posted for a sub-threshold send.

- [ ] **Step 3: Implement**

In `config.ts`, add `knownPayees: string[]` to `WalletConfig` (default `[]`) and:

```typescript
export function rememberPayee(c: WalletConfig, pubkey: string): void {
  if (!c.knownPayees.includes(pubkey)) c.knownPayees = [...c.knownPayees, pubkey];
}
```

In `walletSend`, widen the condition that triggers consent:

```typescript
  // The threshold answers "how much". A payee you have never paid raises
  // "to whom", which no amount can answer — so the first payment to a
  // given pubkey shows a card whatever its size, and only the first.
  const newPayee =
    resolved.payeePubkey !== undefined && !deps.config.knownPayees.includes(resolved.payeePubkey);
  const needsConsent = amount.raw > threshold.raw || newPayee;
```

Use `needsConsent` where `amount.raw > threshold.raw` was, and after an approval:

```typescript
    if (resolved.payeePubkey) {
      rememberPayee(deps.config, resolved.payeePubkey);
      saveConfig(deps.config);
    }
```

Include the reason in the consent text when it is a new payee: prepend a line `first payment to this agent`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/config.ts packages/fez-wallet/src/tools.ts packages/fez-wallet/tests/tools.test.ts
git commit -m "wallet: the first payment to a new agent asks, whatever the size

the threshold answers how much and says nothing about to whom. keyed on
the pubkey rather than the name, because two owners can both run a chip
and only one of them is the one you meant. once per counterparty, then
the threshold governs again"
```

---

### Task 12: The prefs write seam in core

**Files:**
- Modify: `packages/fez-desktop/src-tauri/src/lib.rs`
- Modify: `packages/fez-desktop/src/gui-extensions.ts`
- Modify: `packages/fez-extension-api/src/gui.ts`
- Test: `packages/fez-evals/tests/extension-storage.test.ts`

**Interfaces:**
- Produces:
  - Rust `extension_storage_write(name: String, key: String, value: String) -> Result<(), String>` — writes only under the file's `prefs` object
  - `GuiApi.prefs: { get<T>(key): Promise<T | undefined>; set(key, value): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-evals/tests/extension-storage.test.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";

/**
 * Inventory completeness, after Buzz's egress guard: this asserts over
 * FUTURE code, not just today's. Any new Tauri command that writes the
 * extension-data directory must go through the prefs-scoped helper, or
 * the subtree scoping is not a rule — it is a habit.
 */
describe("extension-data write inventory", () => {
  const libRs = fs.readFileSync(
    path.join(__dirname, "../../fez-desktop/src-tauri/src/lib.rs"),
    "utf-8"
  );

  it("has exactly one command writing extension-data", () => {
    // Commands that name the directory AND write it.
    const writers = libRs
      .split("#[tauri::command]")
      .slice(1)
      .filter((body) => body.includes("extension-data") && /fs::write|write_all|OpenOptions/.test(body))
      .map((body) => /fn\s+(\w+)/.exec(body)?.[1]);
    expect(writers).toEqual(["extension_storage_write"]);
  });

  it("scopes that command to the prefs subtree", () => {
    const body = libRs.split("fn extension_storage_write")[1].split("#[tauri::command]")[0];
    expect(body).toContain("\"prefs\"");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-evals/tests/extension-storage.test.ts`
Expected: FAIL — `writers` is `[]`, not `["extension_storage_write"]`.

- [ ] **Step 3: Implement the Rust command**

In `lib.rs`, directly below `extension_storage_read`:

```rust
/// Write ONE key under an extension's `prefs` object
/// (~/.fez/extension-data/<name>.json). Name validation mirrors
/// `extension_storage_read` verbatim.
///
/// Scoped to `prefs` on purpose: the CLI rewrites the rest of this file
/// on every spend, so a webview writing those keys would race it and
/// drop ledger rows. This is a correctness boundary — gui parts run in
/// the page and can reach every command regardless, so it is not, and
/// must not be described as, a security boundary.
#[tauri::command]
fn extension_storage_write(name: String, key: String, value: String) -> Result<(), String> {
    let ok_first = name
        .chars()
        .next()
        .map(|c| c.is_ascii_alphanumeric())
        .unwrap_or(false);
    let ok_rest = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok_first || !ok_rest || name.contains("..") {
        return Err(format!("invalid extension name: {name}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&value).map_err(|e| format!("invalid value json: {e}"))?;
    let home = std::env::var("HOME").map_err(|_| "no HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".fez").join("extension-data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{name}.json"));
    let mut state: serde_json::Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !state.is_object() {
        state = serde_json::json!({});
    }
    state["prefs"]
        .as_object_mut()
        .is_none()
        .then(|| state["prefs"] = serde_json::json!({}));
    state["prefs"][key] = parsed;
    std::fs::write(&file, serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
```

Add `extension_storage_write` to the `invoke_handler!` list beside `extension_storage_read`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest --run packages/fez-evals/tests/extension-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `prefs` to the gui api**

In `packages/fez-extension-api/src/gui.ts`, below `storage`:

```typescript
  /**
   * This extension's own preferences — the one part of its state file a
   * gui part may write. Mirrored state (`storage`) stays read-only: the
   * headless side rewrites it and a shared key would race.
   */
  prefs: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
```

In `packages/fez-desktop/src/gui-extensions.ts`, beside the `storage` implementation:

```typescript
      prefs: {
        get: async <T = unknown>(key: string): Promise<T | undefined> => {
          try {
            const raw = await invoke<string>("extension_storage_read", { name });
            const data = JSON.parse(raw) as { prefs?: Record<string, unknown> };
            return data.prefs?.[key] as T | undefined;
          } catch {
            return undefined;
          }
        },
        set: async (key: string, value: unknown): Promise<void> => {
          await invoke("extension_storage_write", { name, key, value: JSON.stringify(value) });
        },
      },
```

- [ ] **Step 6: Verify it compiles and commit**

Run: `cd packages/fez-desktop && npx tsc --noEmit && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: both clean.

```bash
git add packages/fez-desktop/src-tauri/src/lib.rs packages/fez-desktop/src/gui-extensions.ts packages/fez-extension-api/src/gui.ts packages/fez-evals/tests/extension-storage.test.ts
git commit -m "desktop: extensions can persist a preference

gui parts could render state and never change any, so no settings panel
could hold a setting. api.prefs is a second narrow channel rather than a
widened storage.set: the cli rewrites the mirrored file on every spend,
and sharing those keys with the webview would race it.

the inventory test is the part worth keeping — borrowed from buzz's
egress guard, it asserts over every command that writes extension-data,
so a future one that skips the prefs helper fails the build instead of
quietly becoming the hole the scoping existed to close"
```

---

### Task 13: The panel gets a network selector and a threshold

**Files:**
- Modify: `packages/fez-wallet/src/gui.ts` (`WalletPanel`, ~line 354)
- Modify: `packages/fez-wallet/src/gui-logic.ts`
- Test: `packages/fez-wallet/tests/gui-logic.test.ts`

**Interfaces:**
- Consumes: `api.prefs`, `endpointFor`.
- Produces: `nextPrefs(current, change)` — the pure part; the React shell stays thin.

- [ ] **Step 1: Write the failing test**

Append to `packages/fez-wallet/tests/gui-logic.test.ts`:

```typescript
import { networkLabel, validThreshold } from "../src/gui-logic.js";

describe("wallet panel logic", () => {
  it("marks anything that is not mainnet", () => {
    expect(networkLabel("test")).toMatch(/play money/i);
    expect(networkLabel("finney")).not.toMatch(/play money/i);
  });

  it("accepts a plain decimal threshold", () => {
    expect(validThreshold("0.05")).toBe(true);
    expect(validThreshold("1")).toBe(true);
  });

  it("rejects anything that isn't one", () => {
    expect(validThreshold("")).toBe(false);
    expect(validThreshold("-1")).toBe(false);
    expect(validThreshold("0.0000000001")).toBe(false); // more than 9 decimals
    expect(validThreshold("abc")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/gui-logic.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement the pure part**

In `gui-logic.ts`:

```typescript
export function networkLabel(network: string): string {
  return network === "finney" ? "finney (mainnet)" : `${network} — play money`;
}

/** Same shape parseAmount accepts, checked before it reaches the wallet:
 * a decimal with at most TAO's 9 places. */
export function validThreshold(text: string): boolean {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  return !!m && (m[2]?.length ?? 0) <= 9;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/gui-logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the panel**

In `gui.ts`'s `WalletPanel`, add state and controls above the balances block:

```typescript
    const [network, setNetwork] = useState<string>("finney");
    const [threshold, setThreshold] = useState<string>("0.01");

    useEffect(() => {
      void api.prefs.get<string>("network").then((n) => setNetwork(n ?? "finney"));
      void api.prefs
        .get<Record<string, string>>("thresholds")
        .then((t) => setThreshold(t?.default ?? "0.01"));
    }, []);

    const onNetwork = useCallback(async (next: string) => {
      setNetwork(next);
      await api.prefs.set("network", next);
    }, []);

    const onThreshold = useCallback(async (next: string) => {
      setThreshold(next);
      if (validThreshold(next)) await api.prefs.set("thresholds", { default: next });
    }, []);
```

Render a `<select>` over `["finney", "test"]` labelled with `networkLabel(network)`, and a text input bound to `threshold` marked invalid when `!validThreshold(threshold)`. Keep the existing endpoint-driven balance effect — it already re-reads when `endpoint` changes, and the wallet mirrors the derived endpoint down on the next CLI or tool call.

Note in a comment that balances follow the mirrored `endpoint`, so the selector's effect appears once the wallet side next mirrors — the panel does not connect to a chain the wallet has not adopted.

- [ ] **Step 6: Build and commit**

Run: `cd packages/fez-wallet && npm run build && npm run check`
Expected: clean.

```bash
git add packages/fez-wallet/src/gui.ts packages/fez-wallet/src/gui-logic.ts packages/fez-wallet/tests/gui-logic.test.ts
git commit -m "wallet: pick your network in settings, and the threshold with it

switching chains was a json edit and a restart. the two settings a person
actually changes are the two that are here, and anything that isn't
mainnet says play money next to it — the panel should be the last place
you'd confuse the two"
```

---

### Task 14: The bolt under the message

**Files:**
- Modify: `packages/fez-wallet/src/gui.ts`
- Test: `packages/fez-wallet/tests/gui-logic.test.ts`

**Interfaces:**
- Consumes: `parseReceipt`.
- Produces: `receiptLine(r: ParsedReceipt, state: "verified" | "unverifiable" | "false"): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { receiptLine } from "../src/gui-logic.js";

describe("receipt rendering", () => {
  const base = { raw: 50_000_000n, symbol: "TAO", payer: "abc123def456", network: "test" as const };

  it("shows the amount and who paid", () => {
    expect(receiptLine(base as never, "verified")).toMatch(/0\.05 TAO/);
  });

  it("distinguishes unverifiable from false — they are not the same thing", () => {
    const unver = receiptLine(base as never, "unverifiable");
    const wrong = receiptLine(base as never, "false");
    expect(unver).toMatch(/couldn't check/i);
    expect(wrong).toMatch(/does not match/i);
    expect(unver).not.toEqual(wrong);
  });

  it("does not decorate a verified receipt with a caveat", () => {
    expect(receiptLine(base as never, "verified")).not.toMatch(/couldn't check|does not match/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest --run packages/fez-wallet/tests/gui-logic.test.ts`
Expected: FAIL — `receiptLine` is not exported.

- [ ] **Step 3: Implement**

In `gui-logic.ts`:

```typescript
import type { ParsedReceipt } from "./receipt.js";
import { formatAmount } from "./chains/adapter.js";

/** Three states, never two: a block we could not fetch is not a check
 * that failed, and collapsing them would call an honest receipt a lie. */
export function receiptLine(r: ParsedReceipt, state: "verified" | "unverifiable" | "false"): string {
  const amount = formatAmount({ raw: r.raw, decimals: 9, symbol: r.symbol });
  const who = `${r.payer.slice(0, 8)}…`;
  const suffix =
    state === "verified"
      ? ""
      : state === "unverifiable"
        ? " · couldn't check this block"
        : " · ⚠️ the chain does not match this receipt";
  return `⚡ ${amount} · ${who}${suffix}`;
}
```

In `gui.ts`, register a decorator over receipt events. The existing `registerMessageDecorator` matches on message content, so receipts reach the panel through the client's event stream: subscribe via `api.client` for `KIND_PAYMENT_RECEIPT` events e-tagging visible messages, and render `receiptLine` beneath the matching bubble. Render `unverifiable` initially and upgrade to `verified` only once a chain check returns — never the reverse.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest --run packages/fez-wallet/tests/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/gui.ts packages/fez-wallet/src/gui-logic.ts packages/fez-wallet/tests/gui-logic.test.ts
git commit -m "wallet: a payment shows up under the message that earned it

three states and not two. a block we couldn't fetch is not a check that
failed, and rendering them the same would call an honest receipt a lie —
so unverified is what it says, and only a real mismatch gets the warning"
```

---

### Task 15: The runbook

**Files:**
- Modify: `packages/fez-wallet/README.md`

- [ ] **Step 1: Rewrite the testnet section**

Replace the "Testnet e2e (before real TAO)" section with a two-machine runbook:

```markdown
## Networks

    fez-wallet network            # which chain am I on
    fez-wallet network test       # testnet — play money
    fez-wallet network finney     # mainnet — real TAO

Keys are the same on both chains; balances, history and the ledger are
not. An explicit `endpoints.tao` in `wallet.json` still wins, for a local
node or a fork.

## Paying another owner's agent (two machines)

1. Both sides: `fez-wallet network test`, then `init` / `derive` / `fund`.
2. Both agents run once so each publishes its address event.
3. From one agent: `wallet_send` to `@theirname`, naming the message it
   pays for. Approve the card.
4. The bolt appears under that message on BOTH screens.
5. `fez-wallet status` and `wallet_history` reconcile to the chain on
   both sides.

Failure paths worth walking once: an agent that has published no address,
a payee on the other network, and a card left to time out.

No real TAO until this passes end to end.
```

- [ ] **Step 2: Add the resolution and receipt sections**

Document the four resolution tiers from spec §1 (noting that an unknown name falls through to a raw address), the `for` argument, and that a pruned block makes a receipt unverifiable rather than invalid.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-wallet/README.md
git commit -m "wallet: document networks, resolution and receipts

the testnet runbook was a single-machine rehearsal; paying another owner
needs two, so that's what it walks through now — including the three
failure paths worth seeing once before any of this touches real tao"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 resolution fall-through, ambiguity, roster scope | 5, 6 |
| §2 address event 30175, lazy publish | 4; publish wired in 6's `mcp.ts` resolver |
| §3 network mode, derived endpoint, per-network ledger, guard | 1, 2, 3, 6 |
| §4 receipts 47040, blockRef verification, unverifiable ≠ invalid | 7, 8, 9, 14 |
| §5 consent, `knownPayees` by pubkey | 11 |
| §6 prefs seam, panel, correctness-not-security framing | 12, 13 |
| §7 files | all |
| §8 errors | 5 (no address, ambiguous), 6 (network mismatch), 9 (receipt publish fails) |
| §9 testing incl. inventory test | 12; two-machine gate in 15 |
| §10 non-goals | nothing built |

**Gap found and closed:** §2 requires the address event to be *published*, and no task owned it — building and parsing one (Task 4) is not the same as announcing it. Task 6 gained an explicit step 5 for it: lazy, once per process, unawaited, and silent on failure, since an agent that cannot announce where to be paid must still be able to pay.

**Type consistency:** `Network` is defined once in `storage-mirror.ts` and re-exported from `config.ts`; `Resolved.payeePubkey` is added in Task 9 and consumed in Task 11; `ChainAdapter.transfer`'s widened return is introduced in Task 7 and consumed in Task 9; `readLog(network, limit)` changes signature in Task 2 and every caller is fixed in that task's step 5.

**Known risk carried from the spec:** receipt verification depends on the endpoint retaining the block. Task 8 returns `"unverifiable"` for that case and Task 14 renders it distinctly — the limitation is surfaced, not hidden.
