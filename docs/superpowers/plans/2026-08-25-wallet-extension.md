# @fezchat/wallet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-agent crypto allowance wallets for fez agents — HD-derived from one master mnemonic, TAO live, EVM stubbed, threshold consent over existing nostr kinds.

**Architecture:** A fez extension package (`packages/fez-wallet`) with two entry points: an MCP server (`dist/mcp.js`, the skill part) that runs inside each agent's harness env and exposes wallet tools scoped to that agent's derived account, and a CLI (`dist/cli.js`, npm bin `fez-wallet`) that owns the mnemonic ceremony and treasury funding. A `ChainAdapter` interface isolates chains; only the substrate adapter is live. Consent for over-threshold sends rides kind 47103 (request message) + kind 7 (owner-signed ✅/❌ reaction) — no new event kinds.

**Tech Stack:** TypeScript (plain, esbuild-bundled like sibling packages), `@polkadot/api` + `@polkadot/util-crypto` + `@polkadot/keyring` (sr25519, finney), `nostr-tools` (events/relay), `@modelcontextprotocol/sdk` + `zod` (MCP), vitest (tests).

**Spec:** `docs/superpowers/specs/2026-08-25-wallet-extension-design.md`

**Working directory:** the git worktree `/Users/ken/Projects/fez-wallet-wt`, branch `wallet-extension`. All paths below are relative to that root. Never touch `packages/fez-desktop` (another agent owns it).

## Global Constraints

- `minFezVersion: "0.2.0"` in the fez manifest.
- Keychain service is exactly `fez-wallet` (NOT `fez-keys`); entry `root` holds the mnemonic; entry `<persona>` holds that agent's derived pair JSON.
- `src/mcp.ts` (and anything it imports) must never reference the `root` keychain entry — the literal string `"root"` as an entry name may appear only in `cli-commands.ts` (invariant 1 of the spec).
- Key selection in the MCP server comes only from `process.env.FEZ_AGENT_PERSONA` — never from tool arguments (invariant 2).
- TAO has 9 decimals (1 TAO = 1e9 rao). Default consent threshold `"0.01"` TAO.
- Transfers use `balances.transferKeepAlive`, never `transfer`/`transferAllowDeath`.
- All new code lives in `packages/fez-wallet/`; no core-repo files are modified.
- Commits: plain messages, NO Claude co-author/session trailers.
- Test/typecheck commands run from `packages/fez-wallet`: `npm test` (vitest --run), `npm run check` (tsc --noEmit).
- Tests must not touch the real macOS keychain or `~/.fez`: every module that reads keychain/config/log honors the env overrides defined in its task (`FEZ_WALLET_STORE=file`, `FEZ_WALLET_HOME=<tmpdir>`), and tests always set them.

---

### Task 1: Package scaffold + derivation module

**Files:**
- Create: `packages/fez-wallet/package.json`
- Create: `packages/fez-wallet/tsconfig.json`
- Create: `packages/fez-wallet/src/derive.ts`
- Test: `packages/fez-wallet/tests/derive.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces (for Tasks 4, 7, 8):
  - `generateWalletMnemonic(): string` — 24-word BIP-39.
  - `deriveAgentPair(mnemonic: string, persona: string): WalletPair` — sr25519 hard path `//<persona>`.
  - `treasuryPair(mnemonic: string): WalletPair` — the base (undived) account.
  - `type WalletPair = { publicKeyHex: string; secretKeyHex: string; address: string }` — hex WITHOUT `0x` prefix; `address` is SS58 prefix 42.
  - `pairFromStored(json: string): WalletPair` — parse a keychain-stored pair back.

- [ ] **Step 1: Scaffold the package**

`packages/fez-wallet/package.json`:

```jsonc
{
  "name": "@fezchat/wallet",
  "version": "0.1.0",
  "private": true,
  "description": "Per-agent allowance wallets for fez — HD-derived accounts from one master mnemonic, TAO live (EVM later), threshold consent via owner-signed reactions. The balance IS the cap.",
  "type": "module",
  "bin": { "fez-wallet": "dist/cli.js" },
  "fez": {
    "type": "extension",
    "parts": { "skill": { "command": "node", "args": ["dist/mcp.js"] } },
    "permissions": [
      "network:entrypoint-finney.opentensor.ai",
      "network:relay",
      "publish"
    ],
    "minFezVersion": "0.2.0"
  },
  "scripts": {
    "build": "esbuild src/mcp.ts src/cli.ts --bundle --format=esm --platform=node --banner:js=\"import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);\" --outdir=dist",
    "check": "tsc --noEmit",
    "test": "vitest --run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@polkadot/api": "^16.5.6",
    "@polkadot/keyring": "^13.2.3",
    "@polkadot/util": "^13.2.3",
    "@polkadot/util-crypto": "^13.2.3",
    "nostr-tools": "^2.10.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "esbuild": "^0.21.5",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "files": ["dist"]
}
```

`packages/fez-wallet/tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

Run: `cd packages/fez-wallet && npm install` (also add `@types/node` to devDependencies if tsc complains about `process`).

- [ ] **Step 2: Write the failing derivation test**

`packages/fez-wallet/tests/derive.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import {
  generateWalletMnemonic,
  deriveAgentPair,
  treasuryPair,
  pairFromStored,
} from "../src/derive.js";

// Substrate's canonical dev mnemonic — public knowledge, safe in tests.
const DEV_MNEMONIC =
  "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

beforeAll(async () => {
  await cryptoWaitReady();
});

