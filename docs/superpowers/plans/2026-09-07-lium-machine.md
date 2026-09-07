# LiumMachine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Mining page can run a miner on a rented Lium GPU pod — pick subnet → pick machine → confirm burn + $/hr → live row — with Gradients (SN56) as the first curated remote descriptor.

**Architecture:** A `MinerMachine` seam (`exec/copy/ports`) is added to the miner contract; descriptors talk to machines through it. LocalMachine wraps the shell (phase A, no behavior change). LiumMachine wraps the `lium` CLI via a small library extracted from fez-lium (phase B), with a standalone remote hotkey exported by fez-wallet and pod-aware sentinel reconcile. Phase C adds the Gradients descriptor, the GUI machine picker, and the hardware-gated badge; the mainnet unlock is a gated task that runs only on Ken's explicit go.

**Tech Stack:** TypeScript ESM, esbuild, vitest, `lium` CLI (execFile argv, `--format json`), @polkadot/api via fez-wallet.

**Spec:** `docs/superpowers/specs/2026-09-07-lium-machine-design.md` (read its §3 amendment: remote hotkeys are standalone fresh keypairs, never root-derived).

## Global Constraints

- Plain commit messages, no trailers of any kind. Never push — Ken tests first.
- ESM everywhere (`node:` builtins); per-package `npm test` (vitest) + `npm run check` (tsc --noEmit) must be clean at every commit.
- Bins carry `#!/usr/bin/env node` + the realpath main-module guard (copy the pattern from `packages/fez-mining/src/run.ts` verbatim — never a filename-suffix check).
- fez-mining's cli/run esbuild line already carries `--external:@fezchat/bittensor`; anything else externalized must be a real dependency in package.json (install-time npm install provides node_modules).
- The root mnemonic is read ONLY in `packages/fez-wallet/src/cli-commands.ts` (existing invariant — `grep -rn '"root"' src | grep -v cli-commands` stays empty). The new remote-hotkey entry follows the same rule.
- No real Lium spend in any unit test — LiumMachine is tested with an injected fake exec. Real money appears only in Task 12's supervised smoke (cents, testnet 553).
- Phase A must leave v1 behavior identical: the v1 smoke (`fez-mine start/stop --netuid 553 --persona quill` locally) still works after every phase-A commit.
- fez-bazaar lives in the SIBLING repo `/Users/ken/Projects/Fez/fez-bazaar` (Task 3 only).
- Mainnet unlock (Task 11) executes ONLY after Ken's explicit go recorded in the session — skip it otherwise and say so.

---

### Task 1: Contract v2 — MinerMachine on the context (fez-extension-api)

**Files:**
- Modify: `packages/fez-extension-api/src/miner.ts`

**Interfaces:**
- Consumes: existing `MinerContext`.
- Produces (all later tasks): `MinerMachine`, `MachinePort`, and `MinerContext.machine`.

- [ ] **Step 1: Add the types**

In `miner.ts`, above `MinerContext`:

```ts
/** A public endpoint mapping on the machine — how a serving miner (an
 *  axon) is reached from the internet. Empty on a local machine. */
export interface MachinePort {
  externalIp: string;
  externalPort: number;
  internalPort: number;
}

/**
 * The machine seam — where a miner's commands actually run. Descriptors
 * call these instead of spawning directly, so one descriptor works on
 * any machine kind whose requirements it fits. "ssh" is the designed-for
 * third member (spec §7), not yet built.
 */
export interface MinerMachine {
  kind: "local" | "lium";
  /** Run a shell command on the machine; resolves when it exits. */
  exec(cmd: string, opts?: { env?: Record<string, string>; cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Copy a local file or directory onto the machine. */
  copy(localPath: string, remotePath: string): Promise<void>;
  ports: MachinePort[];
}
```

And add to `MinerContext` after `env`:

```ts
  /** Where this miner's commands run. Local shell today; a rented pod
   *  when the harness provisioned one. */
  machine: MinerMachine;
```

- [ ] **Step 2: Build** — `npm run build --prefix packages/fez-extension-api`; expected clean.
- [ ] **Step 3: Commit** — `git add packages/fez-extension-api && git commit -m "extension-api: MinerMachine seam on the miner context"`

---

### Task 2: LocalMachine + runner wires ctx.machine (fez-mining, phase A)

**Files:**
- Create: `packages/fez-mining/src/machine-local.ts`
- Modify: `packages/fez-mining/src/run.ts` (build `ctx.machine`)
- Test: `packages/fez-mining/tests/machine-local.test.ts`

**Interfaces:**
- Consumes: `MinerMachine` (Task 1).
- Produces: `localMachine(): MinerMachine` — Tasks 3, 7 rely on `ctx.machine` existing on every run.

- [ ] **Step 1: Write the failing test**

