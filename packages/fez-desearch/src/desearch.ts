/**
 * Desearch (Bittensor subnet 22) API client — the sovereign, paid search
 * layer. Two GET endpoints, keyed by `Authorization: <key>` (NO Bearer
 * prefix — their docs are explicit). Every billable response carries the
 * cost in the `X-Desearch-Cost-Usd` header; we surface it so spend is
 * never silent (the honest-cost idiom).
 *
 * The network calls are one thin fetch each; the shaping (which is what
 * can break when their JSON drifts) is split into pure functions below,
 * so it's unit-testable without a key or the network.
 */

const BASE = (process.env.DESEARCH_BASE_URL || "https://api.desearch.ai").replace(/\/$/, "");

export interface WebHit { title: string; url: string; snippet: string }
export interface XHit {
  text: string; url: string; author: string; handle: string;
  created: string; likes: number; retweets: number;
}
export interface Priced<T> { results: T; costUsd: number | null }

/** GET /web → {data:[{title, link, snippet}]}. */
export function shapeWeb(body: string, max: number): WebHit[] {
  let parsed: { data?: { title?: string; link?: string; snippet?: string }[] };
  try { parsed = JSON.parse(body); } catch { throw new Error("Desearch answered with non-JSON — it may be rate-limiting; try again shortly."); }
  return (parsed.data ?? [])
    .filter((r) => !!r.link)
    .slice(0, Math.max(1, Math.min(max, 20)))
    .map((r) => ({ title: r.title ?? "", url: r.link!, snippet: r.snippet ?? "" }));
}

interface RawTweet {
  text?: string; url?: string; created_at?: string;
  like_count?: number; retweet_count?: number;
  user?: { username?: string; name?: string };
}
/** GET /twitter → [tweet]. Flatten the fields an agent actually cites. */
export function shapeX(body: string, max: number): XHit[] {
  let parsed: RawTweet[] | { data?: RawTweet[] };
  try { parsed = JSON.parse(body); } catch { throw new Error("Desearch answered with non-JSON — it may be rate-limiting; try again shortly."); }
  const arr = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  return arr
    .filter((t) => !!t.url)
    .slice(0, Math.max(1, Math.min(max, 50)))
    .map((t) => ({
      text: t.text ?? "",
      url: t.url!,
      author: t.user?.name ?? "",
      handle: t.user?.username ? `@${t.user.username}` : "",
      created: t.created_at ?? "",
      likes: t.like_count ?? 0,
      retweets: t.retweet_count ?? 0,
    }));
}

/** Cost header → dollars, or null when the response didn't report one. */
export function costOf(headers: Headers): number | null {
  const raw = headers.get("x-desearch-cost-usd");
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function get(path: string, params: Record<string, string>): Promise<Response> {
  const key = process.env.DESEARCH_API_KEY;
  if (!key) throw new Error("no DESEARCH_API_KEY set — add it in SKILLS & SECRETS (get one at console.desearch.ai).");
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { authorization: key, "content-type": "application/json" }, // no Bearer prefix (Desearch docs)
  });
  if (!res.ok) {
    const hint = res.status === 401 ? " — check DESEARCH_API_KEY" : res.status === 429 ? " — rate-limited, slow down" : "";
    throw new Error(`Desearch ${path} failed: HTTP ${res.status}${hint}`);
  }
  return res;
}

export async function searchWeb(query: string, maxResults = 5, start = 0): Promise<Priced<WebHit[]>> {
  const res = await get("/web", { query, start: String(start) });
  return { results: shapeWeb(await res.text(), maxResults), costUsd: costOf(res.headers) };
}

export async function searchX(
  query: string, count = 20, sort: "Top" | "Latest" = "Top"
): Promise<Priced<XHit[]>> {
  const res = await get("/twitter", { query, count: String(count), sort });
  return { results: shapeX(await res.text(), count), costUsd: costOf(res.headers) };
}
