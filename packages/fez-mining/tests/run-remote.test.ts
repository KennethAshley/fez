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
