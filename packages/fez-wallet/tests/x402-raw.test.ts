import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { recoverTypedDataAddress, getAddress } from "viem";
import { authorizationTypes } from "@x402/evm";
import {
  encodePaymentResponseHeader,
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  x402Fetch,
  x402FetchRaw,
  type X402ToolDeps,
  type FetchLike,
  type X402Outcome,
} from "../src/tools.js";
import { deriveAgentEvm } from "../src/derive.js";
import { payWith402, parseSettlementHeader, resolveX402Version, type X402Offer } from "../src/x402.js";
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

function paymentRequiredResponse(offers: X402Offer[], opts: { x402Version?: unknown } = {}): FakeResponse {
  const header = Buffer.from(
    JSON.stringify({ x402Version: opts.x402Version ?? 2, resource: { url: "http://test.local/paid" }, accepts: offers }),
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

// Round 2: version negotiation. A v1 PAYMENT-REQUIRED offer routes
// payWith402 through @x402/evm's OWN v1 scheme (ExactEvmSchemeV1) and the
// SDK's version-aware header naming (x402HTTPClient.encodePaymentSignatureHeader)
// — X-PAYMENT for v1, same restricted signer as v2.
const OFFER_V1 = {
  scheme: "exact",
  network: "base-sepolia", // v1's own network label, not v2's CAIP "eip155:84532"
  maxAmountRequired: "10000", // $0.01, v1's name for v2's `amount`
  resource: "http://test.local/paid",
  description: "test resource",
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

describe("payWith402: x402Version routing (v1 vs v2)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("a v1 offer's paid retry arrives under X-PAYMENT (not PAYMENT-SIGNATURE), and the server verifies the signer", async () => {
    const derived = deriveAgentEvm(JUNK_MNEMONIC, 0);
    let sawHeaderName: string | undefined;
    let sawPaymentSignatureHeader = false;
    let serverVerified = false;

    server = createServer((req, res) => {
      void (async () => {
        const v1Header = req.headers["x-payment"];
        sawPaymentSignatureHeader = sawPaymentSignatureHeader || Boolean(req.headers["payment-signature"]);
        if (!v1Header) {
          const header = encodePaymentRequiredHeader({
            x402Version: 1,
            accepts: [OFFER_V1],
          } as never);
          res.writeHead(402, { "PAYMENT-REQUIRED": header });
          res.end();
          return;
        }
        sawHeaderName = "x-payment";
        const decoded = decodePaymentSignatureHeader(
          Array.isArray(v1Header) ? v1Header[0] : v1Header,
        ) as unknown as { payload: { authorization: Record<string, string>; signature: `0x${string}` } };
        const auth = decoded.payload.authorization;
        const recovered = await recoverTypedDataAddress({
          domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC) },
          types: authorizationTypes,
          primaryType: "TransferWithAuthorization",
          message: {
            from: getAddress(auth.from),
            to: getAddress(auth.to),
            value: BigInt(auth.value),
            validAfter: BigInt(auth.validAfter),
            validBefore: BigInt(auth.validBefore),
            nonce: auth.nonce as `0x${string}`,
          },
          signature: decoded.payload.signature,
        });
        serverVerified = recovered.toLowerCase() === derived.addressHex.toLowerCase();
        const settleHeader = encodePaymentResponseHeader({
          success: true,
          transaction: "0x" + "ee".repeat(32),
          network: "eip155:84532",
        });
        res.writeHead(200, { "X-PAYMENT-RESPONSE": settleHeader });
        res.end("paid");
      })();
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/`;

    const first = await fetch(url);
    expect(first.status).toBe(402);
    const decodedRequired = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf-8"));
    expect(decodedRequired.x402Version).toBe(1);

    const { paymentHeaders } = await payWith402({
      offer: OFFER_V1,
      privateKeyHex: derived.privateKeyHex,
      usdcAddress: USDC,
      x402Version: decodedRequired.x402Version,
    });
    expect(paymentHeaders["X-PAYMENT"]).toBeTruthy();
    expect(paymentHeaders["PAYMENT-SIGNATURE"]).toBeUndefined();

    const second = await fetch(url, { headers: paymentHeaders });
    expect(second.status).toBe(200);
    expect(sawHeaderName).toBe("x-payment");
    expect(sawPaymentSignatureHeader).toBe(false);
    expect(serverVerified).toBe(true);

    const settlement = parseSettlementHeader(second.headers);
    expect(settlement?.success).toBe(true);
  });

  it("the v1 path refuses a mismatched-asset offer through the real payWith402 route, naming the offer's contract", async () => {
    const derived = deriveAgentEvm(JUNK_MNEMONIC, 0);
    const wrongContract = "0x000000000000000000000000000000deadbeef";
    const wrongAssetOffer = { ...OFFER_V1, asset: wrongContract };
    await expect(
      payWith402({ offer: wrongAssetOffer, privateKeyHex: derived.privateKeyHex, usdcAddress: USDC, x402Version: 1 }),
    ).rejects.toThrow(new RegExp(wrongContract, "i"));
  });

  it("a v2 offer (absent/2 x402Version) still emits PAYMENT-SIGNATURE — no regression on the name", async () => {
    const derived = deriveAgentEvm(JUNK_MNEMONIC, 0);
    const v2Offer = offer();
    const { paymentHeaders } = await payWith402({
      offer: v2Offer,
      privateKeyHex: derived.privateKeyHex,
      usdcAddress: USDC,
      x402Version: 2,
    });
    expect(paymentHeaders["PAYMENT-SIGNATURE"]).toBeTruthy();
    expect(paymentHeaders["X-PAYMENT"]).toBeUndefined();
  });
});

// Round 3: the version gate refuses unsupported/garbled signals instead of
// guessing, and offer selection is gated by that SAME normalized version
// (a cross-format offer — right label, wrong declared version — must not
// be picked at all).
describe("resolveX402Version: refuse, don't guess", () => {
  it("absent is the documented v2 default", () => {
    expect(resolveX402Version(undefined)).toBe(2);
  });

  it("exactly 1 and exactly 2 pass through unchanged", () => {
    expect(resolveX402Version(1)).toBe(1);
    expect(resolveX402Version(2)).toBe(2);
  });

  it("an unsupported version number is refused, naming it", () => {
    expect(() => resolveX402Version(3)).toThrow(/3/);
  });

  it("a string version is refused — money is never coerced", () => {
    expect(() => resolveX402Version("1")).toThrow(/1/);
  });

  it("null is refused, not treated as absent", () => {
    expect(() => resolveX402Version(null)).toThrow(/null/);
  });
});

describe("x402FetchRaw: the version gate refuses before any offer selection or signing", () => {
  it("x402Version 3 -> refused, names the version, zero writes", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([offer()], { x402Version: 3 });
    const outcome = await x402FetchRaw(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(outcome.kind).toBe("refused");
    expect((outcome as Extract<X402Outcome, { kind: "refused" }>).message).toContain("3");
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("x402Version as the string \"1\" is refused — no coercion on money, zero writes", async () => {
    const dir = tmpHome();
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([offer()], { x402Version: "1" });
    const outcome = await x402FetchRaw(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(outcome.kind).toBe("refused");
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("absent x402Version still pays via v2 — no regression", async () => {
    const dir = tmpHome();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      // No x402Version override -> paymentRequiredResponse's default (2).
      return calls === 1
        ? paymentRequiredResponse([offer()])
        : settledResponse();
    };
    const outcome = await x402FetchRaw(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(outcome.kind).toBe("paid");
  });
});

describe("pickOffer via x402FetchRaw: offer selection is gated by the offer's own declared version", () => {
  it("a v1-declared offer wearing a v2 CAIP network string does not match (cross-format refused)", async () => {
    const dir = tmpHome();
    const crossFormatOffer = offer({ network: NETWORK }); // "eip155:84532" — v2's CAIP shape
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([crossFormatOffer], { x402Version: 1 });
    const outcome = await x402FetchRaw(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(outcome.kind).toBe("refused");
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("a v2-declared offer wearing a bare v1 network label does not match (cross-format refused)", async () => {
    const dir = tmpHome();
    const crossFormatOffer = offer({ network: "base-sepolia" }); // v1's own label, not a CAIP string
    const fetchImpl: FetchLike = async () => paymentRequiredResponse([crossFormatOffer], { x402Version: 2 });
    const outcome = await x402FetchRaw(baseDeps(dir, { fetchImpl }), { url: "http://x/", maxUsd: 1 });
    expect(outcome.kind).toBe("refused");
    expect(readX402Log(dir)).toHaveLength(0);
  });

  it("happy path unchanged: a v2-declared offer with the CAIP network still matches and pays", async () => {
    const dir = tmpHome();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1 ? paymentRequiredResponse([offer()], { x402Version: 2 }) : settledResponse();
    };
    const outcome = await x402FetchRaw(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(outcome.kind).toBe("paid");
  });

  it("happy path unchanged: a v1-declared offer with its own network label still matches and pays", async () => {
    const dir = tmpHome();
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1
        ? paymentRequiredResponse([OFFER_V1], { x402Version: 1 })
        : settledResponse({ headerName: "X-PAYMENT-RESPONSE" });
    };
    const outcome = await x402FetchRaw(
      baseDeps(dir, { fetchImpl, config: baseConfig({ x402: { autoApproveUnderUsd: { default: 1 } } }) }),
      { url: "http://x/", maxUsd: 1 }
    );
    expect(outcome.kind).toBe("paid");
  });
});
