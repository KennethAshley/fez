import { describe, expect, it } from "vitest";
import { plan, planRemote } from "../src/reconcile.js";

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
