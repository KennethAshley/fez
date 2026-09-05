import { describe, it, expect } from "vitest";
import { recordProposal, updateRecord, latestPendingFor, findByProposal, type OrchestrationRecord } from "../../fez-desktop/src/orchestration";

function memoryStore(initial?: string) {
  let blob = initial;
  return {
    read: async () => blob,
    write: async (c: string) => { blob = c; },
    dump: () => JSON.parse(blob ?? "{}") as { records?: OrchestrationRecord[] },
  };
}

const base = {
  task: "summarize RFC 9114", roster: ["quill"],
  picked: { pk: "d".repeat(64), name: "lebron", rateTaoHr: 0.5 },
  why: "no roster agent claims cited research", kind: "settle", priceEstTao: 0.13,
};

describe("orchestration records", () => {
  it("records a proposal as pending and finds it by pk", async () => {
    const s = memoryStore();
    const id = await recordProposal(s.read, s.write, base);
    expect(id).toBeTruthy();
    const found = await latestPendingFor(s.read, "d".repeat(64));
    expect(found?.id).toBe(id);
    expect(found?.decision).toBe("pending");
  });
  it("updates decision and outcome in place", async () => {
    const s = memoryStore();
    const id = await recordProposal(s.read, s.write, base);
    await updateRecord(s.read, s.write, id, { decision: "accepted", sentTaskId: "evt1" });
    await updateRecord(s.read, s.write, id, { outcome: { delivered: true, latencyS: 41 } });
    const rec = s.dump().records!.find((r) => r.id === id)!;
    expect(rec.decision).toBe("accepted");
    expect(rec.outcome?.delivered).toBe(true);
  });
  it("survives a corrupt blob by starting fresh", async () => {
    const s = memoryStore("{ not json");
    const id = await recordProposal(s.read, s.write, base);
    expect(s.dump().records!.length).toBe(1);
    expect(id).toBeTruthy();
  });
});

describe("findByProposal (remount hydration)", () => {
  it("finds a record by pk + task", async () => {
    const s = memoryStore();
    const id = await recordProposal(s.read, s.write, base);
    const found = await findByProposal(s.read, base.picked.pk, base.task);
    expect(found?.id).toBe(id);
  });
  it("returns the latest when the same proposal was recorded more than once", async () => {
    const s = memoryStore();
    await recordProposal(s.read, s.write, base);
    const id2 = await recordProposal(s.read, s.write, base);
    const found = await findByProposal(s.read, base.picked.pk, base.task);
    expect(found?.id).toBe(id2);
  });
  it("is undefined when no record matches this pk + task", async () => {
    const s = memoryStore();
    await recordProposal(s.read, s.write, base);
    const found = await findByProposal(s.read, base.picked.pk, "a different task");
    expect(found).toBeUndefined();
  });
});
