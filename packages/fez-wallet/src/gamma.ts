/**
 * Gamma, the buyer's side: an agent's own key is its account at every
 * Bittensor service that takes gamma. The owner funds the key on chain;
 * the agent proves who it is by signing each request (`btauth/1`), and the
 * service charges that key's balance. No API keys, no escrow.
 *
 * The signed bytes are normative and pinned in tests against the Bittensor
 * library's own output.
 */
import { createHash } from "node:crypto";
import { sr25519Sign } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import type { WalletPair } from "./derive.js";

export interface SignedRequest { method: string; path: string; body?: string; receiver?: string; nonceNs?: bigint }

/** The exact bytes a service verifies: eight newline-joined lines. */
export function btauthPayload(req: { method: string; path: string; body: string; nonceNs: bigint; sender: string; receiver?: string }): string {
  return ["btauth/1", "sr25519", req.method.toUpperCase(), req.path, createHash("sha256").update(req.body).digest("hex"),
    req.nonceNs.toString(), req.sender, req.receiver ?? "-"].join("\n");
}

let lastNonce = 0n;
/** Nanosecond clock that never repeats, so two requests in one tick still differ. */
function nextNonce(): bigint {
  const now = BigInt(Date.now()) * 1_000_000n;
  lastNonce = now > lastNonce ? now : lastNonce + 1n;
  return lastNonce;
}

/** Headers proving this request came from the agent's key. `path` is the request target as sent, query included. */
export function btauthHeaders(pair: WalletPair, req: SignedRequest): Record<string, string> {
  const nonceNs = req.nonceNs ?? nextNonce();
  const payload = btauthPayload({ method: req.method, path: req.path, body: req.body ?? "", nonceNs, sender: pair.address, receiver: req.receiver });
  const signature = sr25519Sign(payload, { publicKey: hexToU8a(`0x${pair.publicKeyHex}`), secretKey: hexToU8a(`0x${pair.secretKeyHex}`) });
  return {
    "X-Bittensor-Version": "1", "X-Bittensor-Hotkey": pair.address, "X-Bittensor-Nonce": nonceNs.toString(),
    "X-Bittensor-Signature": u8aToHex(signature), ...(req.receiver ? { "X-Bittensor-Receiver": req.receiver } : {}),
  };
}

const target = (url: URL) => url.pathname + url.search;

export interface GammaBalance { creditedUsd: number; usedUsd: number; remainingUsd: number }

/** What this agent has left at one service. `service` is the service's hotkey. */
export async function gammaBalance(balanceUrl: string, pair: WalletPair, service: string, timeoutMs = 15_000): Promise<GammaBalance> {
  const url = new URL(balanceUrl);
  url.searchParams.set("hotkey", pair.address);
  // The standard lets a balance be public or need the hotkey's signature. Ask
  // plainly first: one live service (SN117) answers a signed read from an
  // unfunded key with 402, and the plain one with zeros.
  let res = await fetch(url.href, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url.href, { headers: btauthHeaders(pair, { method: "GET", path: target(url), receiver: service }), signal: AbortSignal.timeout(timeoutMs) });
  }
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  const amounts = ["credited_usd", "used_usd", "remaining_usd"].map((key) => body?.[key]);
  if (!res.ok || !amounts.every((v) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v))) throw new Error(`Gamma balance unreadable (HTTP ${res.status})`);
  const [creditedUsd, usedUsd, remainingUsd] = amounts.map(Number);
  return { creditedUsd, usedUsd, remainingUsd };
}

export interface GammaResult { status: number; /** false when the service refused for lack of balance */ paid: boolean; body: unknown }

/** One signed request to a gamma service. An empty balance is an answer (`paid: false`), not an error. */
export async function gammaCall(pair: WalletPair, service: string, req: { url: string; method: string; body?: unknown; timeoutMs?: number }): Promise<GammaResult> {
  const url = new URL(req.url);
  const body = req.body === undefined ? "" : JSON.stringify(req.body);
  const res = await fetch(url.href, {
    method: req.method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...btauthHeaders(pair, { method: req.method, path: target(url), body, receiver: service }) },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
  });
  return { status: res.status, paid: res.status !== 402, body: await res.json().catch(() => undefined) };
}
