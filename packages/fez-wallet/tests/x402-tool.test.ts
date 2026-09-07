import { describe, it, expect, vi } from "vitest";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import {
  x402Fetch,
  resolveEvmPair,
  CONSENT_TIMEOUT_MS,
  type X402ToolDeps,
  type FetchLike,
} from "../src/tools.js";
import { deriveAgentEvm } from "../src/derive.js";
import { todaySpend, recordSpend, type X402Offer } from "../src/x402.js";
import { readX402Log } from "../src/log.js";
import type { ChainAdapter } from "../src/chains/adapter.js";
import type { ConsentRelay, SignedNostrEvent } from "../src/consent.js";
import type { WalletConfig } from "../src/config.js";
import { parseReceipt } from "../src/receipt.js";
import { tmpHome } from "./helpers.js";

const JUNK_MNEMONIC = "test test test test test test test test test test test junk";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK: `${string}:${string}` = "eip155:84532";
const PAY_TO = "0x2096000000000000000000000000000000000001";
const evmPair = deriveAgentEvm(JUNK_MNEMONIC, 0);

const ownerSk = generateSecretKey();
const ownerPk = getPublicKey(ownerSk);
const agentNostrKey = bytesToHex(generateSecretKey());

function offer(overrides: Partial<X402Offer> = {}): X402Offer {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "10000", // $0.01
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

type FakeResponse = Awaited<ReturnType<FetchLike>>;

function fakeResponse(status: number, opts: { headers?: Record<string, string>; body?: string } = {}): FakeResponse {
  const headers = opts.headers ?? {};
  return {
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => opts.body ?? "",
  };
}

// Hand-rolled, not the SDK encoder: decodePaymentRequired only needs valid
// base64 JSON with an `accepts` array (see x402-policy.test.ts), and
// X402Offer's plain `string` network type fights the SDK's
// PaymentRequirements' template-literal network type for no test value.
function paymentRequiredResponse(offers: X402Offer[]): FakeResponse {
  const header = Buffer.from(
    JSON.stringify({ x402Version: 2, resource: { url: "http://test.local/paid" }, accepts: offers }),
    "utf-8"
  ).toString("base64");
  return fakeResponse(402, { headers: { "PAYMENT-REQUIRED": header } });
}

function settledResponse(txHash = "0x" + "de".repeat(32)): FakeResponse {
  const header = encodePaymentResponseHeader({ success: true, transaction: txHash, network: NETWORK });
  return fakeResponse(200, { headers: { "PAYMENT-RESPONSE": header }, body: "thanks" });
}

function fakeAdapter(usdcRaw: bigint): ChainAdapter {
  return {
    chain: "eth",
    assets: [{ symbol: "USDC", decimals: 6 }],
    address: () => evmPair.addressHex,
    balance: async () => ({ raw: usdcRaw, decimals: 6, symbol: "USDC" }),
    transfer: async () => {
      throw new Error("not used by x402");
    },
  };
}

/** Same shape as tools.test.ts's autoRelay — a ConsentRelay whose publish
 * immediately (via microtask) fires back the owner's reaction. */
function autoRelay(decide: (req: SignedNostrEvent) => string | null) {
  let request: SignedNostrEvent | undefined;
  let handler: ((ev: SignedNostrEvent) => void) | undefined;
  const published: SignedNostrEvent[] = [];
  const relay: ConsentRelay = {
    publish: async (ev) => {
      published.push(ev);
      // The first publish is always the consent request; a successful
      // payment publishes a SECOND event (the receipt) afterwards, which
      // must not overwrite what getRequest() returns.
      if (!request) request = ev;
      queueMicrotask(() => {
        const content = decide(ev);
        if (content && handler) {
          handler({ id: "r", kind: 7, pubkey: ownerPk, content, tags: [["e", ev.id]], created_at: 0, sig: "00" });
        }
      });
    },
    subscribe: (_f, on) => {
      handler = on;
      return () => {};
    },
    query: async () => [],
  };
  return { relay, getRequest: () => request, published };
}

function baseConfig(overrides: Partial<WalletConfig> = {}): WalletConfig {
  return {
    thresholds: { default: "0.01" },
    personas: {},
    endpoints: { tao: "wss://unused" },
    network: "test",
    knownPayees: [],
    consentChannel: "chan1",
    ...overrides,
  };
}

function baseDeps(dir: string, overrides: Partial<X402ToolDeps> = {}): X402ToolDeps {
  return {
    persona: "scout",
    evmPair,
    adapter: fakeAdapter(10_000_000n), // $10 USDC — plenty for these tests
    config: baseConfig(),
    dir,
    now: () => "2026-08-30T00:00:00Z",
    ...overrides,
  };
}

describe("x402Fetch: non-402 passthrough", () => {
  it("passes a non-402 response through untouched — no spend, no consent, no writes", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => fakeResponse(200, { headers: { "content-type": "text/plain" }, body: "hello" });
    const out = await x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(out).toContain("HTTP 200");
    expect(out).toContain("hello");
    expect(todaySpend(dir)).toBe(0);
    expect(readX402Log(dir)).toHaveLength(0);
  });
});

