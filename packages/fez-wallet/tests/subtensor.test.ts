import { describe, expect, it } from "vitest";
import { formatRao, stakedAlpha, uidFor, type SubtensorApi } from "../src/chains/subtensor.js";

describe("formatRao", () => {
  it("renders 9-decimal base units as decimal text", () => {
    expect(formatRao(0n)).toBe("0");
    expect(formatRao(500000n)).toBe("0.0005");
    expect(formatRao(5_000_000_000n)).toBe("5");
    expect(formatRao(1_234_500_000_0n)).toBe("12.3450000".replace(/0+$/, "")); // 12.345
  });
});

describe("uidFor", () => {
  const apiWith = (uid: number | undefined) =>
    ({
      query: {
        subtensorModule: {
          uids: async () => (uid === undefined
            ? { isSome: false, unwrap: () => { throw new Error("none"); } }
            : { isSome: true, unwrap: () => ({ toNumber: () => uid }) }),
        },
      },
    }) as unknown as SubtensorApi;

  it("returns the uid when registered, undefined when not", async () => {
    expect(await uidFor(apiWith(7), 553, "hot")).toBe(7);
    expect(await uidFor(apiWith(undefined), 553, "hot")).toBeUndefined();
  });
});

describe("stakedAlpha", () => {
  const apiWith = (info: unknown, throws = false) =>
    ({
      call: {
        stakeInfoRuntimeApi: {
          getStakeInfoForHotkeyColdkeyNetuid: async () => {
            if (throws) throw new Error("no such runtime api");
            return { toJSON: () => info };
          },
        },
      },
    }) as unknown as SubtensorApi;

  it("reads the stake field, numeric or stringy", async () => {
    expect(await stakedAlpha(apiWith({ stake: 5_000_000_000 }), 553, "h", "c")).toBe(5_000_000_000n);
    expect(await stakedAlpha(apiWith({ stake: "123" }), 553, "h", "c")).toBe(123n);
  });

  it("answers unknown — never zero — when the chain won't say", async () => {
    expect(await stakedAlpha(apiWith(null), 553, "h", "c")).toBeUndefined();
    expect(await stakedAlpha(apiWith({ nope: 1 }), 553, "h", "c")).toBeUndefined();
    expect(await stakedAlpha(apiWith(undefined, true), 553, "h", "c")).toBeUndefined();
  });
});

describe("transferStake shape", () => {
  it("submits destination, hotkey, same netuid twice, and the amount", async () => {
    const calls: unknown[] = [];
    const api = {
      registry: { findMetaError: () => ({ section: "", name: "", docs: [] }) },
      tx: {
        subtensorModule: {
          transferStake: (...args: unknown[]) => {
            calls.push(args);
            return {
              signAndSend: async (_s: unknown, cb: (r: never) => void) => {
                cb({ status: { isInBlock: true, asInBlock: { toHex: () => "0xb" } }, txHash: { toHex: () => "0xt" } } as never);
                return () => {};
              },
            };
          },
        },
      },
    } as never;
    const { transferStake } = await import("../src/chains/subtensor.js");
    const pair = {
      publicKeyHex: "22".repeat(32),
      secretKeyHex: "11".repeat(64),
      address: "5Treasury",
    };
    const r = await transferStake(api, pair as never, {
      destinationColdkey: "5Agent",
      hotkey: "5AgentHot",
      netuid: 553,
      amountRao: 42n,
    });
    expect(r.txHash).toBe("0xt");
    expect(calls[0]).toEqual(["5Agent", "5AgentHot", 553, 553, 42n]);
  });
});

describe("offerFromAnnounces — the standing offer", () => {
  it("takes the freshest announce's rate, and its silence as not-for-rent", async () => {
    const { offerFromAnnounces } = await import("../src/rent.js");
    const offer = offerFromAnnounces([
      { created_at: 100, content: JSON.stringify({ rate: { tao_hr: 0.2, pay_to: "5Old" } }) },
      { created_at: 200, content: JSON.stringify({ rate: { tao_hr: 0.1, pay_to: "5New" } }) },
    ]);
    expect(offer).toEqual({ taoHr: 0.1, payTo: "5New" });
    // freshest beat dropped the rate → the agent is not for rent NOW
    expect(() =>
      offerFromAnnounces([
        { created_at: 300, content: JSON.stringify({ answered: 5 }) },
        { created_at: 100, content: JSON.stringify({ rate: { tao_hr: 0.2, pay_to: "5Old" } }) },
      ])
    ).toThrow(/not for rent/);
    expect(() => offerFromAnnounces([])).toThrow(/not for rent/);
  });
});

describe("escrowAddress — deterministic 2-of-3 derivation", () => {
  it("is order-independent and stable (same three keys → same escrow)", async () => {
    const { escrowAddress } = await import("../src/chains/escrow.js");
    const a = "5FHoTj4Kryo9PdFcg8KPrm48ER1fxvN4LhtfLCxhQ36Qtkqr";
    const b = "5HH8BQaYnLH5pKL3o7amtRFExD2zWXXvnrCDkoFGhZfhPLt7";
    const c = "5CAq7cJ8aWf4HCoNGjQDRWH82SXXq1Zb5qiMy4QieyYhpD1q";
    // proven live 2026-09-03: this trio derives this escrow
    expect(escrowAddress(a, b, c)).toBe("5CoFuLj18cUGWVZsH94S132iijs2Gyk4GyBdachSG1WGMXKs");
    // participant order must not change the address — release re-derives it
    expect(escrowAddress(c, a, b)).toBe(escrowAddress(a, b, c));
    expect(escrowAddress(b, c, a)).toBe(escrowAddress(a, b, c));
  });
});
