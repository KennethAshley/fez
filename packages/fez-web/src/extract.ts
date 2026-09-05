/** URL → readable text. Readability strips nav/footer chrome; a page it
 *  can't parse degrades to tag-stripped text, never a throw — a bad page
 *  must read as a bad page, not as a tool failure. */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { guardedFetch } from "./guard.js";

const DEFAULT_MAX_CHARS = 20_000;

export function extractReadable(html: string, url: string, maxChars = DEFAULT_MAX_CHARS): { title: string; text: string; truncated: boolean } {
  const cap = Math.min(maxChars, DEFAULT_MAX_CHARS);
  let title = "";
  let text = "";
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as never, { charThreshold: 100 }).parse();
    if (article) {
      title = article.title ?? "";
      text = (article.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
    }
  } catch { /* fall through to the crude strip */ }
  if (!text) {
    title ||= /<title[^>]*>([^<]*)</i.exec(html)?.[1]?.trim() ?? "";
    text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  const truncated = text.length > cap;
  return { title, text: truncated ? text.slice(0, cap) : text, truncated };
}

export async function fetchReadable(url: string, maxChars?: number): Promise<{ url: string; status: number; title: string; text: string; truncated: boolean }> {
  const res = await guardedFetch(url);
  if (!/html|xml|text|json/.test(res.contentType) && res.contentType) {
    return { url: res.finalUrl, status: res.status, title: "", text: `(${res.contentType}, ${res.body.length} bytes — not a text page)`, truncated: false };
  }
  const r = extractReadable(res.body, res.finalUrl, maxChars);
  return { url: res.finalUrl, status: res.status, ...r };
}
