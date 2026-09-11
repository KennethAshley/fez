import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { endpointFor } from "../../fez-wallet/src/networks.js";
import { escrowApprove, escrowOpen, requireRehearsalNetwork } from "../../fez-wallet/src/stake.js";
import { marketPublish, offerFromAnnounces, payAddress, rentAgent, rentalIdentity } from "../../fez-wallet/src/rent.js";

const state = vi.hoisted(() => ({ network: "test", endpoint: "", payer: "", events: [] as unknown[], transfers: [] as { to: string; amount: bigint }[], rejectReceipt: false }));
vi.mock("../../fez-wallet/src/store.js", () => ({ readEntry: () => "fixture", readAgentNostrKey: () => "11".repeat(32) }));
vi.mock("../../fez-wallet/src/derive.js", () => ({ pairFromStored: () => ({ address: state.payer, publicKeyHex: "11".repeat(32), secretKeyHex: "22".repeat(64) }) }));
vi.mock("../../fez-wallet/src/config.js", () => ({ loadConfig: () => ({ network: state.network, endpoints: { tao: state.endpoint } }) }));
vi.mock("../../fez-wallet/src/fees.js", () => ({ splitFee: (amount: bigint) => ({ netRao: amount, feeRao: 0n }) }));
vi.mock("../../fez-wallet/src/chains/substrate.js", async original => ({
  ...await original<typeof import("../../fez-wallet/src/chains/substrate.js")>(), signerFromPair: async () => ({}),
  submitAndWait: async () => ({ txHash: "0x" + "ab".repeat(32), blockRef: "0x" + "cd".repeat(32) }),
}));
vi.mock("../../fez-wallet/src/chains/subtensor.js", async original => ({
  ...await original<typeof import("../../fez-wallet/src/chains/subtensor.js")>(),
  connectSubtensor: async () => ({ query: { system: { account: async () => ({ data: { free: { toBigInt: () => 100_000_000_000n } } }) } },
    tx: { balances: { transferKeepAlive: (to: string, amount: bigint) => { state.transfers.push({ to, amount }); return {}; } } } }),
}));
vi.mock("../../fez-wallet/node_modules/ws/wrapper.mjs", () => ({ default: class {
  onopen?: () => void; onmessage?: (event: { data: string }) => void; onerror?: () => void;
  constructor(_url: string) { queueMicrotask(() => this.onopen?.()); }
  close() {}
  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg[0] === "REQ") {
      this.onmessage?.({ data: JSON.stringify(["EVENT", "other-subscription", state.events[0]]) });
      for (const event of state.events) this.onmessage?.({ data: JSON.stringify(["EVENT", msg[1], event]) });
      this.onmessage?.({ data: JSON.stringify(["EOSE", msg[1]]) });
    } else if (msg[0] === "EVENT") {
      this.onmessage?.({ data: JSON.stringify(["OK", "wrong-id", true]) });
      this.onmessage?.({ data: JSON.stringify(["OK", msg[1].id, !state.rejectReceipt, "fixture receipt rejected"]) });
    }
  }
} }));
const key = new Uint8Array(32).fill(7), miner = getPublicKey(key);
const payer = "5FHoTj4Kryo9PdFcg8KPrm48ER1fxvN4LhtfLCxhQ36Qtkqr", payTo = "5HH8BQaYnLH5pKL3o7amtRFExD2zWXXvnrCDkoFGhZfhPLt7", arbiter = "5CAq7cJ8aWf4HCoNGjQDRWH82SXXq1Zb5qiMy4QieyYhpD1q";
const now = 2_000_000_000;
function announce(content: unknown = { rate: { tao_hr: 0.1, pay_to: payTo } }, created_at = now, secret = key) {
  return JSON.parse(JSON.stringify(finalizeEvent({ kind: 47000, created_at, tags: [], content: typeof content === "string" ? content : JSON.stringify(content) }, secret)));
}
beforeEach(() => {
  vi.stubEnv("FEZ_EVALUATION_ACTIVE", "0"); vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  state.network = "test"; state.endpoint = endpointFor("test"); state.payer = payer; state.events = [announce()]; state.transfers = []; state.rejectReceipt = false;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("guest wallet payment boundaries", () => {
  it("reads the payer identity without a chain request, including during evaluation", () => {
    vi.stubEnv("FEZ_EVALUATION_ACTIVE", "1");
    expect(rentalIdentity("scout")).toEqual({ persona: "scout", payerAddress: payer, renterPubkey: getPublicKey(new Uint8Array(32).fill(17)) });
    expect(state.transfers).toEqual([]);
  });
  it("refuses a custom endpoint even with a test network label", () => {
    expect(() => requireRehearsalNetwork("test", "wss://mainnet.example")).toThrow(/testnet/);
    expect(() => requireRehearsalNetwork("test", endpointFor("test"))).not.toThrow();
  });
  it("rejects forged and wrong-author offers without constructing a transfer", async () => {
    const forged = announce(); forged.content = JSON.stringify({ rate: { tao_hr: 0.1, pay_to: arbiter } });
    state.events = [forged, announce(undefined, now, new Uint8Array(32).fill(8))];
    await expect(rentAgent("scout", miner, 1, "wss://fixture.invalid")).rejects.toThrow(/offer|rent|announce/); expect(state.transfers).toEqual([]);
  });
  it.each(["{broken", { rate: { tao_hr: "0.1", pay_to: payTo } }, { rate: { tao_hr: 0.1, pay_to: payTo.slice(0, -1) + "1" } }, { answered: 2 }])("never uses an older offer behind malformed/withdrawn latest %j", content => {
    expect(() => offerFromAnnounces([announce(undefined, now - 1), announce(content)], miner, now)).toThrow(/offer|rent|announce|address/);
  });
  it.each([now - 901, now + 61])("refuses stale/future signed offers at %s", created => {
    expect(() => offerFromAnnounces([announce(undefined, created)], miner, now)).toThrow(/stale|future|fresh|offer|rent/);
  });
  it.each([{ expectedQuote: { payTo: arbiter, rateTaoHr: 0.1 } }, { expectedQuote: { payTo, rateTaoHr: 0.2 } }, { expectedQuote: { payTo, rateTaoHr: 0.1, offerId: "a".repeat(64) } }, { expectedPayer: arbiter }, { expectedRenter: "f".repeat(64) }, { maxAmount: "0.09" }])("binds payment to consent %j", async opts => {
    await expect(rentAgent("scout", miner, 1, "wss://fixture.invalid", opts)).rejects.toThrow(/changed|quote|payer|maximum|amount/); expect(state.transfers).toEqual([]);
  });
  it("returns confirmed payment when publishing its receipt fails", async () => {
    state.rejectReceipt = true;
    const result = await rentAgent("scout", miner, 1, "wss://fixture.invalid");
    expect(result).toMatchObject({ txHash: "0x" + "ab".repeat(32), amount: "0.1", payerAddress: payer, payTo, network: "test", receiptPublished: false });
    expect(result.receiptError).toContain("rejected"); expect(state.transfers).toEqual([{ to: payTo, amount: 100_000_000n }]);
  });
  it("ignores ACKs for another event", async () => { state.rejectReceipt = true; await expect(marketPublish("wss://fixture.invalid", announce())).rejects.toThrow(/rejected/); });
  it("refuses a rotated payer for settlement and escrow", async () => {
    await expect(payAddress("scout", payTo, "0.1", { expectedPayer: arbiter })).rejects.toThrow(/payer/);
    await expect(escrowOpen("scout", payTo, arbiter, "0.1", { expectedPayer: arbiter })).rejects.toThrow(/payer/);
    await expect(escrowApprove("scout", payer, payTo, arbiter, "0.1", "worker", { expectedPayer: arbiter })).rejects.toThrow(/payer/); expect(state.transfers).toEqual([]);
  });
  it("refuses zero escrow and repeated parties before transfer", async () => {
    await expect(escrowOpen("scout", payTo, arbiter, "0")).rejects.toThrow(/greater than zero/);
    await expect(escrowOpen("scout", payer, arbiter, "0.1")).rejects.toThrow(/distinct/); expect(state.transfers).toEqual([]);
  });
});