describe("x402Fetch: maxUsd is required", () => {
  it("refuses without a maxUsd", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => fakeResponse(200);
    await expect(x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: undefined as unknown as number })).rejects.toThrow(
      /maxUsd/
    );
  });
});

describe("x402Fetch: policy refusals leave zero writes", () => {
  it("no matching offer -> refusal naming the offers seen", async () => {
    const dir = tmpHome();
    const wrong = offer({ network: "eip155:1" });
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([wrong]);
    const out = await x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(out).toContain("eip155:1");
    expect(todaySpend(dir)).toBe(0);
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("usd > maxUsd -> refusal naming both numbers", async () => {
    const dir = tmpHome();
    const pricey = offer({ amount: "5000000" }); // $5
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([pricey]);
    const out = await x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(out).toContain("$5.00");
    expect(out).toContain("$1.00");
    expect(todaySpend(dir)).toBe(0);
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("daily cap exceeded -> refusal naming the cap and today's total", async () => {
    const dir = tmpHome();
    recordSpend(dir, 24.5); // already spent
    const pricey = offer({ amount: "600000" }); // $0.60 — pushes the total past a $25 cap
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([pricey]);
    const out = await x402Fetch(baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { dailyCapUsd: 25 } }) }), {
      url: "http://x/",
      maxUsd: 1,
    });
    expect(out).toContain("$25.00"); // the cap
    expect(out).toContain("$24.50"); // today's total already spent
    expect(readX402Log(dir)).toHaveLength(0);
    expect(todaySpend(dir)).toBeCloseTo(24.5);
  });
});