```ts
// packages/fez-mining/tests/machine-local.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { localMachine } from "../src/machine-local.js";

describe("localMachine", () => {
  it("execs a shell command with env and cwd", async () => {
    const m = localMachine();
    const dir = mkdtempSync(path.join(tmpdir(), "fm-"));
    const r = await m.exec("echo -n $FOO > out.txt && pwd", { env: { FOO: "bar" }, cwd: dir });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("bar");
  });
  it("reports nonzero exit codes without throwing", async () => {
    const r = await localMachine().exec("exit 3");
    expect(r.code).toBe(3);
  });
  it("copies a file", async () => {
    const m = localMachine();
    const dir = mkdtempSync(path.join(tmpdir(), "fm-"));
    const src = path.join(dir, "a"); writeFileSync(src, "x");
    await m.copy(src, path.join(dir, "b"));
    expect(readFileSync(path.join(dir, "b"), "utf8")).toBe("x");
  });
  it("has no ports and kind local", () => {
    const m = localMachine();
    expect(m.kind).toBe("local");
    expect(m.ports).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npm test --prefix packages/fez-mining -- machine-local`)
- [ ] **Step 3: Implement**

```ts
// packages/fez-mining/src/machine-local.ts
import { exec as cpExec } from "node:child_process";
import fs from "node:fs/promises";
import type { MinerMachine } from "@fezchat/extension-api";

/** The Mac itself, behind the seam: exec is a shell, copy is cp, no ports. */
export function localMachine(): MinerMachine {
  return {
    kind: "local",
    ports: [],
    exec(cmd, opts = {}) {
      return new Promise((resolve) => {
        cpExec(cmd, { env: { ...process.env, ...opts.env }, cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
      });
    },
    async copy(localPath, remotePath) {
      await fs.cp(localPath, remotePath, { recursive: true });
    },
  };
}
```

In `run.ts`, where the `ctx` object is built, add `machine: localMachine()` (import from `./machine-local.js`). Task 7 later makes this machine-selected; for phase A it is always local.

- [ ] **Step 4: Run — expect PASS**, plus the whole package suite + `npm run check` clean.
- [ ] **Step 5: Commit** — `git add packages/fez-mining && git commit -m "fez-mining: LocalMachine behind the seam; runner supplies ctx.machine"`

---

### Task 3: Bazaar descriptor migrates onto the seam (sibling repo, phase A)

**Files (in `/Users/ken/Projects/Fez/fez-bazaar`):**
- Modify: `src/miner-part.ts`

**Interfaces:**
- Consumes: `ctx.machine.exec` (Tasks 1–2). The structural type mirror in miner-part.ts gains the machine field.

- [ ] **Step 1: Extend the structural mirror** in `src/miner-part.ts` — add to its local `MinerContext` interface:

```ts
  machine: {
    kind: string;
    exec(cmd: string, opts?: { env?: Record<string, string>; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
    copy(localPath: string, remotePath: string): Promise<void>;
    ports: { externalIp: string; externalPort: number; internalPort: number }[];
  };
```

- [ ] **Step 2: Migrate start()** — replace the direct `spawn(process.execPath, [MINER_BIN], ...)` with the seam. The miner bin file must exist ON the machine, so start() first copies it over (a no-op-ish local cp today, the exact right thing on a pod):

```ts
  async start(ctx) {
    ctx.log(`starting bazaar miner as ${ctx.persona} (hotkey ${ctx.hotkey})`);
    const remoteBin = `${ctx.workDir}/fez-bazaar-miner.js`;
    await ctx.machine.copy(MINER_BIN, remoteBin);
    const r = await ctx.machine.exec(`node ${JSON.stringify(remoteBin)} 2>&1 | tee -a miner-child.log`, {
      cwd: ctx.workDir,
      env: { ...ctx.env, BAZAAR_PROFILE: ctx.persona, BAZAAR_HOTKEY: ctx.hotkey, BAZAAR_NETUID: String(ctx.netuid) },
    });
    if (r.code !== 0) throw new Error(`bazaar miner exited ${r.code}`);
  },
```

(Keep the existing realpath `MINER_BIN` resolution. The blocking contract is preserved — `exec` resolves when the miner exits. Streaming per-line logs through `ctx.log` is lost in exchange for machine-portability; the `tee` keeps a child log in workDir. Note this trade in the commit message.)

- [ ] **Step 3: Verify** — in fez-bazaar: `bun run typecheck && bun run build:ext`. Then from the fez repo: the v1 local smoke — `~/.fez/bin/fez-mine start --netuid 553 --persona quill --json`, confirm the log shows the miner connecting, then `stop`. Expected: identical behavior to v1.
- [ ] **Step 4: Commit (fez-bazaar, only its own files)** — `git -C /Users/ken/Projects/Fez/fez-bazaar add src/miner-part.ts && git -C /Users/ken/Projects/Fez/fez-bazaar commit -m "miner part: drive the miner through the harness machine seam"`

