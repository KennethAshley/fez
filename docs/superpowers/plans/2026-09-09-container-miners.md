# Container Miners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Miners ship as pinned container images and fez can provision the machine itself (DigitalOcean first), so a user adds one token and clicks Mine.

**Architecture:** `SubnetMiner` gains an optional `container` block (data, not code); one generic runner in fez-mining drives docker over the existing `ctx.machine.exec` seam. A new `Provisioner` interface creates machines that, once up, ARE SshMachines — DoMachine is its first implementation (REST + cloud-init). Gradients converts to the container block as the proving descriptor.

**Tech Stack:** TypeScript, esbuild bundles, vitest, docker CLI driven over ssh/lium exec, DigitalOcean API v2 via fetch.

**Spec:** `docs/superpowers/specs/2026-09-09-container-miners-design.md`

## Global Constraints

- Images are digest-pinned (`repo@sha256:…`); the digest is the install done-file.
- Key material never enters an image, argv, or a `docker run -e` flag: keys are bind-mounted read-only from `/root/.bittensor`; config/secrets go through an `--env-file` written mode 600 on the machine.
- Every machine-kind branch must treat "remote" as `kind !== "local"` — never enumerate `"lium"` (five live bugs came from that; see mining-live-state memory).
- All remote commands go through `ctx.machine.exec` / `buildRemoteCommand` — never raw ssh, never a local docker SDK.
- `docker run` is the default; `compose` only when `container.compose` is set.
- Bazaar's script descriptor is untouched.
- Run every vitest command from the owning package dir (`packages/fez-mining` etc.).
- Commit messages: plain, no co-author trailers (Ken's rule).

---

### Task 1: `container` block on the SubnetMiner contract

**Files:**
- Modify: `packages/fez-extension-api/src/miner.ts` (after the `MinerStatus` interface, before `SubnetMiner`)

**Interfaces:**
- Produces: `MinerContainer` type and `SubnetMiner.container?: MinerContainer` — Tasks 2–5 consume exactly these names.

- [ ] **Step 1: Add the types**

In `packages/fez-extension-api/src/miner.ts`, immediately above the `SubnetMiner` interface, add:

```ts
/**
 * Descriptor v2 — the miner as a pinned image instead of install
 * instructions (spec 2026-09-09-container-miners-design.md). A
 * descriptor with `container` needs no install()/start(); when both
 * exist, `container` wins. The harness owns orchestration once.
 */
export interface MinerContainer {
  /** Digest-pinned image ref: "ghcr.io/fezchat/gradients-miner@sha256:…". */
  image: string;
  /** Env template values — "{key}" substrings resolve from ctx.config. */
  env?: Record<string, string>;
  /** Internal ports published on the machine's declared external ports. */
  ports?: { internal: number }[];
  /** Bind-mount /root/.bittensor read-only into the container. */
  mountKeys?: boolean;
  /** One-shot enrollment run in the SAME image (e.g. fiber-post-ip). */
  register?: { command: string[] };
  /** Verbatim upstream compose.yml — when set, the compose verbs drive
   *  and image/ports above are descriptive only. */
  compose?: string;
}
```

Then add to the `SubnetMiner` interface (next to the existing optional `stop?`):

```ts
  /** Descriptor v2: run as a container. Present ⇒ install/start unused. */
  container?: MinerContainer;
```

- [ ] **Step 2: Build and typecheck**

Run: `cd packages/fez-extension-api && npm run build && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/fez-extension-api/src/miner.ts
git commit -m "extension-api: SubnetMiner gains the container block (descriptor v2)"
```

---

### Task 2: container-runner — pure command builders (TDD)

**Files:**
- Create: `packages/fez-mining/src/container-runner.ts`
- Test: `packages/fez-mining/tests/container-runner.test.ts`

**Interfaces:**
- Consumes: `MinerContainer` from Task 1; `MachinePort` from `@fezchat/extension-api`.
- Produces (Task 3/4 rely on these exact signatures):
  - `containerName(netuid: number, persona: string): string`
  - `resolveEnv(tpl: Record<string,string> | undefined, config: Record<string, string|number|boolean>): Record<string,string>`
  - `envFileContent(env: Record<string,string>): string`
  - `dockerRunArgs(c: MinerContainer, name: string, envFilePath: string, machinePorts: MachinePort[]): string[]`
  - `dockerRegisterArgs(c: MinerContainer, envFilePath: string): string[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/fez-mining/tests/container-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  containerName, resolveEnv, envFileContent, dockerRunArgs, dockerRegisterArgs,
} from "../src/container-runner.js";
import type { MinerContainer } from "@fezchat/extension-api";

const C: MinerContainer = {
  image: "ghcr.io/fezchat/gradients-miner@sha256:abc",
  env: { WALLET_NAME: "{walletName}", NETUID: "56" },
  ports: [{ internal: 7999 }],
  mountKeys: true,
};
const PORTS = [{ externalIp: "1.2.3.4", externalPort: 7999, internalPort: 7999 }];

describe("container-runner builders", () => {
  it("names containers deterministically — stop can always find them", () => {
    expect(containerName(56, "gauss")).toBe("fez-56-gauss");
  });

  it("resolves {key} templates from config and passes literals through", () => {
    expect(resolveEnv(C.env, { walletName: "default" }))
      .toEqual({ WALLET_NAME: "default", NETUID: "56" });
  });

  it("env file is KEY=VALUE lines with a trailing newline", () => {
    expect(envFileContent({ A: "1", B: "two" })).toBe("A=1\nB=two\n");
  });

  it("run args: detached, restart policy, name, env-file, port publishes, ro key mount, image", () => {
    expect(dockerRunArgs(C, "fez-56-gauss", "/root/fez-mining/56-gauss/.env", PORTS)).toEqual([
      "run", "-d", "--name", "fez-56-gauss", "--restart", "unless-stopped",
      "--env-file", "/root/fez-mining/56-gauss/.env",
      "-p", "7999:7999",
      "-v", "/root/.bittensor:/root/.bittensor:ro",
      "ghcr.io/fezchat/gradients-miner@sha256:abc",
    ]);
  });

  it("a declared internal port with no machine mapping publishes identity", () => {
    const args = dockerRunArgs(C, "n", "/e", []);
    expect(args).toContain("7999:7999");
  });

  it("register args: --rm one-shot in the same image with the command", () => {
    const withReg: MinerContainer = { ...C, register: { command: ["fiber-post-ip", "--netuid", "56"] } };
    expect(dockerRegisterArgs(withReg, "/e")).toEqual([
      "run", "--rm", "--env-file", "/e",
      "-v", "/root/.bittensor:/root/.bittensor:ro",
      "ghcr.io/fezchat/gradients-miner@sha256:abc",
      "fiber-post-ip", "--netuid", "56",
    ]);
  });

  it("no mountKeys ⇒ no volume flag", () => {
    const bare: MinerContainer = { image: "img@sha256:x" };
    expect(dockerRunArgs(bare, "n", "/e", []).join(" ")).not.toContain("-v");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fez-mining && npx vitest --run tests/container-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builders**

Create `packages/fez-mining/src/container-runner.ts`:

```ts
import type { MinerContainer, MachinePort } from "@fezchat/extension-api";

/**
 * Container miners (spec 2026-09-09): pure builders here, orchestration
 * below. Deterministic names are the point — `stop` must be able to
 * find the remote container with no shared state beyond netuid+persona.
 */
export function containerName(netuid: number, persona: string): string {
  return `fez-${netuid}-${persona}`;
}

/** "{key}" templates resolve from ctx.config; anything else is literal. */
export function resolveEnv(
  tpl: Record<string, string> | undefined,
  config: Record<string, string | number | boolean>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl ?? {})) {
    out[k] = v.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => String(config[key] ?? ""));
  }
  return out;
}

