/**
 * Which gamma services exist and which of them an agent can actually buy
 * from. The list comes from the chain; each service's own documents say
 * the rest, and the free checks of the Gamma Integration Standard V1.3
 * say whether to believe them.
 *
 * The checks are a port of dev/gamma-reference/checks.py and run.py. They
 * send only GET requests, signed by a key made for the run and never
 * funded, so a run spends nothing and a funded agent's key is never used
 * to probe.
 *
 * "unknown" means this checker could not tell, never that the service is
 * wrong.
 */
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { gammaRegistrations, type GammaRegistration, type SubtensorApi } from "./chains/subtensor.js";
import { deriveAgentPair, generateWalletMnemonic, type WalletPair } from "./derive.js";
import { btauthHeaders } from "./gamma.js";

export interface Check { id: string; status: "pass" | "fail" | "unknown"; detail: string }

const TIMEOUT_MS = 15_000;
const ROUTES_TRIED = 3;
const MONEY = /^\d+(\.\d+)?$/;

const check = (id: string, status: Check["status"], detail = ""): Check => ({ id, status, detail });
const passIf = (id: string, ok: boolean, detail: string): Check => check(id, ok ? "pass" : "fail", ok ? "" : detail);
type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const dicts = (v: unknown): Dict[] => (Array.isArray(v) ? v.filter(isDict) : []);
/** Python truthiness, which the reference relies on: `{}` and `[]` are not a price list. */
const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : isDict(v) ? Object.keys(v).length > 0 : Boolean(v));

/** Requirement 1: the services document `set_service` points at. */
export function documentChecks(doc: unknown, netuid: number, hotkey: string, cors: string | null): Check[] {
  const corsCheck = check("cors", cors === "*" ? "pass" : "fail", `Access-Control-Allow-Origin: ${cors}`);
  if (!isDict(doc)) {
    return [check("json", "fail", "The URL does not return a JSON object."), corsCheck,
      ...["publisher", "btauth", "balance_url", "spec", "pricing"].map((id) => check(id, "unknown", "No document to read."))];
  }
  const gamma = dicts(doc.payments).filter((p) => p.type === "gamma");
  const specs = specUrls(doc).length > 0;
  return [
    check("json", "pass"),
    corsCheck,
    passIf("publisher", dicts(doc.publishers).some((p) => p.hotkey === hotkey && p.netuid === netuid), "The hotkey registered on chain is not a listed publisher."),
    passIf("btauth", gamma.some((p) => p.signature === "btauth/1"), 'No gamma payment entry with "signature": "btauth/1".'),
    passIf("balance_url", balanceUrl(doc) !== undefined, "The gamma payment entry has no balance URL."),
    check("spec", specs ? "pass" : "unknown", specs ? "" : "No OpenAPI entry; other spec types are not checked."),
    check("pricing", filled(doc.pricing) ? "pass" : "unknown", filled(doc.pricing) ? "" : "No pricing key; prices may be inside the spec."),
  ];
}

export function balanceUrl(doc: unknown): string | undefined {
  const entry = dicts(isDict(doc) ? doc.payments : undefined).find((p) => p.type === "gamma" && typeof p.balance === "string" && p.balance);
  return entry?.balance as string | undefined;
}

export function specUrls(doc: unknown): string[] {
  return dicts(isDict(doc) ? doc.services : undefined)
    .filter((s) => s.type === "openapi" && typeof s.endpoint === "string")
    .map((s) => s.endpoint as string);
}

/** Where the spec's paths live: its first server (variables at their defaults), else the spec's own origin. */
function specBase(spec: Dict, specUrl: string): string | undefined {
  const first = dicts(spec.servers)[0];
  let server = String(first?.url || "/");
  for (const [name, variable] of Object.entries(isDict(first?.variables) ? first.variables : {})) {
    if (isDict(variable) && typeof variable.default === "string") server = server.replaceAll(`{${name}}`, variable.default);
  }
  try { return new URL(server.includes("{") ? "/" : server, specUrl).href.replace(/\/+$/, ""); } catch { return undefined; }
}

const METHODS = ["get", "post", "put", "patch", "delete"];

