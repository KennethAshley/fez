import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { stringToHex } from "@polkadot/util";
import { deriveAgentPair } from "../src/derive.js";
import { gammaRegistrations, type SubtensorApi } from "../src/chains/subtensor.js";
import { walletGammaServices, walletGammaBuy } from "../src/tools.js";
import {
  documentChecks, getRoutes, specRoutes, routeAllowed, balanceCheck, refusal, checkService, discoverGammaServices, type Check,
} from "../src/gamma-services.js";

// The pure checks are a port of dev/gamma-reference/checks.py; the first 17
// tests mirror test_checks.py one for one, so the two cannot drift silently.
const HOTKEY = "5EKrpcqVNWfVfmKiq8v3LRrgb3E3ENBwYzmAziDhMK58gtb5";
const USER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const DEV_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const GOOD = {
  name: "Example",
  description: "Things.",
  publishers: [{ netuid: 7, hotkey: HOTKEY }],
  services: [{ type: "openapi", endpoint: "https://api.example.com/openapi.json" }],
  pricing: "https://api.example.com/pricing",
  payments: [{ type: "gamma", signature: "btauth/1", balance: "https://api.example.com/balance" }],
};
const status = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

beforeAll(async () => { await cryptoWaitReady(); });
afterEach(() => vi.unstubAllGlobals());

describe("services document", () => {
  it("a complete document passes every document check", () => {
    const got = status(documentChecks(GOOD, 7, HOTKEY, "*"));
    expect(new Set(Object.values(got))).toEqual(new Set(["pass"]));
    expect(Object.keys(got).sort()).toEqual(["balance_url", "btauth", "cors", "json", "pricing", "publisher", "spec"]);
  });
  it("a page that is not JSON fails json and leaves the rest unknown", () => {
    const { json, cors: _cors, ...rest } = status(documentChecks(undefined, 7, HOTKEY, "*"));
    expect(json).toBe("fail");
    expect(new Set(Object.values(rest))).toEqual(new Set(["unknown"]));
  });
  it("missing CORS fails", () => {
    expect(status(documentChecks(GOOD, 7, HOTKEY, null)).cors).toBe("fail");
  });
  it("the chain hotkey must be a listed publisher of this subnet", () => {
    const other = { ...GOOD, publishers: [{ netuid: 8, hotkey: HOTKEY }] };
    expect(status(documentChecks(other, 7, HOTKEY, "*")).publisher).toBe("fail");
  });
  it("a gamma entry without btauth or balance fails those checks", () => {
    const got = status(documentChecks({ ...GOOD, payments: [{ type: "gamma" }] }, 7, HOTKEY, "*"));
    expect([got.btauth, got.balance_url]).toEqual(["fail", "fail"]);
  });
  it("no OpenAPI entry and no pricing key are unknown, not failures", () => {
    const { pricing: _pricing, ...doc } = GOOD;
    const got = status(documentChecks({ ...doc, services: [{ type: "http", endpoint: "https://api.example.com" }] }, 7, HOTKEY, "*"));
    expect([got.spec, got.pricing]).toEqual(["unknown", "unknown"]);
  });
  it("malformed fields do not crash", () => {
    const got = status(documentChecks({ publishers: "x", services: [3], payments: { type: "gamma" } }, 7, HOTKEY, "*"));
    expect(got.publisher).toBe("fail");
  });
});

describe("routes to try", () => {
  const SPEC = {
    openapi: "3.1.0",
    servers: [{ url: "https://api.example.com/base" }],
    paths: { "/v1/models": { get: {} }, "/v1/jobs/{id}": { get: {} }, "/v1/run": { post: {} }, "/v1/gamma/balance": { get: {} } },
  };
  it("only GET routes without parameters and never the balance route", () => {
    expect(getRoutes(SPEC, "https://x.example/openapi.json", "/v1/gamma/balance")).toEqual(["https://api.example.com/base/v1/models"]);
  });
  it("without servers routes resolve against the spec URL", () => {
    expect(getRoutes({ openapi: "3.0.0", paths: { "/a": { get: {} } } }, "https://x.example/api/openapi.json", undefined)).toEqual(["https://x.example/a"]);
  });
  it("server variables take their defaults or fall back to the spec origin", () => {
    const spec = { openapi: "3.1.0", servers: [{ url: "{baseUrl}/api", variables: { baseUrl: { default: "https://api.example.com" } } }] as unknown[], paths: { "/a": { get: {} } } };
    expect(getRoutes(spec, "https://x.example/s.json", undefined)).toEqual(["https://api.example.com/api/a"]);
    spec.servers = [{ url: "{baseUrl}" }];
    expect(getRoutes(spec, "https://x.example/s.json", undefined)).toEqual(["https://x.example/a"]);
  });
  it("something that is not an OpenAPI document has no routes", () => {
    expect(getRoutes({ hello: 1 }, "https://x.example/s.json", undefined)).toEqual([]);
    expect(getRoutes(undefined, "https://x.example/s.json", undefined)).toEqual([]);
  });
});

