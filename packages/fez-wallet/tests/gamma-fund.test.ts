import { describe, it, expect } from "vitest";
import type { SubtensorApi } from "../src/chains/subtensor.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fundGamma, fundingJson } from "../src/gamma-fund.js";
import { walletGammaTopup } from "../src/tools.js";
import { gammaFundConfirm } from "../src/gui-logic.js";
import type { GammaServiceReport } from "../src/gamma-services.js";

const TREASURY = { publicKeyHex: "aa".repeat(32), secretKeyHex: "bb".repeat(64), address: "5Treasury" };
const AGENT = { publicKeyHex: "cc".repeat(32), secretKeyHex: "dd".repeat(64), address: "5Agent" };
const service = (over: Partial<GammaServiceReport> = {}): GammaServiceReport => ({
  netuid: 75, hotkey: "5Hippius", url: "https://h.example/s.json", name: "Hippius", specUrls: [], routes: [], checks: [], ready: true, ...over,
});

/** A chain that quotes, mints into a deposit and lets the hotkey spend it.
 * Shapes measured on finney, 26 Nov 2026: `simMintGamma` answers
 * `{ ok: [alpha, taoValue, gamma] }` or `{ err }`; `getGammaDeposit` answers
 * `{ deposit: { balance }, spendable }` or null. */
function chain(opts: { freeRao?: bigint; gammaPerTao?: number; quoteError?: boolean; deposit?: bigint; failSpend?: boolean } = {}) {
  const state = { deposit: opts.deposit ?? 0n, calls: [] as { call: string; signer: string; args: unknown[] }[] };
  const quote = (rao: bigint) => BigInt(Math.round(Number(rao) * (opts.gammaPerTao ?? 180)));
  const tx = (call: string, args: unknown[], apply: () => void, fail = false) => ({
    signAndSend: async (signer: { address: string }, cb: (r: unknown) => void) => {
      state.calls.push({ call, signer: signer.address, args });
      if (fail) cb({ status: { isInBlock: false }, dispatchError: { isModule: false, toString: () => "ServiceDoesNotExist" }, txHash: { toHex: () => "0x0" } });
      else { apply(); cb({ status: { isInBlock: true, asInBlock: { toHex: () => "0xblock" } }, txHash: { toHex: () => `0x${call}` } }); }
      return () => {};
    },
  });
  const api = {
    registry: { findMetaError: () => ({ section: "subtensorModule", name: "GammaDisabled", docs: ["Gamma minting is disabled network-wide or on this subnet."] }) },
    query: { system: { account: async () => ({ data: { free: { toBigInt: () => opts.freeRao ?? 5_000_000_000n } } }) } },
    tx: { subtensorModule: {
      mintGamma: (hotkey: string, netuid: number, amount: bigint, minOut: bigint, cap: null) => tx("mint", [hotkey, netuid, amount, minOut, cap], () => { state.deposit += quote(amount); }),
      spendGamma: (svc: string, netuid: number, amount: bigint) => tx("spend", [svc, netuid, amount], () => { state.deposit -= amount; }, opts.failSpend),
    } },
    call: { gammaRuntimeApi: {
      simMintGamma: async (_netuid: number, amount: bigint) => ({ toJSON: () => (opts.quoteError ? { err: { module: { index: 7, error: "0xc0000000" } } } : { ok: [1, Number(amount), Number(quote(amount))] }) }),
      getGammaDeposit: async () => ({ toJSON: () => (state.deposit > 0n ? { deposit: { coldkey: TREASURY.address, balance: Number(state.deposit), dailySpendCap: null }, spendable: Number(state.deposit) } : null) }),
    } },
  } as unknown as SubtensorApi;
  return { api, state };
}
// Tests sign with the stored pair itself; the real signer is built from it.
const signer = async (pair: { address: string }) => pair;
const fund = (c: ReturnType<typeof chain>, args: Partial<Parameters<typeof fundGamma>[1]> = {}, services = [service()]) =>
  fundGamma({ api: c.api, payer: TREASURY, agent: AGENT, services, signer }, { netuid: 75, taoRao: 10_000_000n, confirm: true, ...args });

