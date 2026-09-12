import { describe, expect, it } from "vitest";
import {
  beginGuestLease, beginGuestPayment, cancelGuestJob, createGuestJob, finishGuestLease,
  finishGuestPayment, guestJobStorageKey, guestRecoveryRecords, markGuestLeaseUnknown, markGuestPaymentUnknown,
  readGuestJobs, readGuestLease, readLegacyGuestHire,
} from "../../fez-desktop/src/guest-job";

const owner = "a".repeat(64), guest = "b".repeat(64);
const scope = { ownerPk: owner, guestPk: guest, relay: "wss://market.example" };
const address = "5" + "A".repeat(47), payerAddress = "5" + "B".repeat(47), arbiterAddress = "5" + "C".repeat(47);
const escrowAddress = "5" + "D".repeat(47), resultId = "d".repeat(64);
const txHash = "0x" + "e".repeat(64), receiptId = "f".repeat(64);
const request = { id: "c".repeat(64), kind: 47001, pubkey: owner, tags: [["p", guest]], content: "Write the agreed report." };
const terms = { kind: "settle" as const, amount: "0.10", persona: "buyer", payerAddress, payTo: address };
const payment = { persona: "buyer", payerAddress, network: "test", to: address, amount: "0.1", txHash };
const funded = { escrow: escrowAddress, txHash, payerAddress, network: "test", poster: payerAddress, worker: address, arbiter: arbiterAddress, amount: "0.1" };

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
}