export function envFileContent(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join("");
}

const keyMount = (c: MinerContainer): string[] =>
  c.mountKeys ? ["-v", "/root/.bittensor:/root/.bittensor:ro"] : [];

export function dockerRunArgs(
  c: MinerContainer,
  name: string,
  envFilePath: string,
  machinePorts: MachinePort[]
): string[] {
  const publishes = (c.ports ?? []).flatMap((p) => {
    const m = machinePorts.find((mp) => mp.internalPort === p.internal);
    return ["-p", `${m?.externalPort ?? p.internal}:${p.internal}`];
  });
  return [
    "run", "-d", "--name", name, "--restart", "unless-stopped",
    "--env-file", envFilePath,
    ...publishes,
    ...keyMount(c),
    c.image,
  ];
}

export function dockerRegisterArgs(c: MinerContainer, envFilePath: string): string[] {
  return ["run", "--rm", "--env-file", envFilePath, ...keyMount(c), c.image, ...(c.register?.command ?? [])];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fez-mining && npx vitest --run tests/container-runner.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/fez-mining/src/container-runner.ts packages/fez-mining/tests/container-runner.test.ts
git commit -m "mining: container-runner pure builders — names, env templates, docker args"
```

---

### Task 3: container-runner — orchestration over the machine seam (TDD)

**Files:**
- Modify: `packages/fez-mining/src/container-runner.ts` (append)
- Test: `packages/fez-mining/tests/container-runner.test.ts` (append)

**Interfaces:**
- Consumes: `MinerMachine` from `@fezchat/extension-api` (`exec`, `ports`), builders from Task 2, `escapeShellValue` from `./machine-lium.js`.
- Produces (Task 4 relies on these):
  - `ensureDocker(machine: MinerMachine, log: (l: string) => void): Promise<void>` — throws with a one-line fix if docker is absent.
  - `runContainerMiner(opts: { machine: MinerMachine; container: MinerContainer; netuid: number; persona: string; workDir: string; config: Record<string, string|number|boolean>; registered: boolean; log: (l: string) => void }): Promise<number>` — pull → (register once) → run → `docker wait`; resolves with the container's exit code when it stops.
  - `stopContainerMiner(machine: MinerMachine, netuid: number, persona: string): Promise<void>` — `docker rm -f`, ignores absence.

- [ ] **Step 1: Write the failing tests** (append to the test file)

```ts
import { ensureDocker, runContainerMiner, stopContainerMiner } from "../src/container-runner.js";
import type { MinerMachine } from "@fezchat/extension-api";

// Scripted machine: responses keyed by the first docker verb in the command.
const machineOf = (script: Record<string, { code: number; stdout?: string; stderr?: string }>) => {
  const cmds: string[] = [];
  const machine: MinerMachine = {
    kind: "ssh",
    ports: [{ externalIp: "1.2.3.4", externalPort: 7999, internalPort: 7999 }],
    exec: async (cmd) => {
      cmds.push(cmd);
      const verb = Object.keys(script).find((k) => cmd.includes(k));
      const r = verb ? script[verb] : { code: 0 };
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    copy: async () => {},
  };
  return { machine, cmds };
};

describe("container-runner orchestration", () => {
  it("ensureDocker passes when docker answers, throws a named fix when absent", async () => {
    const ok = machineOf({ "docker -v": { code: 0, stdout: "Docker version 27" } });
    await expect(ensureDocker(ok.machine, () => {})).resolves.toBeUndefined();
    const missing = machineOf({ "docker -v": { code: 127, stderr: "docker: command not found" } });
    await expect(ensureDocker(missing.machine, () => {})).rejects.toThrow(/no Docker/);
  });

  it("run sequence: pull → register (once) → env-file 600 → run → wait; resolves with the exit code", async () => {
    const { machine, cmds } = machineOf({
      "docker pull": { code: 0 },
      "docker run --rm": { code: 0 },
      "docker run -d": { code: 0, stdout: "abc123\n" },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    const code = await runContainerMiner({
      machine,
      container: { image: "img@sha256:x", env: { A: "{a}" }, register: { command: ["post-ip"] }, mountKeys: true },
      netuid: 56, persona: "gauss", workDir: "/root/fez-mining/56-gauss",
      config: { a: "1" }, registered: false, log: () => {},
    });
    expect(code).toBe(0);
    const joined = cmds.join(" || ");
    expect(joined).toContain("docker pull 'img@sha256:x'");
    expect(joined).toContain("chmod 600");
    expect(cmds.findIndex((c) => c.includes("docker run --rm")))
      .toBeLessThan(cmds.findIndex((c) => c.includes("docker run -d")));
    expect(joined).toContain("docker wait 'fez-56-gauss'");
  });

  it("registered: true skips the one-shot", async () => {
    const { machine, cmds } = machineOf({
      "docker pull": { code: 0 },
      "docker run -d": { code: 0 },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    await runContainerMiner({
      machine, container: { image: "i@sha256:x", register: { command: ["x"] } },
      netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
    });
    expect(cmds.some((c) => c.includes("docker run --rm"))).toBe(false);
  });

  it("stale container is removed before a fresh run (restart-safe)", async () => {
    const { machine, cmds } = machineOf({
      "docker pull": { code: 0 },
      "docker rm -f": { code: 0 },
      "docker run -d": { code: 0 },
      "docker wait": { code: 0, stdout: "0\n" },
    });
    await runContainerMiner({
      machine, container: { image: "i@sha256:x" },
      netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
    });
    expect(cmds.findIndex((c) => c.includes("docker rm -f")))
      .toBeLessThan(cmds.findIndex((c) => c.includes("docker run -d")));
  });

  it("stopContainerMiner force-removes by deterministic name and tolerates absence", async () => {
    const { machine, cmds } = machineOf({ "docker rm -f": { code: 1, stderr: "No such container" } });
    await expect(stopContainerMiner(machine, 56, "gauss")).resolves.toBeUndefined();
    expect(cmds[0]).toContain("docker rm -f 'fez-56-gauss'");
  });

  it("transportError from the machine surfaces as a throw, not a fake exit code", async () => {
    const machine: MinerMachine = {
      kind: "ssh", ports: [],
      exec: async () => ({ code: 255, stdout: "", stderr: "unreachable", transportError: true }),
      copy: async () => {},
    };
    await expect(
      runContainerMiner({ machine, container: { image: "i@sha256:x" }, netuid: 1, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {} })
    ).rejects.toThrow(/unreachable/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fez-mining && npx vitest --run tests/container-runner.test.ts`
Expected: FAIL — `ensureDocker` not exported.

- [ ] **Step 3: Implement orchestration** (append to `container-runner.ts`)

```ts
import type { MinerMachine } from "@fezchat/extension-api";
import { escapeShellValue } from "./machine-lium.js";

async function mustExec(
  machine: MinerMachine,
  cmd: string,
  what: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const r = await machine.exec(cmd, opts);
  if (r.transportError) throw new Error(`${what}: machine unreachable — ${r.stderr || "transport error"}`);
  return r;
}

/** Fail loudly with the fix; fez-provisioned machines never hit this. */
export async function ensureDocker(machine: MinerMachine, log: (l: string) => void): Promise<void> {
  const r = await mustExec(machine, "docker -v", "docker probe");
  if (r.code !== 0) {
    throw new Error(
      "this machine has no Docker — fez-provisioned machines get it automatically; on your own server: apt-get install -y docker.io"
    );
  }
  log(`docker: ${r.stdout.trim()}`);
}

export async function runContainerMiner(opts: {
  machine: MinerMachine;
  container: MinerContainer;
  netuid: number;
  persona: string;
  workDir: string;
  config: Record<string, string | number | boolean>;
  registered: boolean;
  log: (l: string) => void;
}): Promise<number> {
  const { machine, container: c, netuid, persona, workDir, config, registered, log } = opts;
  const name = containerName(netuid, persona);
  const envFile = `${workDir}/.env`;

  const pull = await mustExec(machine, `docker pull ${escapeShellValue(c.image)}`, "pull", { timeoutMs: 600_000 });
  if (pull.code !== 0) throw new Error(`docker pull failed: ${pull.stderr || pull.stdout}`);

  // Secrets ride an env-file (mode 600), never argv — ps-safe.
  const env = resolveEnv(c.env, config);
  const write = await mustExec(
    machine,
    `printf %s ${escapeShellValue(envFileContent(env))} > ${escapeShellValue(envFile)} && chmod 600 ${escapeShellValue(envFile)}`,
    "env-file"
  );
  if (write.code !== 0) throw new Error(`env-file write failed: ${write.stderr}`);

  if (c.register && !registered) {
    log(`container: one-shot register (${c.register.command.join(" ")})`);
    const reg = await mustExec(
      machine,
      `docker ${dockerRegisterArgs(c, envFile).map(escapeShellValue).join(" ")}`,
      "register",
      { timeoutMs: 300_000 }
    );
    if (reg.code !== 0) throw new Error(`container register exited ${reg.code}: ${reg.stderr || reg.stdout}`);
  }

  // A stale same-name container (crashed runner, prior run) blocks -d.
  await mustExec(machine, `docker rm -f ${escapeShellValue(name)} 2>/dev/null || true`, "stale rm");

  log(`container: starting ${name} from ${c.image}`);
  const run = await mustExec(
    machine,
    `docker ${dockerRunArgs(c, name, envFile, machine.ports).map(escapeShellValue).join(" ")}`,
    "run"
  );
  if (run.code !== 0) throw new Error(`docker run exited ${run.code}: ${run.stderr || run.stdout}`);

  // Blocking wait — keeps the harness's "start resolves when mining
  // stops" contract, so supervision/reconcile need no changes. No
  // timeout: mining runs for days.
  const waited = await mustExec(machine, `docker wait ${escapeShellValue(name)}`, "wait");
  const code = Number(waited.stdout.trim());
  return Number.isFinite(code) ? code : waited.code;
}

export async function stopContainerMiner(machine: MinerMachine, netuid: number, persona: string): Promise<void> {
  // rm -f by deterministic name: reaches the remote process even when the
  // local runner is long dead — the orphan gap closed for containers.
  // The compose variant tears down its project the same call.
  const name = containerName(netuid, persona);
  await machine.exec(`docker rm -f ${escapeShellValue(name)}`).catch(() => undefined);
  await machine.exec(`docker compose -p ${escapeShellValue(name)} down 2>/dev/null || true`).catch(() => undefined);
}

/** Tail the container's own stdout — feeds `fez-mine logs` for container miners. */
export async function containerLogs(
  machine: MinerMachine,
  netuid: number,
  persona: string,
  lines: number
): Promise<string> {
  const r = await machine.exec(
    `docker logs --tail ${Math.max(1, Math.floor(lines))} ${escapeShellValue(containerName(netuid, persona))} 2>&1`
  );
  return r.stdout || r.stderr;
}
```

The compose variant (spec: verbs become `compose pull / up -d / down / ps`): inside `runContainerMiner`, immediately after the env-file write, branch —

```ts
  if (c.compose) {
    const composeFile = `${workDir}/compose.yml`;
    const w = await mustExec(
      machine,
      `printf %s ${escapeShellValue(c.compose)} > ${escapeShellValue(composeFile)}`,
      "compose-file"
    );
    if (w.code !== 0) throw new Error(`compose-file write failed: ${w.stderr}`);
    const base = `docker compose -p ${escapeShellValue(name)} -f ${escapeShellValue(composeFile)} --env-file ${escapeShellValue(envFile)}`;
    const pullC = await mustExec(machine, `${base} pull`, "compose pull", { timeoutMs: 600_000 });
    if (pullC.code !== 0) throw new Error(`compose pull failed: ${pullC.stderr || pullC.stdout}`);
    const up = await mustExec(machine, `${base} up -d`, "compose up");
    if (up.code !== 0) throw new Error(`compose up exited ${up.code}: ${up.stderr || up.stdout}`);
    // Block until the project's containers all exit (mirrors docker wait).
    const waitedC = await mustExec(machine, `${base} wait 2>/dev/null || ${base} ps --quiet | xargs -r docker wait | tail -1`, "compose wait");
    const codeC = Number(waitedC.stdout.trim().split("\n").pop());
    return Number.isFinite(codeC) ? codeC : waitedC.code;
  }
```

Add one test for it in the orchestration describe block:

```ts
  it("compose descriptor drives compose verbs, project-named like the container", async () => {
    const { machine, cmds } = machineOf({
      "compose": { code: 0, stdout: "0\n" },
    });
    await runContainerMiner({
      machine, container: { image: "i@sha256:x", compose: "services: {}" },
      netuid: 2, persona: "p", workDir: "/w", config: {}, registered: true, log: () => {},
    });
    const joined = cmds.join(" || ");
    expect(joined).toContain("docker compose -p 'fez-2-p'");
    expect(joined).toContain("up -d");
    expect(joined).not.toContain("docker run -d");
  });
```

Note: `dockerRunArgs`/`dockerRegisterArgs` return raw arg arrays; the exec lines quote each with `escapeShellValue` — `docker pull 'img@sha256:x'` in the test asserts exactly this.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/fez-mining && npx vitest --run tests/container-runner.test.ts`
Expected: 13 passed.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/fez-mining && npx tsc --noEmit` — expected clean.

```bash
git add packages/fez-mining/src/container-runner.ts packages/fez-mining/tests/container-runner.test.ts
git commit -m "mining: container-runner orchestration — pull/register/run/wait/stop over the machine seam"
```

---

### Task 4: route container descriptors through the harness

**Files:**
- Modify: `packages/fez-mining/src/run.ts` — the descriptor-invocation block (currently `if (d.install) await d.install(ctx); … await d.start(ctx);` around lines 363–372) and the top-of-file imports.
- Modify: `packages/fez-mining/src/cli.ts` — `cmdStop` (find `case "stop"` and the function it calls).
- Test: `packages/fez-mining/tests/run-remote.test.ts` (append)

**Interfaces:**
- Consumes: Task 3's `ensureDocker`, `runContainerMiner`, `stopContainerMiner`; the existing `registered`-flag logic already computed in `run.ts` (the `fs.access(flag)` check).
- Produces: no new exports — behavior: a descriptor with `container` never has `install`/`register`/`start` called.

- [ ] **Step 1: Write the failing test** (append to `tests/run-remote.test.ts`)

```ts
import { runMiner } from "../src/run.js";
import { writeState, readState, upsertMiner } from "../src/state.js";

describe("container descriptor routing", () => {
  it("a container descriptor runs through docker verbs, not script hooks", async () => {
    const home = homeWithFixture(); // existing helper in this file
    let s = await readState(home);
    s = upsertMiner(s, { netuid: 9997, persona: "p", hotkey: "5FAKE", desired: "running" });
    await writeState(home, s);
    // Fixture descriptor: tests/fixtures/miners/container-fixture.js —
    // create it in this step (see below).
    const execs: string[] = [];
    const machine = {
      kind: "ssh" as const,
      ports: [],
      exec: async (cmd: string) => {
        execs.push(cmd);
        if (cmd.includes("docker wait")) return { code: 0, stdout: "0\n", stderr: "" };
        return { code: 0, stdout: cmd.includes("docker -v") ? "Docker version 27" : "", stderr: "" };
      },
      copy: async () => {},
    };
    const code = await runMiner(9997, "p", home, { hotkey: "5FAKE", machineFactory: async () => machine });
    expect(code).toBe(0);
    const joined = execs.join(" || ");
    expect(joined).toContain("docker pull");
    expect(joined).toContain("docker run -d");
    expect(joined).toContain("docker wait 'fez-9997-p'");
  });
});
```

And create `packages/fez-mining/tests/fixtures/miners/container-fixture.js` (the fixture dir pattern `homeWithFixture` already loads):

```js
export default [{
  netuid: 9997,
  name: "container-fixture",
  requirements: {},
  config: [],
  container: { image: "example/fixture@sha256:0000", env: {}, ports: [] },
}];
```

Check how `homeWithFixture` wires the miners dir in this test file and place the fixture where it reads (if it copies from `tests/fixtures`, follow that path exactly).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fez-mining && npx vitest --run tests/run-remote.test.ts`
Expected: the new test FAILS — script hooks path runs (or no hooks at all) and no docker verbs appear.

- [ ] **Step 3: Route in `run.ts`**

Add imports at top:

```ts
import { ensureDocker, runContainerMiner, stopContainerMiner } from "./container-runner.js";
```

Replace the descriptor-invocation block (the `if (d.install) … await d.start(ctx);` sequence — keep the surrounding try/catch, `record()` calls, and the `registered` flag logic identical) with:

```ts
    if (d.container) {
      await ensureDocker(machine, log);
      const registered = await fs.access(flag).then(() => true, () => false);
      const exit = await runContainerMiner({
        machine, container: d.container, netuid, persona,
        workDir, config: ctx.config, registered, log,
      });
      if (d.container.register && !registered) await fs.writeFile(flag, "1");
      if (exit !== 0) throw new Error(`container miner exited ${exit}`);
    } else {
      if (d.install) await d.install(ctx);
      if (d.register && !(await fs.access(flag).then(() => true, () => false))) {
        await d.register(ctx);
        await fs.writeFile(flag, "1");
      }
      await d.start(ctx);
    }
```

(Adapt the flag-write lines to match how the existing code writes `flag` — read the current block first and preserve its exact flag path and error handling; only the branching is new.)

- [ ] **Step 4: Container-aware `stop` in `cli.ts`**

In the stop command implementation, after the existing local-runner kill and state write, add — only when the entry has a remote machine and its descriptor has `container`:

```ts
  // A container miner's remote process is reachable by name even when the
  // local runner is long gone — kill it too, best-effort.
  const descriptor = (await loadDescriptors(home)).find((m) => m.netuid === netuid);
  if (descriptor?.container && entry?.machine) {
    try {
      const { machine } = await resolveMachine(entry, persona, {});
      await stopContainerMiner(machine, netuid, persona);
      console.error(`stopped container fez-${netuid}-${persona}`);
    } catch {
      console.error(`container fez-${netuid}-${persona} may still be running on the machine`);
    }
  }
```

Import `loadDescriptors` from `./descriptors.js`, `resolveMachine` from `./run.js`, `stopContainerMiner` from `./container-runner.js` (check what `cli.ts` already imports and reuse its `entry` lookup variable names).

Also make `cmdLogs` container-aware (spec: logs = `docker logs --tail`): when the entry's descriptor has `container` and the entry has a remote machine, resolve the machine and append `containerLogs(machine, netuid, persona, lines)` (from `./container-runner.js`) after the local miner.log tail, under a `--- container ---` separator line. Local/absent machine or any error → silently keep the local tail only.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `cd packages/fez-mining && npx vitest --run && npx tsc --noEmit`
Expected: all pass (existing 134 + new), clean types.

```bash
git add packages/fez-mining/src/run.ts packages/fez-mining/src/cli.ts packages/fez-mining/tests/run-remote.test.ts packages/fez-mining/tests/fixtures/miners/container-fixture.js
git commit -m "mining: container descriptors route through the generic runner; stop reaches the remote container"
```

---

### Task 5: Gradients converts to a container descriptor

**Files:**
- Create: `packages/fez-gradients/Dockerfile`
- Modify: `packages/fez-gradients/src/miner-part.ts` (replace the descriptor body)
- Test: `packages/fez-gradients/tests/` — follow the existing test file's pattern (read it first) and update assertions.

**Interfaces:**
- Consumes: `MinerContainer` from Task 1.
- Produces: the proving `container` descriptor.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# ghcr.io/fezchat/gradients-miner — G.O.D at the pinned commit with its
# venv baked. The deadsnakes/pip dance from the 2026-09-08 live run,
# solved once here instead of on every user's box.
FROM python:3.10-slim
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential \
  && rm -rf /var/lib/apt/lists/*
ARG GOD_COMMIT=ebbd3d729c8c36173eac7022ff9aa29907d7f643
RUN git clone https://github.com/rayonlabs/G.O.D.git /app \
  && cd /app && git checkout "$GOD_COMMIT"
WORKDIR /app
RUN pip install --no-cache-dir --upgrade pip \
  && pip uninstall -y substrate-interface scalecodec cyscale || true \
  && pip install --no-cache-dir -e .
EXPOSE 7999
ENV ENV=DEV
CMD ["uvicorn", "miner.asgi:app", "--host", "0.0.0.0", "--port", "7999", "--log-level", "info"]
```

- [ ] **Step 2: Replace the descriptor body in `miner-part.ts`**

Keep `netuid`, `name`, `requirements`, and the `config` array exactly as they are. Delete `install`, `register`, `start` and the `run`/`repoDir`/`doneFile` helpers. Add:

```ts
  container: {
    // Digest filled by the image-publish step below — a tag is not a pin.
    image: "ghcr.io/fezchat/gradients-miner@sha256:REPLACED_AT_PUBLISH",
    env: {
      WALLET_NAME: "{walletName}",
      HOTKEY_NAME: "{persona}",
      SUBTENSOR_NETWORK: "{subtensorNetwork}",
      NETUID: "56",
      REFRESH_NODES: "{refreshNodes}",
      MIN_STAKE_THRESHOLD: "{minStakeThreshold}",
    },
    ports: [{ internal: 7999 }],
    mountKeys: true,
    register: {
      command: [
        "fiber-post-ip", "--netuid", "56",
        "--subtensor.network", "{subtensorNetwork}",
        "--external_port", "{servePort}", "--external_ip", "{serveIp}",
        "--wallet.name", "{walletName}", "--wallet.hotkey", "{persona}",
      ],
    },
  },
```

This introduces three context template keys the runner must supply beyond user config — add them in `container-runner.ts`'s `runContainerMiner` before `resolveEnv`/register (and cover with a unit test appended to `container-runner.test.ts`):

```ts
  const enriched = {
    ...config,
    persona,
    serveIp: machine.ports[0]?.externalIp ?? "",
    servePort: String(machine.ports[0]?.externalPort ?? c.ports?.[0]?.internal ?? ""),
  };
```

…and use `enriched` for both the env resolution and a template pass over `register.command` (apply `resolveEnv`'s replace to each argv element — extract the replacer as `resolveTemplate(s: string, config): string` and reuse it in `resolveEnv`).

- [ ] **Step 3: Build the image and pin the digest (human-gated — needs Docker locally + ghcr auth)**

```bash
cd packages/fez-gradients
docker build -t ghcr.io/fezchat/gradients-miner:0.2.0 .
docker push ghcr.io/fezchat/gradients-miner:0.2.0   # prints the sha256 digest
# paste the digest into miner-part.ts's image field
```

If Docker/ghcr isn't available in the session, STOP and hand this step to Ken; the code tasks before and after remain mergeable (the placeholder digest fails loudly at pull, never silently).

- [ ] **Step 4: Update tests, build, commit**

Read `packages/fez-gradients/tests/` first; rewrite assertions to check the container block (image is ghcr+digest, register command templates, mountKeys true) instead of install-script strings.

Run: `cd packages/fez-gradients && npx vitest --run && npm run build`

```bash
git add packages/fez-gradients
git commit -m "gradients: descriptor v2 — the miner is an image, not install instructions"
```

---

### Task 6: `kind: "do"` machine state + fez ssh identity

**Files:**
- Modify: `packages/fez-mining/src/state.ts` (the `MinerMachineState` union)
- Create: `packages/fez-mining/src/fez-ssh-key.ts`
- Test: `packages/fez-mining/tests/fez-ssh-key.test.ts`

**Interfaces:**
- Produces:
  - state: `{ kind: "do"; dropletId?: number; host?: string; user?: string; servePort?: number }`
  - `ensureFezSshKey(home?: string): Promise<{ keyPath: string; publicKey: string }>` — Task 7 consumes.

- [ ] **Step 1: Extend the state union** — add a third member to `MinerMachineState`:

```ts
  | {
      kind: "do";
      /** Absent until the provisioner returns — start records intent first. */
      dropletId?: number;
      host?: string;
      user?: string;
      servePort?: number;
    }
```

- [ ] **Step 2: Failing test for the key helper**

```ts
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureFezSshKey } from "../src/fez-ssh-key.js";

describe("fez ssh identity", () => {
  it("generates once, returns the same key after, public half is ed25519", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-sshkey-"));
    const a = await ensureFezSshKey(home);
    expect(a.publicKey).toMatch(/^ssh-ed25519 /);
    expect(fs.statSync(a.keyPath).mode & 0o777).toBe(0o600);
    const b = await ensureFezSshKey(home);
    expect(b.publicKey).toBe(a.publicKey);
  });
});
```

- [ ] **Step 3: Implement** `src/fez-ssh-key.ts`:

```ts
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fezHome } from "./state.js";

/**
 * fez's own machine identity: one ed25519 pair in ~/.fez/ssh, its public
 * half injected into every fez-provisioned machine via cloud-init. The
 * user's cloud-account keys are never touched.
 */
export async function ensureFezSshKey(home = fezHome()): Promise<{ keyPath: string; publicKey: string }> {
  const dir = path.join(home, "ssh");
  const keyPath = path.join(dir, "fez_ed25519");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.access(keyPath);
  } catch {
    await new Promise<void>((resolve, reject) =>
      execFile("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "fez", "-f", keyPath], (e) =>
        e ? reject(e) : resolve()
      )
    );
  }
  await fs.chmod(keyPath, 0o600);
  const publicKey = (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
  return { keyPath, publicKey };
}
```

- [ ] **Step 4: Run tests (both files), typecheck, commit**

Run: `cd packages/fez-mining && npx vitest --run tests/fez-ssh-key.test.ts && npx tsc --noEmit`

```bash
git add packages/fez-mining/src/state.ts packages/fez-mining/src/fez-ssh-key.ts packages/fez-mining/tests/fez-ssh-key.test.ts
git commit -m "mining: do machine state + fez's own ssh identity (ed25519, cloud-init-injected)"
```

---

### Task 7: DoMachine provisioner (TDD, fake fetch)

**Files:**
- Create: `packages/fez-mining/src/machine-do.ts`
- Test: `packages/fez-mining/tests/machine-do.test.ts`

**Interfaces:**
- Consumes: `SshSpec` from `./machine-ssh.js`; `ensureFezSshKey` from Task 6.
- Produces (Task 8 relies on):
  - `type DoFetch = (url: string, init?: { method?: string; headers?: Record<string,string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>`
  - `doProvision(opts: { token: string; netuid: number; persona: string; servePorts: number[]; publicKey: string; keyPath: string }, f?: DoFetch, pollDelayMs?: number): Promise<{ ref: string; ssh: SshSpec }>`
  - `doAlive(token: string, ref: string, f?: DoFetch): Promise<boolean>`
  - `doDestroy(token: string, ref: string, f?: DoFetch): Promise<void>`
  - `DO_SIZE = "s-1vcpu-2gb"`, `DO_IMAGE = "ubuntu-24-04-x64"`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { doProvision, doAlive, doDestroy, DO_SIZE } from "../src/machine-do.js";

const fakeFetch = (routes: Record<string, { status: number; body?: unknown }[]>) => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const counts: Record<string, number> = {};
  const f = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url.replace(/\d+/g, "N")}`;
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const seq = routes[key] ?? [{ status: 404 }];
    const r = seq[Math.min(counts[key] ?? 0, seq.length - 1)];
    counts[key] = (counts[key] ?? 0) + 1;
    return { status: r.status, json: async () => r.body ?? {} };
  };
  return { f, calls };
};

const OPTS = { token: "tok", netuid: 56, persona: "gauss", servePorts: [7999], publicKey: "ssh-ed25519 AAA fez", keyPath: "/k" };

describe("DoMachine provisioner", () => {
  it("creates with cloud-init (fez key + docker), polls to active, returns ssh spec", async () => {
    const { f, calls } = fakeFetch({
      "POST https://api.digitalocean.com/v2/droplets": [
        { status: 202, body: { droplet: { id: 42 } } },
      ],
      "GET https://api.digitalocean.com/v2/droplets/N": [
        { status: 200, body: { droplet: { id: 42, status: "new", networks: { v4: [] } } } },
        { status: 200, body: { droplet: { id: 42, status: "active", networks: { v4: [{ type: "public", ip_address: "1.2.3.4" }] } } } },
      ],
    });
    const r = await doProvision(OPTS, f, 1);
    expect(r.ref).toBe("42");
    expect(r.ssh).toEqual({ host: "1.2.3.4", user: "root", keyPath: "/k", ports: [{ externalIp: "1.2.3.4", externalPort: 7999, internalPort: 7999 }] });
    const create = calls[0].body as { name: string; size: string; user_data: string };
    expect(create.name).toBe("fez-56-gauss");
    expect(create.size).toBe(DO_SIZE);
    expect(create.user_data).toContain("ssh-ed25519 AAA fez");
    expect(create.user_data).toContain("docker.io");
  });

  it("alive: active droplet true, 404 false", async () => {
    const live = fakeFetch({ "GET https://api.digitalocean.com/v2/droplets/N": [{ status: 200, body: { droplet: { id: 42, status: "active" } } }] });
    expect(await doAlive("tok", "42", live.f)).toBe(true);
    const gone = fakeFetch({});
    expect(await doAlive("tok", "42", gone.f)).toBe(false);
  });

  it("destroy issues DELETE and tolerates 404", async () => {
    const { f, calls } = fakeFetch({ "DELETE https://api.digitalocean.com/v2/droplets/N": [{ status: 204 }] });
    await doDestroy("tok", "42", f);
    expect(calls[0].method).toBe("DELETE");
    await doDestroy("tok", "42", fakeFetch({}).f); // 404 — resolves anyway
  });

  it("a failed create throws with DO's message", async () => {
    const { f } = fakeFetch({
      "POST https://api.digitalocean.com/v2/droplets": [{ status: 422, body: { message: "size unavailable" } }],
    });
    await expect(doProvision(OPTS, f, 1)).rejects.toThrow(/size unavailable/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement** `src/machine-do.ts`:

```ts
import type { SshSpec } from "./machine-ssh.js";

/**
 * The DigitalOcean provisioner — first implementation of the
 * provisioned-ssh pattern (spec §Provisioner): create a droplet whose
 * cloud-init authorizes fez's key and installs Docker; after that it IS
 * an SshMachine. Stop = DELETE — no orphan possible, no idle billing.
 * ponytail: region fixed to the account default; a region picker when
 * someone outside the US asks.
 */
export const DO_SIZE = "s-1vcpu-2gb";
export const DO_IMAGE = "ubuntu-24-04-x64";
const API = "https://api.digitalocean.com/v2";

export type DoFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; json(): Promise<unknown> }>;

const realFetch: DoFetch = (url, init) => fetch(url, init) as never;

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function userData(publicKey: string): string {
  return [
    "#cloud-config",
    "ssh_authorized_keys:",
    `  - ${publicKey}`,
    "packages:",
    "  - docker.io",
    "runcmd:",
    "  - systemctl enable --now docker",
    "  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
    "  - systemctl reload ssh || systemctl reload sshd",
    "",
  ].join("\n");
}

interface DropletJson {
  droplet?: { id: number; status?: string; networks?: { v4?: { type: string; ip_address: string }[] }; message?: never };
  message?: string;
}

export async function doProvision(
  opts: { token: string; netuid: number; persona: string; servePorts: number[]; publicKey: string; keyPath: string },
  f: DoFetch = realFetch,
  pollDelayMs = 5000
): Promise<{ ref: string; ssh: SshSpec }> {
  const create = await f(`${API}/droplets`, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify({
      name: `fez-${opts.netuid}-${opts.persona}`,
      size: DO_SIZE,
      image: DO_IMAGE,
      user_data: userData(opts.publicKey),
      tags: ["fez-miner"],
    }),
  });
  const created = (await create.json()) as DropletJson;
  if (create.status >= 300 || !created.droplet) {
    throw new Error(`DO create failed (${create.status}): ${created.message ?? "unknown"}`);
  }
  const id = created.droplet.id;

  // Poll to active + public IPv4. 60 × pollDelayMs ceiling (5 min at the
  // default) — a droplet not active by then is a provision failure.
  for (let n = 0; n < 60; n++) {
    const r = await f(`${API}/droplets/${id}`, { headers: headers(opts.token) });
    const j = (await r.json()) as DropletJson;
    const ip = j.droplet?.networks?.v4?.find((v) => v.type === "public")?.ip_address;
    if (j.droplet?.status === "active" && ip) {
      return {
        ref: String(id),
        ssh: {
          host: ip,
          user: "root",
          keyPath: opts.keyPath,
          ports: opts.servePorts.map((p) => ({ externalIp: ip, externalPort: p, internalPort: p })),
        },
      };
    }
    await new Promise((res) => setTimeout(res, pollDelayMs));
  }
  throw new Error(`DO droplet ${id} never became active — check your DO dashboard; it may be billing`);
}

export async function doAlive(token: string, ref: string, f: DoFetch = realFetch): Promise<boolean> {
  const r = await f(`${API}/droplets/${ref}`, { headers: headers(token) });
  if (r.status === 404) return false;
  const j = (await r.json()) as DropletJson;
  return j.droplet?.status === "active" || j.droplet?.status === "new";
}

export async function doDestroy(token: string, ref: string, f: DoFetch = realFetch): Promise<void> {
  await f(`${API}/droplets/${ref}`, { method: "DELETE", headers: headers(token) }).catch(() => undefined);
}
```

- [ ] **Step 4: Run to verify pass, typecheck, commit**

Run: `cd packages/fez-mining && npx vitest --run tests/machine-do.test.ts && npx tsc --noEmit`

```bash
git add packages/fez-mining/src/machine-do.ts packages/fez-mining/tests/machine-do.test.ts
git commit -m "mining: DoMachine provisioner — create/poll/destroy against the DO API, cloud-init docker + fez key"
```

---

### Task 8: resolveMachine "do" branch + CLI `--machine do` + stop-destroys

**Files:**
- Modify: `packages/fez-mining/src/run.ts` — `resolveMachine` (add a branch above the ssh branch) and its option type.
- Modify: `packages/fez-mining/src/cli.ts` — machine flag validation, `cmdStart`'s machine-state write, `cmdStop`.
- Test: `packages/fez-mining/tests/run-remote.test.ts` (append)

**Interfaces:**
- Consumes: Task 7's `doProvision`/`doAlive`/`doDestroy` (+ `DoFetch`), Task 6's `ensureFezSshKey` and `kind: "do"` state, the existing `sshMachine`, `retryFirstContact`, `remoteWorkDir`, `deployHotkey`.
- Produces: `resolveMachine`'s opts gain `doFetch?: DoFetch` (test injection); state after a do-provision carries `dropletId`, `host`, `user: "root"`, `servePort`.

- [ ] **Step 1: Failing test** (append to `run-remote.test.ts`)

```ts
describe("resolveMachine do (provision → ssh, reattach when alive)", () => {
  const doEntry: MinerEntry = {
    netuid: 56, persona: "gauss", hotkey: "5F", desired: "running",
    machine: { kind: "do", servePort: 7999 },
  };

  it("provisions when no droplet recorded, persists BEFORE hotkey deploy, hands back an ssh machine", async () => {
    const prevTok = process.env.DO_API_TOKEN; process.env.DO_API_TOKEN = "tok";
    const prevBin = process.env.FEZ_WALLET_BIN; process.env.FEZ_WALLET_BIN = fakeWalletBin;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS; process.env.FEZ_MINE_RETRY_DELAY_MS = "1";
    const prevInit = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS; process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1";
    try {
      const doFetch = async (url: string, init?: { method?: string }) => ({
        status: init?.method === "POST" ? 202 : 200,
        json: async () =>
          init?.method === "POST"
            ? { droplet: { id: 7 } }
            : { droplet: { id: 7, status: "active", networks: { v4: [{ type: "public", ip_address: "9.9.9.9" }] } } },
      });
      const sshCalls: string[][] = [];
      const sshRun = async (argv: string[]) => { sshCalls.push(argv); return { code: 0, stdout: "", stderr: "" }; };
      let persisted: unknown;
      const { machine, machineState, provisioned } = await resolveMachine(
        doEntry, "gauss", { sshRun, doFetch }, undefined, undefined, () => {},
        async (ms) => { persisted = ms; }
      );
      expect(machine.kind).toBe("ssh");
      expect(machine.ports).toEqual([{ externalIp: "9.9.9.9", externalPort: 7999, internalPort: 7999 }]);
      expect(provisioned).toBe(true);
      expect(machineState).toMatchObject({ kind: "do", dropletId: 7, host: "9.9.9.9" });
      expect(persisted).toMatchObject({ kind: "do", dropletId: 7 }); // findable even if deploy fails after
      expect(sshCalls.some((c) => c[0] === "scp")).toBe(true); // hotkey deployed
    } finally {
      if (prevTok === undefined) delete process.env.DO_API_TOKEN; else process.env.DO_API_TOKEN = prevTok;
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN; else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS; else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInit === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS; else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInit;
    }
  });

  it("no DO_API_TOKEN fails with the SKILLS & SECRETS instruction, before any API call", async () => {
    const prev = process.env.DO_API_TOKEN; delete process.env.DO_API_TOKEN;
    try {
      await expect(resolveMachine(doEntry, "gauss", {})).rejects.toThrow(/DO_API_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.DO_API_TOKEN = prev;
    }
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement the branch in `resolveMachine`** (insert ABOVE the `kind === "ssh"` branch; imports: `doProvision, doAlive, doDestroy, type DoFetch` from `./machine-do.js`, `ensureFezSshKey` from `./fez-ssh-key.js`; add `doFetch?: DoFetch` to the opts type):

```ts
  if (entry?.machine?.kind === "do") {
    const st = entry.machine;
    const token = process.env.DO_API_TOKEN;
    if (!token) {
      throw new Error("DigitalOcean mining needs DO_API_TOKEN — add it in SKILLS & SECRETS (an API token from cloud.digitalocean.com/account/api)");
    }
    const identity = await ensureFezSshKey();
    const servePorts = st.servePort ? [st.servePort] : [];
    let ref = st.dropletId !== undefined ? String(st.dropletId) : undefined;
    let ssh: import("./machine-ssh.js").SshSpec | undefined;
    if (ref && st.host && (await doAlive(token, ref, opts.doFetch))) {
      ssh = {
        host: st.host, user: st.user ?? "root", keyPath: identity.keyPath,
        ports: servePorts.map((p) => ({ externalIp: st.host!, externalPort: p, internalPort: p })),
      };
    }
    let provisioned = false;
    let machineState: MinerMachineState | undefined;
    if (!ssh) {
      const r = await doProvision(
        { token, netuid: entry.netuid, persona, servePorts, publicKey: identity.publicKey, keyPath: identity.keyPath },
        opts.doFetch
      );
      ssh = r.ssh;
      provisioned = true;
      machineState = { kind: "do", dropletId: Number(r.ref), host: r.ssh.host, user: "root", servePort: st.servePort };
      // Persist BEFORE deploy: a droplet that fails setup must still be
      // findable and destroyable (the Lium lesson, verbatim).
      if (persistProvision) await persistProvision(machineState);
    }
    const machine = sshMachine(ssh, opts.sshRun);
    await retryFirstContact(
      "droplet readiness",
      async () => {
        const r = await machine.exec("true");
        if (r.code !== 0) throw new Error(r.stderr || `exec exited ${r.code}`);
      },
      log
    );
    const mk = await machine.exec(`mkdir -p ${escapeShellValue(remoteWorkDir(entry.netuid, persona))}`);
    if (mk.code !== 0) throw new Error(mk.stderr || `mkdir workDir exited ${mk.code}`);
    await deployHotkey(persona, machine);
    return provisioned ? { machine, provisioned, machineState } : { machine };
  }
```

- [ ] **Step 4: CLI — accept and carry `--machine do`**

In `cli.ts`: the machine-flag validation adds `"do"` to the allowed set. `cmdStart`'s machine-state write gains (mirroring the ssh arm; `--serve-port` reuses the existing flag):

```ts
      : machine === "do"
        ? {
            machine:
              existing?.machine?.kind === "do"
                ? existing.machine
                : { kind: "do" as const, ...(servePortValue ? { servePort: servePortValue } : {}) },
          }
```

`cmdStart`'s remote-hotkey export condition becomes `machine === "lium" || machine === "ssh" || machine === "do"` (it is currently `lium || ssh`). In the stop command, after the container-stop block from Task 4, destroy the droplet:

```ts
  if (entry?.machine?.kind === "do" && entry.machine.dropletId !== undefined) {
    const token = process.env.DO_API_TOKEN;
    if (token) {
      await doDestroy(token, String(entry.machine.dropletId));
      console.error(`destroyed droplet ${entry.machine.dropletId} — billing stopped`);
    } else {
      console.error(`droplet ${entry.machine.dropletId} NOT destroyed (no DO_API_TOKEN) — delete it in your DO dashboard or it keeps billing`);
    }
  }
```

After destroy, clear the recorded machine's `dropletId`/`host` in state (write the entry back with `machine: { kind: "do", servePort: entry.machine.servePort }`) so a later start provisions fresh.

- [ ] **Step 5: Run the full suite, typecheck, commit**

Run: `cd packages/fez-mining && npx vitest --run && npx tsc --noEmit`

```bash
git add packages/fez-mining/src/run.ts packages/fez-mining/src/cli.ts packages/fez-mining/tests/run-remote.test.ts
git commit -m "mining: do machine — provision on start, reattach when alive, destroy on stop"
```

---

### Task 9: GUI — DO in the machine picker, do rows, cost honesty

**Files:**
- Modify: `packages/fez-mining/src/gui-rows.ts` (`MachineChoice`, `machineChoices`)
- Modify: `packages/fez-mining/src/gui.tsx` (picker render, start args, restart carry, row/detail rendering, confirm cost line)
- Test: `packages/fez-mining/tests/gui-rows.test.ts` (append)

**Interfaces:**
- Consumes: state `kind: "do"` fields from Task 6; CLI `--machine do` from Task 8.
- Produces: `MachineChoice = "local" | "lium" | "ssh" | "do"`; `machineChoices(req, hasDoToken: boolean)` — note the new second parameter.

- [ ] **Step 1: Failing tests** (append to `gui-rows.test.ts`)

```ts
  it("remote-needing subnets offer DO when a token exists, disabled with the fix when not", () => {
    const withTok = machineChoices({ publicEndpoint: true }, true);
    expect(withTok.find((x) => x.choice === "do")).toMatchObject({ enabled: true });
    const noTok = machineChoices({ publicEndpoint: true }, false);
    expect(noTok.find((x) => x.choice === "do")).toMatchObject({ enabled: false });
    expect(noTok.find((x) => x.choice === "do")?.reason).toMatch(/DO_API_TOKEN/);
  });

  it("no-requirement subnets still skip the picker entirely", () => {
    expect(machineChoices(undefined, true)).toEqual([{ choice: "local", enabled: true }]);
  });
```

Update the existing `machineChoices` tests' call sites to pass a second argument (`false` keeps their current expectations for the non-DO rows).

- [ ] **Step 2: Implement in `gui-rows.ts`** — extend the type and function:

```ts
export type MachineChoice = "local" | "lium" | "ssh" | "do";
```

In `machineChoices(req, hasDoToken: boolean)`, after the ssh entry:

```ts
    {
      choice: "do" as const,
      enabled: hasDoToken,
      reason: hasDoToken
        ? "fez makes a DigitalOcean droplet (~$0.018/hr, billed to your DO account until stop)"
        : "add DO_API_TOKEN in SKILLS & SECRETS to let fez make the machine for you",
    },
```

- [ ] **Step 3: Wire `gui.tsx`**

- Token presence: the extension can only see what the host exposes — check how existing secrets reach the GUI (search `gui.tsx` for how it learns of `LIUM` availability, e.g. the `machines --json` error path). Follow the same route: add a cheap `fez-mine do-token-status --json` CLI verb in `cli.ts` returning `{ present: boolean }` from `!!process.env.DO_API_TOKEN`, called once on mount alongside `loadCatalog`, stored as `const [hasDoToken, setHasDoToken] = useState(false)`.
- Pass it: `machineChoices(req, hasDoToken)` at both call sites (`enterMachineStep` default-choice pick and the picker render).
- Start args in `doStart`: `if (machine === "do") { startArgs.push("--machine", "do"); if (sshServePort.trim()) startArgs.push("--serve-port", sshServePort.trim()); }` — reuse the existing serve-port input, shown when `machineChoice === "ssh" || machineChoice === "do"` (host/key inputs stay ssh-only).
- Restart carries: in both restart paths add `if (m.machine?.kind === "do") args.push("--machine", "do");` (and the `status?.…` twin).
- Rows and detail: extend both machine-info renderings (the pattern from commit e8c5a06) with:

```ts
: m.machine?.kind === "do"
  ? ` · DO droplet${m.machine.dropletId ? ` ${m.machine.dropletId}` : ""} · ~$0.018/hr${m.machine.host ? ` · ${m.machine.host}` : ""}`
```

- Confirm step: in `startFlow`, when `machine === "do"`, append to the message: `"\n\nDigitalOcean: fez will create a ~$0.018/hr droplet on your account; stopping the miner destroys it."`

- [ ] **Step 4: Run tests, typecheck, build, stage**

Run: `cd packages/fez-mining && npx vitest --run && npx tsc --noEmit && npm run build && cp dist/gui.js ~/.fez/packages/fez-mining/dist/gui.js`

- [ ] **Step 5: Commit**

```bash
git add packages/fez-mining/src/gui-rows.ts packages/fez-mining/src/gui.tsx packages/fez-mining/src/cli.ts packages/fez-mining/tests/gui-rows.test.ts
git commit -m "mining GUI: DigitalOcean in the machine picker — token-gated, cost-honest, do rows"
```

---

### Task 10: env-gated live smoke (Stage C)

**Files:**
- Create: `packages/fez-mining/tests/live-do-smoke.test.ts`

**Interfaces:**
- Consumes: everything; runs only with `FEZ_SMOKE_DO_TOKEN` set.

- [ ] **Step 1: Write the smoke** (mirrors `live-ssh-smoke.test.ts`'s gating):

```ts
import { describe, expect, it } from "vitest";
import { doProvision, doAlive, doDestroy } from "../src/machine-do.js";
import { sshMachine } from "../src/machine-ssh.js";
import { ensureDocker } from "../src/container-runner.js";
import { ensureFezSshKey } from "../src/fez-ssh-key.js";

const TOKEN = process.env.FEZ_SMOKE_DO_TOKEN;

describe.skipIf(!TOKEN)("DoMachine live smoke — provision, docker-ready, destroy", () => {
  it("full lifecycle; the droplet is GONE at the end (billing safety is the test)", async () => {
    const identity = await ensureFezSshKey();
    const { ref, ssh } = await doProvision(
      { token: TOKEN!, netuid: 999, persona: "smoke", servePorts: [], publicKey: identity.publicKey, keyPath: identity.keyPath }
    );
    try {
      const m = sshMachine(ssh);
      // cloud-init needs a beat after "active" — retry the probe.
      let up = false;
      for (let n = 0; n < 60 && !up; n++) {
        const r = await m.exec("true", { timeoutMs: 10_000 });
        up = r.code === 0;
        if (!up) await new Promise((res) => setTimeout(res, 5000));
      }
      expect(up).toBe(true);
      // docker may still be installing — poll ensureDocker.
      let dockered = false;
      for (let n = 0; n < 36 && !dockered; n++) {
        dockered = await ensureDocker(m, () => {}).then(() => true, () => false);
        if (!dockered) await new Promise((res) => setTimeout(res, 5000));
      }
      expect(dockered).toBe(true);
    } finally {
      await doDestroy(TOKEN!, ref);
    }
    // The assertion that matters: nothing is billing.
    let alive = true;
    for (let n = 0; n < 24 && alive; n++) {
      alive = await doAlive(TOKEN!, ref);
      if (alive) await new Promise((res) => setTimeout(res, 5000));
    }
    expect(alive).toBe(false);
  }, 900_000);
});
```

- [ ] **Step 2: Verify it skips without the token**

Run: `cd packages/fez-mining && npx vitest --run tests/live-do-smoke.test.ts`
Expected: skipped.

- [ ] **Step 3: Run it live once** (human-gated — needs a real `FEZ_SMOKE_DO_TOKEN`; costs ~1¢):

Run: `FEZ_SMOKE_DO_TOKEN=<token> npx vitest --run tests/live-do-smoke.test.ts`
Expected: 1 passed in ~3–6 min. Then the full Gradients-on-DO proof happens through the app (start a miner with machine "do" on testnet), same shape as the 2026-09-08 ssh proof.

- [ ] **Step 4: Commit**

```bash
git add packages/fez-mining/tests/live-do-smoke.test.ts
git commit -m "mining: DO live smoke — provision to docker-ready to destroyed, billing-safe by assertion"
```