describe("fundGamma", () => {
  it("without --confirm it only quotes: what the TAO would buy and where it would go", async () => {
    const c = chain();
    expect(await fund(c, { confirm: false })).toMatchObject({ sent: false, service: { netuid: 75, name: "Hippius", hotkey: "5Hippius" }, quotedGamma: 1_800_000_000n });
    expect(c.state.calls).toEqual([]);
  });

  it("mints from the treasury to the agent's address, then the agent's own key spends it all at the service", async () => {
    const c = chain();
    const done = await fund(c);
    expect(done).toMatchObject({ sent: true, spentGamma: 1_800_000_000n, mintTx: "0xmint", spendTx: "0xspend" });
    expect(c.state.calls).toEqual([
      // minAmountOut is the quote less 3%: a worse price than that fails instead of filling.
      { call: "mint", signer: "5Treasury", args: ["5Agent", 75, 10_000_000n, 1_746_000_000n, null] },
      { call: "spend", signer: "5Agent", args: ["5Hippius", 75, 1_800_000_000n] },
    ]);
    expect(c.state.deposit).toBe(0n);
  });

  it("refuses a subnet with no ready service, and a subnet with several unless one is named", async () => {
    const c = chain();
    await expect(fund(c, {}, [service({ ready: false })])).rejects.toThrow(/no ready gamma service on subnet 75/i);
    const two = [service(), service({ hotkey: "5Other", name: "Other" })];
    await expect(fund(c, {}, two)).rejects.toThrow(/--service/);
    expect((await fund(c, { service: "5Other" }, two)).service.name).toBe("Other");
    await expect(fund(c, { service: "5Nobody" }, two)).rejects.toThrow(/no ready gamma service/i);
    expect(c.state.calls.filter((x) => x.call === "mint").length).toBe(1);
  });

  it("refuses before sending when the treasury cannot cover it or the chain will not mint", async () => {
    const poor = chain({ freeRao: 1_000n });
    await expect(fund(poor)).rejects.toThrow(/5Treasury has .* TAO free/i);
    const off = chain({ quoteError: true });
    await expect(fund(off)).rejects.toThrow(/GammaDisabled/);
    expect([...poor.state.calls, ...off.state.calls]).toEqual([]);
  });

  it("says where the gamma is when the mint landed and the spend did not, and an amount of 0 finishes the job", async () => {
    const broken = chain({ failSpend: true });
    await expect(fund(broken)).rejects.toThrow(/minted.* sits in a deposit at 5Agent .* gamma fund .* 0/s);
    const waiting = chain({ deposit: 1_800_000_000n });
    const done = await fund(waiting, { taoRao: 0n });
    expect(done).toMatchObject({ sent: true, spentGamma: 1_800_000_000n });
    expect(waiting.state.calls.map((x) => x.call)).toEqual(["spend"]);
    await expect(fund(chain(), { taoRao: 0n })).rejects.toThrow(/no gamma deposit/i);
  });
});

// The wallet panel cannot hold keys, so it runs the command and reads this.
describe("what the wallet panel reads and shows", () => {
  it("a quote and a finished funding both cross as plain JSON, amounts in dollars", async () => {
    expect(fundingJson(await fund(chain(), { confirm: false }))).toEqual({ sent: false, netuid: 75, service: "Hippius", hotkey: "5Hippius", quotedUsd: "1.8" });
    expect(JSON.parse(JSON.stringify(fundingJson(await fund(chain()))))).toEqual({ sent: true, netuid: 75, service: "Hippius", hotkey: "5Hippius", quotedUsd: "1.8", spentUsd: "1.8", mintTx: "0xmint", spendTx: "0xspend" });
  });

  it("the confirmation names the agent, the money, the service, and that it cannot be undone", () => {
    const asked = gammaFundConfirm("scout", "0.01", { sent: false, netuid: 75, service: "Hippius", hotkey: "5Hippius", quotedUsd: "1.837608667" }, "finney");
    expect(asked.title).toBe("Fund @scout with about $1.84 at Hippius?");
    expect(asked.body).toMatch(/0\.01 TAO from the treasury/);
    expect(asked.body).toMatch(/subnet 75/);
    expect(asked.body).toMatch(/cannot be refunded/i);
    expect(gammaFundConfirm("scout", "0.01", { sent: false, netuid: 482, service: "SayGM", hotkey: "5S", quotedUsd: "2" }, "test").body).toMatch(/testnet/i);
  });
});

