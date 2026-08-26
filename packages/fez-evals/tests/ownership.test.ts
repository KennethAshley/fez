import { describe, it, expect } from "vitest";
import { decide, claimOwnership, type OwnershipIO, type PresenceBeat } from "../../fez-acp/src/ownership.js";

const claiming = (nonce: string, takeOver = false) => ({ nonce, phase: "claiming" as const, takeOver });
const steady = (nonce: string, takeOver = false) => ({ nonce, phase: "steady" as const, takeOver });

describe("decide", () => {
  it("ignores echoes and legacy beats", () => {
    expect(decide(claiming("a"), { instance: "a", phase: "claim" })).toBe("ignore");
    expect(decide(steady("a"), {})).toBe("ignore"); // old binary, no instance
  });
  it("claiming yields to a live steady incumbent", () => {
    expect(decide(claiming("b"), { instance: "a", phase: "steady" })).toBe("yield");
  });
  it("simultaneous claims: lower nonce wins", () => {
    expect(decide(claiming("a"), { instance: "b", phase: "claim" })).toBe("ignore");
    expect(decide(claiming("b"), { instance: "a", phase: "claim" })).toBe("yield");
  });
  it("take-over never yields while claiming", () => {
    expect(decide(claiming("z", true), { instance: "a", phase: "steady" })).toBe("ignore");
    expect(decide(claiming("z", true), { instance: "a", phase: "claim" })).toBe("ignore");
  });
  it("steady defends against a claim", () => {
    expect(decide(steady("a"), { instance: "b", phase: "claim" })).toBe("defend");
  });
  it("steady/steady split-brain: lower nonce defends, higher shuts down", () => {
    expect(decide(steady("a"), { instance: "b", phase: "steady" })).toBe("defend");
    expect(decide(steady("b"), { instance: "a", phase: "steady" })).toBe("shutdown");
  });
  it("a foreign supersede shuts an incumbent down", () => {
    expect(decide(steady("a"), { instance: "z", phase: "steady", supersede: true })).toBe("shutdown");
  });
  it("dueling take-overs: lower nonce survives", () => {
    expect(decide(steady("a", true), { instance: "b", phase: "steady", supersede: true })).toBe("defend");
    expect(decide(steady("b", true), { instance: "a", phase: "steady", supersede: true })).toBe("shutdown");
  });
});

/** Two instances share one in-memory bus — the race, without a relay. */
function bus() {
  const subs: ((b: PresenceBeat & { from: string }) => void)[] = [];
  const io = (nonce: string): OwnershipIO => ({
    publishBeat: (extra) => subs.forEach((cb) => cb({ instance: nonce, ...extra, from: nonce })),
    onBeat: (cb) => {
      const wrapped = (b: PresenceBeat & { from: string }) => {
        if (b.from !== nonce) cb(b);
      };
      subs.push(wrapped);
      return () => subs.splice(subs.indexOf(wrapped), 1);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return io;
}

describe("claimOwnership", () => {
  it("two simultaneous claims: exactly one proceeds", async () => {
    const io = bus();
    const [a, b] = await Promise.all([
      claimOwnership(io("a"), { nonce: "a", takeOver: false, windowMs: 50 }),
      claimOwnership(io("b"), { nonce: "b", takeOver: false, windowMs: 50 }),
    ]);
    expect([a, b].sort()).toEqual(["proceed", "yield"]);
    expect(a).toBe("proceed"); // lower nonce
  });
  it("a claim against a defending incumbent yields", async () => {
    const io = bus();
    const incumbent = io("a");
    incumbent.onBeat((beat) => {
      if (decide(steady("a"), beat) === "defend") incumbent.publishBeat({ phase: "steady" });
    });
    expect(await claimOwnership(io("b"), { nonce: "b", takeOver: false, windowMs: 50 })).toBe("yield");
  });
  it("take-over proceeds through a defending incumbent", async () => {
    const io = bus();
    const incumbent = io("a");
    incumbent.onBeat((beat) => {
      if (decide(steady("a"), beat) === "defend") incumbent.publishBeat({ phase: "steady" });
    });
    expect(await claimOwnership(io("b"), { nonce: "b", takeOver: true, windowMs: 50 })).toBe("proceed");
  });
});
