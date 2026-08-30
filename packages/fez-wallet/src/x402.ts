// x402 pure logic: decode the PAYMENT-REQUIRED header, pin to a chain+asset,
// convert atomic USDC units to dollars, and track a daily spend tally.
// Dependency-free (node builtins only) — no network, no viem, no SDK.
//
// Task 4 adds the signing layer beside it: a restricted signer that will
// only produce EIP-3009 TransferWithAuthorization signatures for the pinned
// USDC contract, and payWith402 which builds the signed retry payload via
// Coinbase's official @x402/evm ExactEvmScheme (wire encoding via @x402/core —
// never hand-rolled while that SDK is live).

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/client";
import { x402HTTPClient, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, PaymentPayload, SettleResponse } from "@x402/core/types";

export interface X402Offer {
  scheme: string;
  network: string;
  // v2 names this `amount`; v1 names the identical atomic-unit string
  // `maxAmountRequired` (and v1 offers carry `resource`/`description` as
  // plain strings, not v2's structured `resource` object). Both optional
  // here because only one of the two amount fields is ever actually
  // present on a real offer — offerUsd/payWith402 read whichever exists.
  amount?: string;
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  // `name`/`version` are the two fields this wallet's own signing path
  // reads directly; the index signature lets a real 402 offer carry
  // whatever else the exact-scheme spec allows through untyped (e.g.
  // `assetTransferMethod: "permit2"`, which @x402/evm's client reads to
  // pick a signing primitive — restrictedSigner is what actually gates
  // that choice, not this type).
  extra?: { name?: string; version?: string; [key: string]: unknown };
}