---

### Task 4: fez-lium CLI as a library export (phase B)

**Files:**
- Create: `packages/fez-lium/src/cli-lib.ts` (moved logic)
- Modify: `packages/fez-lium/src/mcp.ts` (import from cli-lib, delete moved code)
- Modify: `packages/fez-lium/package.json` (exports map + second build entry + vitest)
- Test: `packages/fez-lium/tests/cli-lib.test.ts`

**Interfaces:**
- Consumes: the existing `liumBin()`, `lium(args, timeoutMs)`, `parseJson`, `record` currently inline in mcp.ts (~lines 40–105).
- Produces: `@fezchat/lium/cli` exporting `lium(args, timeoutMs?)` → `{ok:true,out}|{ok:false,err}`, `parseJson<T>`, `record(row)`, and the guard re-exports (`parseTtl`, `DEFAULT_MAX_USD_HOUR`, …) from `./guards.js`. Task 6 consumes these.

- [ ] **Step 1: Extract verbatim** — move `EXEC_CAP`, `INSTALL`, `NO_KEY`, `FEZ_BIN`, `exists`, `liumBin`, `lium`, `parseJson`, `priceOf`, `matchesNode`, `ROWS`, `Row`, `record` into `src/cli-lib.ts`, all exported; mcp.ts imports them. This is a MOVE — behavior identical; diff the moved code against the original.
- [ ] **Step 2: Failing test** (the pure parts — no lium binary):

```ts
// packages/fez-lium/tests/cli-lib.test.ts
import { describe, expect, it } from "vitest";
import { parseJson, priceOf, matchesNode } from "../src/cli-lib.js";

describe("cli-lib pure helpers", () => {
  it("parseJson tolerates garbage", () => {
    expect(parseJson("{not json")).toBeNull();
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it("priceOf reads price_per_hour", () => {
    expect(priceOf({ price_per_hour: "1.5" })).toBe(1.5);
    expect(priceOf({})).toBeNull();
  });
  it("matchesNode matches index, id, or huid", () => {
    expect(matchesNode({ id: "abc" }, "abc")).toBe(true);
    expect(matchesNode({ index: 3 }, "3")).toBe(true);
    expect(matchesNode({}, "x")).toBe(false);
  });
});
```

