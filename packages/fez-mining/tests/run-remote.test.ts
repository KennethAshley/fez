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

  it("falls through to a fresh provision when describe fails on a pod ps still lists", async () => {
    const prevBin = process.env.FEZ_WALLET_BIN;
    process.env.FEZ_WALLET_BIN = fakeWalletBin;
    try {
      const { exec, calls } = scriptedExec({
        ps: () => ({ ok: true, out: JSON.stringify([{ pod: "p9" }]) }),
        describe: (_args, call) =>
          call === 1
            ? { ok: false, err: "pod half-dead" } // the reattach describe
            : { ok: true, out: JSON.stringify({ host_ip: "5.5.5.5", ports: [{ external: 40001, internal: 8091 }] }) }, // provisionPod's own describe
        up: () => ({ ok: true, out: JSON.stringify({ pod: "p10", price_per_hour: "0.5" }) }),
        exec: () => ({ ok: true, out: JSON.stringify({ results: [{ exit_code: 0, stdout: "", stderr: "" }] }) }),
        scp: () => ({ ok: true, out: "" }),
      });
      const { machine, machineState } = await resolveMachine(entry, "p", {}, exec);
      expect(machineState?.podId).toBe("p10"); // a NEW pod, not the stale p9
      expect(machine.ports).toEqual([{ externalIp: "5.5.5.5", externalPort: 40001, internalPort: 8091 }]);
      expect(calls.filter((c) => c[0] === "describe").length).toBe(2);
      expect(calls.some((c) => c[0] === "scp")).toBe(true); // the hotkey got deployed onto the fresh pod
    } finally {
      if (prevBin === undefined) delete process.env.FEZ_WALLET_BIN;
      else process.env.FEZ_WALLET_BIN = prevBin;
    }
  });
});
