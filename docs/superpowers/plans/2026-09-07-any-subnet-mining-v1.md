# Any-Subnet Mining v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mining page in fez-desktop that lists every Bittensor subnet and can register + run a miner locally for any subnet whose extension ships a `parts.miner` descriptor, with the bazaar (netuid 553) as the reference miner.

**Architecture:** A tiny core change (the `miner` manifest part + its install placement) plus one new extension, `fez-mining`, that owns everything else: a `fez-mine` CLI, a `fez-mine-run` supervised runner, a sentinel reconcile task, and the GUI nav view. Registration and burn signing stay inside fez-wallet (guardian custody, shelled out to as a process). Subnet discovery is fez-bittensor's existing chain read, extracted into a library export.

**Tech Stack:** TypeScript ESM, esbuild bundles per package, vitest per package, React (iife `__fezExt` gui parts), @polkadot/api via fez-wallet/fez-bittensor.

**Spec:** `docs/superpowers/specs/2026-09-07-any-subnet-mining-design.md`

## Global Constraints

- Plain commit messages, no Co-Authored-By or any trailers (Ken's standing rule).
- Commit locally only. NEVER push — Ken tests first.
- All packages are ESM (`"type": "module"`); node builtins imported as `node:fs` etc.
- Per-package tests: `npm test` = `vitest --run` inside the package dir. Root `npm test` also runs vitest.
- Gui parts build as `--format=iife --global-name=__fezExt --platform=browser` and `export default function activate(api)` (fez-wallet/fez-loom pattern). Node bins build as `--format=esm --platform=node` with the createRequire banner (copy fez-wallet's build script).
- `minFezVersion: "0.2.0"` on new packages; default netuid for examples is 553 (testnet).
- The chain is testnet finney (`wss://test.finney.opentensor.ai`) wherever a task touches it; no mainnet spend anywhere in this plan.
- fez-bazaar lives in the SIBLING repo `/Users/ken/Projects/Fez/fez-bazaar` (Task 10 only); everything else is in `/Users/ken/Projects/Fez/fez`.

---

### Task 1: Miner contract types + manifest part (fez-extension-api)

**Files:**
- Create: `packages/fez-extension-api/src/miner.ts`
- Modify: `packages/fez-extension-api/src/manifest.ts` (add `miner?: string` to `parts`)
- Modify: `packages/fez-extension-api/src/index.ts` (export the new module)

**Interfaces:**
- Consumes: nothing.
- Produces: `SubnetMiner`, `MinerContext`, `MinerStatus` types and the `parts.miner` manifest field. Tasks 6, 7, 10 import these types; Task 2 places the part.

- [ ] **Step 1: Write the contract module**

```ts
// packages/fez-extension-api/src/miner.ts
/**
 * The MINER surface — how a subnet extension teaches fez to mine its
 * subnet. A `parts.miner` module default-exports SubnetMiner[]; the
 * install places it in ~/.fez/miners/<name>.js and the mining harness
 * (fez-mining) loads every file in that dir.
 *
 * The harness owns what is the same for every subnet: chain
 * registration (burnedRegister via fez-wallet), process supervision,
 * restart, and the GUI. A descriptor owns only what is subnet-specific.
 */

/** What the harness hands every verb. */
export interface MinerContext {
  /** Absolute dir this miner may write — venv, checkout, logs. Created by the harness. */
  workDir: string;
  /** The mining persona's name (its derived account IS the hotkey). */
  persona: string;
  /** The hotkey's ss58 address. */
  hotkey: string;
  netuid: number;
  /** Extra env the harness was configured with for this miner. */
  env: Record<string, string>;
  /** Append a line to the miner's log (harness tees to file + stdout). */
  log(line: string): void;
}

export interface MinerStatus {
  running: boolean;
  detail?: string;
}

export interface SubnetMiner {
  netuid: number;
  /** Short human name shown in the GUI row ("bazaar"). */
  name: string;
  requirements?: { gpu?: string; ramGb?: number; diskGb?: number; alwaysOn?: boolean };
  /** One-time machine setup (clone, deps). MUST be idempotent — the runner calls it every start. */
  install?(ctx: MinerContext): Promise<void>;
  /**
   * Subnet-specific enrollment AFTER chain registration (the harness has
   * already burnedRegister'd the hotkey when this runs) — e.g. the
   * bazaar's npub↔hotkey binding. Called once per (netuid, persona);
   * the harness records completion in a flag file.
   */
  register?(ctx: MinerContext): Promise<void>;
  /** Run the miner. Resolves only when mining stops; the harness supervises the process around it. */
  start(ctx: MinerContext): Promise<void>;
  /** Graceful stop; the harness kills the process if this is absent or hangs. */
  stop?(ctx: MinerContext): Promise<void>;
  /** Subnet-side health beyond process-alive. */
  status?(ctx: MinerContext): Promise<MinerStatus>;
}
```

- [ ] **Step 2: Add the part to the manifest type**

In `packages/fez-extension-api/src/manifest.ts`, inside `parts?: {...}` after the `workspace` line:

```ts
      /** → ~/.fez/miners: SubnetMiner[] descriptors the mining harness loads. */
      miner?: string;
```

- [ ] **Step 3: Export from index**

In `packages/fez-extension-api/src/index.ts` add:

```ts
export type * from "./miner.js";
```

- [ ] **Step 4: Verify it builds**

Run: `npm run build --prefix packages/fez-extension-api` (or `tsc --noEmit` there if that's the check script — read its package.json first).
Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-extension-api
git commit -m "extension-api: miner part — the SubnetMiner contract"
```

---

### Task 2: package-manager places and removes the miner part

**Files:**
- Modify: `src/extensions/package-manager.ts` (three spots: the inline `parts` type ~line 103-110, `installParts` ~line 937, `removeOwnedIndexEntries` ~line 684)

**Interfaces:**
- Consumes: the `parts.miner` manifest field (Task 1).
- Produces: installed descriptors at `~/.fez/miners/<name>.js` — Task 6's runner and Task 7's CLI read this dir.

- [ ] **Step 1: Add `miner?: string` to the inline parts type**

`package-manager.ts` re-declares the parts shape twice — the `FezManifest` interface near line 103 and the `installParts` parameter near line 939. Add `miner?: string;` to BOTH, after `workspace`.

- [ ] **Step 2: Place it in installParts**

Copy the `parts.relay` branch pattern (lines ~968-980) — mkdir, materialize, symlink index:

```ts
    if (parts.miner) {
      // → ~/.fez/miners: SubnetMiner[] descriptors; loaded by the mining
      // harness (fez-mining), not by any host process.
      const minersDir = this.home("miners");
      await fs.mkdir(minersDir, { recursive: true });
      const dest = await this.materializeIntoPackage(name, parts.miner);
      this.linkIndex(dest, path.join(minersDir, `${name}.js`));
      console.log(chalk.dim(`   Created ~/.fez/miners/${name}.js`));
    }
```

- [ ] **Step 3: Remove it on uninstall**

In `removeOwnedIndexEntries`, after the `parts?.workspace` line:

```ts
    if (parts?.miner) await this.removeIfOwned(name, this.home("miners", `${name}.js`));
```

- [ ] **Step 4: Verify by build + link smoke**

Run: `npm run build` (repo root), then after Task 5 exists, `node dist/cli.js link packages/fez-mining` will prove placement (`ls ~/.fez/miners/`). For now: `npx tsc --noEmit` at root.
Expected: clean typecheck. (The runnable end-to-end check for this task is Task 11's smoke — installParts has no existing unit harness and building one is not worth it for a copied branch.)

- [ ] **Step 5: Commit**

```bash
git add src/extensions/package-manager.ts
git commit -m "package-manager: place parts.miner into ~/.fez/miners"
```

---

### Task 3: fez-bittensor discovery as a library export

**Files:**
- Create: `packages/fez-bittensor/src/subnets.ts` (moved logic)
- Create: `packages/fez-bittensor/tests/subnets.test.ts`
- Modify: `packages/fez-bittensor/src/mcp.ts` (import from subnets.ts, delete moved code)
- Modify: `packages/fez-bittensor/package.json` (build the second entry, add `exports`, add vitest)

**Interfaces:**
- Consumes: the existing `allSubnets`/`maybeEnrich`/`hexToStr` code currently inline in `mcp.ts` (lines ~23-109).
- Produces: `export interface Subnet { netuid: number; name: string; description?: string; github?: string }` and `export async function allSubnets(): Promise<Subnet[]>` from `@fezchat/bittensor/subnets`. Task 7's CLI imports these.

- [ ] **Step 1: Extract**

Move `FINNEY`, `TAOSTATS_KEY`, `hexToStr`, `chain()`, the `Subnet` type, `allSubnets()`, `maybeEnrich()` from `mcp.ts` into `src/subnets.ts` verbatim, exporting `Subnet`, `allSubnets`, `maybeEnrich`, and a new pure helper so the mapping is testable without a chain:

```ts
/** Pure: one chain identity record → a Subnet row. Exported for tests. */
export function subnetFromIdentity(netuid: number, id: Record<string, unknown>): Subnet {
  return {
    netuid,
    name: hexToStr(id.subnetName) || `subnet ${netuid}`,
    description: hexToStr(id.description) || undefined,
    github: hexToStr(id.githubRepo) || undefined,
  };
}
```

Refactor the mapping inside `allSubnets()` to call `subnetFromIdentity` (keep behavior identical — compare against the current lines 70-85 while moving). `mcp.ts` imports `{ allSubnets, maybeEnrich, type Subnet }` from `./subnets.js`.

- [ ] **Step 2: Write the failing test**

```ts
// packages/fez-bittensor/tests/subnets.test.ts
import { describe, expect, it } from "vitest";
import { subnetFromIdentity } from "../src/subnets.js";

const hex = (s: string) => "0x" + Buffer.from(s, "utf8").toString("hex");

describe("subnetFromIdentity", () => {
  it("decodes hex identity fields", () => {
    const s = subnetFromIdentity(64, {
      subnetName: hex("chutes"),
      description: hex("serverless compute"),
      githubRepo: hex("https://github.com/rayonlabs/chutes"),
    });
    expect(s).toEqual({
      netuid: 64,
      name: "chutes",
      description: "serverless compute",
      github: "https://github.com/rayonlabs/chutes",
    });
  });
  it("falls back to a placeholder name on an empty identity", () => {
    expect(subnetFromIdentity(7, {}).name).toBe("subnet 7");
  });
});
```

Add to `packages/fez-bittensor/package.json`: `"test": "vitest --run"` script, `"vitest"` devDependency (match the version fez-wallet uses), and:

```json
"exports": { ".": "./dist/mcp.js", "./subnets": "./dist/subnets.js" }
```

and extend the build script: `esbuild src/mcp.ts src/subnets.ts --bundle --format=esm --platform=node --outdir=dist`.

- [ ] **Step 3: Run the test — expect FAIL** (`subnetFromIdentity` not yet written if you test-first; otherwise verify it passes and that `hexToStr` behavior matches the original by reading the moved code once more)

Run: `npm test --prefix packages/fez-bittensor`

- [ ] **Step 4: Make it pass; verify the MCP server still builds**

Run: `npm test --prefix packages/fez-bittensor && npm run build --prefix packages/fez-bittensor`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-bittensor
git commit -m "bittensor: subnet discovery as a library export"
```

---

### Task 4: fez-wallet `cost` command

**Files:**
- Modify: `packages/fez-wallet/src/cli-commands.ts` (new `costForNetuid` + `cmdCost`)
- Modify: `packages/fez-wallet/src/cli.ts` (new `cost` case)
- Test: `packages/fez-wallet/tests/cost.test.ts`

**Interfaces:**
- Consumes: `burnCost`, `formatRao` already imported in `cli-commands.ts` from `./chains/subtensor.js`; the file's existing api-connection helper (read how `registerPersona` gets its `api` and reuse the same path).
- Produces: `fez-wallet cost --netuid N [--json]` printing `{ netuid, rao, tao }`. Task 9's GUI shows this (via `fez-mine cost`, Task 7).

- [ ] **Step 1: Write the failing test**

`burnCost(api, netuid)` takes an api; test the formatting layer pure by injecting a fake:

```ts
// packages/fez-wallet/tests/cost.test.ts
import { describe, expect, it } from "vitest";
import { costResult } from "../src/cli-commands.js";

describe("costResult", () => {
  it("shapes rao into the json the gui reads", () => {
    // 1 TAO = 1e9 rao
    expect(costResult(553, 500_000_000n)).toEqual({ netuid: 553, rao: "500000000", tao: "0.5" });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`costResult` not exported)

Run: `npm test --prefix packages/fez-wallet -- cost`

- [ ] **Step 3: Implement**

In `cli-commands.ts` (match the file's existing style — read `registerPersona` and its neighbors first, reuse the same `connectApi`/io plumbing):

```ts
/** Pure shaping so the gui's json contract is testable without a chain. */
export function costResult(netuid: number, rao: bigint): { netuid: number; rao: string; tao: string } {
  return { netuid, rao: rao.toString(), tao: formatRao(rao) };
}

export async function registrationCost(netuid = DEFAULT_NETUID): Promise<{ netuid: number; rao: string; tao: string }> {
  const api = await subtensorFor(loadConfig().endpoints.tao); // same connection registerPersona uses
  return costResult(netuid, await burnCost(api, netuid));
}
```

(`formatRao` — verify its output for 500_000_000n rao is `"0.5"`; if it appends a unit, strip in `costResult` and fix the test to the real shape. The test pins whatever `fez-mine`/GUI will parse.)

In `cli.ts` add beside `register`:

```ts
    case "cost": {
      const r = await registrationCost(netuidArg());
      if (json) console.log(JSON.stringify(r));
      else io.print(`netuid ${r.netuid}: registration burn ${r.tao} tTAO`);
      break;
    }
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test --prefix packages/fez-wallet`
Expected: full suite green (not just the new file).

- [ ] **Step 5: Live check against testnet (read-only, no spend)**

Run: `node packages/fez-wallet/dist/cli.js cost --netuid 553 --json` after `npm run build --prefix packages/fez-wallet`
Expected: a JSON line with a plausible rao value.

- [ ] **Step 6: Commit**

```bash
git add packages/fez-wallet
git commit -m "wallet: cost command — read the registration burn before paying it"
```

---

### Task 5: fez-mining scaffold + state module

**Files:**
- Create: `packages/fez-mining/package.json`, `packages/fez-mining/tsconfig.json`
- Create: `packages/fez-mining/src/state.ts`
- Test: `packages/fez-mining/tests/state.test.ts`

**Interfaces:**
- Consumes: nothing yet.
- Produces: the package skeleton and the state module every later task uses:
  - `interface MinerEntry { netuid: number; persona: string; hotkey: string; uid?: number; desired: "running" | "stopped"; pid?: number; startedAt?: number; lastExit?: string }`
  - `readState(home?)`, `writeState(home, s)`, `upsertMiner(s, entry)`, `removeMiner(s, netuid, persona)`, `minerKey(netuid, persona)` — state file is `<home>/extension-data/fez-mining.json` with keys `{ miners: MinerEntry[], subnets: Subnet[], covered: number[] }` (the same file the GUI reads via `api.storage`; nothing secret lands here — fez-wallet's storage-mirror is the precedent).
  - `home` defaults to `~/.fez`, overridable by env `FEZ_MINE_HOME` (tests use a temp dir).

- [ ] **Step 1: Scaffold the package**

`packages/fez-mining/package.json`:

```json
{
  "name": "@fezchat/mining",
  "version": "0.1.0",
  "description": "Mine any Bittensor subnet from fez — harness, CLI, and GUI.",
  "type": "module",
  "bin": { "fez-mine": "dist/cli.js", "fez-mine-run": "dist/run.js" },
  "scripts": {
    "build": "esbuild src/cli.ts src/run.ts --bundle --format=esm --platform=node --banner:js=\"import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);\" --outdir=dist && esbuild src/gui.tsx --bundle --format=iife --global-name=__fezExt --platform=browser --jsx=transform --jsx-factory=h --outfile=dist/gui.js && esbuild src/headless.ts --bundle --format=esm --platform=node --outfile=dist/headless.js",
    "check": "tsc --noEmit",
    "test": "vitest --run"
  },
  "fez": {
    "type": "extension",
    "parts": { "gui": "dist/gui.js", "headless": "dist/headless.js", "background": true },
    "permissions": ["ui", "processes", "personas", "background", "network:.opentensor.ai"],
    "minFezVersion": "0.2.0"
  },
  "dependencies": { "@fezchat/bittensor": "file:../fez-bittensor" },
  "devDependencies": { "@fezchat/extension-api": "file:../fez-extension-api", "esbuild": "^0.21.5", "typescript": "^5.6.0", "vitest": "^2.0.0" }
}
```

(Check fez-wallet's actual devDependency versions and match them. Copy `tsconfig.json` from fez-lium.)

- [ ] **Step 2: Write the failing state test**

```ts
// packages/fez-mining/tests/state.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readState, writeState, upsertMiner, removeMiner } from "../src/state.js";

const home = () => mkdtempSync(path.join(tmpdir(), "fez-mine-"));

describe("mining state", () => {
  it("round-trips and upserts by (netuid, persona)", async () => {
    const h = home();
    let s = await readState(h);
    expect(s.miners).toEqual([]);
    s = upsertMiner(s, { netuid: 553, persona: "quill", hotkey: "5F...", desired: "running" });
    s = upsertMiner(s, { netuid: 553, persona: "quill", hotkey: "5F...", desired: "stopped" });
    expect(s.miners).toHaveLength(1);
    expect(s.miners[0].desired).toBe("stopped");
    await writeState(h, s);
    expect((await readState(h)).miners[0].netuid).toBe(553);
  });
  it("removes by key and leaves others", async () => {
    let s = { miners: [], subnets: [], covered: [] as number[] };
    s = upsertMiner(s, { netuid: 1, persona: "a", hotkey: "x", desired: "running" });
    s = upsertMiner(s, { netuid: 2, persona: "a", hotkey: "x", desired: "running" });
    s = removeMiner(s, 1, "a");
    expect(s.miners.map((m) => m.netuid)).toEqual([2]);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`src/state.ts` missing)

Run: `npm test --prefix packages/fez-mining`

- [ ] **Step 4: Implement `src/state.ts`**

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Subnet } from "@fezchat/bittensor/subnets";

export interface MinerEntry {
  netuid: number;
  persona: string;
  hotkey: string;
  uid?: number;
  desired: "running" | "stopped";
  pid?: number;
  startedAt?: number;
  lastExit?: string;
}
export interface MiningState { miners: MinerEntry[]; subnets: Subnet[]; covered: number[] }

export const fezHome = (): string => process.env.FEZ_MINE_HOME || path.join(os.homedir(), ".fez");
const stateFile = (home: string) => path.join(home, "extension-data", "fez-mining.json");

export async function readState(home = fezHome()): Promise<MiningState> {
  try {
    const raw = JSON.parse(await fs.readFile(stateFile(home), "utf8"));
    return { miners: raw.miners ?? [], subnets: raw.subnets ?? [], covered: raw.covered ?? [] };
  } catch {
    return { miners: [], subnets: [], covered: [] };
  }
}
export async function writeState(home: string, s: MiningState): Promise<void> {
  await fs.mkdir(path.dirname(stateFile(home)), { recursive: true });
  await fs.writeFile(stateFile(home), JSON.stringify(s, null, 2));
}
export const minerKey = (netuid: number, persona: string) => `${netuid}:${persona}`;
export function upsertMiner(s: MiningState, e: MinerEntry): MiningState {
  const rest = s.miners.filter((m) => minerKey(m.netuid, m.persona) !== minerKey(e.netuid, e.persona));
  return { ...s, miners: [...rest, e] };
}
export function removeMiner(s: MiningState, netuid: number, persona: string): MiningState {
  return { ...s, miners: s.miners.filter((m) => minerKey(m.netuid, m.persona) !== minerKey(netuid, persona)) };
}
```

- [ ] **Step 5: Run — expect PASS**, then commit

```bash
npm test --prefix packages/fez-mining
git add packages/fez-mining
git commit -m "fez-mining: package scaffold + state module"
```

---

### Task 6: fez-mine-run — the runner, with a fixture-miner conformance test

**Files:**
- Create: `packages/fez-mining/src/descriptors.ts` (load `~/.fez/miners/*.js`)
- Create: `packages/fez-mining/src/run.ts` (the `fez-mine-run` bin)
- Create: `packages/fez-mining/tests/fixtures/heartbeat-miner.js`
- Test: `packages/fez-mining/tests/run.test.ts`

**Interfaces:**
- Consumes: `SubnetMiner`/`MinerContext` types (Task 1), state module (Task 5), descriptors placed in `<home>/miners/` (Task 2's placement; tests write the dir by hand).
- Produces:
  - `loadDescriptors(home?): Promise<SubnetMiner[]>` — dynamic-imports every `<home>/miners/*.js`, flattens default exports, skips (and warns on) files that fail to import.
  - `runMiner(netuid, persona, home?): Promise<number>` — resolves the descriptor, builds the context (`workDir = <home>/mining/<netuid>-<persona>/`, log file `miner.log` inside it), runs `install()` then once-only `register()` (flag file `registered` in workDir) then `start()`; returns an exit code; writes `lastExit` + `pid` into state around the run.
  - The bin: `fez-mine-run <netuid> <persona>` calls `runMiner` and exits with its code. Task 7 spawns it; Task 8 respawns it.

- [ ] **Step 1: Write the fixture miner**

```js
// packages/fez-mining/tests/fixtures/heartbeat-miner.js
// The conformance fixture: a SubnetMiner[] module with observable verbs.
import fs from "node:fs/promises";
import path from "node:path";

export default [
  {
    netuid: 9999,
    name: "heartbeat",
    async install(ctx) {
      await fs.writeFile(path.join(ctx.workDir, "installed"), "1");
    },
    async register(ctx) {
      await fs.writeFile(path.join(ctx.workDir, "enrolled"), ctx.hotkey);
    },
    async start(ctx) {
      ctx.log("beating");
      await fs.writeFile(path.join(ctx.workDir, "heartbeat"), String(Date.now()));
      // resolves immediately — a real miner blocks here
    },
  },
];
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/fez-mining/tests/run.test.ts
import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadDescriptors } from "../src/descriptors.js";
import { runMiner } from "../src/run.js";
import { readState } from "../src/state.js";

function homeWithFixture(): string {
  const home = mkdtempSync(path.join(tmpdir(), "fez-mine-"));
  mkdirSync(path.join(home, "miners"), { recursive: true });
  cpSync(path.join(__dirname, "fixtures", "heartbeat-miner.js"), path.join(home, "miners", "heartbeat.js"));
  return home;
}

describe("runner", () => {
  it("loads descriptors from the miners dir", async () => {
    const ds = await loadDescriptors(homeWithFixture());
    expect(ds.map((d) => d.netuid)).toEqual([9999]);
  });
  it("install → register-once → start, with state and workdir evidence", async () => {
    const home = homeWithFixture();
    const code = await runMiner(9999, "testp", home, { hotkey: "5FAKE" });
    expect(code).toBe(0);
    const wd = path.join(home, "mining", "9999-testp");
    expect(existsSync(path.join(wd, "installed"))).toBe(true);
    expect(existsSync(path.join(wd, "enrolled"))).toBe(true);
    expect(existsSync(path.join(wd, "heartbeat"))).toBe(true);
    const s = await readState(home);
    expect(s.miners[0].lastExit).toContain("exit 0");
    // register() must not run twice
    await runMiner(9999, "testp", home, { hotkey: "5FAKE" });
    expect((await import("node:fs")).readFileSync(path.join(wd, "enrolled"), "utf8")).toBe("5FAKE");
  });
});
```

(`runMiner`'s fourth arg `{ hotkey }` lets tests skip the fez-wallet lookup; the bin resolves the real hotkey — Step 4.)

- [ ] **Step 3: Run — expect FAIL**, then implement `descriptors.ts` and `run.ts`

```ts
// packages/fez-mining/src/descriptors.ts
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SubnetMiner } from "@fezchat/extension-api";
import { fezHome } from "./state.js";

export async function loadDescriptors(home = fezHome()): Promise<SubnetMiner[]> {
  const dir = path.join(home, "miners");
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".js")); } catch { return []; }
  const out: SubnetMiner[] = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, f)).href);
      const list = mod.default;
      if (Array.isArray(list)) out.push(...list);
    } catch (e) {
      console.warn(`fez-mine: skipping ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}
```

```ts
// packages/fez-mining/src/run.ts
import fs from "node:fs/promises";
import path from "node:path";
import { loadDescriptors } from "./descriptors.js";
import { fezHome, readState, upsertMiner, writeState } from "./state.js";

export async function runMiner(
  netuid: number,
  persona: string,
  home = fezHome(),
  opts: { hotkey?: string } = {}
): Promise<number> {
  const d = (await loadDescriptors(home)).find((m) => m.netuid === netuid);
  if (!d) throw new Error(`no miner descriptor for netuid ${netuid} — is the subnet's extension installed?`);
  // The hotkey was recorded into state by `fez-mine start` (from
  // RegisterResult.hotkey); the runner never talks to fez-wallet itself,
  // so a sentinel respawn needs no keychain access.
  const known = (await readState(home)).miners.find((m) => m.netuid === netuid && m.persona === persona);
  const hotkey = opts.hotkey ?? known?.hotkey;
  if (!hotkey) throw new Error(`no recorded hotkey for ${netuid}:${persona} — start it once with: fez-mine start`);
  const workDir = path.join(home, "mining", `${netuid}-${persona}`);
  await fs.mkdir(workDir, { recursive: true });
  const logFile = path.join(workDir, "miner.log");
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    fs.appendFile(logFile, stamped).catch(() => {});
    process.stdout.write(stamped);
  };
  const ctx = { workDir, persona, hotkey, netuid, env: { ...process.env } as Record<string, string>, log };

  const record = async (patch: Partial<import("./state.js").MinerEntry>) => {
    const s = await readState(home);
    const cur = s.miners.find((m) => m.netuid === netuid && m.persona === persona);
    await writeState(home, upsertMiner(s, { netuid, persona, hotkey, desired: "running", ...cur, ...patch }));
  };

  await record({ pid: process.pid, startedAt: Date.now() });
  let code = 0;
  try {
    if (d.install) await d.install(ctx);
    const flag = path.join(workDir, "registered");
    if (d.register && !(await fs.access(flag).then(() => true, () => false))) {
      await d.register(ctx);
      await fs.writeFile(flag, "1");
    }
    await d.start(ctx);
  } catch (e) {
    log(`miner error: ${(e as Error).message}`);
    code = 1;
  }
  await record({ pid: undefined, lastExit: `exit ${code} at ${new Date().toISOString()}` });
  return code;
}

// bin entry
if (process.argv[1]?.endsWith("run.js")) {
  const [netuid, persona] = process.argv.slice(2);
  if (!netuid || !persona) { console.error("usage: fez-mine-run <netuid> <persona>"); process.exit(2); }
  runMiner(Number(netuid), persona).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm test --prefix packages/fez-mining`

- [ ] **Step 5: Commit**

```bash
git add packages/fez-mining
git commit -m "fez-mining: runner — descriptors dir, miner lifecycle, conformance fixture"
```

---

### Task 7: fez-mine CLI

**Files:**
- Create: `packages/fez-mining/src/cli.ts`
- Create: `packages/fez-mining/src/procs.ts` (spawn/alive/kill by pid — shared with Task 8)
- Test: `packages/fez-mining/tests/cli.test.ts`

**Interfaces:**
- Consumes: `allSubnets` (Task 3), state (Task 5), `loadDescriptors` (Task 6), `fez-wallet` bin (`register`, `cost` — Task 4).
- Produces (all support `--json`; the GUI drives these via `processes.run("fez-mine", [...])`):
  - `fez-mine subnets [--refresh]` — cached list; `--refresh` re-reads chain via `allSubnets()`, recomputes `covered` from `loadDescriptors()`, writes state.
  - `fez-mine cost --netuid N` — shells `fez-wallet cost --netuid N --json`, passes it through.
  - `fez-mine start --netuid N --persona P` — shells `fez-wallet register P --netuid N --json` (idempotent adopt; THE burn — the GUI confirms before calling this), records `desired: "running"` + uid, spawns `fez-mine-run N P` detached (`procs.spawnDetached`), records pid.
  - `fez-mine stop --netuid N --persona P` — records `desired: "stopped"`, kills the pid if alive.
  - `fez-mine status [--json]` — the state's miners annotated with `alive` (pid check).

- [ ] **Step 1: Write the failing test for the pure parts**

```ts
// packages/fez-mining/tests/cli.test.ts
import { describe, expect, it } from "vitest";
import { statusRows } from "../src/cli.js";

describe("statusRows", () => {
  it("annotates miners with liveness", () => {
    const rows = statusRows(
      [{ netuid: 553, persona: "quill", hotkey: "5F", desired: "running", pid: 1 }],
      (pid) => pid === 1
    );
    expect(rows[0]).toMatchObject({ netuid: 553, alive: true });
    const dead = statusRows(
      [{ netuid: 553, persona: "quill", hotkey: "5F", desired: "running", pid: 999999 }],
      () => false
    );
    expect(dead[0].alive).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL, then implement**

`src/procs.ts`:

```ts
import { spawn } from "node:child_process";

export function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function spawnDetached(bin: string, args: string[], env: Record<string, string> = {}): number {
  const child = spawn(bin, args, { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn ${bin}`);
  return child.pid;
}
export function kill(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
}
```

`src/cli.ts` — argv dispatch in the fez-wallet cli.ts style (`--json`, `--netuid`, `--persona` flags), commands as listed in Produces. The exported pure helper the test pins:

```ts
import type { MinerEntry } from "./state.js";
export function statusRows(miners: MinerEntry[], isAlive: (pid?: number) => boolean) {
  return miners.map((m) => ({ ...m, alive: isAlive(m.pid) }));
}
```

`start` shells fez-wallet with `execFileSync("fez-wallet", ["register", persona, "--netuid", String(netuid), "--json"], { encoding: "utf8" })` and parses `RegisterResult` — `{ persona, netuid, uid, hotkey, txHash?, burned?, adopted? }` (`cli-commands.ts` ~line 210). It records `hotkey` + `uid` into state (the runner reads the hotkey from there), then `spawnDetached("fez-mine-run", [String(netuid), persona])`. Both bins resolve via `~/.fez/bin` on PATH; when running from the repo before install, pass absolute dist paths via env `FEZ_MINE_RUN_BIN`/`FEZ_WALLET_BIN` overrides (read them at the top of cli.ts: `const WALLET_BIN = process.env.FEZ_WALLET_BIN || "fez-wallet"`).

- [ ] **Step 3: Run — expect PASS**

Run: `npm test --prefix packages/fez-mining && npm run check --prefix packages/fez-mining`

- [ ] **Step 4: Commit**

```bash
git add packages/fez-mining
git commit -m "fez-mining: cli — subnets, cost, start/stop/status"
```

---

### Task 8: headless part — sentinel reconcile

**Files:**
- Create: `packages/fez-mining/src/reconcile.ts` (pure)
- Create: `packages/fez-mining/src/headless.ts` (the part)
- Test: `packages/fez-mining/tests/reconcile.test.ts`

**Interfaces:**
- Consumes: state (Task 5), `procs.alive`/`spawnDetached` (Task 7), `registerScheduledTask` from `@fezchat/extension-api/headless` (Task 1's package).
- Produces: `plan(miners, isAlive): MinerEntry[]` — the miners that should be respawned. The headless part runs it every 120s in the sentinel (`background: true` is already in Task 5's manifest).

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-mining/tests/reconcile.test.ts
import { describe, expect, it } from "vitest";
import { plan } from "../src/reconcile.js";

const miner = (netuid: number, desired: "running" | "stopped", pid?: number) =>
  ({ netuid, persona: "p", hotkey: "5F", desired, pid });

describe("reconcile plan", () => {
  it("respawns only desired-running miners whose process is gone", () => {
    const out = plan(
      [miner(1, "running", 10), miner(2, "running", 20), miner(3, "stopped", 30)],
      (pid) => pid === 10
    );
    expect(out.map((m) => m.netuid)).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL, then implement**

```ts
// packages/fez-mining/src/reconcile.ts
import type { MinerEntry } from "./state.js";
export function plan(miners: MinerEntry[], isAlive: (pid?: number) => boolean): MinerEntry[] {
  return miners.filter((m) => m.desired === "running" && !isAlive(m.pid));
}
```

```ts
// packages/fez-mining/src/headless.ts
import type { FezExtensionAPI } from "@fezchat/extension-api/headless";
import { readState, writeState, upsertMiner, fezHome } from "./state.js";
import { alive, spawnDetached } from "./procs.js";
import { plan } from "./reconcile.js";

export default function activate(api: FezExtensionAPI): void {
  api.registerScheduledTask("mining-reconcile", 120_000, async () => {
    const home = fezHome();
    let s = await readState(home);
    for (const m of plan(s.miners, alive)) {
      const bin = process.env.FEZ_MINE_RUN_BIN || "fez-mine-run";
      const pid = spawnDetached(bin, [String(m.netuid), m.persona]);
      s = upsertMiner(s, { ...m, pid, startedAt: Date.now() });
    }
    await writeState(home, s);
  });
}
```

(Read one existing headless part first — e.g. `packages/fez-communities/src` entry — and match its activate/default-export shape exactly; if the loader expects a named export instead of default, follow the loader.)

- [ ] **Step 3: Run — expect PASS, commit**

```bash
npm test --prefix packages/fez-mining
git add packages/fez-mining
git commit -m "fez-mining: sentinel reconcile — respawn desired-running miners"
```

---

### Task 9: GUI — the Mining nav view

**Files:**
- Create: `packages/fez-mining/src/gui.tsx`
- Test: `packages/fez-mining/tests/gui-rows.test.ts`

**Interfaces:**
- Consumes: `GuiExtensionApi` (`registerNavView` — see `packages/fez-loom/src/gui.tsx:219` for the mount form; `api.storage.get`, `api.processes.run`, `api.personas.list`), state shape (Task 5), `fez-mine` CLI (Task 7).
- Produces: nav view `"mining"` (glyph `"⛏"`, label `"Mining"`).

Behavior (all actions go through `api.processes!.run("fez-mine", [...])` — the GUI may only run its own package's bins; fez-mine shells to fez-wallet from its own process, which the seam does not restrict):

1. On mount: `storage.get("subnets")`, `storage.get("miners")`, `storage.get("covered")`; a Refresh button runs `fez-mine subnets --refresh` then re-reads.
2. Subnet rows: `netuid · name — description`, badge `curated` when `covered.includes(netuid)`, else a disabled `agent-run (v2)` chip. Curated rows get a **Mine** button.
3. Mine flow (curated only): pick persona from `api.personas!.list()` → run `fez-mine cost --netuid N --json` → confirm dialog stating the exact tTAO burn (skipped-if-adopted note) → on confirm run `fez-mine start --netuid N --persona P --json` → refresh rows.
4. Miner rows (top of page): persona, subnet name, alive/dead dot, uid, startedAt, lastExit; Stop button → `fez-mine stop ...`; poll `storage.get("miners")` + `fez-mine status --json` every 10s while the view is mounted.

- [ ] **Step 1: Write the failing row-model test**

```ts
// packages/fez-mining/tests/gui-rows.test.ts
import { describe, expect, it } from "vitest";
import { subnetRows } from "../src/gui-rows.js";

describe("subnetRows", () => {
  it("badges covered subnets and sorts them first", () => {
    const rows = subnetRows(
      [{ netuid: 1, name: "one" }, { netuid: 553, name: "bazaar" }],
      [553]
    );
    expect(rows[0]).toMatchObject({ netuid: 553, curated: true });
    expect(rows[1]).toMatchObject({ netuid: 1, curated: false });
  });
});
```

Put the pure helper in `src/gui-rows.ts` (not the .tsx) so vitest needs no DOM:

```ts
import type { Subnet } from "@fezchat/bittensor/subnets";
export function subnetRows(subnets: Subnet[], covered: number[]) {
  return subnets
    .map((s) => ({ ...s, curated: covered.includes(s.netuid) }))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || a.netuid - b.netuid);
}
```

- [ ] **Step 2: Run — expect FAIL, implement, PASS**

Run: `npm test --prefix packages/fez-mining`

- [ ] **Step 3: Build the gui part; implement `gui.tsx`**

`export default function activate(api: GuiExtensionApi): void { api.registerNavView("mining", { glyph: "⛏", label: "Mining" }, (host) => { ... createRoot(host).render(<MiningPage api={api}/>) ... return dispose }) }` — copy the mount-form mechanics from fez-loom's registerNavView call and the panel styling conventions from fez-wallet's gui.tsx. Keep it one file; no router, no css file (inline styles like the wallet panel).

Run: `npm run build --prefix packages/fez-mining`
Expected: `dist/gui.js`, `dist/cli.js`, `dist/run.js`, `dist/headless.js` all emitted.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-mining
git commit -m "fez-mining: gui — the Mining nav view"
```

---

### Task 10: Bazaar reference miner (sibling repo)

**Files (all in `/Users/ken/Projects/Fez/fez-bazaar`):**
- Create: `src/miner-part.ts`
- Modify: `package.json` (`fez.parts.miner: "dist/miner.js"`, build entry `build:miner-part`)

**Interfaces:**
- Consumes: `SubnetMiner` type (dev-dep on `file:../fez/packages/fez-extension-api`), the existing `fez-bazaar-miner` bin (`dist/fez-bazaar-miner.js`, built by `build:miner-js`).
- Produces: `~/.fez/miners/<name>.js` exporting the netuid-553 descriptor once the package is `fez link`ed / installed.

- [ ] **Step 1: Read `src/miner/main.ts` top-to-bottom** — pin exactly which env vars and args the miner expects (persona/profile selection, relay URL, keys). Write them into the descriptor below where marked.

- [ ] **Step 2: Write the descriptor**

```ts
// src/miner-part.ts — the fez mining-harness descriptor for netuid 553.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SubnetMiner } from "@fezchat/extension-api";

const here = path.dirname(fileURLToPath(import.meta.url)); // ~/.fez/miners resolves the symlink into the package dir
const MINER_BIN = path.join(here, "fez-bazaar-miner.js");

const bazaar: SubnetMiner = {
  netuid: 553,
  name: "bazaar",
  requirements: { alwaysOn: true },
  // chain registration is the harness's job; the npub↔hotkey binding
  // (kind 47040) is not built yet — becomes register() when it lands.
  async start(ctx) {
    ctx.log(`starting bazaar miner as ${ctx.persona} (hotkey ${ctx.hotkey})`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [MINER_BIN], {
        cwd: ctx.workDir,
        env: { ...ctx.env /* + the env vars Step 1 found, from ctx */ },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (d) => ctx.log(String(d).trimEnd()));
      child.stderr.on("data", (d) => ctx.log(String(d).trimEnd()));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`bazaar miner exited ${code}`))));
      child.on("error", reject);
    });
  },
};