/** Every route the spec lists, as "METHOD url" with path parameters kept as written (`/jobs/{id}`). */
export function specRoutes(spec: unknown, specUrl: string): string[] {
  if (!isDict(spec) || !("openapi" in spec) || !isDict(spec.paths)) return [];
  const base = specBase(spec, specUrl);
  if (base === undefined) return [];
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    METHODS.filter((m) => isDict(methods) && m in methods).map((m) => `${m.toUpperCase()} ${base}${path}`));
}

/** Full URLs of the spec's GET routes that take no path parameter, without the balance route. */
export function getRoutes(spec: unknown, specUrl: string, balancePath: string | undefined): string[] {
  if (!isDict(spec) || !("openapi" in spec) || !isDict(spec.paths)) return [];
  const base = specBase(spec, specUrl);
  if (base === undefined) return [];
  return Object.entries(spec.paths)
    .filter(([path, methods]) => isDict(methods) && "get" in methods && !path.includes("{") && path !== balancePath)
    .map(([path]) => base + path);
}

/** May an agent send this request to a service whose spec lists `routes`?
 * Gamma cannot be refunded and the URL comes from the agent, so the
 * method and path must be ones the service itself published, over https.
 * A path parameter stands for exactly one path segment. */
export function routeAllowed(routes: string[], method: string, url: string): boolean {
  let target: URL;
  try { target = new URL(url); } catch { return false; }
  if (target.protocol !== "https:") return false;
  const asked = `${method.toUpperCase()} ${target.origin}${target.pathname}`;
  return routes.some((route) => new RegExp(`^${route.split(/\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`).test(asked));
}

/** Requirement 3: a hotkey never seen reads zero, in decimal strings, not a 404. */
export function balanceCheck(status: number, payload: unknown): Check {
  if (status !== 200 || !isDict(payload)) return check("balance", "fail", `HTTP ${status} for a hotkey never seen; zeros expected.`);
  const fields = ["credited_usd", "used_usd", "remaining_usd"].map((key) => payload[key]);
  if (!fields.every((v) => typeof v === "string" && MONEY.test(v))) return check("balance", "fail", `Amounts are not decimal strings: ${JSON.stringify(fields)}`);
  if (fields.some((v) => Number(v) !== 0)) return check("balance", "fail", `A hotkey never funded has a balance: ${JSON.stringify(fields)}`);
  return check("balance", "pass");
}

export interface Seen { url: string; status: number; body: unknown }

/** Requirement 5: a signed request from a hotkey never funded gets a 402. Other
 * answers are unknown: the route tried may not be a paid one. */
export function refusal(seen: Seen[]): Check {
  const refused = seen.find((s) => s.status === 402 && JSON.stringify(s.body ?? null).includes("insufficient_balance"));
  if (refused) return check("refuses", "pass", refused.url);
  if (seen.length === 0) return check("refuses", "unknown", "No GET route without parameters in an OpenAPI spec.");
  return check("refuses", "unknown", `No 402 on the routes tried: ${seen.map((s) => `${s.status} ${s.url}`).join(", ")}`);
}

/** One GET. Status 0 when nothing answered, or when the URL is not https:
 * every URL here was written by a stranger (the chain entry, then their
 * document, then their spec), and http is how one would point this wallet
 * at the owner's own machine or network. */