Add to package.json: `"test": "vitest --run"` script + vitest devDependency (match fez-wallet's version); `"exports": { ".": "./dist/mcp.js", "./cli": "./dist/cli-lib.js" }`; build both entries (`esbuild src/mcp.ts src/cli-lib.ts --bundle --format=esm --platform=node --outdir=dist`).

- [ ] **Step 3: Run — FAIL → implement → PASS**; `npm run build --prefix packages/fez-lium` emits both entries; `npm run check` clean.
- [ ] **Step 4: Commit** — `git add packages/fez-lium && git commit -m "lium: cli wrapper as a library export"`

---

### Task 5: fez-wallet — standalone remote hotkey + export-hotkey (phase B)

**Files:**
- Modify: `packages/fez-wallet/src/cli-commands.ts` (remote-hotkey create/load/export + register override)
- Modify: `packages/fez-wallet/src/cli.ts` (verb `export-hotkey <persona> [--json]`)
- Test: `packages/fez-wallet/tests/remote-hotkey.test.ts`

**Interfaces:**
- Consumes: `generateWalletMnemonic()` and the sr25519 pair helpers in `src/derive.ts`; the keychain store seam in `src/store.ts` (read it first — mirror how the root entry is stored, under a DIFFERENT entry name `remote-hotkey/<persona>`).
- Produces:
  - `keyfileFor(mnemonic: string): { accountId: string; publicKey: string; secretPhrase: string; ss58Address: string }` — pure, exported for tests. **Verification step inside this task:** pin the exact field set against the bittensor-wallet keyfile loader (fetch `https://github.com/opentensor/btwallet` or the bittensor `keyfile.py` and cite the accepted fields in a code comment; adjust fields to what it actually loads — `secretPhrase` is the load path that avoids needing a mini-secret).
  - `exportRemoteHotkey(persona: string): Promise<{ persona: string; ss58Address: string; keyfile: object; created: boolean }>` — create-or-load, mnemonic never printed except inside the keyfile JSON.
  - `registerPersona` gains an optional third argument `opts?: { hotkeyAddress?: string }` — when given, the treasury registers THAT address instead of the derived pair's (adopt-idempotency by that address). Existing two-arg calls unchanged.
  - CLI: `fez-wallet export-hotkey quill --json` → the export result on stdout.

- [ ] **Step 1: Failing test**

```ts
// packages/fez-wallet/tests/remote-hotkey.test.ts
import { describe, expect, it } from "vitest";
import { keyfileFor } from "../src/cli-commands.js";
import { generateWalletMnemonic } from "../src/derive.js";

describe("remote hotkey keyfile", () => {
  it("shapes a btcli-loadable keyfile from a mnemonic", () => {
    const m = generateWalletMnemonic();
    const k = keyfileFor(m);
    expect(k.secretPhrase).toBe(m);
    expect(k.ss58Address).toMatch(/^5/);
    expect(k.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(k.accountId).toBe(k.publicKey);
  });
  it("is deterministic for the same mnemonic", () => {
    const m = generateWalletMnemonic();
    expect(keyfileFor(m)).toEqual(keyfileFor(m));
  });
});
```

- [ ] **Step 2: Run — FAIL → implement.** `keyfileFor` builds the pair from the bare mnemonic (no derivation path — standalone key) using the same sr25519 keyring derive.ts uses. `exportRemoteHotkey` reads/writes the keychain entry through store.ts's seam (new entry helpers beside the root ones; the root entry itself is untouched). The custody grep (`grep -rn '"root"' src | grep -v cli-commands`) must stay empty.
- [ ] **Step 3: Wire the CLI verb** beside `cost` in cli.ts:

```ts
    case "export-hotkey": {
      if (!rest[0]) throw new Error("usage: fez-wallet export-hotkey <persona> [--json]");
      const r = await exportRemoteHotkey(rest[0]);
      if (json) console.log(JSON.stringify(r));
      else io.print(`${r.created ? "created" : "loaded"} remote hotkey for ${r.persona}: ${r.ss58Address}`);
      break;
    }
```

(No-`--json` mode never prints the keyfile — address only.)

- [ ] **Step 4: Full suite + check clean** (`npm test --prefix packages/fez-wallet`, 342+ green), commit — `git add packages/fez-wallet && git commit -m "wallet: standalone remote hotkey — export-hotkey verb and register override"`

---

### Task 6: LiumMachine (fez-mining, phase B)

**Files:**
- Create: `packages/fez-mining/src/machine-lium.ts`
- Modify: `packages/fez-mining/package.json` (dependency `"@fezchat/lium": "file:../fez-lium"`; add `--external:@fezchat/lium` to the SAME esbuild line that externalizes `@fezchat/bittensor`)
- Test: `packages/fez-mining/tests/machine-lium.test.ts`

**Interfaces:**
- Consumes: `lium`, `parseJson` from `@fezchat/lium/cli` (Task 4) — but injected, so tests never touch the binary.
- Produces (Task 7 relies on these exact signatures):

```ts
export interface LiumHandle { podId: string; hourlyRate?: string; ports: MachinePort[]; sshHost?: string }
export type LiumExec = (args: string[], timeoutMs?: number) => Promise<{ ok: true; out: string } | { ok: false; err: string }>;
export function liumMachine(handle: LiumHandle, exec?: LiumExec): MinerMachine;                    // wrap an existing pod
export function provisionPod(opts: { template?: string; ports?: number; ttl?: string; maxUsdHour?: number }, exec?: LiumExec): Promise<LiumHandle>; // lium up + describe
export function podAlive(podId: string, exec?: LiumExec): Promise<boolean>;                       // lium ps
export function teardownPod(podId: string, exec?: LiumExec): Promise<void>;                       // lium rm
```

`exec` defaults to the real `lium` from `@fezchat/lium/cli`; every function takes it injectable.

- [ ] **Step 1: Failing tests with a scripted fake exec**

```ts
// packages/fez-mining/tests/machine-lium.test.ts
import { describe, expect, it } from "vitest";
import { liumMachine, provisionPod, podAlive, teardownPod } from "../src/machine-lium.js";

const script = (responses: Record<string, string>) => {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const out = responses[key] ?? responses[args[0]];
    return out !== undefined ? { ok: true as const, out } : { ok: false as const, err: `no script for ${args.join(" ")}` };
  };
  return { exec, calls };
};

describe("liumMachine", () => {
  it("exec runs through lium exec and parses exit", async () => {
    const { exec, calls } = script({ exec: JSON.stringify({ exit_code: 0, stdout: "hi", stderr: "" }) });
    const m = liumMachine({ podId: "p1", ports: [] }, exec);
    const r = await m.exec("echo hi");
    expect(r).toMatchObject({ code: 0, stdout: "hi" });
    expect(calls[0].slice(0, 3)).toEqual(["exec", "p1", "--format"]);
  });
  it("provisionPod runs up then describe and returns the port map", async () => {
    const { exec } = script({
      up: JSON.stringify({ pod: "p9", price_per_hour: "0.42" }),
      describe: JSON.stringify({ host_ip: "1.2.3.4", ports: [{ external: 20001, internal: 22 }, { external: 20002, internal: 8091 }] }),
    });
    const h = await provisionPod({ ports: 2, ttl: "12h" }, exec);
    expect(h.podId).toBe("p9");
    expect(h.ports).toContainEqual({ externalIp: "1.2.3.4", externalPort: 20002, internalPort: 8091 });
  });
  it("podAlive is false when ps lacks the pod", async () => {
    const { exec } = script({ ps: JSON.stringify([{ pod: "other" }]) });
    expect(await podAlive("p9", exec)).toBe(false);
  });
  it("teardown calls rm", async () => {
    const { exec, calls } = script({ rm: "{}" });
    await teardownPod("p9", exec);
    expect(calls[0][0]).toBe("rm");
  });
});
```

**Reality-pinning step folded in:** before implementing, run the REAL CLI read-only to pin actual argv/JSON shapes (`lium ls --format json`, `lium ps --format json`, `lium describe --help`, `lium exec --help`) — Ken's machine has `lium init` done (fez-lium is live). Adjust the fake-script keys and parsers to the real shapes, and note each pinned shape in a code comment. NEVER run `lium up`/`rm` in this task.

- [ ] **Step 2: Implement** — thin arg-building + JSON parsing around the injected exec; `liumMachine().copy` uses `lium scp <local> <pod>:<remote>` (pin the real scp argv the same way); `provisionPod` composes `up` (with `--ports`, `--ttl`, price guard args as the real CLI names them) then `describe`.
- [ ] **Step 3: PASS + check clean + commit** — `git add packages/fez-mining && git commit -m "fez-mining: LiumMachine — pods behind the seam, exec injectable"`

---

### Task 7: Runner — machine selection, hotkey deploy, reattach (phase B)

**Files:**
- Modify: `packages/fez-mining/src/state.ts` (MinerEntry.machine field)
- Modify: `packages/fez-mining/src/run.ts` (machine-aware lifecycle)
- Modify: `packages/fez-mining/src/cli.ts` (`start --machine lium`, teardown on stop)
- Test: `packages/fez-mining/tests/run-remote.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6 exactly as produced.
- Produces:
  - `MinerEntry.machine?: { kind: "lium"; podId: string; externalIp?: string; externalPort?: number; hourlyRate?: string }` (absent = local; v1 state stays valid).
  - `runMiner(netuid, persona, home?, opts?)` gains `opts.machineFactory?: (entry: MinerEntry) => Promise<MinerMachine>` for tests; production resolves: entry has `machine.kind === "lium"` → reattach if `podAlive(podId)`, else `provisionPod` + deploy hotkey + update state; otherwise `localMachine()`.
  - Hotkey deploy: run `FEZ_WALLET_BIN export-hotkey <persona> --json`, write the keyfile to a mode-0600 temp file, `machine.copy` it to `~/.bittensor/wallets/default/hotkeys/<persona>` on the pod, delete the temp file in a `finally`.
  - `fez-mine start --netuid N --persona P --machine lium` registers the REMOTE hotkey address (`fez-wallet register P --netuid N --json` with the export's address via the Task 5 override — pass `--hotkey <ss58>` through cli.ts to `registerPersona(p, n, { hotkeyAddress })`; add that flag to fez-wallet's cli.ts register case as part of this task, wired to the existing override), records `machine: {kind:"lium"}` (no podId yet — the runner provisions), then spawns the runner as in v1.
  - `fez-mine stop` on a lium miner: kill runner pid, then `teardownPod(podId)`, clear `machine.podId`.

- [ ] **Step 1: Failing tests** (FakeMachine + fake wallet bin):

```ts
// packages/fez-mining/tests/run-remote.test.ts
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMiner } from "../src/run.js";
import { readState, upsertMiner, writeState } from "../src/state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function homeWithFixture(): string {
  const home = mkdtempSync(path.join(tmpdir(), "fm-remote-"));
  mkdirSync(path.join(home, "miners"), { recursive: true });
  cpSync(path.join(here, "fixtures", "machine-miner.js"), path.join(home, "miners", "machine-miner.js"));
  return home;
}