export interface PaymentRequired {
  // The negotiation signal: which x402 version this offer set speaks.
  // Absent (or 2) is v2, the wallet's long-standing default; 1 is what
  // Ridges documents. Selects payWith402's wire shape AND its header name
  // — see payWith402 below.
  x402Version?: number;
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

/** Normalizes an x402Version signal to exactly `1` or `2` — never guesses.
 * Absent/undefined is the documented v2 default (the wallet's long-standing
 * behavior, unchanged); exactly the number `1` or `2` pass through as-is;
 * anything else — a future v3, a string `"1"` (money is never coerced), a
 * NaN, `null` — is refused BY NAME rather than silently routed into
 * either scheme's signer/header logic. Called once at the top of the
 * pipeline (x402FetchRaw, before offer selection) and again inside
 * payWith402 itself as defense-in-depth for any other caller. */
export function resolveX402Version(v: unknown): 1 | 2 {
  if (v === undefined) return 2;
  if (v === 1 || v === 2) return v;
  throw new Error(`x402: unsupported x402Version "${String(v)}" — only 1 and 2 are supported`);
}

export function pickOffer(
  offers: X402Offer[],
  // Matching is gated by the ALREADY-NORMALIZED version (see
  // resolveX402Version) — and only THAT version's own network format is
  // tried: v2 offers must use the CAIP-2 `network` ("eip155:84532"); v1
  // offers must use the wallet's human network label (`v1Network`, e.g.
  // "base-sepolia" — @x402/evm's EVM_NETWORK_CHAIN_ID_MAP names). A
  // cross-format offer (a v1-declared offer wearing a CAIP string, or a
  // v2-declared offer wearing a bare label) simply doesn't match either
  // arm — it falls through to the ordinary no-matching-offer refusal
  // rather than being accepted into an inconsistent signing domain.
  // `version` defaults to `2` when omitted — the same "absent is v2"
  // rule resolveX402Version applies, and what every pre-v1 caller
  // (predating x402Version-awareness entirely) still gets unchanged.
  opts: { network: string; usdcAddress: string; v1Network?: string; version?: 1 | 2 },
): X402Offer | undefined {
  const version = opts.version ?? 2;
  return offers.find(
    (o) =>
      o.scheme === "exact" &&
      (version === 1 ? o.network === opts.v1Network : o.network === opts.network) &&
      o.asset.toLowerCase() === opts.usdcAddress.toLowerCase(),
  );
}

const MAX_SAFE_ATOMIC = 2 ** 53;

export function offerUsd(offer: X402Offer): number {
  const amount = offer.amount ?? offer.maxAmountRequired;
  // BigInt(str) also accepts hex ("0x2710") and treats "" as 0n — neither is
  // a valid x402 atomic-unit amount (the spec is a plain decimal string).
  // Reject anything but digits before BigInt ever sees it.
  if (!amount || !/^\d+$/.test(amount)) {
    throw new Error(`x402: offer amount "${amount}" is not a decimal integer string`);
  }
  const raw = BigInt(amount);
  if (raw > BigInt(MAX_SAFE_ATOMIC)) throw new Error(`x402: offer amount "${amount}" exceeds safe integer bounds`);
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

/**
 * Reads, checks against `capUsd`, and writes in one synchronous call —
 * no `await` anywhere in this function. That matters more than the
 * tmp+rename below: two "overlapping" x402Fetch calls are only ever
 * concurrent at their `await` points (JS run-to-completion), so as long
 * as the cap is enforced HERE (right before the paid request is
 * dispatched) rather than by an earlier pre-check separated from the
 * write by a network round-trip or a 10-minute consent wait, the second
 * caller to reach this line always sees the first caller's already-
 * written total. Throws WITHOUT writing when `cur.usd + usd > capUsd`.
 *
 * ponytail: tmp-file + rename protects a READER from ever seeing a
 * torn/partial write (e.g. a crash mid-write, or another process reading
 * at the wrong instant) — it does NOT make check-then-write atomic
 * across separate OS processes (two independent `fez-wallet` MCP
 * processes for the same persona could still race each other here).
 * Today's deployment is one process per persona, so in-process
 * synchronity is the actual guarantee; upgrade to a real file lock
 * (e.g. proper-lockfile) only if multiple processes ever share one dir.
 */
export function recordSpend(dir: string, usd: number, capUsd?: number): number {
  const current = readDaySpend(dir);
  const next = current.usd + usd;
  if (capUsd !== undefined && next > capUsd) {
    throw new Error(`x402: daily cap $${capUsd.toFixed(2)} would be exceeded (spent $${current.usd.toFixed(2)} today)`);
  }
  current.usd = next;
  const file = path.join(dir, SPEND_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current));
  renameSync(tmp, file);
  return current.usd;
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
  /** From the decoded PAYMENT-REQUIRED's own `x402Version` (see
   * `PaymentRequired`) — absent or 2 is the long-standing v2 path,
   * byte-identical to before this field existed. 1 routes to the SDK's
   * dedicated v1 scheme/header machinery below. */
  x402Version?: number;
}

/** Builds the signed exact-scheme payment for a HELD offer (never re-fetch
 * the offer between quoting and paying) and returns the retry header(s).
 * No fetch happens here — the paid retry itself is Task 5's job.
 *
 * Version-routed: v2 (default) is the original path, unchanged. v1 uses
 * @x402/evm's OWN v1 scheme class (`ExactEvmSchemeV1`) to build the flat
 * `{x402Version:1, scheme, network, payload}` wire shape v1 uses instead
 * of v2's `{accepted, payload}` — through the SAME `restrictedSigner`,
 * because `ExactEvmSchemeV1.signAuthorization` (a private method) calls
 * `signer.signTypedData({ domain: { verifyingContract: asset, ... },
 * primaryType: "TransferWithAuthorization", ... })`, the exact same
 * member/primaryType/domain shape v2 invokes — restrictedSigner's guard
 * needs no change to hold on this path too. Verified by reading
 * @x402/evm's `exact/v1/client/scheme.ts` (bundled at
 * `node_modules/@x402/evm/dist/cjs/exact/v1/client/index.js`) directly;
 * not asserted from the type signature alone. */
export async function payWith402(opts: PayWith402Opts): Promise<{ paymentHeaders: Record<string, string> }> {
  // Defense-in-depth: x402FetchRaw already normalizes before this is ever
  // called, but payWith402 is a real SDK-signing boundary in its own
  // right (tests, and any future caller, invoke it directly) — it must
  // refuse a garbage version itself rather than trust the caller.
  const version = resolveX402Version(opts.x402Version);
  const signer = restrictedSigner(opts.privateKeyHex, opts.usdcAddress);
  // I3: a server-controlled maxTimeoutSeconds otherwise becomes the
  // lifetime of a bearer authorization we hand over — an offer naming
  // 315360000 (10 years) would get a decade-long signed blank cheque.
  // Clamped to 10 minutes; `|| 60` also neutralizes non-numeric junk
  // (NaN is falsy), which previously passed straight through unclamped.
  const maxTimeoutSeconds = Math.min(Number(opts.offer.maxTimeoutSeconds) || 60, 600);

  let paymentPayload: PaymentPayload;
  if (version === 1) {
    // @x402/core's PUBLIC `PaymentRequirements`/`PaymentPayload` types are
    // the v2 shapes only (v1's are separately named `PaymentRequirementsV1`/
    // `PaymentPayloadV1` — a real gap in the SDK's own .d.ts, not something
    // this wallet should paper over by inventing v1 typings of its own).
    // `ExactEvmSchemeV1.createPaymentPayload`'s runtime body reads exactly
    // these v1 fields (verified in its source, see the doc comment above)
    // regardless of what its .d.ts happens to declare — the `unknown`
    // round-trip below crosses that one typing gap, nothing else.
    const requirements = {
      scheme: opts.offer.scheme,
      network: opts.offer.network,
      maxAmountRequired: opts.offer.maxAmountRequired ?? opts.offer.amount,
      resource: opts.offer.resource ?? "",
      description: opts.offer.description ?? "",
      payTo: opts.offer.payTo,
      maxTimeoutSeconds,
      asset: opts.offer.asset,
      extra: opts.offer.extra ?? {},
    } as unknown as PaymentRequirements;
    paymentPayload = (await new ExactEvmSchemeV1(signer).createPaymentPayload(1, requirements)) as unknown as PaymentPayload;
  } else {
    const requirements: PaymentRequirements = {
      scheme: opts.offer.scheme,
      network: opts.offer.network as `${string}:${string}`,
      asset: opts.offer.asset,
      amount: opts.offer.amount ?? opts.offer.maxAmountRequired ?? "",
      payTo: opts.offer.payTo,
      maxTimeoutSeconds,
      extra: opts.offer.extra ?? {},
    };
    const result = await new ExactEvmScheme(signer).createPaymentPayload(2, requirements);
    paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: result.payload,
      ...(result.extensions ? { extensions: result.extensions } : {}),
    };
  }

