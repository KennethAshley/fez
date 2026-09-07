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