describe("balance of a hotkey never seen", () => {
  const ZERO = { hotkey: USER, credited_usd: "0", used_usd: "0.00", remaining_usd: "0.000" };
  it("an unknown hotkey reads zero in decimal strings", () => {
    expect(balanceCheck(200, ZERO).status).toBe("pass");
  });
  it("a 404 or numbers instead of strings fail", () => {
    expect(balanceCheck(404, undefined).status).toBe("fail");
    expect(balanceCheck(200, { ...ZERO, remaining_usd: 0 }).status).toBe("fail");
  });
  it("a never-funded hotkey with money fails", () => {
    expect(balanceCheck(200, { ...ZERO, remaining_usd: "5.00" }).status).toBe("fail");
  });
});

describe("refusal at zero", () => {
  it("a 402 naming insufficient_balance passes", () => {
    expect(refusal([{ url: "https://a/x", status: 404, body: undefined }, { url: "https://a/y", status: 402, body: { error: "insufficient_balance" } }]).status).toBe("pass");
  });
  it("the error may be nested as long as the body names it", () => {
    expect(refusal([{ url: "https://a/y", status: 402, body: { error: { code: "insufficient_balance" } } }]).status).toBe("pass");
  });
  it("anything else is unknown because the route may not be a paid one", () => {
    expect(refusal([{ url: "https://a/x", status: 200, body: {} }]).status).toBe("unknown");
    expect(refusal([]).status).toBe("unknown");
    expect(refusal([{ url: "https://a/x", status: 401, body: undefined }]).detail).toContain("401");
  });
});

// ── Beyond the Python: the chain read, one service end to end, the cache ──

/** A chain holding these registrations; counts how often the list is read. */
function chain(registered: { netuid: number; hotkey: string; url: string; enabled: boolean }[]) {
  const reads = { count: 0 };
  const api = {
    query: { subtensorModule: {
      services: { entries: async () => {
        reads.count++;
        // Shape measured on finney, block 9,593,794: the url is hex bytes.
        return registered.map((r) => [{ args: [{ toNumber: () => r.netuid }, { toString: () => r.hotkey }] }, { toJSON: () => ({ url: stringToHex(r.url) }) }]);
      } },
      subnetGammaEnabled: async (netuid: number) => ({ isTrue: registered.find((r) => r.netuid === netuid)!.enabled }),
    } },
    rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 9_593_794 } }) } },
  } as unknown as SubtensorApi;
  return { api, reads };
}

/** A service that follows the standard, as a fetch stub. Records every request. */
function standardService(overrides: Record<string, (req: { url: URL; headers: Record<string, string> }) => Response> = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input), headers = init?.headers ?? {};
    requests.push({ url: input, headers });
    const route = overrides[url.pathname] ?? ({
      "/services.json": () => Response.json(GOOD, { headers: { "Access-Control-Allow-Origin": "*" } }),
      "/balance": () => Response.json({ hotkey: url.searchParams.get("hotkey"), credited_usd: "0", used_usd: "0", remaining_usd: "0" }),
      "/openapi.json": () => Response.json({ openapi: "3.1.0", paths: { "/v1/models": { get: {} }, "/balance": { get: {} } } }),
      "/v1/models": () => Response.json({ error: "insufficient_balance" }, { status: 402 }),
    } as typeof overrides)[url.pathname];
    return route ? route({ url, headers }) : new Response("not found", { status: 404 });
  });
  return requests;
}
const REGISTERED = { netuid: 7, hotkey: HOTKEY, url: "https://api.example.com/services.json", enabled: true };