describe("guest job payment bindings", () => {
  it("captures the exact request and payment terms, regardless of later mutable form or announcement changes", () => {
    const store = memory(), form = { ...terms };
    createGuestJob(store, scope, request, form, 100);
    form.amount = "99"; form.payTo = arbiterAddress;
    const pending = beginGuestPayment(store, scope, request.id, "pay", resultId, 200);
    expect(pending).toMatchObject({ requestId: request.id, brief: "Write the agreed report.", at: 100, amount: "0.10", payTo: address, payerAddress, persona: "buyer", state: "paying", acceptedResultId: resultId });
    expect(readGuestJobs(store, scope)[0]?.state).toBe("paying");
    expect(() => beginGuestPayment(store, scope, "9".repeat(64), "pay", resultId)).toThrow(/job/i);
  });

  it("isolates owner, guest and relay while canonicalizing equivalent relay URLs", () => {
    const store = memory();
    createGuestJob(store, scope, request, terms);
    expect(readGuestJobs(store, { ...scope, relay: "wss://MARKET.example:443/" })).toHaveLength(1);
    expect(readGuestJobs(store, { ...scope, ownerPk: "1".repeat(64) })).toEqual([]);
    expect(readGuestJobs(store, { ...scope, guestPk: "2".repeat(64) })).toEqual([]);
    expect(readGuestJobs(store, { ...scope, relay: "wss://other.example" })).toEqual([]);
  });

  it("requires a directed owner request and valid immutable terms before any record is written", () => {
    for (const bad of [{ ...request, pubkey: guest }, { ...request, kind: 47103 }, { ...request, tags: [] }, { ...request, tags: [["p", "9".repeat(64)]] }]) {
      expect(() => createGuestJob(memory(), scope, bad, terms)).toThrow(/request/i);
    }
    for (const amount of ["0", "-1", "1e2", "NaN", "0.0000000001"]) {
      const store = memory();
      expect(() => createGuestJob(store, scope, request, { ...terms, amount })).toThrow(/amount/i);
      expect(store.data.size).toBe(0);
    }
    expect(() => createGuestJob(memory(), scope, request, { ...terms, payTo: "" })).toThrow(/address|recipient/i);
  });

  it("requires explicit requester acceptance and rejects duplicate payment after remount or uncertain wallet failure", () => {
    const store = memory();
    createGuestJob(store, scope, request, terms);
    expect(() => beginGuestPayment(store, scope, request.id, "pay")).toThrow(/accept/i);
    beginGuestPayment(store, scope, request.id, "pay", resultId);
    expect(() => beginGuestPayment(store, scope, request.id, "pay", resultId)).toThrow(/pending|progress|state/i);
    markGuestPaymentUnknown(store, scope, request.id);
    expect(readGuestJobs(store, scope)[0]?.state).toBe("unknown");
    expect(() => beginGuestPayment(store, scope, request.id, "pay", resultId)).toThrow(/unknown|state/i);
    expect(() => cancelGuestJob(store, scope, request.id)).toThrow(/state|cancel/i);
    expect(() => createGuestJob(store, scope, { ...request, id: "8".repeat(64) }, terms)).toThrow(/active|recovery/i);
  });

  it("requires matching wallet accounting and keeps malformed completion unknown", () => {
    for (const returned of [
      { ...payment, to: arbiterAddress },
      { ...payment, persona: "stranger" },
      { ...payment, amount: "0.2" },
      { ...payment, txHash: "" },
      { ...payment, payerAddress: arbiterAddress },
      { ...payment, network: "finney" },
    ]) {
      const store = memory();
      createGuestJob(store, scope, request, terms);
      beginGuestPayment(store, scope, request.id, "pay", resultId);
      expect(() => finishGuestPayment(store, scope, request.id, returned)).toThrow(/outcome|accounting|confirm/i);
      expect(readGuestJobs(store, scope)[0]?.state).toBe("unknown");
    }
  });

  it("retains terminal jobs and will not pay the same request again", () => {
    const store = memory();
    createGuestJob(store, scope, request, terms);
    beginGuestPayment(store, scope, request.id, "pay", resultId);
    finishGuestPayment(store, scope, request.id, payment, 300);
    expect(readGuestJobs(store, scope)[0]).toMatchObject({ state: "paid", txHash, acceptedResultId: resultId });
    expect(() => createGuestJob(store, scope, request, terms)).toThrow(/already|exists/i);
    const next = { ...request, id: "8".repeat(64) };
    createGuestJob(store, scope, next, terms);
    cancelGuestJob(store, scope, next.id);
    expect(readGuestJobs(store, scope).map(j => j.state).sort()).toEqual(["cancelled", "paid"]);
  });

  it("keeps captured escrow participants and waits for executed release, not merely an approval hash", () => {
    const store = memory();
    createGuestJob(store, scope, request, { ...terms, kind: "escrow", escrow: { arbiterPersona: "escrowarbiter", arbiterAddress } });
    beginGuestPayment(store, scope, request.id, "fund");
    finishGuestPayment(store, scope, request.id, funded);
    const releasing = beginGuestPayment(store, scope, request.id, "release", resultId);
    expect(releasing).toMatchObject({ payerAddress, payTo: address, escrow: { arbiterPersona: "escrowarbiter", arbiterAddress, addr: escrowAddress, fundingTxHash: txHash } });
    expect(() => finishGuestPayment(store, scope, request.id, { ...funded, executed: false })).toThrow(/outcome|confirm/i);
    expect(readGuestJobs(store, scope)[0]?.state).toBe("unknown");
    expect(() => beginGuestPayment(store, scope, request.id, "refund")).toThrow(/unknown|state/i);
  });

  it("records confirmed escrow refund without inventing acceptance or allowing another release", () => {
    const store = memory();
    createGuestJob(store, scope, request, { ...terms, kind: "escrow", escrow: { arbiterPersona: "escrowarbiter", arbiterAddress } });
    beginGuestPayment(store, scope, request.id, "fund");
    finishGuestPayment(store, scope, request.id, funded);
    beginGuestPayment(store, scope, request.id, "refund");
    finishGuestPayment(store, scope, request.id, { ...funded, payerAddress: arbiterAddress, executed: true });
    expect(readGuestJobs(store, scope)[0]).toMatchObject({ state: "refunded" });
    expect(readGuestJobs(store, scope)[0]?.acceptedResultId).toBeUndefined();
    expect(() => beginGuestPayment(store, scope, request.id, "release", resultId)).toThrow(/state/i);
  });

  it("refuses escrow confirmations whose accounts, amount or network differ from the captured agreement", () => {
    for (const changed of [{ poster: address }, { worker: payerAddress }, { arbiter: address }, { payerAddress: arbiterAddress }, { amount: "0.2" }, { network: "finney" }]) {
      const store = memory();
      createGuestJob(store, scope, request, { ...terms, kind: "escrow", escrow: { arbiterPersona: "escrowarbiter", arbiterAddress } });
      beginGuestPayment(store, scope, request.id, "fund");
      expect(() => finishGuestPayment(store, scope, request.id, { ...funded, ...changed })).toThrow(/outcome|confirm/i);
      expect(readGuestJobs(store, scope)[0]?.state).toBe("unknown");
    }
  });

  it("preserves legacy escrow recovery evidence and never infers recipients from current announcements", () => {
    const store = memory();
    const raw = JSON.stringify({ amount: "0.75", persona: "old-buyer", at: 100, escrow: { addr: escrowAddress, state: "open" } });
    store.setItem(`fez-hire-${guest}`, raw);
    expect(readLegacyGuestHire(store, guest)).toMatchObject({ raw, amount: "0.75", persona: "old-buyer", escrowAddress });
    expect(readGuestJobs(store, scope)).toEqual([]);
    expect(() => createGuestJob(store, scope, request, terms)).toThrow(/legacy|recovery/i);
    expect(store.getItem(`fez-hire-${guest}`)).toBe(raw);
  });

  it("exports raw corrupt job records alongside legacy escrow data without requiring either to parse", () => {
    const store = memory();
    const jobsRaw = '{"partially-written-funding-record":';
    const legacyHireRaw = JSON.stringify({ amount: "0.75", persona: "old-buyer", escrow: { addr: escrowAddress, state: "open" } });
    store.setItem(guestJobStorageKey(scope), jobsRaw);
    store.setItem(`fez-hire-${guest}`, legacyHireRaw);
    expect(guestRecoveryRecords(store, scope)).toEqual({ jobsRaw, leaseRaw: null, legacyHireRaw });
    expect(store.getItem(guestJobStorageKey(scope))).toBe(jobsRaw);
    expect(store.getItem(`fez-hire-${guest}`)).toBe(legacyHireRaw);
  });

  it("fails closed on corrupted state and storage failure before a wallet operation can begin", () => {
    const store = memory();
    store.setItem(guestJobStorageKey(scope), "{broken");
    expect(() => createGuestJob(store, scope, request, terms)).toThrow(/state|record|storage/i);
    expect(store.getItem(guestJobStorageKey(scope))).toBe("{broken");
    const good = memory();
    createGuestJob(good, scope, request, terms);
    const unavailable = { getItem: good.getItem, setItem() { throw new Error("storage unavailable"); } };
    expect(() => beginGuestPayment(unavailable, scope, request.id, "pay", resultId)).toThrow(/storage/);
    expect(readGuestJobs(good, scope)[0]?.state).toBe("agreed");
  });
});