describe("x402Fetch: consent", () => {
  it("default autoApproveUnderUsd (0) forces consent — text carries usd, payTo, and url", async () => {
    const dir = tmpHome();
    const { relay, getRequest } = autoRelay(() => "✅");
    const fetchImpl: FetchLike = async (_url, init) => {
      // 402 on the plain GET, settled 200 once payment headers show up.
      return init?.headers ? settledResponse() : paymentRequiredResponse([offer()]);
    };
    const out = await x402Fetch(
      baseDeps(dir, {
        fetchImpl,
        ownerPk,
        agentNostrKey,
        relay: () => Promise.resolve(relay),
      }),
      { url: "http://pay.example/thing", maxUsd: 1 }
    );
    const content = getRequest()?.content ?? "";
    expect(content).toContain("$0.01");
    expect(content).toContain(PAY_TO);
    expect(content).toContain("http://pay.example/thing");
    expect(out).toContain("paid $0.01 USDC");
  });

  it("declined -> nothing was paid, zero writes", async () => {
    const dir = tmpHome();
    const { relay } = autoRelay(() => "❌");
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([offer()]);
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, ownerPk, agentNostrKey, relay: () => Promise.resolve(relay) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toContain("nothing was paid");
    expect(todaySpend(dir)).toBe(0);
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("timeout -> nothing was paid, zero writes", async () => {
    vi.useFakeTimers();
    try {
      const dir = tmpHome();
      const silentRelay: ConsentRelay = {
        publish: async () => {},
        subscribe: () => () => {},
        query: async () => [],
      };
      const fetchImpl: FetchLike = async () => paymentRequiredResponse([offer()]);
      const promise = x402Fetch(
        baseDeps(dir, { fetchImpl, ownerPk, agentNostrKey, relay: () => Promise.resolve(silentRelay) }),
        { url: "http://x/", maxUsd: 1 }
      );
      await vi.advanceTimersByTimeAsync(CONSENT_TIMEOUT_MS + 1000);
      const out = await promise;
      expect(out).toContain("nothing was paid");
      expect(todaySpend(dir)).toBe(0);
      expect(readX402Log(dir)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abort landing between approval and signing blocks the payment (tools.ts:424-426)", async () => {
    const dir = tmpHome();
    const controller = new AbortController();
    let handler: ((ev: SignedNostrEvent) => void) | undefined;
    const relay: ConsentRelay = {
      publish: async (ev) => {
        queueMicrotask(() => {
          // The owner genuinely approves — verdict will be "approved" —
          // but the caller gives up in the very same tick, before
          // x402Fetch gets to sign anything.
          handler?.({ id: "r", kind: 7, pubkey: ownerPk, content: "✅", tags: [["e", ev.id]], created_at: 0, sig: "00" });
          controller.abort();
        });
      },
      subscribe: (_f, on) => {
        handler = on;
        return () => {};
      },
      query: async () => [],
    };
    let fetchCalls = 0;
    const fetchImpl: FetchLike = async () => {
      fetchCalls++;
      return paymentRequiredResponse([offer()]);
    };
    const out = await x402Fetch(
      baseDeps(dir, {
        fetchImpl,
        ownerPk,
        agentNostrKey,
        relay: () => Promise.resolve(relay),
        signal: controller.signal,
      }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toContain("nothing was paid");
    expect(fetchCalls).toBe(1); // only the original 402 request — no paid retry ever fires
    expect(todaySpend(dir)).toBe(0);
    expect(readX402Log(dir)).toHaveLength(0);
  });
});

describe("x402Fetch: daily cap float-precision boundary", () => {
  it("exactly at the cap passes; one cent over refuses", async () => {
    const dirAtCap = tmpHome();
    recordSpend(dirAtCap, 24.99);
    let calls = 0;
    const atCapFetch: FetchLike = async () => {
      calls++;
      return calls === 1 ? paymentRequiredResponse([offer({ amount: "10000" })]) : settledResponse(); // $0.01 -> exactly $25.00
    };
    const atCapOut = await x402Fetch(
      baseDeps(dirAtCap, { fetchImpl: atCapFetch, config: baseConfig({ x402: { dailyCapUsd: 25, autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(atCapOut).not.toContain("daily cap");

    const overCapDir = tmpHome();
    recordSpend(overCapDir, 24.99);
    const overCapFetch: FetchLike = async () => paymentRequiredResponse([offer({ amount: "20000" })]); // $0.02 -> $25.01
    const overCapOut = await x402Fetch(
      baseDeps(overCapDir, { fetchImpl: overCapFetch, config: baseConfig({ x402: { dailyCapUsd: 25 } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(overCapOut).toContain("daily cap");
    expect(readX402Log(overCapDir)).toHaveLength(0);
  });
});

describe("x402Fetch: record-before-retry (the invariant)", () => {
  it("the tally and the signed log entry land BEFORE the paid retry is dispatched", async () => {
    const dir = tmpHome();
    let sawSignedLogBeforePaidFetch = false;
    let sawTallyBeforePaidFetch = false;
    let calls = 0;
    const fetchImpl: FetchLike = async (_url, _init) => {
      calls++;
      if (calls === 1) return paymentRequiredResponse([offer()]);
      // This is the paid retry: the invariant says the write already happened.
      sawSignedLogBeforePaidFetch = readX402Log(dir, 5).some((e) => e.status === "signed");
      sawTallyBeforePaidFetch = todaySpend(dir) > 0;
      return settledResponse();
    };
    await x402Fetch(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(sawSignedLogBeforePaidFetch).toBe(true);
    expect(sawTallyBeforePaidFetch).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("x402Fetch: success", () => {
  it("settles, logs settled+txHash, and publishes a 47040 receipt", async () => {
    const dir = tmpHome();
    const txHash = "0x" + "ab".repeat(32);
    const { relay, published } = autoRelay(() => "✅");
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1 ? paymentRequiredResponse([offer()]) : settledResponse(txHash);
    };
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, ownerPk, agentNostrKey, relay: () => Promise.resolve(relay) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toContain(txHash);
    expect(out).toContain("paid $0.01 USDC");

    const rows = readX402Log(dir, 5);
    expect(rows[0]).toMatchObject({ status: "settled", txHash });

    const receipt = published.map(parseReceipt).find(Boolean);
    expect(receipt).toBeDefined();
    expect(receipt!.chain).toBe("base");
    expect(receipt!.txHash).toBe(txHash);
    expect(receipt!.raw).toBe(10000n);
    expect(receipt!.symbol).toBe("USDC");
    expect(receipt!.memo).toBe("http://x/");
  });
});

describe("x402Fetch: never pays twice", () => {
  it("paid retry answers 402 again -> ambiguous message, no second signature, one tally write", async () => {
    const dir = tmpHome();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return paymentRequiredResponse([offer()]); // 402 both times
    };
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toMatch(/may have settled/i);
    expect(out).toMatch(/not retrying|do not retry/i);
    expect(calls).toBe(2); // the original + exactly one paid retry — no loop
    expect(todaySpend(dir)).toBeCloseTo(0.01);
    const rows = readX402Log(dir, 5);
    expect(rows[0].status).toBe("ambiguous");
    expect(rows.filter((r) => r.status === "signed")).toHaveLength(1);
  });

  it("fetchImpl throws after the paid request is dispatched -> ambiguous, tally kept", async () => {
    const dir = tmpHome();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls === 1) return paymentRequiredResponse([offer()]);
      throw new Error("socket hang up");
    };
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toMatch(/may have settled/i);
    expect(out).toMatch(/do not retry/i);
    expect(todaySpend(dir)).toBeCloseTo(0.01); // fail-closed: kept, not reversed
    const rows = readX402Log(dir, 5);
    expect(rows[0].status).toBe("ambiguous");
  });
});

describe("x402Fetch: balance-first check", () => {
  it("insufficient balance -> refusal naming balance vs price, zero writes", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([offer({ amount: "5000000" })]); // $5
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, adapter: fakeAdapter(1_000_000n) /* $1 */ }),
      { url: "http://x/", maxUsd: 10 }
    );
    expect(out).toContain("$1.00");
    expect(out).toContain("$5.00");
    expect(readX402Log(dir)).toHaveLength(0);
    expect(todaySpend(dir)).toBe(0);
  });

  it("RPC failure on balance check does not block — noted, not fatal", async () => {
    const dir = tmpHome();
    const throwingAdapter: ChainAdapter = { ...fakeAdapter(0n), balance: async () => { throw new Error("rpc down"); } };
    const { relay } = autoRelay(() => "✅");
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1 ? paymentRequiredResponse([offer()]) : settledResponse();
    };
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, adapter: throwingAdapter, ownerPk, agentNostrKey, relay: () => Promise.resolve(relay) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toContain("balance unverified");
    expect(out).toContain("paid $0.01 USDC");
  });
});

describe("x402Fetch: signing refusal is unambiguous (I1)", () => {
  it("a permit2-routed offer (server-steerable via extra.assetTransferMethod) is refused — zero writes", async () => {
    const dir = tmpHome();
    // @x402/evm routes into PermitWitnessTransferFrom when the offer says
    // so — our restricted signer refuses that primaryType outright. The
    // bug this guards was recording the spend as if it happened anyway.
    const permit2Offer = offer({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } });
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([permit2Offer]);
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toContain("nothing was paid");
    expect(out).toMatch(/could not be signed/);
    expect(out).not.toMatch(/may have settled/i); // unambiguous — nothing left the process
    expect(todaySpend(dir)).toBe(0);
    expect(readX402Log(dir)).toHaveLength(0);
  });
});

describe("x402Fetch: nothing after settlement may throw (C1)", () => {
  it("200 + a malformed PAYMENT-RESPONSE header -> ambiguous, not settled, no receipt, never throws", async () => {
    const dir = tmpHome();
    const { relay, published } = autoRelay(() => "✅");
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls === 1) return paymentRequiredResponse([offer()]);
      // @x402/core's decoder throws on this — that's the point.
      return fakeResponse(200, { headers: { "PAYMENT-RESPONSE": "not-a-valid-header!!!" }, body: "ok" });
    };
    const out = await x402Fetch(
      baseDeps(dir, { fetchImpl, ownerPk, agentNostrKey, relay: () => Promise.resolve(relay) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toMatch(/may have settled/i);
    expect(out).toMatch(/do not retry/i);
    const rows = readX402Log(dir, 5);
    expect(rows[0].status).toBe("ambiguous");
    expect(rows.some((r) => r.status === "settled")).toBe(false);
    expect(published.map(parseReceipt).filter(Boolean)).toHaveLength(0);
  });
});

describe("x402Fetch: payTo must be a real EVM address (M1)", () => {
  it("refuses an offer whose payTo isn't a plain 20-byte hex address", async () => {
    const dir = tmpHome();
    const badOffer = offer({ payTo: "0x2096000000000000000000000000000000000001`\ninjected" });
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([badOffer]);
    const out = await x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(out).toContain("not a valid EVM address");
    expect(readX402Log(dir)).toHaveLength(0);
    expect(todaySpend(dir)).toBe(0);
  });
});

describe("x402Fetch: only http(s) URLs (M5)", () => {
  it("refuses a non-http(s) URL up front", async () => {
    const dir = tmpHome();
    await expect(
      x402Fetch(baseDeps(dir, { fetchImpl: async () => fakeResponse(200) }), {
        url: "file:///etc/passwd",
        maxUsd: 1,
      })
    ).rejects.toThrow(/http\(s\)/);
  });
});

describe("x402Fetch: concurrent calls cannot together exceed the cap (I2)", () => {
  it("two overlapping calls against one dir settle at most one of them once the cap is tight", async () => {
    const dir = tmpHome();
    const pricey = offer({ amount: "15000000" }); // $15 each; a $25 cap admits only one
    const config = baseConfig({ x402: { dailyCapUsd: 25, autoApproveUnderUsd: { default: 100 } } }); // skip consent entirely
    const makeFlow = (): FetchLike => {
      let calls = 0;
      return async () => {
        calls++;
        return calls === 1 ? paymentRequiredResponse([pricey]) : settledResponse();
      };
    };
    const plentyOfBalance = fakeAdapter(1_000_000_000n); // $1,000 — balance is not what's under test here
    const [outA, outB] = await Promise.all([
      x402Fetch(baseDeps(dir, { fetchImpl: makeFlow(), config, adapter: plentyOfBalance }), { url: "http://a/", maxUsd: 100 }),
      x402Fetch(baseDeps(dir, { fetchImpl: makeFlow(), config, adapter: plentyOfBalance }), { url: "http://b/", maxUsd: 100 }),
    ]);
    const outs = [outA, outB];
    expect(outs.filter((o) => o.includes("paid $15.00"))).toHaveLength(1);
    expect(outs.filter((o) => o.includes("daily cap"))).toHaveLength(1);
    // The real invariant: together, they never spent more than the cap —
    // an EARLY pre-check alone (before this fix) let both through.
    expect(todaySpend(dir)).toBeLessThanOrEqual(25);
  });
});

describe("resolveEvmPair: friendly error on a pre-EVM stored entry", () => {
  it("names the fix instead of echoing a generic parse error", () => {
    const preEvmStored = JSON.stringify({ publicKeyHex: "aa", secretKeyHex: "bb", address: "5X" });
    expect(() => resolveEvmPair("scout", preEvmStored)).toThrow(/re-run: fez-wallet derive scout/);
  });
});