describe("gammaRegistrations", () => {
  it("reads every registered service with its document URL and whether minting is on", async () => {
    const { api } = chain([REGISTERED, { netuid: 9, hotkey: USER, url: "https://b.example/s.json", enabled: false }]);
    expect(await gammaRegistrations(api)).toEqual([REGISTERED, { netuid: 9, hotkey: USER, url: "https://b.example/s.json", enabled: false }]);
  });
});

describe("checkService", () => {
  const probe = () => deriveAgentPair(DEV_MNEMONIC, "probe");

  it("a service that follows the standard passes all eleven checks and names what an agent needs to buy", async () => {
    standardService();
    const got = await checkService(REGISTERED, probe());
    expect(got.checks.map((c) => c.id)).toEqual(["enabled", "reachable", "json", "cors", "publisher", "btauth", "balance_url", "spec", "pricing", "balance", "refuses"]);
    expect(got.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(got).toMatchObject({
      netuid: 7, hotkey: HOTKEY, name: "Example", description: "Things.", ready: true,
      balanceUrl: "https://api.example.com/balance", pricing: "https://api.example.com/pricing",
      specUrls: ["https://api.example.com/openapi.json"], paidRoute: "https://api.example.com/v1/models",
    });
  });

  it("signs the paid-route request with the probe key, bound to the service's hotkey", async () => {
    const requests = standardService();
    await checkService(REGISTERED, probe());
    const paid = requests.find((r) => r.url === "https://api.example.com/v1/models")!;
    expect(paid.headers).toMatchObject({ "X-Bittensor-Hotkey": probe().address, "X-Bittensor-Receiver": HOTKEY });
  });

  it("asks for the balance again, signed, when the service wants a signature", async () => {
    const requests = standardService({
      "/balance": ({ url, headers }) => headers["X-Bittensor-Signature"]
        ? Response.json({ hotkey: url.searchParams.get("hotkey"), credited_usd: "0", used_usd: "0", remaining_usd: "0" })
        : new Response("", { status: 401 }),
    });
    const got = await checkService(REGISTERED, probe());
    expect(status(got.checks).balance).toBe("pass");
    expect(requests.filter((r) => r.url.startsWith("https://api.example.com/balance")).length).toBe(2);
  });

  it("is not ready when minting is off, even if everything else passes", async () => {
    standardService();
    const got = await checkService({ ...REGISTERED, enabled: false }, probe());
    expect(status(got.checks).enabled).toBe("fail");
    expect(got.ready).toBe(false);
  });

  it("a service that does not answer fails reachable and is not ready", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    const got = await checkService(REGISTERED, probe());
    expect(status(got.checks)).toMatchObject({ reachable: "fail", json: "fail", balance: "unknown", refuses: "unknown" });
    expect(got).toMatchObject({ ready: false, name: undefined });
  });

  // Every URL here comes from a stranger: the chain entry, then the document,
  // then the spec. None of them may point the wallet at the owner's machine.
  it("never fetches a URL that is not https", async () => {
    const requests = standardService({
      "/services.json": () => Response.json({ ...GOOD, payments: [{ type: "gamma", signature: "btauth/1", balance: "http://127.0.0.1:7777/balance" }], services: [{ type: "openapi", endpoint: "http://localhost/openapi.json" }] }, { headers: { "Access-Control-Allow-Origin": "*" } }),
    });
    const got = await checkService(REGISTERED, probe());
    expect(requests.map((r) => r.url)).toEqual(["https://api.example.com/services.json"]);
    expect(status(got.checks).balance).toBe("fail");
    await checkService({ ...REGISTERED, url: "http://169.254.169.254/latest" }, probe());
    expect(requests.length).toBe(1);
  });
});

