import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { recoverTypedDataAddress, getAddress } from "viem";
import { authorizationTypes } from "@x402/evm";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { deriveAgentEvm } from "../src/derive.js";
import { restrictedSigner, payWith402, parseSettlementHeader, decodePaymentRequired, pickOffer } from "../src/x402.js";

const JUNK_MNEMONIC = "test test test test test test test test test test test junk";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK: `${string}:${string}` = "eip155:84532";
const PAY_TO = "0x2096000000000000000000000000000000000001";

const OFFER = {
  scheme: "exact",
  network: NETWORK,
  amount: "10000",
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

describe("restrictedSigner", () => {
  const signer = restrictedSigner(deriveAgentEvm(JUNK_MNEMONIC, 0).privateKeyHex, USDC);
  const validDomain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC };
  const validMessage = {
    from: signer.address,
    to: PAY_TO,
    value: 1n,
    validAfter: 0n,
    validBefore: 9999999999n,
    nonce: `0x${"11".repeat(32)}`,
  };

  it("refuses to sign a Permit — names the refused primaryType", async () => {
    await expect(
      signer.signTypedData({
        domain: validDomain,
        types: { Permit: [] },
        primaryType: "Permit",
        message: validMessage,
      }),
    ).rejects.toThrow(/Permit/);
  });

  it("refuses a TransferWithAuthorization for the wrong contract — names the refused contract", async () => {
    const wrongContract = "0x000000000000000000000000000000deadbeef";
    await expect(
      signer.signTypedData({
        domain: { ...validDomain, verifyingContract: wrongContract },
        types: authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: validMessage,
      }),
    ).rejects.toThrow(new RegExp(wrongContract));
  });

  it("signs a valid TransferWithAuthorization for the allowed contract", async () => {
    const sig = await signer.signTypedData({
      domain: validDomain,
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: validMessage,
    });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  // The tests above call the signer directly — they'd stay green even if a
  // future SDK refactor stopped routing through signTypedData entirely. This
  // one goes through the real payWith402 -> ExactEvmScheme path so the
  // restriction is pinned end-to-end, not just at the unit boundary.
  it("payWith402 (real SDK path) refuses a mismatched-asset offer, naming the offer's contract", async () => {
    const derived = deriveAgentEvm(JUNK_MNEMONIC, 0);
    const wrongContract = "0x000000000000000000000000000000deadbeef";
    const wrongAssetOffer = { ...OFFER, asset: wrongContract };
    await expect(
      payWith402({ offer: wrongAssetOffer, privateKeyHex: derived.privateKeyHex, usdcAddress: USDC }),
    ).rejects.toThrow(new RegExp(wrongContract, "i"));
  });
});

describe("x402 SDK round-trip (in-test HTTP, zero chain access)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("client pays a 402, server cryptographically verifies the signer and terms, then settles", async () => {
    const derived = deriveAgentEvm(JUNK_MNEMONIC, 0);
    let serverSaw: { recovered: string; value: string; to: string; validBefore: number } | undefined;

    server = createServer((req, res) => {
      void (async () => {
        const sigHeader = req.headers["payment-signature"];
        if (!sigHeader) {
          const header = encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: "http://test.local/paid" },
            accepts: [OFFER],
          });
          res.writeHead(402, { "PAYMENT-REQUIRED": header });
          res.end();
          return;
        }
        const paymentPayload = decodePaymentSignatureHeader(
          Array.isArray(sigHeader) ? sigHeader[0] : sigHeader,
        ) as unknown as {
          accepted: typeof OFFER;
          payload: { authorization: Record<string, string>; signature: `0x${string}` };
        };
        const auth = paymentPayload.payload.authorization;
        const domain = {
          name: paymentPayload.accepted.extra.name,
          version: paymentPayload.accepted.extra.version,
          chainId: parseInt(paymentPayload.accepted.network.split(":")[1], 10),
          verifyingContract: getAddress(paymentPayload.accepted.asset),
        };
        const message = {
          from: getAddress(auth.from),
          to: getAddress(auth.to),
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce as `0x${string}`,
        };
        const recovered = await recoverTypedDataAddress({
          domain,
          types: authorizationTypes,
          primaryType: "TransferWithAuthorization",
          message,
          signature: paymentPayload.payload.signature,
        });
        serverSaw = {
          recovered,
          value: auth.value,
          to: getAddress(auth.to),
          validBefore: Number(auth.validBefore),
        };
        if (recovered.toLowerCase() !== derived.addressHex.toLowerCase()) {
          res.writeHead(401);
          res.end();
          return;
        }
        const settleHeader = encodePaymentResponseHeader({
          success: true,
          transaction: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
          network: NETWORK,
        });
        res.writeHead(200, { "PAYMENT-RESPONSE": settleHeader });
        res.end("paid");
      })();
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/`;

    const first = await fetch(url);
    expect(first.status).toBe(402);
    const paymentRequiredHeader = first.headers.get("PAYMENT-REQUIRED");
    expect(paymentRequiredHeader).toBeTruthy();
    const decoded = decodePaymentRequired(paymentRequiredHeader!);
    const offer = pickOffer(decoded.accepts, { network: NETWORK, usdcAddress: USDC });
    expect(offer).toBeDefined();

    const { paymentHeaders } = await payWith402({
      offer: offer!,
      privateKeyHex: derived.privateKeyHex,
      usdcAddress: USDC,
    });
    expect(paymentHeaders["PAYMENT-SIGNATURE"]).toBeTruthy();

    const second = await fetch(url, { headers: paymentHeaders });
    expect(second.status).toBe(200);

    const settlement = parseSettlementHeader(second.headers);
    expect(settlement?.success).toBe(true);

    expect(serverSaw?.recovered.toLowerCase()).toBe(derived.addressHex.toLowerCase());
    expect(serverSaw?.value).toBe("10000");
    expect(serverSaw?.to).toBe(getAddress(PAY_TO));
    expect(serverSaw?.validBefore).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
