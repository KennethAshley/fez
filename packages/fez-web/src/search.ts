/** Search through the fez-hosted SearXNG — keyless for every client, the
 *  relay pattern: fez hosts the commons once, agents just work. Env
 *  FEZ_SEARX_URL points self-hosters elsewhere. */
import { guardedFetch } from "./guard.js";

export const DEFAULT_SEARX = "https://bazaar.fez.chat/searx";

export async function webSearch(
  query: string,
  maxResults = 5,
  fetcher: typeof guardedFetch = guardedFetch
): Promise<{ title: string; url: string; snippet: string }[]> {
  const base = process.env.FEZ_SEARX_URL || DEFAULT_SEARX;
  const url = `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  let body: string;
  try {
    body = (await fetcher(url)).body;
  } catch (e) {
    throw new Error(`the search service is unreachable (${e instanceof Error ? e.message : String(e)}) — web_fetch still works if you have a URL`);
  }
  let parsed: { results?: { title?: string; url?: string; content?: string }[] };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { throw new Error("the search service answered with something that isn't JSON — it may be rate-limiting; try again shortly"); }
  return (parsed.results ?? [])
    .filter((r) => !!r.url)
    .slice(0, Math.max(1, Math.min(maxResults, 10)))
    .map((r) => ({ title: r.title ?? "", url: r.url!, snippet: r.content ?? "" }));
}