describe("discoverGammaServices", () => {
  it("checks every registered service and reports the block it read", async () => {
    standardService();
    const { api } = chain([REGISTERED]);
    const report = await discoverGammaServices(api);
    expect(report.block).toBe(9_593_794);
    expect(report.services.map((s) => [s.netuid, s.ready])).toEqual([[7, true]]);
  });

  it("reuses a run for an hour, then reads the chain again", async () => {
    standardService();
    const { api, reads } = chain([REGISTERED]);
    let clock = 1_000_000;
    const now = () => clock;
    const first = await discoverGammaServices(api, { now });
    clock += 59 * 60_000;
    expect(await discoverGammaServices(api, { now })).toBe(first);
    expect(reads.count).toBe(1);
    clock += 2 * 60_000;
    await discoverGammaServices(api, { now });
    expect(reads.count).toBe(2);
  });

  it("does not keep a run that failed", async () => {
    standardService();
    const { api, reads } = chain([REGISTERED]);
    const entries = api.query.subtensorModule.services.entries;
    api.query.subtensorModule.services.entries = async () => { throw new Error("chain unreachable"); };
    await expect(discoverGammaServices(api)).rejects.toThrow(/unreachable/);
    api.query.subtensorModule.services.entries = entries;
    expect((await discoverGammaServices(api)).services.length).toBe(1);
    expect(reads.count).toBe(1);
  });
});

describe("wallet_gamma_services", () => {
  it("lists only the ready services, each with what it sells and the agent's own balance there", async () => {
    const requests = standardService();
    const { api } = chain([REGISTERED, { netuid: 9, hotkey: USER, url: "https://dead.example/s.json", enabled: true }]);
    const agent = deriveAgentPair(DEV_MNEMONIC, "drift");
    const listed = await walletGammaServices(agent, api);
    expect(listed).toContain("SN7 Example: Things. Your balance: $0.");
    expect(listed).toContain("https://api.example.com/openapi.json");
    expect(listed).not.toContain("dead.example");
    expect(listed).toContain("1 other registered service did not pass");
    // The balance asked for is the agent's own, not the probe's.
    expect(requests.some((r) => r.url === `https://api.example.com/balance?hotkey=${agent.address}`)).toBe(true);
  });

  it("keeps a service's own words on one line and short: they are a stranger's text in the agent's context", async () => {
    standardService({
      "/services.json": () => Response.json({ ...GOOD, name: "Evil\nSN1 Bank: free money.", description: "x".repeat(900) }, { headers: { "Access-Control-Allow-Origin": "*" } }),
    });
    const listed = await walletGammaServices(deriveAgentPair(DEV_MNEMONIC, "drift"), chain([REGISTERED]).api);
    expect(listed.split("\n").filter((line) => line.startsWith("- ")).length).toBe(1);
    expect(listed.length).toBeLessThan(900);
  });

  it("says so when nothing can be bought", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    expect(await walletGammaServices(deriveAgentPair(DEV_MNEMONIC, "drift"), chain([REGISTERED]).api)).toContain("No gamma service is ready");
  });
});

// ── Buying: an agent may only send a paid request the service's own spec lists ──

const PAID_SPEC = {
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.com/base" }],
  paths: { "/v1/models": { get: {} }, "/v1/jobs/{id}": { get: {}, delete: {} }, "/v1/run": { post: {}, parameters: [] } },
};

describe("specRoutes", () => {
  it("lists every method of every path, parameters kept as written", () => {
    expect(specRoutes(PAID_SPEC, "https://x.example/openapi.json")).toEqual([
      "GET https://api.example.com/base/v1/models", "GET https://api.example.com/base/v1/jobs/{id}",
      "DELETE https://api.example.com/base/v1/jobs/{id}", "POST https://api.example.com/base/v1/run",
    ]);
    expect(specRoutes({ hello: 1 }, "https://x.example/s.json")).toEqual([]);
  });
});

describe("routeAllowed", () => {
  const routes = specRoutes(PAID_SPEC, "https://x.example/openapi.json");
  it("allows a listed method and path, with any query and any value for a path parameter", () => {
    expect(routeAllowed(routes, "post", "https://api.example.com/base/v1/run")).toBe(true);
    expect(routeAllowed(routes, "GET", "https://api.example.com/base/v1/models?limit=5")).toBe(true);
    expect(routeAllowed(routes, "GET", "https://api.example.com/base/v1/jobs/abc-123")).toBe(true);
  });
  it("refuses another host, another path, another method, and a parameter that smuggles a path", () => {
    expect(routeAllowed(routes, "POST", "https://evil.example/base/v1/run")).toBe(false);
    expect(routeAllowed(routes, "POST", "https://api.example.com.evil.example/base/v1/run")).toBe(false);
    expect(routeAllowed(routes, "POST", "https://api.example.com/base/v1/admin")).toBe(false);
    expect(routeAllowed(routes, "GET", "https://api.example.com/base/v1/run")).toBe(false);
    expect(routeAllowed(routes, "GET", "https://api.example.com/base/v1/jobs/a/b")).toBe(false);
    expect(routeAllowed(routes, "GET", "https://api.example.com/base/v1/jobs/../models/x")).toBe(false);
    expect(routeAllowed(routes, "POST", "not a url")).toBe(false);
  });
  it("refuses anything that is not https, even when the spec lists it", () => {
    const local = specRoutes({ openapi: "3.1.0", servers: [{ url: "http://127.0.0.1:7777" }], paths: { "/x": { post: {} } } }, "https://x.example/s.json");
    expect(routeAllowed(local, "POST", "http://127.0.0.1:7777/x")).toBe(false);
  });
});

