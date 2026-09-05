/**
 * Every outbound request fez-web ever makes goes through here. The miner
 * mount runs NEXT TO the relay and validator on the droplet — an
 * unguarded fetch is a hole into that box, so private ranges are refused
 * by construction and re-checked on every redirect hop (redirect to
 * 127.0.0.1 is the classic bypass).
 *
 * Known limitation: DNS rebinding TOCTOU. assertPublicHost() resolves the
 * hostname with lookup() and checks THAT result, but fetch() re-resolves
 * the hostname independently — a short-TTL attacker-controlled DNS record
 * can answer public on the first lookup and private on the second, landing
 * the actual request on an internal address we already "approved". Full
 * fix needs a dispatcher that pins the fetch to the exact IP we checked
 * (e.g. undici Agent with a custom lookup/connect, or resolve-then-fetch-
 * by-IP with a Host header) instead of trusting a second resolution.
 * Deferred — add the pinned-IP dispatcher if this guard ever fronts
 * anything higher-value than best-effort SSRF hardening.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// IPv4-mapped IPv6 (::ffff:a.b.c.d or its hex-group form ::ffff:XXXX:YYYY,
// compressed or fully expanded) embeds a real IPv4 address. Node's URL
// canonicalizes literal IPv4-mapped hosts into the hex-group form (e.g.
// "[::ffff:127.0.0.1]" becomes hostname "::ffff:7f00:1"), so the embedded
// address must be extracted structurally, not by matching a dotted-decimal
// string suffix — a prefix-slice misses the hex form entirely and falls
// through to "not private".
function extractMappedIPv4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:::ffff:|(?:0:){5}ffff:)(.+)$/);
  if (!m) return null;
  const rest = m[1];
  if (rest.includes(".")) return isIP(rest) === 4 ? rest : null;
  const parts = rest.split(":");
  if (parts.length !== 2) return null;
  const hi = parseInt(parts[0] || "0", 16);
  const lo = parseInt(parts[1] || "0", 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = extractMappedIPv4(ip) ?? ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // fc00::/7
  if (low.startsWith("fe80")) return true; // link-local
  return false;
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs can be fetched");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`${host} is a private/internal host — refusing`);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`${host} is a private/internal address — refusing`);
    return;
  }
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`${host} resolves to a private/internal address — refusing`);
  }
}

export async function guardedFetch(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<{ finalUrl: string; status: number; contentType: string; body: string }> {
  let url = new URL(rawUrl);
  const timeoutMs = Math.min(opts.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS);
  const maxBytes = Math.min(opts.maxBytes ?? MAX_BYTES, MAX_BYTES);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "fez-web/0.1 (+https://fez.chat)" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect with no location from ${url.hostname}`);
      url = new URL(loc, url); // relative redirects resolve against current
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error(`response over ${Math.round(maxBytes / 1024)}KB — refusing to read further`); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { finalUrl: url.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body };
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects — refusing`);
}
