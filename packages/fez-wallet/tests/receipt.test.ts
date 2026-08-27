import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { buildReceipt, parseReceipt, verifyReceipt, KIND_PAYMENT_RECEIPT } from "../src/receipt.js";

const sk = bytesToHex(generateSecretKey());
const payee = getPublicKey(generateSecretKey());
const amount = { raw: 50_000_000n, decimals: 9, symbol: "TAO" };

function receipt(over: Partial<Parameters<typeof buildReceipt>[0]> = {}) {
  return buildReceipt({
    agentSecretHex: sk,
    forEvent: "msg1",
    payeePubkey: payee,
    channelId: "chan1",
    amount,
    chain: "tao",
    network: "test",
    txHash: "0xtx",
    blockRef: "0xblock",
    ...over,
  });
}

describe("payment receipt", () => {
  it("binds the payment to the message it paid for", () => {
    const ev = receipt();
    expect(ev.kind).toBe(KIND_PAYMENT_RECEIPT);
    expect(ev.tags).toContainEqual(["e", "msg1"]);
    expect(ev.tags).toContainEqual(["p", payee]);
    expect(ev.tags).toContainEqual(["h", "chan1"]);
  });

  it("carries the amount as an integer string, never a decimal", () => {
    expect(receipt().tags).toContainEqual(["amount", "50000000"]);
  });

  it("round-trips through parse", () => {
    const p = parseReceipt(receipt())!;
    expect(p.forEvent).toBe("msg1");
    expect(p.raw).toBe(50_000_000n);
    expect(p.network).toBe("test");
    expect(p.txHash).toBe("0xtx");
    expect(p.blockRef).toBe("0xblock");
  });

  it("verifies against the chain", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5Payer", to: "5Payee", raw: 50_000_000n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("verified");
  });

  it("calls a tampered amount false", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5Payer", to: "5Payee", raw: 1n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("false");
  });

  it("calls a payment to a different address false", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5Payer", to: "5Someone", raw: 50_000_000n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("false");
  });

  it("calls a payment made by a different payer false, even when to/raw match", async () => {
    const p = parseReceipt(receipt())!;
    const lookup = async () => ({ from: "5SomeoneElse", to: "5Payee", raw: 50_000_000n });
    expect(await verifyReceipt(p, lookup, { from: "5Payer", to: "5Payee" })).toBe("false");
  });

  it("calls a pruned block unverifiable, NOT false", async () => {
    const p = parseReceipt(receipt())!;
    expect(await verifyReceipt(p, async () => undefined, { from: "5Payer", to: "5Payee" })).toBe(
      "unverifiable"
    );
  });

  it("calls a receipt with no block unverifiable", async () => {
    const p = parseReceipt(receipt({ blockRef: undefined }))!;
    expect(await verifyReceipt(p, async () => undefined, { from: "5Payer", to: "5Payee" })).toBe(
      "unverifiable"
    );
  });
});