/** A judge that answers from a table and counts its questions. */
function judge(answers: { service?: string; delivered?: number } = {}) {
  const asked: string[] = [];
  const ask = async (_state: unknown, questions: Record<string, unknown>) => {
    asked.push(...Object.keys(questions));
    return { model: "m", inputTokens: 1, outputTokens: 0, answers: {
      ...(questions.service ? { service: { type: "choice", choice: answers.service ?? "sn7", confidence: 0.9, probabilities: {} } } : {}),
      ...(questions.delivered ? { delivered: { type: "noul", noul: answers.delivered ?? 0.9 } } : {}),
    } } as never;
  };
  return { ask, asked };
}

describe("wallet_gamma_buy", () => {
  const agent = () => deriveAgentPair(DEV_MNEMONIC, "drift");
  const RUN = { need: "run a model", url: "https://api.example.com/v1/run", method: "POST", body: { model: "x" } };

  /** A funded agent at a service whose paid route charges `price` a call. The probe key still reads zero. */
  function paidService(opts: { balance?: number; price?: number; run?: () => Response; balanceDown?: () => boolean } = {}) {
    const account = { remaining: opts.balance ?? 1, used: 0 };
    const requests = standardService({
      "/openapi.json": () => Response.json({ openapi: "3.1.0", paths: { "/v1/models": { get: {} }, "/balance": { get: {} }, "/v1/run": { post: {} } } }),
      "/balance": ({ url }) => {
        if (url.searchParams.get("hotkey") !== agent().address) return Response.json({ credited_usd: "0", used_usd: "0", remaining_usd: "0" });
        if (opts.balanceDown?.()) return new Response("", { status: 503 });
        return Response.json({ credited_usd: String(account.remaining + account.used), used_usd: account.used.toFixed(2), remaining_usd: account.remaining.toFixed(2) });
      },
      "/v1/run": () => {
        if (account.remaining <= 0) return Response.json({ error: "insufficient_balance" }, { status: 402 });
        account.remaining -= opts.price ?? 0.3; account.used += opts.price ?? 0.3;
        return (opts.run ?? (() => Response.json({ output: "42" })))();
      },
    });
    return { requests, paid: () => requests.filter((r) => r.url === RUN.url).length };
  }
  const buy = (over: { dailyLimitUsd?: number; ask?: ReturnType<typeof judge>["ask"] | null; url?: string } = {}) =>
    walletGammaBuy({
      pair: agent(), api: chain([REGISTERED]).api,
      dailyLimitUsd: "dailyLimitUsd" in over ? over.dailyLimitUsd : 1, ask: over.ask === null ? undefined : over.ask ?? judge().ask,
    }, { ...RUN, ...(over.url ? { url: over.url } : {}) });

  it("checks every registered service's routes into the report", async () => {
    standardService();
    expect((await checkService(REGISTERED, agent())).routes).toEqual(["GET https://api.example.com/v1/models", "GET https://api.example.com/balance"]);
  });

  it("sends nothing until the owner has set a daily limit", async () => {
    const s = paidService();
    for (const dailyLimitUsd of [undefined, 0, Number.NaN, -1]) expect(await buy({ dailyLimitUsd })).toMatch(/no daily gamma limit/i);
    expect(s.requests.length).toBe(0);
  });

  it("sends nothing without a judge", async () => {
    const s = paidService();
    expect(await buy({ ask: null })).toMatch(/ZILS_API_KEY/);
    expect(s.requests.length).toBe(0);
  });

  it("refuses a request the chosen service's spec does not list", async () => {
    const s = paidService();
    const j = judge();
    const said = await buy({ ask: j.ask, url: "https://evil.example/v1/run" });
    expect(said).toMatch(/nothing was sent/i);
    expect(said).toContain("SN7 Example");
    expect(s.requests.some((r) => r.url.includes("evil.example"))).toBe(false);
    expect(s.paid()).toBe(0);
    expect(j.asked).toEqual(["service"]);
  });

  it("pays with the agent's own key from its balance at the service", async () => {
    const s = paidService({ price: 0.3 });
    const said = await buy();
    expect(said).toMatch(/^Bought from SN7 Example/);
    expect(said).toContain('{"output":"42"}');
    const paid = s.requests.find((r) => r.url === RUN.url)!;
    expect(paid.headers).toMatchObject({ "X-Bittensor-Hotkey": agent().address, "X-Bittensor-Receiver": HOTKEY });
  });

  // The daily limit is counted where money enters a service (wallet_gamma_topup), so a
  // balance already there can be spent down freely: it was inside the limit when it went in.
  it("keeps buying while the balance lasts, then points an empty agent at the top-up", async () => {
    const s = paidService({ balance: 0.6, price: 0.3 });
    await buy({ dailyLimitUsd: 0.5 });
    await buy({ dailyLimitUsd: 0.5 });
    const said = await buy({ dailyLimitUsd: 0.5 });
    expect(said).toMatch(/no balance at SN7 Example.*wallet_gamma_topup \(subnet 7\)/i);
    expect(s.paid()).toBe(3); // the third was refused by the service: 402, no work, no charge
  });

  it("says so when the service was paid and the result does not deliver", async () => {
    paidService({ run: () => Response.json({ error: "model not found" }, { status: 404 }) });
    const said = await buy({ ask: judge({ delivered: 0.1 }).ask });
    expect(said).toMatch(/did not deliver/i);
    expect(said).toContain("HTTP 404");
    expect(said).toMatch(/may still have charged/i);
  });
});