describe("remote runner path", () => {
  it("uses the injected machine and records its pod on the entry", async () => {
    const home = homeWithFixture();
    let s = await readState(home);
    s = upsertMiner(s, { netuid: 9998, persona: "p", hotkey: "5FAKE", desired: "running", machine: { kind: "lium", podId: "p9" } });
    await writeState(home, s);
    const execs: string[] = [];
    const machine = {
      kind: "lium" as const, ports: [{ externalIp: "1.2.3.4", externalPort: 20002, internalPort: 8091 }],
      exec: async (cmd: string) => { execs.push(cmd); return { code: 0, stdout: "", stderr: "" }; },
      copy: async () => {},
    };
    const code = await runMiner(9998, "p", home, { hotkey: "5FAKE", machineFactory: async () => machine });
    expect(code).toBe(0);
    expect(execs.some((c) => c.includes("machine-fixture-ran"))).toBe(true);
  });
});
```

With fixture `tests/fixtures/machine-miner.js`:

```js
// A SubnetMiner[] whose start proves it went through ctx.machine.
export default [{
  netuid: 9998,
  name: "machine-fixture",
  async start(ctx) {
    const r = await ctx.machine.exec("echo machine-fixture-ran");
    if (r.code !== 0) throw new Error("exec failed");
    ctx.log(`ports: ${JSON.stringify(ctx.machine.ports)}`);
  },
}];
```

- [ ] **Step 2: Implement** run.ts machine resolution (factory injectable; default per the Produces block), the hotkey-deploy helper (own function, called only on freshly provisioned pods), and the cli.ts `--machine` flag + stop-teardown. Keep the v1 local path byte-identical when `machine` is absent.
- [ ] **Step 3: PASS, whole suite + check clean, commit** — `git add packages/fez-mining packages/fez-wallet && git commit -m "fez-mining: remote runner — machine selection, hotkey deploy, reattach"`

---

### Task 8: Sentinel remote reconcile + spend guard (phase B)

**Files:**
- Modify: `packages/fez-mining/src/reconcile.ts`
- Modify: `packages/fez-mining/src/headless.ts`
- Modify: `packages/fez-mining/src/state.ts` (MinerEntry gains `provisions?: number[]` — epoch-ms timestamps of auto-re-provisions — and `attention?: string`)
- Test: `packages/fez-mining/tests/reconcile.test.ts` (extend)

**Interfaces:**
- Consumes: `podAlive` (Task 6), state (Task 7 shape).
- Produces:

```ts
export type ReconcileAction = { miner: MinerEntry; action: "respawn-runner" | "reprovision" | "needs-attention" };
export function planRemote(miners: MinerEntry[], isAlive: (pid?: number) => boolean, podIsAlive: (podId: string) => boolean, now: number, maxPerDay = 3): ReconcileAction[];
```

Rules: desired-running only. Local miners: dead pid → respawn-runner (unchanged v1 behavior via the same function). Lium miners: runner dead + pod alive → respawn-runner; pod dead → reprovision, UNLESS `provisions` already holds ≥ maxPerDay timestamps within 24h of `now` → needs-attention (set `attention` text; GUI shows it). headless.ts executes the actions: respawn = spawnDetached runner (existing); reprovision = clear `machine.podId` + respawn runner (the runner provisions); needs-attention = write the field, log, do nothing else.

- [ ] **Step 1: Failing tests**

```ts
// appended to packages/fez-mining/tests/reconcile.test.ts
import { planRemote } from "../src/reconcile.js";
const DAY = 86_400_000;
const remote = (podId: string, provisions: number[] = []) =>
  ({ netuid: 56, persona: "p", hotkey: "5F", desired: "running" as const, pid: 99, machine: { kind: "lium" as const, podId }, provisions });

