import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { cryptoWaitReady, decodeAddress, sr25519Verify } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { deriveAgentPair } from "../src/derive.js";
import { btauthPayload, btauthHeaders, gammaBalance, gammaCall } from "../src/gamma.js";

// Substrate's canonical dev mnemonic — public knowledge, safe in tests.
const DEV_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

beforeAll(async () => { await cryptoWaitReady(); });
afterEach(() => vi.unstubAllGlobals());

describe("btauth/1 payload", () => {
  // Both strings were produced by bittensor 11.3.6 `http_auth.build_payload`
  // (26 Nov 2026), so this pins the format byte for byte against the library
  // every gamma service verifies with.
  it("matches the Bittensor library for a POST bound to a receiver", () => {
    expect(btauthPayload({ method: "post", path: "/v1/run?a=1", body: '{"model":"x","n":1}', nonceNs: 1795730000000000000n, sender: ALICE, receiver: BOB }))
      .toBe("btauth/1\nsr25519\nPOST\n/v1/run?a=1\n11688c6710e4553eab3f12f830649c49be7ff69949228e05b17675f6f52797cc\n1795730000000000000\n" + ALICE + "\n" + BOB);
  });
  it("matches the Bittensor library for an empty GET with no receiver", () => {
    expect(btauthPayload({ method: "GET", path: "/b", body: "", nonceNs: 5n, sender: ALICE }))
      .toBe("btauth/1\nsr25519\nGET\n/b\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n5\n" + ALICE + "\n-");
  });
});

describe("btauthHeaders", () => {
  it("signs the payload with the agent's own key and names sender, receiver and nonce", () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    const headers = btauthHeaders(pair, { method: "POST", path: "/v1/run", body: "{}", receiver: BOB, nonceNs: 42n });
    expect(headers).toMatchObject({ "X-Bittensor-Version": "1", "X-Bittensor-Hotkey": pair.address, "X-Bittensor-Nonce": "42", "X-Bittensor-Receiver": BOB });
    const payload = btauthPayload({ method: "POST", path: "/v1/run", body: "{}", nonceNs: 42n, sender: pair.address, receiver: BOB });
    expect(sr25519Verify(payload, hexToU8a(headers["X-Bittensor-Signature"]), decodeAddress(pair.address))).toBe(true);
  });
  it("uses a fresh nonce for every request", () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    const a = btauthHeaders(pair, { method: "GET", path: "/", receiver: BOB }), b = btauthHeaders(pair, { method: "GET", path: "/", receiver: BOB });
    expect(BigInt(b["X-Bittensor-Nonce"])).toBeGreaterThan(BigInt(a["X-Bittensor-Nonce"]));
  });
});

describe("gammaBalance", () => {
  it("reads an agent's balance at a service, in dollars", async () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    let asked = "";
    vi.stubGlobal("fetch", async (url: string) => { asked = url; return Response.json({ hotkey: pair.address, credited_usd: "5.00", used_usd: "1.25", remaining_usd: "3.75" }); });
    expect(await gammaBalance("https://api.example.com/gamma/balance", pair, BOB)).toEqual({ creditedUsd: 5, usedUsd: 1.25, remainingUsd: 3.75 });
    expect(asked).toBe(`https://api.example.com/gamma/balance?hotkey=${pair.address}`);
  });
  // Measured 26 Nov 2026: EveryFrame (SN117) answers 200 with zeros to a plain
  // read from an unfunded key, and 402 to the same read signed.
  it("asks plainly first and signs only when the service demands a signature", async () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    const signedFlags: boolean[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
      const isSigned = Boolean(init?.headers?.["X-Bittensor-Signature"]);
      signedFlags.push(isSigned);
      return isSigned ? Response.json({ credited_usd: "2", used_usd: "0", remaining_usd: "2" }) : new Response("", { status: 401 });
    });
    expect((await gammaBalance("https://api.example.com/b", pair, BOB)).remainingUsd).toBe(2);
    expect(signedFlags).toEqual([false, true]);
    signedFlags.length = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: { headers?: Record<string, string> }) => {
      signedFlags.push(Boolean(init?.headers?.["X-Bittensor-Signature"]));
      return Response.json({ credited_usd: "0", used_usd: "0", remaining_usd: "0" });
    });
    await gammaBalance("https://api.example.com/b", pair, BOB);
    expect(signedFlags).toEqual([false]);
  });
  it("refuses an answer that is not three decimal strings", async () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    vi.stubGlobal("fetch", async () => Response.json({ credited_usd: 5, used_usd: "0", remaining_usd: "5" }));
    await expect(gammaBalance("https://api.example.com/b", pair, BOB)).rejects.toThrow(/balance/i);
  });
});

describe("gammaCall", () => {
  it("sends the signed request to the service and returns its answer", async () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    let seen: { url: string; headers: Headers; body: string } | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers), body: String(init?.body) };
      return Response.json({ ok: true });
    });
    const result = await gammaCall(pair, BOB, { url: "https://api.example.com/v1/run?fast=1", method: "POST", body: { n: 1 } });
    expect(result).toEqual({ status: 200, paid: true, body: { ok: true } });
    const payload = btauthPayload({ method: "POST", path: "/v1/run?fast=1", body: seen!.body, nonceNs: BigInt(seen!.headers.get("x-bittensor-nonce")!), sender: pair.address, receiver: BOB });
    expect(sr25519Verify(payload, hexToU8a(seen!.headers.get("x-bittensor-signature")!), decodeAddress(pair.address))).toBe(true);
  });
  it("reports an empty balance as unpaid, not as an error", async () => {
    const pair = deriveAgentPair(DEV_MNEMONIC, "drift");
    vi.stubGlobal("fetch", async () => Response.json({ error: "insufficient_balance" }, { status: 402 }));
    expect(await gammaCall(pair, BOB, { url: "https://api.example.com/v1/run", method: "GET" })).toEqual({ status: 402, paid: false, body: { error: "insufficient_balance" } });
  });
});