// Measured 26 Nov 2026: Hippius answered 429 "new_account_limit: too many new
// accounts from this address" after an afternoon of runs that each probed
// with a fresh key. Every wallet command is its own process, so the run and
// the probe key must outlive the process.
describe("discovery shared between wallet processes", () => {
  const probeKeys = (requests: { url: string; headers: Record<string, string> }[]) =>
    [...new Set(requests.filter((r) => r.url === "https://api.example.com/v1/models").map((r) => r.headers["X-Bittensor-Hotkey"]))];

  it("a second process reuses the first one's run for an hour", async () => {
    standardService();
    const cacheDir = mkdtempSync(join(tmpdir(), "gamma-cache-"));
    let clock = 1_000_000;
    const first = await discoverGammaServices(chain([REGISTERED]).api, { now: () => clock, cacheDir });
    const second = chain([REGISTERED]);
    clock += 59 * 60_000;
    expect(await discoverGammaServices(second.api, { now: () => clock, cacheDir })).toEqual(first);
    expect(second.reads.count).toBe(0);
  });

  it("after the hour it checks again, with the same probe key as before", async () => {
    const requests = standardService();
    const cacheDir = mkdtempSync(join(tmpdir(), "gamma-cache-"));
    let clock = 1_000_000;
    await discoverGammaServices(chain([REGISTERED]).api, { now: () => clock, cacheDir });
    clock += 61 * 60_000;
    const later = chain([REGISTERED]);
    await discoverGammaServices(later.api, { now: () => clock, cacheDir });
    expect(later.reads.count).toBe(1);
    expect(probeKeys(requests).length).toBe(1);
  });

  it("a failed run leaves nothing behind for the next process", async () => {
    standardService();
    const cacheDir = mkdtempSync(join(tmpdir(), "gamma-cache-"));
    const broken = chain([REGISTERED]);
    broken.api.query.subtensorModule.services.entries = async () => { throw new Error("chain unreachable"); };
    await expect(discoverGammaServices(broken.api, { cacheDir })).rejects.toThrow(/unreachable/);
    const next = chain([REGISTERED]);
    expect((await discoverGammaServices(next.api, { cacheDir })).services.length).toBe(1);
    expect(next.reads.count).toBe(1);
  });
});