describe("planRemote", () => {
  it("respawns the runner when pod is alive but runner died", () => {
    const out = planRemote([remote("p1")], () => false, () => true, DAY);
    expect(out[0].action).toBe("respawn-runner");
  });
  it("reprovisions when the pod is gone, under the daily cap", () => {
    const out = planRemote([remote("p1", [1000])], () => false, () => false, DAY);
    expect(out[0].action).toBe("reprovision");
  });
  it("goes to needs-attention at the cap", () => {
    const now = 10 * DAY;
    const recent = [now - 1000, now - 2000, now - 3000];
    const out = planRemote([remote("p1", recent)], () => false, () => false, now);
    expect(out[0].action).toBe("needs-attention");
  });
  it("leaves healthy miners alone", () => {
    expect(planRemote([remote("p1")], () => true, () => true, DAY)).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement** `planRemote` (pure); rewire headless.ts's task to call it (the old `plan` remains for local-only compatibility or is absorbed — absorb it: `planRemote` handles machine-absent entries as local, and headless uses only `planRemote`; keep the old `plan` export as a one-line wrapper so nothing breaks).
- [ ] **Step 3: PASS + check clean + commit** — `git add packages/fez-mining && git commit -m "fez-mining: sentinel learns pods — reattach, bounded reprovision, needs-attention"`

---

### Task 9: Gradients descriptor — fez-gradients (phase C)

**Files:**
- Create: `packages/fez-gradients/package.json`, `packages/fez-gradients/tsconfig.json` (copy fez-mining's), `packages/fez-gradients/src/miner-part.ts`
- Test: `packages/fez-gradients/tests/descriptor.test.ts`

**Interfaces:**
- Consumes: `SubnetMiner`/`MinerContext` types (devDep `file:../fez-extension-api`), the machine seam.
- Produces: `~/.fez/miners/fez-gradients.js` once linked; descriptor `{ netuid: 56, name: "gradients", requirements: { gpu: "24GB", alwaysOn: true } }`.

- [ ] **Step 1: Read the Gradients repo first** (`rayonlabs/G.O.D` or whatever `bittensor_subnets`/taostats names for SN56 — resolve the actual repo via `fez-mine subnets` cache or taostats, then read its miner setup docs top-to-bottom). Pin: clone URL + commit hash, python version, install commands, the miner start command, every env var/config file it needs, and which port (if any) must be public. Record all of it in the descriptor's file comment.
- [ ] **Step 2: package.json**

```json
{
  "name": "@fezchat/gradients",
  "version": "0.1.0",
  "description": "Gradients (SN56) miner descriptor for the fez mining harness.",
  "type": "module",
  "scripts": {
    "build": "esbuild src/miner-part.ts --bundle --format=esm --platform=node --outfile=dist/miner.js",
    "check": "tsc --noEmit",
    "test": "vitest --run"
  },
  "fez": { "type": "extension", "parts": { "miner": "dist/miner.js" }, "permissions": [], "minFezVersion": "0.2.0" },
  "devDependencies": { "@fezchat/extension-api": "file:../fez-extension-api", "esbuild": "^0.21.5", "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

- [ ] **Step 3: Descriptor** — `install(ctx)` = `ctx.machine.exec` of the pinned clone (at the pinned commit) + dependency install, idempotent (guard on a done-file in workDir); `start(ctx)` = launch the miner per the pinned command with wallet args pointing at the deployed hotkey path and, if the miner serves, `--axon.external_ip/port` from `ctx.machine.ports`; blocking via the exec (or launch-detached + poll loop if their miner daemonizes — decide from what Step 1 found and comment why).
- [ ] **Step 4: Test** — descriptor shape only (no network):

```ts
// packages/fez-gradients/tests/descriptor.test.ts
import { describe, expect, it } from "vitest";
import miners from "../src/miner-part.js";

describe("gradients descriptor", () => {
  it("declares SN56 with a GPU requirement", () => {
    expect(miners).toHaveLength(1);
    expect(miners[0]).toMatchObject({ netuid: 56, name: "gradients", requirements: { gpu: "24GB", alwaysOn: true } });
    expect(typeof miners[0].start).toBe("function");
  });
});
```

- [ ] **Step 5: Build + test + check clean; `node dist/cli.js link packages/fez-gradients` from the repo root and confirm `~/.fez/miners/fez-gradients.js` appears and imports (netuid 56). Commit** — `git add packages/fez-gradients && git commit -m "fez-gradients: SN56 miner descriptor"`

---

### Task 10: GUI — machine picker, pod rows, hardware-gated badge (phase C)

**Files:**
- Modify: `packages/fez-mining/src/gui-rows.ts` (badge + picker eligibility, pure)
- Modify: `packages/fez-mining/src/gui.tsx`
- Test: `packages/fez-mining/tests/gui-rows.test.ts` (extend)

**Interfaces:**
- Consumes: descriptors' `requirements` (exposed to the GUI via state: `fez-mine subnets --refresh` already computes `covered`; extend it in this task to also write `requirementsByNetuid: Record<number, {gpu?: string}>` into state from `loadDescriptors()` — modify cli.ts's cmdSubnets accordingly), `MinerEntry.machine`.
- Produces (pure, tested):

```ts
export const HARDWARE_GATED: number[] = [4]; // Targon-class; descriptor-declared flag can replace this later
export type MachineChoice = "local" | "lium";
export function machineChoices(req: { gpu?: string } | undefined): { choice: MachineChoice; enabled: boolean; reason?: string }[];
// gpu required → local disabled ("needs <gpu> GPU"), lium enabled; no gpu → local enabled only (v1 flow, no picker shown)
export function subnetRows(subnets: Subnet[], covered: number[], gated?: number[]): (Subnet & { curated: boolean; gated: boolean })[];
```

- [ ] **Step 1: Failing tests**

```ts
// appended to packages/fez-mining/tests/gui-rows.test.ts
import { machineChoices, subnetRows, HARDWARE_GATED } from "../src/gui-rows.js";

describe("machineChoices", () => {
  it("gpu requirement disables local and enables lium", () => {
    const c = machineChoices({ gpu: "24GB" });
    expect(c.find((x) => x.choice === "local")).toMatchObject({ enabled: false });
    expect(c.find((x) => x.choice === "lium")).toMatchObject({ enabled: true });
  });
  it("no gpu → local only", () => {
    expect(machineChoices(undefined)).toEqual([{ choice: "local", enabled: true }]);
  });
});

describe("gated badge", () => {
  it("marks hardware-gated netuids", () => {
    const rows = subnetRows([{ netuid: 4, name: "targon" }], [], HARDWARE_GATED);
    expect(rows[0]).toMatchObject({ gated: true, curated: false });
  });
});
```

- [ ] **Step 2: Implement** the pure helpers; extend cmdSubnets for `requirementsByNetuid`; gui.tsx: gated rows render a `hardware-gated` chip (no Mine button); curated rows with a gpu requirement insert a machine step into the Mine flow (before the persona picker, same in-view pattern) and pass `--machine lium` to start; the confirm line for lium adds the $/hr (from `lium ls` via a new `fez-mine machines --json` — implement as a thin cmdMachines that shells `lium ls --format json` through `@fezchat/lium/cli` and returns `[{node, usdHour}]`; tolerate absence of the lium CLI with a visible message) and current balance (`lium_balance` equivalent: `lium balance --format json`, same tolerance). Remote miner rows show `pod <id> · $<rate>/hr`.
- [ ] **Step 3: PASS + check + full package build clean; commit** — `git add packages/fez-mining && git commit -m "fez-mining gui: machine picker, pod rows, hardware-gated badge"`

---

### Task 11: Mainnet unlock (GATED — Ken's explicit go required)

**Skip this task entirely unless Ken has explicitly said to ship the mainnet unlock. Record his words in the ledger before dispatching.**

**Files:**
- Modify: `packages/fez-wallet/src/stake.ts` (`requireRehearsalNetwork` — the guard to open deliberately)
- Modify: `packages/fez-wallet/src/cli.ts`, `packages/fez-wallet/src/cli-commands.ts`
- Test: `packages/fez-wallet/tests/mainnet-gate.test.ts`

**Interfaces:**
- Produces: `fez-wallet register <persona> --netuid N --mainnet` — the ONLY way a mainnet registration proceeds. Without `--mainnet`, mainnet endpoints keep today's refusal verbatim. With it: print the live burn in TAO and the words "MAINNET — real TAO" to stderr, and require the environment variable `FEZ_WALLET_MAINNET_OK=1` as the second factor (the GUI sets it only after its own double-confirm dialog; a bare CLI user must set it deliberately). Both factors absent → same refusal.

- [ ] **Step 1: Failing test** — `mainnetAllowed(flags: { mainnetFlag: boolean; envOk: boolean }): boolean` pure gate (true only when both true), plus a test that `requireRehearsalNetwork` still throws when the gate is closed (read its current shape first and test through whatever seam it exposes; do not weaken existing tests).
- [ ] **Step 2: Implement, keeping the default path's behavior and error text byte-identical.**
- [ ] **Step 3: Full wallet suite green; commit** — `git add packages/fez-wallet && git commit -m "wallet: mainnet registration behind a two-factor unlock"`

---

### Task 12: Phase-B end-to-end smoke — bazaar on a real pod (Ken supervising)

**Files:** none — verification. Costs real money in CENTS (one cheap pod, short TTL). Run only with Ken present; his LIUM_API_KEY must be configured (`lium init` done — it is, per fez-lium's live state).

- [ ] **Step 1:** Rebuild + relink fez-mining, fez-lium, fez-wallet, fez-bazaar (`node dist/cli.js link ...` each). `fez-mine status --json` sane.
- [ ] **Step 2:** Pick the cheapest CPU-adequate node: `lium ls --format json | head`; note $/hr.
- [ ] **Step 3:** `fez-mine start --netuid 553 --persona quill --machine lium --json` — watch: remote hotkey created + registered (adopt if already registered under that address — first run BURNS the 553 testnet cost for the new hotkey; testnet TAO, fine), pod provisioned with a TTL ≤ 2h, hotkey deployed, bazaar miner starts in the pod, `~/.fez/mining/553-quill/miner.log` shows it connecting to wss://bazaar.fez.chat from the pod.
- [ ] **Step 4:** Kill the local runner (`kill <pid>`), wait ≤2 min: sentinel respawns it and it REATTACHES (same podId, no second pod — verify `lium ps` shows exactly one).
- [ ] **Step 5:** `fez-mine stop --netuid 553 --persona quill` — pod torn down (`lium ps` empty), state cleared, spend visible in `~/.fez/lium-pods.json`.
- [ ] **Step 6:** Desktop pass (Ken): Mining page shows gradients row with machine picker (Mine → Rent GPU flow up to the confirm — CANCEL there unless Ken wants to rent a real GPU), targon row shows `hardware-gated`. **STOP — nothing is pushed; Ken decides.**

---

## Deliberate exclusions

- SshMachine, `bandwidthMbps`, descriptor-declared gating flags — designed-for in spec §7, not built.
- Lium Volumes, shared pods — until a descriptor needs them.
- Gradients mainnet mining — blocked on Task 11's gate plus Ken renting a real GPU; the plan ships everything up to that decision.