describe("prepaid guest priority leases", () => {
  const quote = { amount: "0.1", persona: "buyer", payerAddress, payTo: address, hours: 0.25, rateTaoHr: 0.4, offerId: "4".repeat(64) };
  const paidLease = { ...quote, renterPubkey: owner, miner: guest, network: "test", forEvent: request.id, txHash, receiptId, receiptPublished: true, paidHours: 0.245 };

  it("persists the quote before payment and advances priority only on a confirmed transaction plus receipt", () => {
    const store = memory();
    beginGuestLease(store, scope, request, quote, 1_000);
    expect(readGuestLease(store, scope)).toMatchObject({ state: "pending", requestId: request.id, amount: "0.1", payTo: address, offerId: "4".repeat(64), paidThrough: 0 });
    expect(() => beginGuestLease(store, scope, request, quote)).toThrow(/pending|state/i);
    finishGuestLease(store, scope, paidLease, 2_000);
    expect(readGuestLease(store, scope)).toMatchObject({ state: "confirmed", paidThrough: 884_000, txHash, receiptId });
    expect(JSON.parse(guestRecoveryRecords(store, scope).leaseRaw!)).toMatchObject({ requestId: request.id, paidThrough: 884_000, receiptId });
  });

  it("does not turn transfer-only or mismatched lease outcomes into priority or retryable credit", () => {
    const store = memory();
    beginGuestLease(store, scope, request, quote, 1_000);
    expect(() => finishGuestLease(store, scope, { ...paidLease, receiptPublished: false, receiptId: undefined }, 2_000)).toThrow(/outcome|receipt|confirm/i);
    expect(readGuestLease(store, scope)).toMatchObject({ state: "unknown", paidThrough: 0, txHash });
    expect(() => beginGuestLease(store, scope, request, quote)).toThrow(/unknown|state/i);
    const other = memory();
    beginGuestLease(other, scope, request, quote);
    markGuestLeaseUnknown(other, scope);
    expect(() => beginGuestLease(other, scope, request, quote)).toThrow(/unknown|state/i);
  });

  it("rejects changed lease quote or identity fields and retains prior confirmed priority when a later tick is unknown", () => {
    for (const changed of [{ payTo: arbiterAddress }, { payerAddress: arbiterAddress }, { renterPubkey: guest }, { renterPubkey: undefined }, { forEvent: resultId }, { amount: "0.2" }, { offerId: resultId }, { paidHours: 0.26 }, { network: "finney" }]) {
      const store = memory();
      beginGuestLease(store, scope, request, quote, 1_000);
      finishGuestLease(store, scope, paidLease, 2_000);
      beginGuestLease(store, scope, request, quote, 3_000);
      expect(() => finishGuestLease(store, scope, { ...paidLease, ...changed }, 4_000)).toThrow(/outcome|confirm/i);
      expect(readGuestLease(store, scope)).toMatchObject({ state: "unknown", paidThrough: 884_000 });
    }
  });
});
