import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { deriveAgentPair } from "../src/derive.js";
import { buyWithGamma, type GammaService } from "../src/gamma-buy.js";

const DEV_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const SERVICES: GammaService[] = [
  { netuid: 75, name: "Hippius", hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty", description: "decentralized file storage" },
  { netuid: 24, name: "sandboxes", hotkey: "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y", description: "run code in a sandbox" },
];
const request = async () => ({ url: "https://api.example.com/v1/files", method: "POST", body: { name: "a.txt" } });

/** A judge that answers from a table and records what it was asked. */
function judge(answers: { service?: string; confidence?: number; allowed?: number; delivered?: number }) {
  const asked: Record<string, unknown>[] = [];
  const ask = async (state: unknown, questions: Record<string, { type: string }>) => {
    asked.push({ state, questions });
    const out: Record<string, unknown> = {};
    if (questions.service) out.service = { type: "choice", choice: answers.service ?? "none", confidence: answers.confidence ?? 0.9, probabilities: {} };
    if (questions.allowed) out.allowed = { type: "noul", noul: answers.allowed ?? 0.9 };
    if (questions.delivered) out.delivered = { type: "noul", noul: answers.delivered ?? 0.9 };
    return { model: "m", answers: out, inputTokens: 1, outputTokens: 0 } as never;
  };
  return { ask, asked };
}

let pair: ReturnType<typeof deriveAgentPair>;
beforeAll(async () => { await cryptoWaitReady(); pair = deriveAgentPair(DEV_MNEMONIC, "drift"); });
afterEach(() => vi.unstubAllGlobals());

const buy = (j: ReturnType<typeof judge>) => buyWithGamma({ need: "store this file", services: SERVICES, ask: j.ask, pair, request });

describe("buyWithGamma", () => {
  it("spends nothing when the judge says no listed service fits", async () => {
    const fetched = vi.fn(); vi.stubGlobal("fetch", fetched);
    expect(await buy(judge({ service: "none" }))).toMatchObject({ outcome: "no_service" });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("spends nothing when the pick is not confident enough", async () => {
    const fetched = vi.fn(); vi.stubGlobal("fetch", fetched);
    expect(await buy(judge({ service: "sn75", confidence: 0.4 }))).toMatchObject({ outcome: "no_service", confidence: 0.4 });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("spends nothing, and asks nothing more, when there is no request it may send to the chosen service", async () => {
    const fetched = vi.fn(); vi.stubGlobal("fetch", fetched);
    const j = judge({ service: "sn75" });
    expect(await buyWithGamma({ need: "store this file", services: SERVICES, ask: j.ask, pair, request: async () => undefined }))
      .toMatchObject({ outcome: "no_request", service: { netuid: 75 } });
    expect(fetched).not.toHaveBeenCalled();
    expect(j.asked.length).toBe(1);
  });

  it("reports an unfunded key without calling it a failure of the service", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "insufficient_balance" }, { status: 402 }));
    expect(await buy(judge({ service: "sn75" }))).toMatchObject({ outcome: "unfunded", service: SERVICES[0] });
  });

  it("pays the chosen service with a signed request and has the judge check the result", async () => {
    let receiver: string | null = null;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => { receiver = new Headers(init?.headers).get("x-bittensor-receiver"); return Response.json({ cid: "bafy" }); });
    const j = judge({ service: "sn75", delivered: 0.95 });
    expect(await buy(j)).toMatchObject({ outcome: "delivered", service: SERVICES[0], delivered: 0.95, result: { cid: "bafy" } });
    expect(receiver).toBe(SERVICES[0].hotkey);
    expect(JSON.stringify(j.asked[1])).toContain("bafy");
  });

  it("says so when the service was paid and the result does not deliver", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "bad request" }, { status: 400 }));
    expect(await buy(judge({ service: "sn75", delivered: 0.1 }))).toMatchObject({ outcome: "not_delivered", status: 400 });
  });
});
