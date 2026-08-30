// x402 pure logic: decode the PAYMENT-REQUIRED header, pin to a chain+asset,
// convert atomic USDC units to dollars, and track a daily spend tally.
// Dependency-free (node builtins only) — no network, no viem, no SDK.
// The SDK/signing layer arrives in Task 4; this is the substrate underneath it.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  let json: string;
  try {
    json = Buffer.from(headerB64, "base64").toString("utf-8");
  } catch {
    throw new Error("x402: PAYMENT-REQUIRED header is not valid base64");
  }
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
  let raw: bigint;
  try {
    raw = BigInt(offer.amount);
  } catch {
    throw new Error(`x402: offer amount "${offer.amount}" is not a valid integer`);
  }
  if (raw < 0n) throw new Error(`x402: offer amount "${offer.amount}" is negative`);
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