// The agent's own side: it holds TAO its owner gave it, and turns some of it
// into credit at one service, inside the owner's daily dollar limit.
describe("wallet_gamma_topup", () => {
  const topup = (c: ReturnType<typeof chain>, dir: string, over: { usd?: number; dailyLimitUsd?: number; netuid?: number; services?: GammaServiceReport[] } = {}) =>
    walletGammaTopup(
      { pair: AGENT, api: c.api, persona: "drift", dir, dailyLimitUsd: "dailyLimitUsd" in over ? over.dailyLimitUsd : 5, services: over.services ?? [service()], signer },
      { netuid: over.netuid ?? 75, usd: over.usd ?? 1 });
  const home = () => mkdtempSync(join(tmpdir(), "gamma-topup-"));

  it("the agent's own key mints from its own TAO and deposits it at the service, never more dollars than asked", async () => {
    const c = chain();
    const said = await topup(c, home());
    // $1 at 180 gamma per TAO is 5,555,555 rao, rounded down so the quote cannot exceed the ask.
    expect(c.state.calls.map((x) => [x.call, x.signer, x.args[0]])).toEqual([["mint", "5Agent", "5Agent"], ["spend", "5Agent", "5Hippius"]]);
    expect(c.state.calls[0].args[2]).toBe(5_555_555n);
    expect(said).toMatch(/^Topped up \$0\.9999999 at SN75 Hippius/);
    expect(said).toMatch(/\$0\.9999999 of your \$5 daily limit/);
  });

  it("does nothing until the owner has set a daily limit", async () => {
    const c = chain();
    for (const dailyLimitUsd of [undefined, 0, Number.NaN]) expect(await topup(c, home(), { dailyLimitUsd })).toMatch(/no daily gamma limit/i);
    expect(c.state.calls).toEqual([]);
  });

  it("refuses, before sending, a top-up that would pass today's limit, and says what room is left", async () => {
    const c = chain(), dir = home();
    await topup(c, dir, { usd: 4 });
    expect(await topup(c, dir, { usd: 2 })).toMatch(/would pass your daily limit of \$5.*\$1\.00000004 left today/i);
    expect(c.state.calls.filter((x) => x.call === "mint").length).toBe(1);
    expect(await topup(c, dir, { usd: 1 })).toMatch(/^Topped up/);
    // Another agent has its own day.
    expect(await walletGammaTopup({ pair: AGENT, api: c.api, persona: "scout", dir, dailyLimitUsd: 5, services: [service()], signer }, { netuid: 75, usd: 4 })).toMatch(/^Topped up/);
  });

  it("refuses amounts that are not money, and subnets with no ready service", async () => {
    const c = chain();
    for (const usd of [0, -1, Number.NaN]) expect(await topup(c, home(), { usd })).toMatch(/amount in dollars/i);
    expect(await topup(c, home(), { netuid: 9 })).toMatch(/no ready gamma service on subnet 9/i);
    expect(c.state.calls).toEqual([]);
  });

  it("tells an agent short of TAO to ask its owner, and counts nothing", async () => {
    const c = chain({ freeRao: 1_000n }), dir = home();
    expect(await topup(c, dir)).toMatch(/has .* TAO free.*ask your owner/is);
    expect(await topup(chain(), dir, { usd: 5 })).toMatch(/^Topped up/);
  });

  it("still counts the dollars when the mint landed and the deposit at the service did not", async () => {
    const c = chain({ failSpend: true }), dir = home();
    expect(await topup(c, dir, { usd: 4 })).toMatch(/sits in a deposit/i);
    expect(await topup(chain(), dir, { usd: 2 })).toMatch(/would pass your daily limit/i);
  });
});