export default [bazaar];
```

- [ ] **Step 3: Wire the build + manifest**

Add to scripts: `"build:miner-part": "bun build src/miner-part.ts --format=esm --outfile dist/miner.js --target=node"` and append it to `build:ext`. Add `"miner": "dist/miner.js"` to `fez.parts`. Dev-dep: `"@fezchat/extension-api": "file:../fez/packages/fez-extension-api"`.

- [ ] **Step 4: Verify**

Run (in fez-bazaar): `bun run typecheck && bun run build:ext`, then (in fez) `node dist/cli.js link ../fez-bazaar` and `ls ~/.fez/miners/`.
Expected: a `.js` symlink named after the package appears; `node -e "import(process.argv[1]).then(m => console.log(m.default[0].netuid))" ~/.fez/miners/*.js` prints `553`.

- [ ] **Step 5: Commit (in fez-bazaar, plain message)**

```bash
git -C /Users/ken/Projects/Fez/fez-bazaar add -A
git -C /Users/ken/Projects/Fez/fez-bazaar commit -m "miner part: netuid 553 descriptor for the fez mining harness"
```

---

### Task 11: End-to-end smoke on the Mac (Ken in the loop)

**Files:** none — verification only. This is the runnable check for Tasks 2 and 9.

- [ ] **Step 1: Build + link everything**

```bash
npm run build   # repo root
npm run build --prefix packages/fez-mining
node dist/cli.js link packages/fez-mining
ls ~/.fez/miners ~/.fez/bin | grep -i mine
```

Expected: `fez-mine`, `fez-mine-run` bins; miners dir exists (bazaar descriptor if Task 10 linked).

- [ ] **Step 2: CLI smoke, read-only**

```bash
fez-mine subnets --refresh | head -20
fez-mine cost --netuid 553 --json
fez-mine status --json
```

Expected: real subnet list from finney testnet; a burn cost; empty miners.

- [ ] **Step 3: Start the bazaar miner through the harness**

quill is already registered on 553, so `fez-wallet register quill --netuid 553` takes the idempotent **adopt** path — no burn. Run:

```bash
fez-mine start --netuid 553 --persona quill --json
fez-mine status --json
tail -f ~/.fez/mining/553-quill/miner.log
```

Expected: `alive: true`, uid echoed from the adopt, log lines flowing. Then `fez-mine stop --netuid 553 --persona quill` and confirm the pid is gone.

- [ ] **Step 4: Desktop GUI check (Ken)**

Per the extension-iteration workflow: copy dist into `~/.fez`, relaunch the desktop app. Ken verifies: Mining nav view renders, subnet list shows with bazaar badged curated, Mine flow shows the cost confirm, miner row goes live, Stop works. **STOP HERE — do not push anything. Ken tests, then decides.**

---

## Deliberate v1 exclusions (from the spec's build order)

- Agent fallback for uncovered subnets — v2. The GUI's disabled `agent-run (v2)` chip is the only trace.
- LiumMachine / remote provisioning — v3. `MinerContext` carries no machine field yet; adding one later is additive.
- Immunity-period countdown + rank in miner rows — needs per-uid chain reads (`query.subtensorModule` metagraph); add when the row exists to hang it on. Tracked, not built.
