// x402 pure logic: decode the PAYMENT-REQUIRED header, pin to a chain+asset,
// convert atomic USDC units to dollars, and track a daily spend tally.
// Dependency-free (node builtins only) — no network, no viem, no SDK.
//
// Task 4 adds the signing layer beside it: a restricted signer that will
// only produce EIP-3009 TransferWithAuthorization signatures for the pinned
// USDC contract, and payWith402 which builds the signed retry payload via
// Coinbase's official @x402/evm ExactEvmScheme (wire encoding via @x402/core —
// never hand-rolled while that SDK is live).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm";
import { encodePaymentSignatureHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, PaymentPayload, SettleResponse } from "@x402/core/types";

export interface X402Offer {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

export interface PaymentRequired {
  accepts: X402Offer[];
  resource?: { url?: string; description?: string };
}

export function decodePaymentRequired(headerB64: string): PaymentRequired {
  // Buffer.from(str, "base64") never throws on malformed input (best-effort
  // decode) — garbage base64 just decodes to garbage bytes, which then
  // fails at the JSON.parse stage below. That error is accurate; no
  // separate base64-stage catch to keep.
  const json = Buffer.from(headerB64, "base64").toString("utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("x402: PAYMENT-REQUIRED header did not decode to JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { accepts?: unknown }).accepts)) {
    throw new Error("x402: PAYMENT-REQUIRED payload is missing an `accepts` array");
  }
  return parsed as PaymentRequired;
}

export function pickOffer(
  offers: X402Offer[],
  opts: { network: string; usdcAddress: string },
): X402Offer | undefined {
  return offers.find(
    (o) =>
      o.scheme === "exact" &&
      o.network === opts.network &&
      o.asset.toLowerCase() === opts.usdcAddress.toLowerCase(),
  );
}

const MAX_SAFE_ATOMIC = 2 ** 53;

export function offerUsd(offer: X402Offer): number {
  // BigInt(str) also accepts hex ("0x2710") and treats "" as 0n — neither is
  // a valid x402 atomic-unit amount (the spec is a plain decimal string).
  // Reject anything but digits before BigInt ever sees it.
  if (!/^\d+$/.test(offer.amount)) {
    throw new Error(`x402: offer amount "${offer.amount}" is not a decimal integer string`);
  }
  const raw = BigInt(offer.amount);
  if (raw > BigInt(MAX_SAFE_ATOMIC)) throw new Error(`x402: offer amount "${offer.amount}" exceeds safe integer bounds`);
  return Number(raw) / 1e6;
}

interface DaySpend {
  day: string;
  usd: number;
}

const SPEND_FILE = "x402-spend.json";
const localDay = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, the owner's clock

function readDaySpend(dir: string): DaySpend {
  const file = path.join(dir, SPEND_FILE);
  const today = localDay();
  try {
    const saved = JSON.parse(readFileSync(file, "utf-8")) as Partial<DaySpend>;
    if (saved.day === today && Number(saved.usd) >= 0) return { day: today, usd: Number(saved.usd) };
  } catch {
    // ponytail: fail-open on a missing/corrupt tally file — the daily cap
    // is defense-in-depth above per-spend consent, so a corrupt file must
    // not brick payments. Upgrade path: only if we need audit-strength
    // tallies, not just a soft daily ceiling.
  }
  return { day: today, usd: 0 };
}

export function todaySpend(dir: string): number {
  return readDaySpend(dir).usd;
}

export function recordSpend(dir: string, usd: number): void {
  const current = readDaySpend(dir);
  current.usd += usd;
  writeFileSync(path.join(dir, SPEND_FILE), JSON.stringify(current));
}

/** The shape @x402/evm's ExactEvmScheme calls signTypedData with — matches
 *  @x402/evm's ClientEvmSigner contract without importing its (unexported
 *  from the package root) type. */
interface X402TypedData {
  domain?: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface RestrictedSigner {
  readonly address: `0x${string}`;
  signTypedData(typedData: X402TypedData): Promise<`0x${string}`>;
}

/** A viem account wrapper that signs ONLY EIP-3009 TransferWithAuthorization
 * for one pinned contract. This is the security boundary of the whole x402
 * feature: a malicious 402 server can hand the client any typed-data request
 * it likes (a Permit, an approval, a transfer to itself) — this signer
 * refuses everything except the exact payment primitive, for the exact
 * asset the wallet is configured to pay with. `sign`/`signMessage`/
 * `signTransaction` pass through unrestricted — the restriction covers only
 * `signTypedData` because that's the one member fez's own payment path
 * invokes; the 402 server never gets to choose which method is called. */
export function restrictedSigner(privateKeyHex: `0x${string}`, allowedContract: string): RestrictedSigner {
  const account = privateKeyToAccount(privateKeyHex);
  return {
    ...account,
    async signTypedData(typedData: X402TypedData) {
      if (typedData.primaryType !== "TransferWithAuthorization") {
        throw new Error(
          `x402 restricted signer: refused to sign "${typedData.primaryType}" typed data — only TransferWithAuthorization is permitted`,
        );
      }
      const contract = typedData.domain?.verifyingContract;
      if (typeof contract !== "string" || contract.toLowerCase() !== allowedContract.toLowerCase()) {
        throw new Error(
          `x402 restricted signer: refused to sign for contract "${String(contract)}" — only ${allowedContract} is permitted`,
        );
      }
      return account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]);
    },
  };
}

export interface PayWith402Opts {
  offer: X402Offer;
  privateKeyHex: `0x${string}`;
  usdcAddress: string;
}

/** Builds the signed exact-scheme payment for a HELD offer (never re-fetch
 * the offer between quoting and paying) and returns the retry header(s).
 * No fetch happens here — the paid retry itself is Task 5's job. */
export async function payWith402(opts: PayWith402Opts): Promise<{ paymentHeaders: Record<string, string> }> {
  const signer = restrictedSigner(opts.privateKeyHex, opts.usdcAddress);
  const requirements: PaymentRequirements = {
    scheme: opts.offer.scheme,
    network: opts.offer.network as `${string}:${string}`,
    asset: opts.offer.asset,
    amount: opts.offer.amount,
    payTo: opts.offer.payTo,
    maxTimeoutSeconds: opts.offer.maxTimeoutSeconds ?? 60,
    extra: opts.offer.extra ?? {},
  };
  const scheme = new ExactEvmScheme(signer);
  const result = await scheme.createPaymentPayload(2, requirements);
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: result.payload,
    ...(result.extensions ? { extensions: result.extensions } : {}),
  };
  return { paymentHeaders: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) } };
}

/** Thin wrap over @x402/core's settlement decoder — T5 reads the settled tx
 * hash off the paid retry's response through this. Accepts either a raw
 * headers record (Node lowercases incoming header names) or a Fetch-style
 * Headers-like object. */
export function parseSettlementHeader(
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null },
): SettleResponse | undefined {
  const raw =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get("PAYMENT-RESPONSE")
      : ((headers as Record<string, string | string[] | undefined>)["PAYMENT-RESPONSE"] ??
        (headers as Record<string, string | string[] | undefined>)["payment-response"]);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return decodePaymentResponseHeader(value);
}
