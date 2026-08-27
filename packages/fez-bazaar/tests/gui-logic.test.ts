import { describe, expect, it } from "vitest";
import { aliveWithin, minerRows, statusLine, type RawEvent } from "../src/gui-logic.js";

const NOW = 1_800_000_000_000;
const SEC = NOW / 1000;

const announce = (pk: string, over: Record<string, unknown> = {}): RawEvent => ({
  pubkey: pk,
  content: JSON.stringify({ heartbeat: SEC - 60, answered: 3, earned: 2, spentUsd: 0.5, ...over }),
});
const profile = (pk: string, name: string): RawEvent => ({
  pubkey: pk,
  content: JSON.stringify({ name, picture: `https://blossom.example/${name}.png` }),
});
const result = (pk: string): RawEvent => ({ pubkey: pk, content: JSON.stringify({ status: "success", result: "x" }) });
const attestation = (pk: string, total: number, rank: number): RawEvent => ({
  tags: [["p", pk]],
  content: JSON.stringify({ total, rank, quality: total, conduct: 1, timeliness: 1 }),
});

const base = {
  profiles: [profile("pk1", "quill"), profile("pk2", "forge")],
  announces: [announce("pk1"), announce("pk2", { answered: 1 })],
  results: [result("pk1"), result("pk2")],
  attestations: [attestation("pk1", 0.9, 1), attestation("pk1", 0.7, 1), attestation("pk2", 0.4, 2)],
  myPks: ["pk1", "pk2"],
  now: NOW,
};

describe("aliveWithin", () => {
  it("counts a recent heartbeat as alive", () => {
    expect(aliveWithin(SEC - 60, NOW)).toBe(true);
  });
  it("counts a stale heartbeat as not alive", () => {
    expect(aliveWithin(SEC - 3600, NOW)).toBe(false);
  });
  it("treats a missing heartbeat as not alive", () => {
    expect(aliveWithin(undefined, NOW)).toBe(false);
  });
  it("tolerates three missed announces before declaring a miner gone", () => {
    // Miners announce every 5 minutes; one dropped publish is not an outage.
    expect(aliveWithin(SEC - 11 * 60, NOW)).toBe(true);
    expect(aliveWithin(SEC - 16 * 60, NOW)).toBe(false);
  });
});

describe("minerRows", () => {
  it("shows only my miners", () => {
    expect(minerRows({ ...base, myPks: ["pk1"] }).map((r) => r.pk)).toEqual(["pk1"]);
  });

  it("names a miner from its kind-0 profile", () => {
    const row = minerRows(base).find((r) => r.pk === "pk1");
    expect(row?.name).toBe("quill");
    expect(row?.picture).toContain("quill.png");
  });

  it("averages the scores it has been given", () => {
    const row = minerRows(base).find((r) => r.pk === "pk1");
    expect(row?.avgTotal).toBeCloseTo(0.8);
    expect(row?.tasksScored).toBe(2);
  });

  it("ranks the better miner first", () => {
    expect(minerRows(base)[0]!.pk).toBe("pk1");
  });

  it("prefers the heartbeat's answered count over what the relay still holds", () => {
    // The relay keeps a window; the miner counts everything it ever did.
    expect(minerRows(base).find((r) => r.pk === "pk1")?.answered).toBe(3);
  });

  it("carries earnings and spend through from the heartbeat", () => {
    const row = minerRows(base)[0]!;
    expect(row.earned).toBe(2);
    expect(row.spentUsd).toBe(0.5);
  });

  it("shows an unjudged miner rather than hiding it", () => {
    const rows = minerRows({ ...base, attestations: [] });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tasksScored).toBe(0);
    expect(rows[0]!.avgTotal).toBe(0);
  });

  it("survives a miner with no profile yet", () => {
    expect(minerRows({ ...base, profiles: [] }).find((r) => r.pk === "pk1")?.name).toBe("pk1");
  });

  it("ignores malformed event content instead of throwing", () => {
    const rows = minerRows({ ...base, announces: [{ pubkey: "pk1", content: "not json" }] });
    expect(rows.find((r) => r.pk === "pk1")?.alive).toBe(false);
  });
});

describe("statusLine", () => {
  it("reads as a sentence, not a row of numbers", () => {
    const row = minerRows(base).find((r) => r.pk === "pk1")!;
    expect(statusLine(row)).toBe("alive · answered 3 · judged 2× · mean 0.80 · best #1");
  });

  it("says so plainly when nothing has been judged", () => {
    const row = minerRows({ ...base, attestations: [] })[0]!;
    expect(statusLine(row)).toContain("not yet judged");
  });
});
