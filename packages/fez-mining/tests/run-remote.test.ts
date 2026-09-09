import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMachine, runMiner } from "../src/run.js";
import type { MinerEntry } from "../src/state.js";
import { readState, upsertMiner, writeState } from "../src/state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function homeWithFixture(): string {
  const home = mkdtempSync(path.join(tmpdir(), "fm-remote-"));
  mkdirSync(path.join(home, "miners"), { recursive: true });
  cpSync(path.join(here, "fixtures", "machine-miner.js"), path.join(home, "miners", "machine-miner.js"));
  cpSync(path.join(here, "fixtures", "workdir-miner.js"), path.join(home, "miners", "workdir-miner.js"));
  cpSync(path.join(here, "fixtures", "container-fixture.js"), path.join(home, "miners", "container-fixture.js"));
  return home;
}

// Fake LiumExec scripted by argv[0], call-count aware where a verb (like
// "describe") is invoked more than once with different intended outcomes.
function scriptedExec(handlers: Record<string, (args: string[], call: number) => { ok: true; out: string } | { ok: false; err: string }>) {
  const calls: string[][] = [];
  const counts: Record<string, number> = {};
  const exec = async (args: string[]) => {
    calls.push(args);
    const verb = args[0];
    const n = (counts[verb] = (counts[verb] ?? 0) + 1);
    const h = handlers[verb];
    return h ? h(args, n) : { ok: false as const, err: `no script for ${args.join(" ")}` };
  };
  return { exec, calls };
}

const fakeWalletBin = path.join(here, "fixtures", "fake-wallet-bin.js");
chmodSync(fakeWalletBin, 0o755);

// record() from @fezchat/lium/cli writes unconditionally to the REAL
// ~/.fez/lium-pods.json — any test that drives a real provisionPod/
// teardownPod call (i.e. NOT short-circuited by machineFactory) passes
// this stub instead so the suite never touches the live ledger file.
const noRecord = async () => {};

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