async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; cors: string | null }> {
  try {
    if (new URL(url).protocol !== "https:") return { status: 0, body: undefined, cors: null };
    const res = await fetch(url, { headers: { "User-Agent": "fez-wallet", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: await res.json().catch(() => undefined), cors: res.headers.get("Access-Control-Allow-Origin") };
  } catch {
    return { status: 0, body: undefined, cors: null };
  }
}

function signed(probe: WalletPair, url: string, receiver: string): Record<string, string> {
  const { pathname, search } = new URL(url);
  return btauthHeaders(probe, { method: "GET", path: pathname + search, receiver });
}

export interface GammaServiceReport {
  netuid: number;
  hotkey: string;
  /** The services document registered on chain. */
  url: string;
  name?: string;
  description?: string;
  balanceUrl?: string;
  specUrls: string[];
  /** Every "METHOD url" the service's specs list: the only requests an agent may pay for. */
  routes: string[];
  /** The document's `pricing` value, as published; unread so far. */
  pricing?: unknown;
  /** A route that answered a signed, unfunded request with a 402: proof the service takes `btauth/1`. */
  paidRoute?: string;
  checks: Check[];
  /** No check failed, and a paid route refused the unfunded probe. Only these are offered to an agent. */
  ready: boolean;
}

/** Run the free checks against one registered service. `probe` must be a key that was never funded. */
export async function checkService(registered: GammaRegistration, probe: WalletPair): Promise<GammaServiceReport> {
  const { netuid, hotkey, url } = registered;
  const page = await get(url);
  const reached = page.status === 200;
  const doc = reached && isDict(page.body) ? page.body : undefined;
  const checks = [
    passIf("enabled", registered.enabled, "Minting is off for this subnet."),
    passIf("reachable", reached, `HTTP ${page.status}`),
    ...documentChecks(doc, netuid, hotkey, page.cors),
  ];

  const balance = balanceUrl(doc);
  if (balance) {
    const target = `${balance}${balance.includes("?") ? "&" : "?"}hotkey=${probe.address}`;
    let answer = await get(target);
    // The standard lets the balance need the hotkey's own signature.
    if (answer.status === 401 || answer.status === 403) answer = await get(target, signed(probe, target, hotkey));
    checks.push(balanceCheck(answer.status, answer.body));
  } else {
    checks.push(check("balance", "unknown", "No balance URL to call."));
  }

  const seen: Seen[] = [];
  const routes: string[] = [];
  let balancePath: string | undefined;
  try { balancePath = balance ? new URL(balance).pathname : undefined; } catch { /* not a URL: nothing to exclude */ }
  for (const specUrl of specUrls(doc)) {
    const spec = (await get(specUrl)).body;
    routes.push(...specRoutes(spec, specUrl));
    for (const route of getRoutes(spec, specUrl, balancePath).slice(0, ROUTES_TRIED - seen.length)) {
      const answer = await get(route, signed(probe, route, hotkey));
      seen.push({ url: route, status: answer.status, body: answer.body });
    }
  }
  const refuses = refusal(seen);
  checks.push(refuses);

  const paidRoute = refuses.status === "pass" ? refuses.detail : undefined;
  return {
    netuid, hotkey, url,
    name: typeof doc?.name === "string" ? doc.name : undefined,
    description: typeof doc?.description === "string" ? doc.description : undefined,
    balanceUrl: balance,
    specUrls: specUrls(doc),
    routes,
    pricing: doc?.pricing,
    paidRoute,
    checks,
    ready: paidRoute !== undefined && checks.every((c) => c.status !== "fail"),
  };
}

export interface GammaServicesReport { block: number; checkedAt: string; services: GammaServiceReport[] }

const MAX_AGE_MS = 60 * 60_000;
const runs = new WeakMap<SubtensorApi, { at: number; run: Promise<GammaServicesReport> }>();

/** Every registered gamma service with its checks. A run is kept for an
 * hour per chain connection: it costs about a hundred requests to other
 * people's servers, and services do not change by the minute. */
export function discoverGammaServices(api: SubtensorApi, opts: { now?: () => number } = {}): Promise<GammaServicesReport> {
  const now = (opts.now ?? Date.now)();
  const kept = runs.get(api);
  if (kept && now - kept.at < MAX_AGE_MS) return kept.run;
  const run = (async () => {
    await cryptoWaitReady();
    const [registered, header] = await Promise.all([gammaRegistrations(api), api.rpc.chain.getHeader()]);
    const probe = deriveAgentPair(generateWalletMnemonic(), "gamma-probe");
    const services = await Promise.all(registered.map((r) => checkService(r, probe)));
    return { block: header.number.toNumber(), checkedAt: new Date(now).toISOString(), services };
  })();
  runs.set(api, { at: now, run });
  run.catch(() => { if (runs.get(api)?.run === run) runs.delete(api); });
  return run;
}