  // Version-aware header NAMING lives in the SDK, not here:
  // x402HTTPClient.encodePaymentSignatureHeader picks "PAYMENT-SIGNATURE"
  // for v2 and "X-PAYMENT" for v1 purely from paymentPayload.x402Version
  // (@x402/core/dist/cjs/http/index.js:1596-1610) — no hand-picked header
  // string on either path. The x402Client constructor argument is stored
  // but never read by this method, so a throwaway one is safe: nothing
  // else is ever called on this instance.
  const http = new x402HTTPClient(undefined as never);
  return { paymentHeaders: http.encodePaymentSignatureHeader(paymentPayload) };
}

/** Thin wrap over @x402/core's settlement decoder — T5 reads the settled tx
 * hash off the paid retry's response through this. Accepts either a raw
 * headers record (Node lowercases incoming header names) or a Fetch-style
 * Headers-like object.
 *
 * Tries both the x402 v2 header name (`PAYMENT-RESPONSE`) and the v1 name
 * (`X-PAYMENT-RESPONSE`, what Ridges documents) — a resource server can
 * answer with either depending on which x402Version its facilitator
 * speaks, and this wallet pays against a HELD offer's own scheme/version
 * rather than dictating one, so the settlement parse has to meet it. */
export function parseSettlementHeader(
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null },
): SettleResponse | undefined {
  const get = (name: string): string | string[] | undefined | null =>
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get(name)
      : (headers as Record<string, string | string[] | undefined>)[name];
  const raw = get("PAYMENT-RESPONSE") ?? get("payment-response") ?? get("X-PAYMENT-RESPONSE") ?? get("x-payment-response");
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  return decodePaymentResponseHeader(value);
}
