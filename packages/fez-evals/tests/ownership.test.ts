import { describe, it, expect } from "vitest";
import {
  decide,
  claimOwnership,
  takeOverActive,
  shutdownGraced,
  type OwnershipIO,
  type PresenceBeat,
} from "../../fez-acp/src/ownership.js";

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
  it("a plain claim yields to a superseding incumbent", () => {
    expect(decide(claiming("z"), { instance: "a", phase: "steady", supersede: true })).toBe("yield");
  });
  it("claiming take-over vs a superseding incumbent: exactly one survivor", () => {
    // Two take-overs land at once; the duel is by nonce, not by who is
    // further along. z loses to a and stands down before announcing…
    expect(decide(claiming("z", true), { instance: "a", phase: "steady", supersede: true })).toBe("yield");
    // …and a, the lower nonce, ignores z's supersede. One survivor: a.
    expect(decide(claiming("a", true), { instance: "z", phase: "steady", supersede: true })).toBe("ignore");
    expect(decide(steady("a", true), { instance: "z", phase: "steady", supersede: true })).toBe("defend");
  });
});

describe("takeOverActive — the move is a transition, not a trait", () => {
  it("is active only while supersede beats remain to be sent", () => {
    expect(takeOverActive(true, 3)).toBe(true);
    expect(takeOverActive(true, 1)).toBe(true);
    expect(takeOverActive(true, 0)).toBe(false);
    expect(takeOverActive(false, 3)).toBe(false); // never took over at all
  });
  it("a decayed take-over is an ordinary incumbent: a later supersede shuts it down", () => {
    // Persona moved once with --take-over (nonce "a"), transition long
    // finished. A SECOND --take-over ("z") arrives. With the old sticky
    // immunity "a" defended (a < z) and the new instance announced and
    // then died — the move visibly failed. Decayed, "a" stands down.
    expect(decide(steady("a", takeOverActive(true, 0)), { instance: "z", phase: "steady", supersede: true })).toBe("shutdown");
    // While the move is still in flight it is still immune.
    expect(decide(steady("a", takeOverActive(true, 2)), { instance: "z", phase: "steady", supersede: true })).toBe("defend");
  });
});

describe("shutdownGraced — a dying incumbent must not take the winner with it", () => {
  it("graces a nonce-tie shutdown in the first moments of steady", () => {
    expect(shutdownGraced({ instance: "a", phase: "steady" }, 1_000)).toBe(true);
    expect(shutdownGraced({ instance: "a", phase: "steady" }, 30_000)).toBe(false); // window closed
  });
  it("never graces an explicit supersede", () => {
    expect(shutdownGraced({ instance: "a", phase: "steady", supersede: true }, 1_000)).toBe(false);
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