describe("resolveMachine ssh (owned host: no provisioning, probe → workDir → hotkey)", () => {
  const sshEntry: MinerEntry = {
    netuid: 2, persona: "p", hotkey: "5F", desired: "running",
    machine: { kind: "ssh", host: "165.1.2.3", user: "root", servePort: 8091 },
  };

  it("builds the machine from declared state, probes, makes workDir, deploys the hotkey", async () => {
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitial = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1";
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1";
    try {
      const calls: string[][] = [];
      const sshRun = async (argv: string[]) => {
        calls.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      };
      const { machine, machineState, provisioned } = await resolveMachine(sshEntry, "p", { sshRun });
      expect(machine.kind).toBe("ssh");
      // Declared, identity-mapped endpoint — no provisioner to discover one.
      expect(machine.ports).toEqual([{ externalIp: "165.1.2.3", externalPort: 8091, internalPort: 8091 }]);
      expect(machineState).toBeUndefined(); // nothing provisioned, nothing to persist
      expect(provisioned).toBeUndefined();
      const cmds = calls.filter((c) => c[0] === "ssh").map((c) => c[c.length - 1]);
      expect(cmds[0]).toBe("true"); // first-contact probe
      expect(cmds.some((c) => c.startsWith("mkdir -p '/root/fez-mining/2-p'"))).toBe(true);
      expect(calls.some((c) => c[0] === "scp")).toBe(true); // hotkey deployed
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitial === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitial;
    }
  });

  it("a host that never answers fails the start with a transport error, not a hang into later steps", async () => {
    const prev = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitial = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1";
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1";
    try {
      const sshRun = async () => ({ code: 255, stdout: "", stderr: "Connection refused" });
      await expect(resolveMachine(sshEntry, "p", { sshRun })).rejects.toThrow(/Connection refused/);
    } finally {
      if (prev === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prev;
      if (prevInitial === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitial;
    }
  });
});

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

describe("resolveMachine (production resolution path, no machineFactory)", () => {
  const entry: MinerEntry = {
    netuid: 1, persona: "p", hotkey: "5F", desired: "running",
    // Deliberately mismatched vs. what `describe` will report below — if
    // reattach ever fabricates ports from these instead of re-describing,
    // the assertions on the REAL port map catch it.
    machine: { kind: "lium", podId: "p9", externalIp: "1.2.3.4", externalPort: 20002, hourlyRate: "0.4" },
  };

  it("reattach re-describes the pod for the real port map, not fabricated from stored state", async () => {
    const { exec, calls } = scriptedExec({
      ps: () => ({ ok: true, out: JSON.stringify([{ pod: "p9" }]) }),
      describe: () => ({ ok: true, out: JSON.stringify({ host_ip: "9.9.9.9", ports: [{ external: 30001, internal: 22 }] }) }),
    });
    const { machine, machineState } = await resolveMachine(entry, "p", {}, exec);
    expect(machine.ports).toEqual([{ externalIp: "9.9.9.9", externalPort: 30001, internalPort: 22 }]);
    expect(machineState).toBeUndefined(); // reattach doesn't rewrite the entry
    expect(calls.some((c) => c[0] === "up")).toBe(false); // never re-provisioned
  });

  it("falls through to a fresh provision when describe fails on a pod ps still lists, tearing down the stale pod first", async () => {
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitialWait = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1"; // collapse inter-attempt delay for the test
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1"; // collapse initial wait for the test
    try {
      const { exec, calls } = scriptedExec({
        ps: () => ({ ok: true, out: JSON.stringify([{ pod: "p9" }]) }),
        describe: (_args, call) =>
          call === 1
            ? { ok: false, err: "pod half-dead" } // the reattach describe
            : { ok: true, out: JSON.stringify({ host_ip: "5.5.5.5", ports: [{ external: 40001, internal: 8091 }] }) }, // provisionPod's own describe
        // `up` with no NODE_ID/filters refuses live — provisionPod picks
        // the node itself from `ls` first.
        // Pinned live 2026-09-08: `up <huid>` fails ("Node ... not found"),
        // `up <uuid>` (the row's `id`) deploys — provisionPod prefers id.
        ls: () => ({ ok: true, out: JSON.stringify([{ huid: "fresh-node-1", id: "b8b06429-0000-0000-0000-000000000009", price_per_hour: "0.5" }]) }),
        up: () => ({ ok: true, out: JSON.stringify({ pod: "p10", price_per_hour: "0.5" }) }),
        rm: () => ({ ok: true, out: "{}" }),
        exec: () => ({ ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) }),
        scp: () => ({ ok: true, out: "" }),
      });
      const { machine, machineState, provisioned } = await resolveMachine(entry, "p", {}, exec, noRecord);
      expect(machineState?.kind === "lium" && machineState.podId).toBe("p10"); // a NEW pod, not the stale p9
      expect(provisioned).toBe(true);
      expect(machine.ports).toEqual([{ externalIp: "5.5.5.5", externalPort: 40001, internalPort: 8091 }]);
      expect(calls.filter((c) => c[0] === "describe").length).toBe(2);
      expect(calls.some((c) => c[0] === "rm" && c[1] === "p9")).toBe(true); // stale pod torn down, best-effort
      expect(calls.some((c) => c[0] === "scp")).toBe(true); // the hotkey got deployed onto the fresh pod
      // I1-I3: the production call site's ports/ttl, not provisionPod's bare defaults.
      const upCall = calls.find((c) => c[0] === "up")!;
      expect(upCall).toEqual([
        "up", "b8b06429-0000-0000-0000-000000000009", "--yes", "--no-ssh", "--ttl", "24h", "--ports", "2",
      ]);
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitialWait === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitialWait;
    }
  });

  // Pinned live 2026-09-08: a freshly-provisioned pod's `up` can report
  // ready before sshd actually accepts connections. I4: the readiness gate
  // (probed right before this) is now the ONE authoritative first-contact
  // wait — deployHotkey itself runs single-attempt, leaning entirely on
  // copy()'s own bounded 3x inner retry (10s apart) for a mid-life
  // transient upload blip, no outer retryFirstContact wrap around it
  // anymore (that used to nest 12 outer x 3 inner = 36 scp attempts).
  it("deployHotkey leans on copy()'s bounded inner retry for a transient scp blip", async () => {
    const freshEntry: MinerEntry = { netuid: 1, persona: "p", hotkey: "5F", desired: "running", machine: { kind: "lium" } };
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitialWait = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    const prevCopyDelay = process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1"; // collapse inter-attempt delay for the test
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1"; // collapse initial wait for the test
    process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = "1"; // collapse copy()'s own inner retry delay
    try {
      const { exec, calls } = scriptedExec({
        ls: () => ({ ok: true, out: JSON.stringify([{ huid: "n1", price_per_hour: "0.3" }]) }),
        up: () => ({ ok: true, out: JSON.stringify({ pod: "pX", price_per_hour: "0.3" }) }),
        describe: () => ({ ok: true, out: JSON.stringify({ host_ip: "1.1.1.1", ports: [] }) }),
        exec: () => ({ ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) }), // readiness probe + mkdir
        // Fails once, succeeds on copy()'s 2nd inner attempt — well within
        // its bounded 3x retry, no outer wrap needed to cover it.
        scp: (_args, call) => (call < 2 ? { ok: false, err: "Failed to upload to: pX" } : { ok: true, out: "" }),
      });
      const { provisioned } = await resolveMachine(freshEntry, "p", {}, exec, noRecord);
      expect(provisioned).toBe(true);
      expect(calls.filter((c) => c[0] === "scp").length).toBe(2);
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitialWait === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitialWait;
      if (prevCopyDelay === undefined) delete process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = prevCopyDelay;
    }
  });

  // New: the readiness gate (machine.exec("true")) probes before
  // deployHotkey ever runs — a fresh pod's `up` can report ready before
  // sshd accepts ANY session, exec or scp. Reuses retryFirstContact's
  // budget (same env overrides as every other first-contact op here).
  it("readiness gate retries exec(\"true\") until the pod accepts a session, then deployHotkey runs", async () => {
    const freshEntry: MinerEntry = { netuid: 1, persona: "p", hotkey: "5F", desired: "running", machine: { kind: "lium" } };
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitialWait = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1";
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1";
    try {
      const { exec, calls } = scriptedExec({
        ls: () => ({ ok: true, out: JSON.stringify([{ huid: "n1", price_per_hour: "0.3" }]) }),
        up: () => ({ ok: true, out: JSON.stringify({ pod: "pX", price_per_hour: "0.3" }) }),
        describe: () => ({ ok: true, out: JSON.stringify({ host_ip: "1.1.1.1", ports: [] }) }),
        // First 2 exec calls are the readiness probe failing (sshd not up
        // yet); the 3rd succeeds (probe passes), the 4th is deployHotkey's
        // mkdir (also succeeds).
        exec: (_args, call) =>
          call <= 2
            ? { ok: false, err: "connection refused" }
            : { ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) },
        scp: () => ({ ok: true, out: "" }),
      });
      const { provisioned } = await resolveMachine(freshEntry, "p", {}, exec, noRecord);
      expect(provisioned).toBe(true);
      const firstExecIdx = calls.findIndex((c) => c[0] === "exec");
      const firstScpIdx = calls.findIndex((c) => c[0] === "scp");
      expect(firstExecIdx).toBeGreaterThanOrEqual(0);
      expect(firstScpIdx).toBeGreaterThan(firstExecIdx); // scp (the hotkey deploy) happens after the readiness probe
      expect(calls.filter((c) => c[0] === "exec").length).toBe(6); // 3 probe attempts + workDir mkdir + hotkey-dir mkdir + hotkey chmod 600
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitialWait === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitialWait;
    }
  });

  it("a runner-side fresh provision (after a half-dead describe) bumps the provisions ledger against the daily cap", async () => {
    const home = homeWithFixture();
    let s = await readState(home);
    s = upsertMiner(s, {
      netuid: 9998, persona: "p", hotkey: "5FAKE", desired: "running",
      machine: { kind: "lium", podId: "p9" }, provisions: [1000],
    });
    await writeState(home, s);
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitialWait = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1"; // collapse inter-attempt delay for the test
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1"; // collapse initial wait for the test
    try {
      const { exec, calls } = scriptedExec({
        ps: () => ({ ok: true, out: JSON.stringify([{ pod: "p9" }]) }),
        describe: (_args, call) =>
          call === 1
            ? { ok: false, err: "pod half-dead" }
            : { ok: true, out: JSON.stringify({ host_ip: "5.5.5.5", ports: [{ external: 40001, internal: 8091 }] }) },
        // Pinned live 2026-09-08: `up <huid>` fails ("Node ... not found"),
        // `up <uuid>` (the row's `id`) deploys — provisionPod prefers id.
        ls: () => ({ ok: true, out: JSON.stringify([{ huid: "fresh-node-1", id: "b8b06429-0000-0000-0000-000000000009", price_per_hour: "0.5" }]) }),
        up: () => ({ ok: true, out: JSON.stringify({ pod: "p10", price_per_hour: "0.5" }) }),
        rm: () => ({ ok: true, out: "{}" }),
        exec: () => ({ ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) }),
        scp: () => ({ ok: true, out: "" }),
      });
      const code = await runMiner(9998, "p", home, { hotkey: "5FAKE", exec, recorder: noRecord });
      expect(code).toBe(0);
      expect(calls.some((c) => c[0] === "rm" && c[1] === "p9")).toBe(true);
      const after = await readState(home);
      const updated = after.miners.find((m) => m.netuid === 9998 && m.persona === "p")!;
      expect(updated.machine?.kind === "lium" && updated.machine.podId).toBe("p10");
      expect(updated.provisions).toEqual([1000, expect.any(Number)]);
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitialWait === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitialWait;
    }
  });

  // Live smoke: a hotkey-deploy failure right after a fresh provision left
  // the pod orphaned — nothing in state pointed to it. Ruling: persist
  // podId BEFORE deployHotkey, then on a failure anywhere after that,
  // best-effort teardown + clear the entry back to "no pod yet".
  it("a deploy failure after a fresh provision persists the pod first, then tears it down and clears it", async () => {
    const home = homeWithFixture();
    let s = await readState(home);
    s = upsertMiner(s, { netuid: 9998, persona: "p", hotkey: "5FAKE", desired: "running", machine: { kind: "lium" } });
    await writeState(home, s);
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitialWait = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    const prevCopyDelay = process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1"; // exhaust the retries fast
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1"; // collapse initial wait for the test
    process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = "1"; // collapse copy()'s own inner retry delay
    try {
      const { exec, calls } = scriptedExec({
        ls: () => ({ ok: true, out: JSON.stringify([{ huid: "n1", price_per_hour: "0.3" }]) }),
        up: () => ({ ok: true, out: JSON.stringify({ pod: "pX", price_per_hour: "0.3" }) }),
        describe: () => ({ ok: true, out: JSON.stringify({ host_ip: "1.1.1.1", ports: [] }) }),
        exec: () => ({ ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) }), // readiness probe + mkdir ok
        scp: () => ({ ok: false, err: "Failed to upload to: pX" }), // permanent — not the boot race, exhausts retries
        rm: () => ({ ok: true, out: "{}" }),
      });
      const code = await runMiner(9998, "p", home, { hotkey: "5FAKE", exec, recorder: noRecord });
      expect(code).toBe(1);
      // I4: deployHotkey no longer has its own outer retry wrap — it runs
      // single-attempt on top of the already-proven readiness gate, leaning
      // entirely on copy()'s bounded 3x inner retry. 3 scp calls total
      // before giving up (was 36 — 12 outer x 3 inner nested on top of a
      // gate that had already proven the pod reachable).
      expect(calls.filter((c) => c[0] === "scp").length).toBe(3);
      expect(calls.some((c) => c[0] === "rm" && c[1] === "pX")).toBe(true); // the orphan risk: torn down instead

      const after = await readState(home);
      const entry = after.miners.find((m) => m.netuid === 9998 && m.persona === "p")!;
      expect(entry.machine).toEqual({ kind: "lium" }); // cleared back to "no pod yet", not left pointing at pX
      expect(entry.lastExit).toContain("exit 1");
      expect(entry.provisions?.length).toBe(1); // still counted (I8), even though the run failed
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitialWait === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitialWait;
      if (prevCopyDelay === undefined) delete process.env.FEZ_MINE_COPY_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_COPY_RETRY_DELAY_MS = prevCopyDelay;
    }
  });

  it("curates ctx.env to the FEZ_MINE_FORWARD_ENV allowlist for a lium miner (no PATH/HOME from the Mac)", async () => {
    const home = homeWithFixture();
    let s = await readState(home);
    s = upsertMiner(s, { netuid: 9998, persona: "envp", hotkey: "5FAKE", desired: "running" });
    await writeState(home, s);
    let capturedEnv: Record<string, string> | undefined;
    const machine = {
      kind: "lium" as const,
      ports: [],
      exec: async (_cmd: string, opts?: { env?: Record<string, string> }) => {
        capturedEnv = opts?.env;
        return { code: 0, stdout: "", stderr: "" };
      },
      copy: async () => {},
    };
    const prevForward = process.env.FEZ_MINE_FORWARD_ENV;
    const prevFoo = process.env.FEZ_TEST_FORWARD_FOO;
    process.env.FEZ_MINE_FORWARD_ENV = "FEZ_TEST_FORWARD_FOO";
    process.env.FEZ_TEST_FORWARD_FOO = "bar";
    try {
      const code = await runMiner(9998, "envp", home, { hotkey: "5FAKE", machineFactory: async () => machine });
      expect(code).toBe(0);
    } finally {
      if (prevForward === undefined) delete process.env.FEZ_MINE_FORWARD_ENV;
      else process.env.FEZ_MINE_FORWARD_ENV = prevForward;
      if (prevFoo === undefined) delete process.env.FEZ_TEST_FORWARD_FOO;
      else process.env.FEZ_TEST_FORWARD_FOO = prevFoo;
    }
    expect(capturedEnv).toEqual({ FEZ_TEST_FORWARD_FOO: "bar" });
    expect(capturedEnv?.PATH).toBeUndefined();
    expect(capturedEnv?.HOME).toBeUndefined();
  });

  // Round 8 root cause: ctx.workDir used to be the MAC's own path
  // (~/.fez/mining/<netuid>-<persona>) even for a lium miner — nonexistent
  // on the pod, so a descriptor's `ctx.machine.copy(local, \`${ctx.workDir}/x\`)`
  // failed (missing parent dir). ctx.workDir is now machine-side, created
  // on the pod right after the readiness gate passes.
  it("a fresh lium provision gets a machine-side workDir, mkdir'd before the descriptor's start runs", async () => {
    const home = homeWithFixture();
    let s = await readState(home);
    s = upsertMiner(s, { netuid: 9997, persona: "p", hotkey: "5FAKE", desired: "running", machine: { kind: "lium" } });
    await writeState(home, s);
    const prevBin = process.env.FEZ_WALLET_BIN;
    const prevDelay = process.env.FEZ_MINE_RETRY_DELAY_MS;
    const prevInitialWait = process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    process.env.FEZ_MINE_RETRY_DELAY_MS = "1";
    process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = "1";
    try {
      const { exec, calls } = scriptedExec({
        ls: () => ({ ok: true, out: JSON.stringify([{ huid: "n1", price_per_hour: "0.3" }]) }),
        up: () => ({ ok: true, out: JSON.stringify({ pod: "pX", price_per_hour: "0.3" }) }),
        describe: () => ({ ok: true, out: JSON.stringify({ host_ip: "1.1.1.1", ports: [] }) }),
        exec: () => ({ ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) }),
        scp: () => ({ ok: true, out: "" }),
      });
      const code = await runMiner(9997, "p", home, { hotkey: "5FAKE", exec, recorder: noRecord });
      expect(code).toBe(0);
      const mkdirIdx = calls.findIndex((c) => c[0] === "exec" && c[2] === "mkdir -p '/root/fez-mining/9997-p'");
      const startIdx = calls.findIndex((c) => c[0] === "exec" && c[2] === "echo WORKDIR /root/fez-mining/9997-p");
      expect(mkdirIdx).toBeGreaterThanOrEqual(0); // the workDir got created on the pod
      expect(startIdx).toBeGreaterThan(mkdirIdx); // ...before the descriptor's start saw it
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
      if (prevDelay === undefined) delete process.env.FEZ_MINE_RETRY_DELAY_MS;
      else process.env.FEZ_MINE_RETRY_DELAY_MS = prevDelay;
      if (prevInitialWait === undefined) delete process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS;
      else process.env.FEZ_MINE_RETRY_INITIAL_WAIT_MS = prevInitialWait;
    }
  });
});

describe("container descriptor routing", () => {
  it("a container descriptor runs through docker verbs, not script hooks", async () => {
    const home = homeWithFixture();
    let s = await readState(home);
    s = upsertMiner(s, { netuid: 9996, persona: "p", hotkey: "5FAKE", desired: "running" });
    await writeState(home, s);
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
    const code = await runMiner(9996, "p", home, { hotkey: "5FAKE", machineFactory: async () => machine });
    expect(code).toBe(0);
    const joined = execs.join(" || ");
    expect(joined).toContain("docker pull");
    expect(joined).toContain("docker run -d");
    expect(joined).toContain("docker wait 'fez-9996-p'");
    // The fixture ALSO defines install/register/start (each execs a
    // SCRIPT_HOOK_RAN sentinel) — proving container wins on precedence,
    // not merely that a hookless descriptor happens to skip them.
    expect(joined).not.toContain("SCRIPT_HOOK_RAN");
  });
});
