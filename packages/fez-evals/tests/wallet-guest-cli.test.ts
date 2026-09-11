import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  rent: vi.fn(async () => ({ persona: "scout", miner: "a".repeat(64), hours: 1, amount: "0.1", txHash: "0xtx", receiptPublished: false })),
  identity: vi.fn(() => ({ persona: "scout", payerAddress: "5Payer", renterPubkey: "d".repeat(64) })),
  pay: vi.fn(async () => ({ persona: "scout", to: "5Worker", amount: "0.1", txHash: "0xtx" })),
  open: vi.fn(async () => ({ escrow: "5Escrow", txHash: "0xtx" })),
  approve: vi.fn(async () => ({ escrow: "5Escrow", txHash: "0xtx", executed: false })),
}));
vi.mock("../../fez-wallet/src/rent.js", () => ({ rentAgent: calls.rent, payAddress: calls.pay, rentalIdentity: calls.identity }));
vi.mock("../../fez-wallet/src/stake.js", async original => ({
  ...await original<typeof import("../../fez-wallet/src/stake.js")>(), escrowOpen: calls.open, escrowApprove: calls.approve,
}));
const originalArgv = process.argv;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.spyOn(process, "exit").mockImplementation(() => undefined as never); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); });
async function run(args: string[]) { process.argv = ["node", "fez-wallet", ...args]; await import("../../fez-wallet/src/cli.js"); }

describe("guest payment CLI preserves reviewed terms", () => {
  it("refuses a safety flag on a command that cannot enforce it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(["pay", "5Worker", "0.1", "--as", "scout", "--expect-rate", "0.1", "--json"]);
    expect(calls.pay).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
  it("exposes only public identity through the existing capabilities command", async () => {
    await run(["capabilities", "--as", "scout", "--json"]);
    expect(calls.identity).toHaveBeenCalledWith("scout");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"renterPubkey":"' + "d".repeat(64) + '"'));
    expect(calls.rent).not.toHaveBeenCalled();
  });
  it("passes lease quote, payer, request and relay without changing them", async () => {
    await run(["rent", "a".repeat(64), "1", "--as", "scout", "--expect-pay-to", "5Worker", "--expect-rate", "0.1", "--expect-offer", "b".repeat(64), "--expect-payer", "5Payer", "--expect-renter", "d".repeat(64), "--max-amount", "0.1", "--for", "c".repeat(64), "--market", "wss://fixture.invalid", "--json"]);
    expect(calls.rent).toHaveBeenCalledWith("scout", "a".repeat(64), 1, "wss://fixture.invalid", { expectedQuote: { payTo: "5Worker", rateTaoHr: 0.1, offerId: "b".repeat(64) }, expectedPayer: "5Payer", expectedRenter: "d".repeat(64), maxAmount: "0.1", forEvent: "c".repeat(64) });
    expect(process.exit).toHaveBeenCalledWith(0);
  });
  it("passes settlement payer and market to the wallet guard", async () => {
    await run(["pay", "5Worker", "0.1", "--as", "scout", "--expect-payer", "5Payer", "--market", "wss://fixture.invalid", "--json"]);
    expect(calls.pay).toHaveBeenCalledWith("scout", "5Worker", "0.1", expect.objectContaining({ expectedPayer: "5Payer", relayUrl: "wss://fixture.invalid" }));
  });
  it("binds escrow funding to the reviewed payer", async () => {
    await run(["escrow", "open", "5Worker", "5Arbiter", "0.1", "--as", "scout", "--expect-payer", "5Payer", "--json"]);
    expect(calls.open).toHaveBeenCalledWith("scout", "5Worker", "5Arbiter", "0.1", { expectedPayer: "5Payer" });
  });
  it("binds escrow approval to the reviewed signer", async () => {
    await run(["escrow", "release", "5Payer", "5Worker", "5Arbiter", "0.1", "--as", "arbiter", "--expect-payer", "5Arbiter", "--json"]);
    expect(calls.approve).toHaveBeenCalledWith("arbiter", "5Payer", "5Worker", "5Arbiter", "0.1", "worker", { expectedPayer: "5Arbiter" });
  });
});