describe("derivation", () => {
  it("generates a 24-word mnemonic", () => {
    expect(generateWalletMnemonic().split(" ")).toHaveLength(24);
  });

  it("matches the public //Alice vector (proves sr25519 hard derivation is correct)", () => {
    const alice = deriveAgentPair(DEV_MNEMONIC, "Alice");
    expect(alice.address).toBe("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
  });

  it("is deterministic and persona-distinct", () => {
    const a1 = deriveAgentPair(DEV_MNEMONIC, "scout");
    const a2 = deriveAgentPair(DEV_MNEMONIC, "scout");
    const b = deriveAgentPair(DEV_MNEMONIC, "vault");
    expect(a1.address).toBe(a2.address);
    expect(a1.address).not.toBe(b.address);
    expect(a1.address).not.toBe(treasuryPair(DEV_MNEMONIC).address);
  });

  it("round-trips through stored JSON", () => {
    const p = deriveAgentPair(DEV_MNEMONIC, "scout");
    const back = pairFromStored(JSON.stringify(p));
    expect(back).toEqual(p);
  });

  it("rejects a bad mnemonic", () => {
    expect(() => deriveAgentPair("not a mnemonic at all", "scout")).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/derive.test.ts`
Expected: FAIL — cannot resolve `../src/derive.js`.

- [ ] **Step 4: Implement `src/derive.ts`**

```ts
import {
  mnemonicGenerate,
  mnemonicValidate,
  mnemonicToMiniSecret,
  sr25519PairFromSeed,
  keyExtractPath,
  keyFromPath,
  encodeAddress,
} from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";

/**
 * The money tree. One mnemonic (keychain entry "root", CLI-only) hard-
 * derives per-agent sr25519 accounts at //<persona>. Only the derived
 * pair is ever stored for an agent — a hard path cannot be climbed back
 * to the parent, so an agent's entry never leaks the treasury.
 */

export interface WalletPair {
  publicKeyHex: string; // no 0x prefix
  secretKeyHex: string; // no 0x prefix (sr25519 64-byte secret)
  address: string;      // SS58 prefix 42 (substrate generic — what bittensor uses)
}

const SS58_PREFIX = 42;

export function generateWalletMnemonic(): string {
  return mnemonicGenerate(24);
}

function toPair(pk: Uint8Array, sk: Uint8Array): WalletPair {
  return {
    publicKeyHex: u8aToHex(pk, undefined, false),
    secretKeyHex: u8aToHex(sk, undefined, false),
    address: encodeAddress(pk, SS58_PREFIX),
  };
}

function basePair(mnemonic: string) {
  if (!mnemonicValidate(mnemonic)) throw new Error("invalid mnemonic");
  return sr25519PairFromSeed(mnemonicToMiniSecret(mnemonic));
}

export function treasuryPair(mnemonic: string): WalletPair {
  const p = basePair(mnemonic);
  return toPair(p.publicKey, p.secretKey);
}

export function deriveAgentPair(mnemonic: string, persona: string): WalletPair {
  const { path } = keyExtractPath(`//${persona}`);
  const d = keyFromPath(basePair(mnemonic), path, "sr25519");
  return toPair(d.publicKey, d.secretKey);
}

export function pairFromStored(json: string): WalletPair {
  const p = JSON.parse(json) as WalletPair;
  if (!p.publicKeyHex || !p.secretKeyHex) throw new Error("malformed stored pair");
  // Recompute the address from the public key — storage carries no authority.
  return toPair(hexToU8a(`0x${p.publicKeyHex}`), hexToU8a(`0x${p.secretKeyHex}`));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/derive.test.ts` — expected PASS (the //Alice vector is the proof the derivation scheme is byte-correct).
Then: `npm run check` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet
git commit -m "wallet: package scaffold + sr25519 //persona derivation (verified against //Alice vector)"
```

---

### Task 2: Keychain store

**Files:**
- Create: `packages/fez-wallet/src/store.ts`
- Test: `packages/fez-wallet/tests/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (for Tasks 6, 7, 8):
  - `readEntry(name: string): string | undefined` — value of `fez-wallet/<name>`.
  - `writeEntry(name: string, value: string): void` — write + read-back verify.
  - `readAgentNostrKey(persona: string): string | undefined` — hex64 from service `fez-keys`, account `agent:<persona>` (read-only; fez core owns writes there).
  - Env contract: `FEZ_WALLET_STORE=file` (or non-darwin) → entries live as 0600 files under `${FEZ_WALLET_HOME ?? ~/.fez}/wallet-store/<name>`; same fallback logic as core `src/identity/keys.ts`.

- [ ] **Step 1: Write the failing test**

`packages/fez-wallet/tests/store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-test-"));
  process.env.FEZ_WALLET_STORE = "file";
  process.env.FEZ_WALLET_HOME = home;
});

describe("store (file backend)", () => {
  it("round-trips an entry", async () => {
    const { writeEntry, readEntry } = await import("../src/store.js");
    writeEntry("scout", '{"hello":"world"}');
    expect(readEntry("scout")).toBe('{"hello":"world"}');
  });

  it("returns undefined for a missing entry", async () => {
    const { readEntry } = await import("../src/store.js");
    expect(readEntry("nobody")).toBeUndefined();
  });

  it("writes files 0600", async () => {
    const { writeEntry } = await import("../src/store.js");
    writeEntry("scout", "x");
    const mode = fs.statSync(path.join(home, "wallet-store", "scout")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Wallet key custody — same pattern as core src/identity/keys.ts, but a
 * SEPARATE keychain service ("fez-wallet"): money and identity never
 * share a compromise domain or a keychain grant.
 *
 * macOS: `security` CLI. Elsewhere, or under FEZ_WALLET_STORE=file:
 * 0600 files under ${FEZ_WALLET_HOME ?? ~/.fez}/wallet-store — a worse
 * backend, not a different contract (and what tests use).
 */

const SERVICE = "fez-wallet";
const NOSTR_SERVICE = "fez-keys";
const HEX64 = /^[0-9a-f]{64}$/i;

function useKeychain(): boolean {
  return process.platform === "darwin" && process.env.FEZ_WALLET_STORE !== "file";
}

function walletHome(): string {
  return process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez");
}

function entryFile(name: string): string {
  return path.join(walletHome(), "wallet-store", name);
}

export function readEntry(name: string): string | undefined {
  if (useKeychain()) {
    const out = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], {
      encoding: "utf-8",
    });
    return out.status === 0 ? out.stdout.trim() : undefined;
  }
  try {
    return fs.readFileSync(entryFile(name), "utf-8");
  } catch {
    return undefined;
  }
}

export function writeEntry(name: string, value: string): void {
  if (useKeychain()) {
    const out = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-l", `fez wallet: ${name}`, "-w", value],
      { stdio: "ignore" }
    );
    if (out.status !== 0) throw new Error(`keychain write failed for "${name}" (security exited ${out.status})`);
    if (readEntry(name) !== value) throw new Error(`entry "${name}": keychain read-back mismatch`);
    return;
  }
  const file = entryFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

/** The agent's NOSTR key (service fez-keys, account agent:<persona>) — read-only here; fez core owns that service. Used to sign consent requests. */
export function readAgentNostrKey(persona: string): string | undefined {
  if (useKeychain()) {
    const out = spawnSync(
      "security",
      ["find-generic-password", "-s", NOSTR_SERVICE, "-a", `agent:${persona}`, "-w"],
      { encoding: "utf-8" }
    );
    const v = out.status === 0 ? out.stdout.trim() : undefined;
    return v && HEX64.test(v) ? v.toLowerCase() : undefined;
  }
  try {
    const v = fs.readFileSync(path.join(walletHome(), "agents", `${persona}.key`), "utf-8").trim();
    return HEX64.test(v) ? v.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/store.test.ts` — expected PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/store.ts packages/fez-wallet/tests/store.test.ts
git commit -m "wallet: keychain store (service fez-wallet, file fallback for tests/linux)"
```

---

### Task 3: Config + spend log

**Files:**
- Create: `packages/fez-wallet/src/config.ts`
- Create: `packages/fez-wallet/src/log.ts`
- Test: `packages/fez-wallet/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (for Tasks 7, 8):
  - `interface WalletConfig { thresholds: Record<string, string>; consentChannel?: string; personas: Record<string, { index: number }>; endpoints: { tao: string } }`
  - `loadConfig(): WalletConfig` — from `${FEZ_WALLET_HOME ?? ~/.fez}/wallet.json`; missing file → defaults `{ thresholds: { default: "0.01" }, personas: {}, endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" } }`.
  - `saveConfig(c: WalletConfig): void`
  - `thresholdFor(c: WalletConfig, persona: string): string` — persona override else `default`.
  - `assignEvmIndex(c: WalletConfig, persona: string): number` — existing index if assigned, else next free integer starting 0 (mutates `c`; caller saves).
  - `appendLog(entry: SpendEntry): void` / `readLog(limit: number): SpendEntry[]` — JSONL at `${FEZ_WALLET_HOME ?? ~/.fez}/wallet-log.jsonl`.
  - `interface SpendEntry { ts: string; persona: string; to: string; amount: string; asset: string; txHash: string; memo?: string; consent: "auto" | "approved" }`

- [ ] **Step 1: Write the failing test**

`packages/fez-wallet/tests/config.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-cfg-"));
});

describe("config", () => {
  it("defaults when no file exists", async () => {
    const { loadConfig, thresholdFor } = await import("../src/config.js");
    const c = loadConfig();
    expect(thresholdFor(c, "scout")).toBe("0.01");
    expect(c.endpoints.tao).toContain("finney");
  });

  it("persona threshold overrides default and round-trips through save", async () => {
    const { loadConfig, saveConfig, thresholdFor } = await import("../src/config.js");
    const c = loadConfig();
    c.thresholds.scout = "0.05";
    saveConfig(c);
    expect(thresholdFor(loadConfig(), "scout")).toBe("0.05");
    expect(thresholdFor(loadConfig(), "vault")).toBe("0.01");
  });

  it("assigns stable, distinct EVM indexes", async () => {
    const { loadConfig, saveConfig, assignEvmIndex } = await import("../src/config.js");
    const c = loadConfig();
    expect(assignEvmIndex(c, "scout")).toBe(0);
    expect(assignEvmIndex(c, "vault")).toBe(1);
    expect(assignEvmIndex(c, "scout")).toBe(0); // stable on re-ask
    saveConfig(c);
    expect(assignEvmIndex(loadConfig(), "vault")).toBe(1);
  });

  it("spend log appends and reads back newest-first with limit", async () => {
    const { appendLog, readLog } = await import("../src/log.js");
    appendLog({ ts: "2026-08-25T00:00:00Z", persona: "scout", to: "5F...", amount: "0.01", asset: "TAO", txHash: "0x1", consent: "auto" });
    appendLog({ ts: "2026-08-25T00:01:00Z", persona: "scout", to: "5G...", amount: "0.5", asset: "TAO", txHash: "0x2", consent: "approved" });
    const rows = readLog(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("0x2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/config.test.ts` — expected FAIL (modules missing).

- [ ] **Step 3: Implement `src/config.ts` and `src/log.ts`**

`src/config.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WalletConfig {
  thresholds: Record<string, string>; // TAO strings; "default" is the floor
  consentChannel?: string;            // channelId consent requests post to
  personas: Record<string, { index: number }>; // stable EVM derivation indexes
  endpoints: { tao: string };
}

const DEFAULTS: WalletConfig = {
  thresholds: { default: "0.01" },
  personas: {},
  endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" },
};

function configFile(): string {
  return path.join(process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"), "wallet.json");
}

export function loadConfig(): WalletConfig {
  try {
    const onDisk = JSON.parse(fs.readFileSync(configFile(), "utf-8"));
    return {
      ...DEFAULTS,
      ...onDisk,
      thresholds: { ...DEFAULTS.thresholds, ...onDisk.thresholds },
      endpoints: { ...DEFAULTS.endpoints, ...onDisk.endpoints },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(c: WalletConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

export function thresholdFor(c: WalletConfig, persona: string): string {
  return c.thresholds[persona] ?? c.thresholds.default;
}

export function assignEvmIndex(c: WalletConfig, persona: string): number {
  const existing = c.personas[persona];
  if (existing) return existing.index;
  const used = new Set(Object.values(c.personas).map((p) => p.index));
  let i = 0;
  while (used.has(i)) i++;
  c.personas[persona] = { index: i };
  return i;
}
```

`src/log.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SpendEntry {
  ts: string;
  persona: string;
  to: string;
  amount: string;
  asset: string;
  txHash: string;
  memo?: string;
  consent: "auto" | "approved";
}

function logFile(): string {
  return path.join(process.env.FEZ_WALLET_HOME ?? path.join(os.homedir(), ".fez"), "wallet-log.jsonl");
}

export function appendLog(entry: SpendEntry): void {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

export function readLog(limit: number): SpendEntry[] {
  try {
    const lines = fs.readFileSync(logFile(), "utf-8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as SpendEntry);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/config.test.ts` — expected PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/config.ts packages/fez-wallet/src/log.ts packages/fez-wallet/tests/config.test.ts
git commit -m "wallet: config (thresholds, evm index registry, endpoints) + jsonl spend log"
```

---

### Task 4: Chain adapter interface + substrate adapter

**Files:**
- Create: `packages/fez-wallet/src/chains/adapter.ts`
- Create: `packages/fez-wallet/src/chains/substrate.ts`
- Test: `packages/fez-wallet/tests/substrate.test.ts`

**Interfaces:**
- Consumes: `WalletPair` from Task 1.
- Produces (for Tasks 5, 7, 8):
  - `interface Amount { raw: bigint; decimals: number; symbol: string }`
  - `parseAmount(text: string, decimals: number, symbol: string): Amount` — throws on negative/NaN/too many decimal places.
  - `formatAmount(a: Amount): string` — e.g. `"0.5 TAO"` (trailing zeros trimmed).
  - `interface ChainAdapter { chain: string; assets: { symbol: string; decimals: number }[]; address(pair: WalletPair): string; balance(address: string, asset: string): Promise<Amount>; transfer(pair: WalletPair, to: string, amount: Amount): Promise<{ txHash: string }> }`
  - `substrateAdapter(opts: { endpoint: string; apiFactory?: () => Promise<SubstrateApi> }): ChainAdapter` — `apiFactory` is the test seam; production default lazily imports `@polkadot/api` (same pattern as fez-bittensor's `chain()`).
  - `TAO_DECIMALS = 9`.

- [ ] **Step 1: Write the failing test**

`packages/fez-wallet/tests/substrate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAmount, formatAmount } from "../src/chains/adapter.js";
import { substrateAdapter, TAO_DECIMALS } from "../src/chains/substrate.js";

describe("amounts", () => {
  it("parses TAO to rao", () => {
    expect(parseAmount("0.5", TAO_DECIMALS, "TAO").raw).toBe(500_000_000n);
    expect(parseAmount("1", TAO_DECIMALS, "TAO").raw).toBe(1_000_000_000n);
  });
  it("rejects garbage", () => {
    expect(() => parseAmount("-1", TAO_DECIMALS, "TAO")).toThrow();
    expect(() => parseAmount("abc", TAO_DECIMALS, "TAO")).toThrow();
    expect(() => parseAmount("0.0000000001", TAO_DECIMALS, "TAO")).toThrow(); // > 9 dp
  });
  it("formats and trims", () => {
    expect(formatAmount({ raw: 500_000_000n, decimals: 9, symbol: "TAO" })).toBe("0.5 TAO");
    expect(formatAmount({ raw: 1_000_000_000n, decimals: 9, symbol: "TAO" })).toBe("1 TAO");
  });
});

describe("substrate adapter (mocked api)", () => {
  const sent: unknown[] = [];
  const fakeApi = {
    query: {
      system: {
        account: async (_addr: string) => ({ data: { free: { toBigInt: () => 2_000_000_000n } } }),
      },
    },
    tx: {
      balances: {
        transferKeepAlive: (to: string, amount: bigint) => ({
          signAndSend: async (_pair: unknown) => {
            sent.push({ to, amount });
            return { toHex: () => "0xdeadbeef" };
          },
        }),
      },
    },
  };
  const adapter = substrateAdapter({
    endpoint: "wss://unused.example",
    apiFactory: async () => fakeApi as never,
  });

  it("reads a balance", async () => {
    const b = await adapter.balance("5Fake", "TAO");
    expect(b.raw).toBe(2_000_000_000n);
    expect(b.symbol).toBe("TAO");
  });

  it("transfers via transferKeepAlive", async () => {
    const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Fake" };
    const r = await adapter.transfer(pair, "5Dest", { raw: 100n, decimals: 9, symbol: "TAO" });
    expect(r.txHash).toBe("0xdeadbeef");
    expect(sent[0]).toEqual({ to: "5Dest", amount: 100n });
  });

  it("rejects unknown assets", async () => {
    await expect(adapter.balance("5Fake", "DOGE")).rejects.toThrow(/asset/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/substrate.test.ts` — expected FAIL (modules missing).

- [ ] **Step 3: Implement `src/chains/adapter.ts`**

```ts
import type { WalletPair } from "../derive.js";

export interface Amount {
  raw: bigint;
  decimals: number;
  symbol: string;
}

export interface ChainAdapter {
  chain: string;
  assets: { symbol: string; decimals: number }[];
  address(pair: WalletPair): string;
  balance(address: string, asset: string): Promise<Amount>;
  transfer(pair: WalletPair, to: string, amount: Amount): Promise<{ txHash: string }>;
}

export function parseAmount(text: string, decimals: number, symbol: string): Amount {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`bad amount "${text}" — expected e.g. "0.5"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimal places`);
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return { raw, decimals, symbol };
}

export function formatAmount(a: Amount): string {
  const base = 10n ** BigInt(a.decimals);
  const whole = a.raw / base;
  const frac = (a.raw % base).toString().padStart(a.decimals, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${a.symbol}`;
}
```

- [ ] **Step 4: Implement `src/chains/substrate.ts`**

```ts
import type { ChainAdapter, Amount } from "./adapter.js";
import type { WalletPair } from "../derive.js";
import { hexToU8a } from "@polkadot/util";

export const TAO_DECIMALS = 9;

/** The slice of ApiPromise we use — narrow on purpose so tests can fake it. */
export interface SubstrateApi {
  query: { system: { account(addr: string): Promise<{ data: { free: { toBigInt(): bigint } } }> } };
  tx: {
    balances: {
      transferKeepAlive(to: string, amount: bigint): {
        signAndSend(pair: unknown): Promise<{ toHex(): string }>;
      };
    };
  };
}

export function substrateAdapter(opts: {
  endpoint: string;
  apiFactory?: () => Promise<SubstrateApi>;
}): ChainAdapter {
  let apiPromise: Promise<SubstrateApi> | undefined;
  const api = () => {
    if (!apiPromise) {
      apiPromise = opts.apiFactory
        ? opts.apiFactory()
        : // Lazy heavy import — the MCP handshake must answer instantly
          // (same reasoning as fez-bittensor's chain()).
          import("@polkadot/api").then(({ ApiPromise, WsProvider }) =>
            ApiPromise.create({ provider: new WsProvider(opts.endpoint), noInitWarn: true }) as unknown as Promise<SubstrateApi>
          );
    }
    return apiPromise;
  };

  const requireTao = (asset: string) => {
    if (asset !== "TAO") throw new Error(`unknown asset "${asset}" on tao chain`);
  };

  return {
    chain: "tao",
    assets: [{ symbol: "TAO", decimals: TAO_DECIMALS }],
    address: (pair: WalletPair) => pair.address,
    async balance(address: string, asset: string): Promise<Amount> {
      requireTao(asset);
      const a = await api();
      const acct = await a.query.system.account(address);
      return { raw: acct.data.free.toBigInt(), decimals: TAO_DECIMALS, symbol: "TAO" };
    },
    async transfer(pair: WalletPair, to: string, amount: Amount) {
      requireTao(amount.symbol);
      const a = await api();
      const { Keyring } = await import("@polkadot/keyring");
      const signer = new Keyring({ type: "sr25519" }).addFromPair({
        publicKey: hexToU8a(`0x${pair.publicKeyHex}`),
        secretKey: hexToU8a(`0x${pair.secretKeyHex}`),
      });
      const hash = await a.tx.balances.transferKeepAlive(to, amount.raw).signAndSend(signer);
      return { txHash: hash.toHex() };
    },
  };
}
```

Note for the implementer: the mocked test never exercises the real `Keyring` path's dynamic import — that's covered by the testnet e2e in Task 8. If `addFromPair` needs `cryptoWaitReady()` first, await it inside `transfer` before constructing the Keyring (harmless when already ready).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/substrate.test.ts` — expected PASS. Then `npm run check`.

- [ ] **Step 6: Add the EVM stub (fold-in — too small for its own task)**

`src/chains/evm.ts`:

```ts
import type { ChainAdapter } from "./adapter.js";

/** EVM lands in a later release. The stub exists so the adapter registry
 * and agent-facing tools are final today — enabling ETH/USDC will not
 * change any tool signature. */
export class NotEnabledError extends Error {
  constructor() {
    super("evm support lands in a later release");
  }
}

export function evmAdapter(): ChainAdapter {
  const nope = () => Promise.reject(new NotEnabledError());
  return {
    chain: "eth",
    assets: [
      { symbol: "ETH", decimals: 18 },
      { symbol: "USDC", decimals: 6 },
    ],
    address: () => {
      throw new NotEnabledError();
    },
    balance: nope,
    transfer: nope,
  };
}
```

Append to `tests/substrate.test.ts`:

```ts
import { evmAdapter, NotEnabledError } from "../src/chains/evm.js";

describe("evm stub", () => {
  it("throws NotEnabledError on everything", async () => {
    const evm = evmAdapter();
    expect(() => evm.address({ publicKeyHex: "", secretKeyHex: "", address: "" })).toThrow(NotEnabledError);
    await expect(evm.balance("0x0", "USDC")).rejects.toThrow(NotEnabledError);
  });
});
```

Run the file again — expected PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-wallet/src/chains packages/fez-wallet/tests/substrate.test.ts
git commit -m "wallet: chain adapter interface, live substrate adapter (transferKeepAlive), evm stub"
```

---

### Task 5: Consent flow

**Files:**
- Create: `packages/fez-wallet/src/consent.ts`
- Test: `packages/fez-wallet/tests/consent.test.ts`

**Interfaces:**
- Consumes: `readAgentNostrKey` (Task 2).
- Produces (for Task 7):
  - `interface ConsentRelay { publish(event: SignedNostrEvent): Promise<void>; subscribe(filter: { kinds: number[]; "#e": string[]; authors: string[] }, onEvent: (ev: SignedNostrEvent) => void): () => void }` — the seam; production impl wraps nostr-tools `SimplePool`, tests use a fake.
  - `type SignedNostrEvent = { id: string; kind: number; pubkey: string; content: string; tags: string[][]; created_at: number; sig: string }` (nostr-tools' `Event` shape).
  - `buildConsentRequest(opts: { agentSecretHex: string; channelId: string; ownerPk: string; text: string }): SignedNostrEvent` — kind 47103, tags `[["h", channelId], ["p", ownerPk]]`, signed with nostr-tools `finalizeEvent`.
  - `awaitDecision(relay: ConsentRelay, requestId: string, ownerPk: string, timeoutMs: number): Promise<"approved" | "declined" | "timeout">` — kind-7 reaction e-tagging `requestId`: content `"✅"` (or `"+"`) from `ownerPk` → approved; `"❌"` (or `"-"`) → declined; anything else ignored; timer → timeout. Defensively re-checks `ev.pubkey === ownerPk` and the e-tag even though the filter asks for both.
  - `KIND_CHANNEL_MESSAGE = 47103`, `KIND_REACTION = 7` (local constants, values must match core `src/protocol/kinds.ts`).

- [ ] **Step 1: Write the failing test**

`packages/fez-wallet/tests/consent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  buildConsentRequest,
  awaitDecision,
  type ConsentRelay,
  type SignedNostrEvent,
} from "../src/consent.js";

const agentSk = bytesToHex(generateSecretKey());
const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const strangerSk = generateSecretKey();

function fakeRelay() {
  const handlers: ((ev: SignedNostrEvent) => void)[] = [];
  const relay: ConsentRelay = {
    publish: async () => {},
    subscribe: (_filter, onEvent) => {
      handlers.push(onEvent);
      return () => {};
    },
  };
  return { relay, emit: (ev: SignedNostrEvent) => handlers.forEach((h) => h(ev)) };
}

// A minimal reaction event; sig is not checked by awaitDecision (the
// relay filter + pubkey check is the trust rule), so a stub sig is fine.
function reaction(content: string, pubkey: string, targetId: string): SignedNostrEvent {
  return { id: "r1", kind: 7, pubkey, content, tags: [["e", targetId]], created_at: 0, sig: "00" };
}

describe("consent", () => {
  it("builds a valid signed 47103 request", () => {
    const ev = buildConsentRequest({
      agentSecretHex: agentSk,
      channelId: "chan1",
      ownerPk,
      text: "scout requests 0.5 TAO → 5Dest",
    });
    expect(ev.kind).toBe(47103);
    expect(ev.tags).toContainEqual(["h", "chan1"]);
    expect(ev.tags).toContainEqual(["p", ownerPk]);
    expect(verifyEvent(ev)).toBe(true);
  });

  it("resolves approved on owner ✅", async () => {
    const { relay, emit } = fakeRelay();
    const p = awaitDecision(relay, "req1", ownerPk, 5000);
    emit(reaction("✅", ownerPk, "req1"));
    await expect(p).resolves.toBe("approved");
  });

  it("resolves declined on owner ❌", async () => {
    const { relay, emit } = fakeRelay();
    const p = awaitDecision(relay, "req1", ownerPk, 5000);
    emit(reaction("❌", ownerPk, "req1"));
    await expect(p).resolves.toBe("declined");
  });

  it("ignores non-owner reactions and times out", async () => {
    const { relay, emit } = fakeRelay();
    const p = awaitDecision(relay, "req1", ownerPk, 50);
    emit(reaction("✅", getPublicKey(strangerSk), "req1")); // wrong signer
    emit(reaction("✅", ownerPk, "other-event"));           // wrong target
    emit(reaction("🎉", ownerPk, "req1"));                  // wrong emoji
    await expect(p).resolves.toBe("timeout");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/consent.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement `src/consent.ts`**

```ts
import { finalizeEvent, type Event as NostrEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";

/**
 * Threshold consent over EXISTING kinds (spec §consent): the request is
 * an ordinary channel message (47103) p-tagging the owner; authorization
 * is the OWNER's kind-7 reaction e-tagging that request. No new kinds —
 * any fez client renders the request and can approve it today.
 */

export const KIND_CHANNEL_MESSAGE = 47103; // matches src/protocol/kinds.ts
export const KIND_REACTION = 7;

export type SignedNostrEvent = NostrEvent;

export interface ConsentRelay {
  publish(event: SignedNostrEvent): Promise<void>;
  subscribe(
    filter: { kinds: number[]; "#e": string[]; authors: string[] },
    onEvent: (ev: SignedNostrEvent) => void
  ): () => void;
}

const APPROVE = new Set(["✅", "+"]);
const DECLINE = new Set(["❌", "-"]);

export function buildConsentRequest(opts: {
  agentSecretHex: string;
  channelId: string;
  ownerPk: string;
  text: string;
}): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: KIND_CHANNEL_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", opts.channelId],
        ["p", opts.ownerPk],
      ],
      content: opts.text,
    },
    hexToBytes(opts.agentSecretHex)
  );
}

export function awaitDecision(
  relay: ConsentRelay,
  requestId: string,
  ownerPk: string,
  timeoutMs: number
): Promise<"approved" | "declined" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: "approved" | "declined" | "timeout") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(v);
    };
    const unsub = relay.subscribe(
      { kinds: [KIND_REACTION], "#e": [requestId], authors: [ownerPk] },
      (ev) => {
        // Filters are advisory — re-verify the trust rule locally.
        if (ev.pubkey !== ownerPk) return;
        if (!ev.tags.some((t) => t[0] === "e" && t[1] === requestId)) return;
        if (APPROVE.has(ev.content.trim())) finish("approved");
        else if (DECLINE.has(ev.content.trim())) finish("declined");
      }
    );
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

/** Production ConsentRelay over nostr-tools SimplePool. Untested by unit
 * tests (the seam above is what's tested); exercised in the e2e pass. */
export async function poolRelay(relayUrls: string[]): Promise<ConsentRelay> {
  const { SimplePool } = await import("nostr-tools/pool");
  const pool = new SimplePool();
  return {
    async publish(event) {
      await Promise.any(pool.publish(relayUrls, event));
    },
    subscribe(filter, onEvent) {
      const sub = pool.subscribeMany(relayUrls, [filter], { onevent: onEvent });
      return () => sub.close();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/consent.test.ts` — expected PASS. Then `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/consent.ts packages/fez-wallet/tests/consent.test.ts
git commit -m "wallet: consent flow — 47103 request + owner-signed reaction decision, timeout declines"
```

---

### Task 6: Tool logic (spend pipeline)

**Files:**
- Create: `packages/fez-wallet/src/tools.ts`
- Test: `packages/fez-wallet/tests/tools.test.ts`

**Interfaces:**
- Consumes: `WalletPair`/`pairFromStored` (Task 1), `readEntry` (Task 2), `WalletConfig`/`thresholdFor` + `appendLog`/`readLog` (Task 3), `ChainAdapter`/`parseAmount`/`formatAmount` (Task 4), `buildConsentRequest`/`awaitDecision`/`ConsentRelay` (Task 5).
- Produces (for Task 7 — `mcp.ts` binds these to MCP tools 1:1):
  - `interface ToolDeps { persona: string; pair: WalletPair; adapters: ChainAdapter[]; config: WalletConfig; ownerPk?: string; relay?: () => Promise<ConsentRelay>; agentNostrKey?: string; now?: () => string }`
  - `walletAddress(deps: ToolDeps, args: { chain?: string }): string`
  - `walletBalance(deps: ToolDeps, args: { chain?: string; asset?: string }): Promise<string>`
  - `walletSend(deps: ToolDeps, args: { to: string; amount: string; asset: string; memo?: string }): Promise<string>`
  - `walletHistory(deps: ToolDeps, args: { limit?: number }): string`
  - All return human-readable strings (they feed straight into MCP `text(...)` results).
  - `CONSENT_TIMEOUT_MS = 600_000` (10 minutes, exported so tests can reference it).

- [ ] **Step 1: Write the failing test**

`packages/fez-wallet/tests/tools.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import type { ChainAdapter } from "../src/chains/adapter.js";
import type { ConsentRelay, SignedNostrEvent } from "../src/consent.js";

const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const agentNostrKey = bytesToHex(generateSecretKey());
const pair = { publicKeyHex: "aa", secretKeyHex: "bb", address: "5Agent" };

function fakeAdapter(balanceRao: bigint) {
  const transfers: { to: string; raw: bigint }[] = [];
  const adapter: ChainAdapter = {
    chain: "tao",
    assets: [{ symbol: "TAO", decimals: 9 }],
    address: (p) => p.address,
    balance: async () => ({ raw: balanceRao, decimals: 9, symbol: "TAO" }),
    transfer: async (_p, to, amount) => {
      transfers.push({ to, raw: amount.raw });
      return { txHash: "0xfeed" };
    },
  };
  return { adapter, transfers };
}

function autoRelay(decide: (req: SignedNostrEvent) => string | null) {
  let request: SignedNostrEvent | undefined;
  let handler: ((ev: SignedNostrEvent) => void) | undefined;
  const relay: ConsentRelay = {
    publish: async (ev) => {
      request = ev;
      // Simulate the owner reacting right after the request lands.
      queueMicrotask(() => {
        const content = decide(ev);
        if (content && handler)
          handler({ id: "r", kind: 7, pubkey: ownerPk, content, tags: [["e", ev.id]], created_at: 0, sig: "00" });
      });
    },
    subscribe: (_f, on) => {
      handler = on;
      return () => {};
    },
  };
  return { relay, getRequest: () => request };
}

function deps(over: Partial<import("../src/tools.js").ToolDeps> = {}) {
  const { adapter, transfers } = fakeAdapter(2_000_000_000n); // 2 TAO
  return {
    transfers,
    d: {
      persona: "scout",
      pair,
      adapters: [adapter],
      config: {
        thresholds: { default: "0.01" },
        consentChannel: "chan1",
        personas: {},
        endpoints: { tao: "wss://unused" },
      },
      ownerPk,
      agentNostrKey,
      now: () => "2026-08-25T00:00:00Z",
      ...over,
    },
  };
}

beforeEach(() => {
  process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-tools-"));
});

describe("tools", () => {
  it("walletAddress reports the agent address", async () => {
    const { walletAddress } = await import("../src/tools.js");
    expect(walletAddress(deps().d, {})).toContain("5Agent");
  });

  it("walletBalance formats the balance", async () => {
    const { walletBalance } = await import("../src/tools.js");
    expect(await walletBalance(deps().d, {})).toContain("2 TAO");
  });

  it("sends under threshold without consent and logs it", async () => {
    const { walletSend, walletHistory } = await import("../src/tools.js");
    const { d, transfers } = deps();
    const out = await walletSend(d, { to: "5Dest", amount: "0.005", asset: "TAO" });
    expect(out).toContain("0xfeed");
    expect(transfers).toHaveLength(1);
    expect(walletHistory(d, {})).toContain("5Dest");
  });

  it("blocks over-threshold sends behind consent — approved path executes", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "✅");
    const { d, transfers } = deps({ relay: async () => relay });
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO", memo: "chutes" });
    expect(out).toContain("0xfeed");
    expect(transfers).toHaveLength(1);
  });

  it("declined consent does not transfer", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { relay } = autoRelay(() => "❌");
    const { d, transfers } = deps({ relay: async () => relay });
    const out = await walletSend(d, { to: "5Dest", amount: "0.5", asset: "TAO" });
    expect(out.toLowerCase()).toContain("declined");
    expect(transfers).toHaveLength(0);
  });

  it("insufficient balance errors before any consent round-trip", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { d, transfers } = deps();
    await expect(walletSend(d, { to: "5Dest", amount: "3", asset: "TAO" })).rejects.toThrow(/balance/i);
    expect(transfers).toHaveLength(0);
  });

  it("resolves a persona name to its derived address", async () => {
    const { walletSend } = await import("../src/tools.js");
    const { d, transfers } = deps();
    // vault's address comes from the store — write a stored pair for it.
    process.env.FEZ_WALLET_STORE = "file";
    const { writeEntry } = await import("../src/store.js");
    writeEntry("vault", JSON.stringify({ publicKeyHex: "cc", secretKeyHex: "dd", address: "5Vault" }));
    await walletSend(d, { to: "vault", amount: "0.005", asset: "TAO" });
    expect(transfers[0].to).toBe("5Vault");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/tools.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement `src/tools.ts`**

```ts
import type { WalletPair } from "./derive.js";
import { pairFromStored } from "./derive.js";
import { readEntry } from "./store.js";
import { type WalletConfig, thresholdFor } from "./config.js";
import { appendLog, readLog } from "./log.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";
import { buildConsentRequest, awaitDecision, type ConsentRelay } from "./consent.js";

export const CONSENT_TIMEOUT_MS = 600_000; // 10 minutes

export interface ToolDeps {
  persona: string;
  pair: WalletPair;
  adapters: ChainAdapter[];
  config: WalletConfig;
  ownerPk?: string;
  relay?: () => Promise<ConsentRelay>;
  agentNostrKey?: string;
  now?: () => string; // test seam; defaults to wall clock
}

function adapterFor(deps: ToolDeps, chain?: string, asset?: string): ChainAdapter {
  const c = deps.adapters.find(
    (a) => (chain ? a.chain === chain : true) && (asset ? a.assets.some((x) => x.symbol === asset) : true)
  );
  if (!c) throw new Error(`no enabled chain matches ${chain ?? asset ?? "(any)"}`);
  return c;
}

/** A `to` that isn't an address is a persona name — resolve via its stored pair. */
function resolveTo(to: string): string {
  if (to.length >= 40) return to; // SS58/hex addresses are long; persona names are not
  const stored = readEntry(to);
  if (!stored) throw new Error(`"${to}" is neither an address nor a persona with a wallet (fez-wallet derive ${to})`);
  return pairFromStored(stored).address;
}

export function walletAddress(deps: ToolDeps, args: { chain?: string }): string {
  const a = adapterFor(deps, args.chain);
  return `${deps.persona} receive address (${a.chain}): ${a.address(deps.pair)}`;
}

export async function walletBalance(deps: ToolDeps, args: { chain?: string; asset?: string }): Promise<string> {
  const a = adapterFor(deps, args.chain, args.asset);
  const asset = args.asset ?? a.assets[0].symbol;
  const b = await a.balance(a.address(deps.pair), asset);
  return `${deps.persona} balance: ${formatAmount(b)}`;
}

export async function walletSend(
  deps: ToolDeps,
  args: { to: string; amount: string; asset: string; memo?: string }
): Promise<string> {
  const a = adapterFor(deps, undefined, args.asset);
  const decimals = a.assets.find((x) => x.symbol === args.asset)!.decimals;
  const amount = parseAmount(args.amount, decimals, args.asset);
  const to = resolveTo(args.to);

  // The envelope speaks first — no consent round-trip for money that isn't there.
  const balance = await a.balance(a.address(deps.pair), args.asset);
  if (balance.raw < amount.raw) {
    throw new Error(`insufficient balance: have ${formatAmount(balance)}, need ${formatAmount(amount)}`);
  }

  const threshold = parseAmount(thresholdFor(deps.config, deps.persona), decimals, args.asset);
  let consent: "auto" | "approved" = "auto";
  if (amount.raw > threshold.raw) {
    if (!deps.relay || !deps.ownerPk || !deps.agentNostrKey || !deps.config.consentChannel) {
      throw new Error(
        "this amount needs owner consent, but the consent channel is not configured (set consentChannel in wallet.json)"
      );
    }
    const relay = await deps.relay();
    const request = buildConsentRequest({
      agentSecretHex: deps.agentNostrKey,
      channelId: deps.config.consentChannel,
      ownerPk: deps.ownerPk,
      text: `💸 ${deps.persona} requests ${formatAmount(amount)} → ${to}${args.memo ? ` (${args.memo})` : ""} — react ✅ to approve, ❌ to decline`,
    });
    // Subscribe BEFORE publishing so a fast reaction can't slip past.
    const decision = awaitDecision(relay, request.id, deps.ownerPk, CONSENT_TIMEOUT_MS);
    await relay.publish(request);
    const verdict = await decision;
    if (verdict !== "approved") {
      return `send ${verdict === "timeout" ? "declined (consent timed out after 10 minutes)" : "declined by owner"} — nothing was transferred`;
    }
    consent = "approved";
  }

  const { txHash } = await a.transfer(deps.pair, to, amount);
  appendLog({
    ts: deps.now ? deps.now() : new Date().toISOString(),
    persona: deps.persona,
    to,
    amount: args.amount,
    asset: args.asset,
    txHash,
    memo: args.memo,
    consent,
  });
  return `sent ${formatAmount(amount)} → ${to} (tx ${txHash}${consent === "approved" ? ", owner-approved" : ""})`;
}

export function walletHistory(deps: ToolDeps, args: { limit?: number }): string {
  const rows = readLog(args.limit ?? 20).filter((r) => r.persona === deps.persona);
  if (rows.length === 0) return "no transfers recorded.";
  return rows
    .map((r) => `- ${r.ts} · ${r.amount} ${r.asset} → ${r.to}${r.memo ? ` (${r.memo})` : ""} · ${r.consent} · ${r.txHash}`)
    .join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/tools.test.ts` — expected PASS. Then the full suite: `npm test` and `npm run check`.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-wallet/src/tools.ts packages/fez-wallet/tests/tools.test.ts
git commit -m "wallet: spend pipeline — envelope check, threshold consent gate, logged transfers"
```

---

### Task 7: MCP server entry point

**Files:**
- Create: `packages/fez-wallet/src/mcp.ts`

**Interfaces:**
- Consumes: everything from Task 6's `tools.ts`, `substrateAdapter`/`evmAdapter` (Task 4), `readEntry`/`readAgentNostrKey` (Task 2), `pairFromStored` (Task 1), `loadConfig` (Task 3), `poolRelay` (Task 5).
- Produces: the `dist/mcp.js` skill part. No exports — it's an entry point. Env contract (set by fez-acp in every agent harness): `FEZ_AGENT_PERSONA` (required), `FEZ_RELAY` (comma-separated relay URLs), `FEZ_AGENT_OWNER` (owner pubkey hex).

This wiring file is deliberately thin — all logic is in `tools.ts` (tested). No unit test for `mcp.ts` itself; sibling packages set that precedent, and its correctness is covered by the smoke run in Step 3 plus the e2e in Task 8.

- [ ] **Step 1: Implement `src/mcp.ts`**

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { pairFromStored } from "./derive.js";
import { readEntry, readAgentNostrKey } from "./store.js";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import { evmAdapter } from "./chains/evm.js";
import { poolRelay } from "./consent.js";
import { walletAddress, walletBalance, walletSend, walletHistory, type ToolDeps } from "./tools.js";

/**
 * fez-wallet, skill part — the calling agent's OWN allowance account.
 *
 * Identity comes from FEZ_AGENT_PERSONA (set by fez-acp in the harness
 * env), NEVER from tool arguments: this process can only ever load one
 * derived key, and the root mnemonic entry is not referenced anywhere
 * in this import graph (spec invariants 1 and 2).
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-wallet: FEZ_AGENT_PERSONA is not set — this skill only runs inside an agent harness.");
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = new McpServer({ name: "fez-wallet", version: "0.1.0" });

/** Deps are built lazily per call: config edits and newly derived keys
 * apply without restarting the agent, and startup stays instant for the
 * MCP handshake. */
async function deps(): Promise<ToolDeps> {
  await cryptoWaitReady();
  const stored = readEntry(persona!);
  if (!stored) {
    throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  }
  const config = loadConfig();
  const relays = (process.env.FEZ_RELAY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    persona: persona!,
    pair: pairFromStored(stored),
    adapters: [substrateAdapter({ endpoint: config.endpoints.tao }), evmAdapter()],
    config,
    ownerPk: process.env.FEZ_AGENT_OWNER,
    agentNostrKey: readAgentNostrKey(persona!),
    relay: relays.length ? () => poolRelay(relays) : undefined,
  };
}

server.registerTool(
  "wallet_address",
  {
    description: "Your own receive address — where someone sends you money. Currently TAO (bittensor).",
    inputSchema: { chain: z.string().optional().describe("Chain id, e.g. 'tao'. Default: the first enabled chain.") },
  },
  async ({ chain }) => text(walletAddress(await deps(), { chain }))
);

server.registerTool(
  "wallet_balance",
  {
    description: "Your current balance. This balance IS your spending cap — there is no other budget.",
    inputSchema: {
      chain: z.string().optional().describe("Chain id, e.g. 'tao'."),
      asset: z.string().optional().describe("Asset symbol, e.g. 'TAO'."),
    },
  },
  async ({ chain, asset }) => text(await walletBalance(await deps(), { chain, asset }))
);

server.registerTool(
  "wallet_send",
  {
    description:
      "Send money from your allowance. Small amounts go through immediately; larger amounts post a consent request to the owner and wait up to 10 minutes for their ✅ — you'll be told the outcome either way.",
    inputSchema: {
      to: z.string().describe("Destination: a raw address, or a local persona name (e.g. 'vault')."),
      amount: z.string().describe("Decimal amount, e.g. '0.05'."),
      asset: z.string().describe("Asset symbol, e.g. 'TAO'."),
      memo: z.string().optional().describe("Short human-readable reason — shown in the consent request."),
    },
  },
  async ({ to, amount, asset, memo }) => text(await walletSend(await deps(), { to, amount, asset, memo }))
);

server.registerTool(
  "wallet_history",
  {
    description: "Your recent transfers (from this machine's spend log).",
    inputSchema: { limit: z.number().optional().describe("Max rows (default 20).") },
  },
  async ({ limit }) => text(walletHistory(await deps(), { limit }))
);

await server.connect(new StdioServerTransport());
console.error(`fez-wallet ready — allowance account for "${persona}"`);
```

- [ ] **Step 2: Build and typecheck**

Run: `cd packages/fez-wallet && npm run check && npm run build`
Expected: clean; `dist/mcp.js` and `dist/cli.js` fail on cli (not written yet) — if esbuild errors on the missing `src/cli.ts`, create a one-line placeholder `src/cli.ts` containing `console.error("fez-wallet cli: implemented in the next commit");` so the build passes (it is replaced in Task 8).

- [ ] **Step 3: Smoke-run the handshake**

Run:

```bash
cd packages/fez-wallet
FEZ_WALLET_STORE=file FEZ_WALLET_HOME=$(mktemp -d) FEZ_AGENT_PERSONA=smoketest \
  timeout 5 node dist/mcp.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
EOF
```

Expected: a JSON-RPC `initialize` result naming `fez-wallet` on stdout and the ready line on stderr — proof the server starts instantly with no wallet derived (tool CALLS would error helpfully; the handshake must not).

- [ ] **Step 4: Commit**

```bash
git add packages/fez-wallet/src/mcp.ts packages/fez-wallet/src/cli.ts
git commit -m "wallet: mcp skill part — per-agent tools wired to the spend pipeline"
```

---

### Task 8: CLI ceremony

**Files:**
- Create: `packages/fez-wallet/src/cli-commands.ts`
- Create (replace placeholder): `packages/fez-wallet/src/cli.ts`
- Test: `packages/fez-wallet/tests/cli.test.ts`

**Interfaces:**
- Consumes: `generateWalletMnemonic`/`deriveAgentPair`/`treasuryPair`/`pairFromStored` (Task 1), `readEntry`/`writeEntry` (Task 2), `loadConfig`/`saveConfig`/`assignEvmIndex` (Task 3), `ChainAdapter`/`parseAmount`/`formatAmount` + `substrateAdapter` (Task 4).
- Produces: the `fez-wallet` bin. Testable command functions:
  - `cmdInit(io: CliIo): void` — refuses if root exists; generates, stores, prints mnemonic ONCE.
  - `cmdDerive(io: CliIo, persona: string): void` — derives from root, stores entry, assigns EVM index, prints address. Idempotent (re-run prints the existing address).
  - `cmdFund(io: CliIo, adapter: ChainAdapter, persona: string, amount: string): Promise<void>` — treasury → persona, `transferKeepAlive`.
  - `cmdStatus(io: CliIo, adapter: ChainAdapter): Promise<void>` — treasury + per-persona address/balance table.
  - `interface CliIo { print(line: string): void }` — test seam; `cli.ts` passes `{ print: console.log }`.
  - **This is the only file allowed to read the `root` store entry** (Global Constraints).

- [ ] **Step 1: Write the failing test**

`packages/fez-wallet/tests/cli.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import type { ChainAdapter } from "../src/chains/adapter.js";

beforeEach(async () => {
  process.env.FEZ_WALLET_STORE = "file";
  process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-cli-"));
  await cryptoWaitReady();
});

function collect() {
  const lines: string[] = [];
  return { io: { print: (l: string) => lines.push(l) }, lines };
}

function fakeAdapter() {
  const transfers: { to: string; raw: bigint }[] = [];
  const adapter: ChainAdapter = {
    chain: "tao",
    assets: [{ symbol: "TAO", decimals: 9 }],
    address: (p) => p.address,
    balance: async () => ({ raw: 5_000_000_000n, decimals: 9, symbol: "TAO" }),
    transfer: async (_p, to, amount) => {
      transfers.push({ to, raw: amount.raw });
      return { txHash: "0xcafe" };
    },
  };
  return { adapter, transfers };
}

describe("cli ceremony", () => {
  it("init generates and stores a mnemonic, printing it exactly once", async () => {
    const { cmdInit } = await import("../src/cli-commands.js");
    const { readEntry } = await import("../src/store.js");
    const { io, lines } = collect();
    cmdInit(io);
    const root = readEntry("root");
    expect(root!.split(" ")).toHaveLength(24);
    expect(lines.join("\n")).toContain(root!); // shown for paper backup
    expect(() => cmdInit(io)).toThrow(/already/i); // refuses a second init
  });

  it("derive stores the pair, assigns an index, and is idempotent", async () => {
    const { cmdInit, cmdDerive } = await import("../src/cli-commands.js");
    const { readEntry } = await import("../src/store.js");
    const { loadConfig } = await import("../src/config.js");
    const { pairFromStored } = await import("../src/derive.js");
    const { io, lines } = collect();
    cmdInit(io);
    cmdDerive(io, "scout");
    const stored = pairFromStored(readEntry("scout")!);
    expect(loadConfig().personas.scout.index).toBe(0);
    expect(lines.join("\n")).toContain(stored.address);
    cmdDerive(io, "scout"); // no throw, same address printed again
    expect(pairFromStored(readEntry("scout")!).address).toBe(stored.address);
  });

  it("fund moves treasury → persona via the adapter", async () => {
    const { cmdInit, cmdDerive, cmdFund } = await import("../src/cli-commands.js");
    const { readEntry } = await import("../src/store.js");
    const { pairFromStored } = await import("../src/derive.js");
    const { io } = collect();
    cmdInit(io);
    cmdDerive(io, "scout");
    const { adapter, transfers } = fakeAdapter();
    await cmdFund(io, adapter, "scout", "1.5");
    expect(transfers[0].to).toBe(pairFromStored(readEntry("scout")!).address);
    expect(transfers[0].raw).toBe(1_500_000_000n);
  });

  it("status lists treasury and derived personas", async () => {
    const { cmdInit, cmdDerive, cmdStatus } = await import("../src/cli-commands.js");
    const { io, lines } = collect();
    cmdInit(io);
    cmdDerive(io, "scout");
    const { adapter } = fakeAdapter();
    await cmdStatus(io, adapter);
    const out = lines.join("\n");
    expect(out).toContain("treasury");
    expect(out).toContain("scout");
    expect(out).toContain("5 TAO");
  });

  it("derive without init explains itself", async () => {
    const { cmdDerive } = await import("../src/cli-commands.js");
    const { io } = collect();
    expect(() => cmdDerive(io, "scout")).toThrow(/fez-wallet init/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fez-wallet && npx vitest --run tests/cli.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement `src/cli-commands.ts`**

```ts
import { generateWalletMnemonic, deriveAgentPair, treasuryPair, pairFromStored } from "./derive.js";
import { readEntry, writeEntry } from "./store.js";
import { loadConfig, saveConfig, assignEvmIndex } from "./config.js";
import { type ChainAdapter, parseAmount, formatAmount } from "./chains/adapter.js";

/**
 * The ceremony. This module is the ONLY place the "root" entry (the
 * mnemonic) is ever read or written — mcp.ts and tools.ts see derived
 * pairs and nothing else (spec invariant 1).
 */

const ROOT = "root";

export interface CliIo {
  print(line: string): void;
}

function requireRoot(): string {
  const mnemonic = readEntry(ROOT);
  if (!mnemonic) throw new Error("no wallet yet — run: fez-wallet init");
  return mnemonic;
}

export function cmdInit(io: CliIo): void {
  if (readEntry(ROOT)) throw new Error("a wallet root already exists — refusing to overwrite it");
  const mnemonic = generateWalletMnemonic();
  writeEntry(ROOT, mnemonic);
  io.print("wallet created. WRITE THESE 24 WORDS DOWN — they are shown exactly once:");
  io.print("");
  io.print(`  ${mnemonic}`);
  io.print("");
  io.print(`treasury address: ${treasuryPair(mnemonic).address}`);
  io.print("fund the treasury, then: fez-wallet derive <persona> && fez-wallet fund <persona> <amount>");
}

export function cmdDerive(io: CliIo, persona: string): void {
  const mnemonic = requireRoot();
  const existing = readEntry(persona);
  const pair = existing ? pairFromStored(existing) : deriveAgentPair(mnemonic, persona);
  if (!existing) writeEntry(persona, JSON.stringify(pair));
  const config = loadConfig();
  assignEvmIndex(config, persona);
  saveConfig(config);
  io.print(`${persona}: ${pair.address}`);
}

export async function cmdFund(io: CliIo, adapter: ChainAdapter, persona: string, amount: string): Promise<void> {
  const mnemonic = requireRoot();
  const stored = readEntry(persona);
  if (!stored) throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  const to = pairFromStored(stored).address;
  const decimals = adapter.assets[0].decimals;
  const parsed = parseAmount(amount, decimals, adapter.assets[0].symbol);
  const { txHash } = await adapter.transfer(treasuryPair(mnemonic), to, parsed);
  io.print(`funded ${persona} with ${formatAmount(parsed)} (tx ${txHash})`);
}

export async function cmdStatus(io: CliIo, adapter: ChainAdapter): Promise<void> {
  const mnemonic = requireRoot();
  const config = loadConfig();
  const asset = adapter.assets[0].symbol;
  const treasury = treasuryPair(mnemonic);
  const tb = await adapter.balance(treasury.address, asset);
  io.print(`treasury  ${treasury.address}  ${formatAmount(tb)}`);
  for (const persona of Object.keys(config.personas).sort()) {
    const stored = readEntry(persona);
    if (!stored) continue;
    const addr = pairFromStored(stored).address;
    const b = await adapter.balance(addr, asset);
    io.print(`${persona}  ${addr}  ${formatAmount(b)}`);
  }
}
```

- [ ] **Step 4: Replace the `src/cli.ts` placeholder**

```ts
#!/usr/bin/env node
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import { cmdInit, cmdDerive, cmdFund, cmdStatus } from "./cli-commands.js";

const io = { print: (l: string) => console.log(l) };
const [cmd, ...rest] = process.argv.slice(2);

try {
  await cryptoWaitReady();
  const adapter = () => substrateAdapter({ endpoint: loadConfig().endpoints.tao });
  switch (cmd) {
    case "init":
      cmdInit(io);
      break;
    case "derive":
      if (!rest[0]) throw new Error("usage: fez-wallet derive <persona>");
      cmdDerive(io, rest[0]);
      break;
    case "fund":
      if (!rest[0] || !rest[1]) throw new Error("usage: fez-wallet fund <persona> <amount>");
      await cmdFund(io, adapter(), rest[0], rest[1]);
      break;
    case "status":
      await cmdStatus(io, adapter());
      break;
    default:
      io.print("fez-wallet — per-agent allowance wallets");
      io.print("  init                    create the master wallet (once)");
      io.print("  derive <persona>        create an agent's allowance account");
      io.print("  fund <persona> <amt>    treasury → agent (TAO)");
      io.print("  status                  balances for treasury + all agents");
      process.exitCode = cmd ? 1 : 0;
  }
  process.exit(process.exitCode ?? 0); // polkadot ws keeps the loop alive otherwise
} catch (e) {
  console.error(`fez-wallet: ${(e as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/fez-wallet && npx vitest --run tests/cli.test.ts`, then the whole suite `npm test`, then `npm run check && npm run build` — all expected clean.

- [ ] **Step 6: Verify invariant 1 mechanically**

Run: `grep -rn '"root"' packages/fez-wallet/src --include='*.ts' | grep -v cli-commands.ts`
Expected: NO output. If anything matches, that's a spec violation — fix before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/fez-wallet/src/cli-commands.ts packages/fez-wallet/src/cli.ts packages/fez-wallet/tests/cli.test.ts
git commit -m "wallet: cli ceremony — init/derive/fund/status; root mnemonic confined to cli-commands"
```

---

### Task 9: README, final verification, e2e instructions

**Files:**
- Create: `packages/fez-wallet/README.md`

**Interfaces:**
- Consumes: everything. Produces: the shippable package.

- [ ] **Step 1: Write `README.md`**

```markdown
# @fezchat/wallet

Per-agent allowance wallets for fez. One master mnemonic (yours, in the
macOS keychain, service `fez-wallet`) hard-derives an sr25519 account
per agent at `//<persona>`. The balance on an agent's account IS its
spending cap. TAO is live; the adapter interface already carries the
EVM stub, so ETH/USDC arrive later without changing any agent-facing
tool.

## Ceremony

    fez-wallet init              # once; prints the 24 words exactly once
    fez-wallet derive scout      # per agent
    fez-wallet fund scout 0.5    # treasury → agent
    fez-wallet status            # who has what

## Agent tools (MCP skill part)

`wallet_address` · `wallet_balance` · `wallet_send` · `wallet_history`
— always scoped to the calling agent (identity from FEZ_AGENT_PERSONA,
never from arguments). Sends over the per-agent threshold (default
0.01 TAO, `thresholds` in `~/.fez/wallet.json`) post a consent request
(kind 47103) to `consentChannel` and wait up to 10 minutes for the
owner's ✅ / ❌ reaction. Timeout declines.

## Custody invariants

1. The MCP server never reads the root mnemonic (only `cli-commands.ts`
   may; `grep -rn '"root"' src | grep -v cli-commands` stays empty).
2. Key selection only from `FEZ_AGENT_PERSONA` env.
3. The allowance balance is the hard cap; thresholds only add prompts.
4. A consent approval counts only when it e-tags the request AND is
   signed by the workspace owner.
5. The mnemonic is printed once, at init, and lives nowhere but the
   keychain.

## Testnet e2e (before real TAO)

1. Point the endpoint at testnet: set `endpoints.tao` to
   `wss://test.finney.opentensor.ai:443` in `~/.fez/wallet.json`.
2. `fez-wallet init`, fund the treasury address from the testnet faucet.
3. `fez-wallet derive <persona>` for an agent that runs in your fleet,
   `fez-wallet fund <persona> 0.1`.
4. From the agent: `wallet_balance`, then a sub-threshold `wallet_send`
   back to the treasury address (auto), then an over-threshold send —
   approve the ✅ path once and let one time out.
5. `fez-wallet status` and `wallet_history` should agree with the chain.
```

- [ ] **Step 2: Full verification**

Run, from `packages/fez-wallet`:

```bash
npm test          # all suites green
npm run check     # tsc clean
npm run build     # dist/mcp.js + dist/cli.js
node dist/cli.js  # prints usage, exits 0
grep -rn '"root"' src --include='*.ts' | grep -v cli-commands.ts   # empty
```

All five must pass. Do not claim completion otherwise.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-wallet/README.md
git commit -m "wallet: README — ceremony, custody invariants, testnet e2e runbook"
```

- [ ] **Step 4: Report**

Summarize for Ken: what shipped, test counts, the testnet e2e steps that remain manual (faucet + live approve), and that merging `wallet-extension` into main is pending his call (desktop agent still active).
