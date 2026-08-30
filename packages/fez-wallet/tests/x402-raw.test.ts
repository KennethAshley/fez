import { describe, it, expect } from "vitest";
import { encodePaymentResponseHeader } from "@x402/core/http";
import {
  x402Fetch,
  x402FetchRaw,
  type X402ToolDeps,
  type FetchLike,
  type X402Outcome,
} from "../src/tools.js";
import { deriveAgentEvm } from "../src/derive.js";
import { type X402Offer } from "../src/x402.js";
import { readX402Log } from "../src/log.js";
import type { ChainAdapter } from "../src/chains/adapter.js";
import type { WalletConfig } from "../src/config.js";
import { tmpHome } from "./helpers.js";

// Fixtures mirrored from x402-tool.test.ts (not exported there) — same
// shapes, so x402FetchRaw's scenarios line up exactly with the existing
// x402Fetch coverage.
const JUNK_MNEMONIC = "test test test test test test test test test test test junk";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK: `${string}:${string}` = "eip155:84532";
const PAY_TO = "0x2096000000000000000000000000000000000001";
const evmPair = deriveAgentEvm(JUNK_MNEMONIC, 0);

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

function paymentRequiredResponse(offers: X402Offer[]): FakeResponse {
  const header = Buffer.from(
    JSON.stringify({ x402Version: 2, resource: { url: "http://test.local/paid" }, accepts: offers }),
    "utf-8"
  ).toString("base64");
  return fakeResponse(402, { headers: { "PAYMENT-REQUIRED": header } });
}

function settledResponse(opts: { txHash?: string; headerName?: string; body?: string } = {}): FakeResponse {
  const txHash = opts.txHash ?? "0x" + "de".repeat(32);
  const header = encodePaymentResponseHeader({ success: true, transaction: txHash, network: NETWORK });
  return fakeResponse(200, { headers: { [opts.headerName ?? "PAYMENT-RESPONSE"]: header }, body: opts.body ?? "thanks" });
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

describe("x402FetchRaw: response (non-402 passthrough)", () => {
  it("returns kind response with the full body untruncated, and x402Fetch formats it identically to before", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => fakeResponse(200, { headers: { "content-type": "text/plain" }, body: "hello" });
    const outcome = await x402FetchRaw(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(outcome).toEqual<X402Outcome>({ kind: "response", status: 200, contentType: "text/plain", bodyText: "hello" });

    const out = await x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(out).toBe("HTTP 200 (text/plain)\nhello");
  });
});

describe("x402FetchRaw: refused (no matching offer)", () => {
  it("returns kind refused with the exact policy message, zero writes", async () => {
    const dir = tmpHome();
    const wrong = offer({ network: "eip155:1" });
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([wrong]);
    const outcome = await x402FetchRaw(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(outcome.kind).toBe("refused");
    expect((outcome as { message: string }).message).toContain("eip155:1");
    expect(readX402Log(dir)).toHaveLength(0);

    const out = await x402Fetch(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(out).toBe((outcome as { message: string }).message);
  });
});

describe("x402FetchRaw: paid", () => {
  it("returns kind paid with usd/txHash/payTo, and x402Fetch's string matches the pre-refactor format exactly", async () => {
    const dir = tmpHome();
    const txHash = "0x" + "ab".repeat(32);
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1 ? paymentRequiredResponse([offer()]) : settledResponse({ txHash, body: "thanks" });
    };
    const outcome = await x402FetchRaw(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(outcome).toMatchObject({ kind: "paid", status: 200, txHash, usd: 0.01, payTo: PAY_TO, bodyText: "thanks" });

    // Fresh dir + fresh fetchImpl: the tally/log are per-call state, so run
    // the identical flow again through the string tool and compare.
    const dir2 = tmpHome();
    let calls2 = 0;
    const fetchImpl2: FetchLike = async () => {
      calls2++;
      return calls2 === 1 ? paymentRequiredResponse([offer()]) : settledResponse({ txHash, body: "thanks" });
    };
    const out = await x402Fetch(
      baseDeps(dir2, { fetchImpl: fetchImpl2, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(out).toBe(`HTTP 200 (unknown)\nthanks\npaid $0.01 USDC → ${PAY_TO}, tx ${txHash}`);
  });
});

describe("x402FetchRaw: ambiguous (second 402)", () => {
  it("returns kind ambiguous with usd and the wallet's do-not-retry wording, one tally write", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([offer()]); // 402 both times
    const outcome = await x402FetchRaw(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(outcome.kind).toBe("ambiguous");
    const ambiguous = outcome as Extract<X402Outcome, { kind: "ambiguous" }>;
    expect(ambiguous.usd).toBeCloseTo(0.01);
    expect(ambiguous.message).toMatch(/may have settled/i);
    expect(ambiguous.message).toMatch(/not retrying|do not retry/i);

    const rows = readX402Log(dir, 5);
    expect(rows[0].status).toBe("ambiguous");
  });
});

describe("x402FetchRaw: settlement-header tolerance (v1 name)", () => {
  it("a server answering with X-PAYMENT-RESPONSE (the v1 header name Ridges documents) still settles", async () => {
    const dir = tmpHome();
    const txHash = "0x" + "cd".repeat(32);
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1
        ? paymentRequiredResponse([offer()])
        : settledResponse({ txHash, headerName: "X-PAYMENT-RESPONSE", body: '{"issue_id":"r-1"}' });
    };
    const outcome = await x402FetchRaw(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(outcome.kind).toBe("paid");
    const paid = outcome as Extract<X402Outcome, { kind: "paid" }>;
    expect(paid.txHash).toBe(txHash);
    expect(paid.bodyText).toBe('{"issue_id":"r-1"}');

    const rows = readX402Log(dir, 5);
    expect(rows[0]).toMatchObject({ status: "settled", txHash });
  });
});
