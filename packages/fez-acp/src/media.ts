import type { PromptImage } from "@fezchat/protocol";

/**
 * What an agent can perceive of the files people drop in a channel.
 *
 * Split out of agent.ts so it can be tested without booting an agent: the
 * allowlist and the classification are pure decisions, and both of them
 * used to be private helpers inside a module whose import starts a daemon.
 */

/** The public Blossom server the desktop uploader defaults to. */
const DEFAULT_MEDIA_HOST = "blossom.primal.net";

/** How many images ride along with one turn, and how big each may be. */
const MAX_IMAGES = 3;
const MAX_BYTES = 8 * 1024 * 1024;

export interface UnperceivedMedia {
  url: string;
  mime: string;
}

export interface MediaInTurn {
  /** Images, base64 + mime, ready to become ACP image blocks. */
  images: PromptImage[];
  /** Media that IS there and the model cannot take in — audio, video. */
  unperceived: UnperceivedMedia[];
  /** Hosts a URL pointed at that the allowlist refused. Surfaced so the
   *  caller can SAY so: a silent skip is how "my screenshots stopped
   *  reaching the agent" became invisible for as long as it did. */
  skippedHosts: string[];
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Hosts an agent will fetch from. A channel message is UNTRUSTED text —
 * anyone in the room wrote it — so fetching an arbitrary URL out of it is an
 * SSRF hole (a link-local metadata endpoint is one paste away). Hence an
 * allowlist rather than a blocklist.
 *
 * It is a UNION, not a precedence chain, and that is the fix for a silent
 * failure: the settings.json `mediaServer` and the `FEZ_MEDIA_SERVER` env
 * are two spellings of "where this workspace keeps its blobs", written by
 * two different surfaces (the desktop settings pane, a shell export). When
 * only one was consulted, a person who changed their media server had every
 * image quietly stop reaching the model — a disallowed host is skipped
 * without a word. Both spellings are legitimate; neither is an attacker.
 */
export function allowedMediaHosts(opts: { settingsMediaServer?: string; env?: { FEZ_MEDIA_SERVER?: string } }): Set<string> {
  const hosts = new Set([DEFAULT_MEDIA_HOST]);
  for (const candidate of [opts.settingsMediaServer, opts.env?.FEZ_MEDIA_SERVER]) {
    if (!candidate) continue;
    const host = hostOf(candidate);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Pull what the person attached and sort it by what the model can do with it.
 *
 * Classification is by the SERVED content-type, never the file extension —
 * a Blossom URL is a bare sha256 with no extension to read, so the response
 * is the only honest source. Best-effort throughout: an unreachable or
 * oversized file is skipped, never fatal to the turn.
 */
export async function fetchMessageMedia(
  content: string,
  opts: { hosts: Set<string>; timeoutMs?: number }
): Promise<MediaInTurn> {
  const urls = [...content.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
  const images: PromptImage[] = [];
  const unperceived: UnperceivedMedia[] = [];
  const skipped = new Set<string>();
  const seen = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const host = new URL(url).host;
      if (!opts.hosts.has(host)) {
        skipped.add(host);
        continue;
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      if (!res.ok) continue;
      // Audio and video are named, not fetched: the bytes would be useless
      // to a model that cannot take them, and megabytes of them worse.
      if (mime.startsWith("audio/") || mime.startsWith("video/")) {
        unperceived.push({ url, mime });
        continue;
      }
      if (!mime.startsWith("image/") || images.length >= MAX_IMAGES) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) continue;
      images.push({ data: buf.toString("base64"), mimeType: mime });
    } catch {
      /* unreachable, timed out, or too big — skip it */
    }
  }
  return { images, unperceived, skippedHosts: [...skipped] };
}

/**
 * A line for the prompt admitting what came through that the model cannot
 * take in.
 *
 * Without it the model sees only a share line naming a file and answers as
 * though the attachment were not there — the worst of the options, because
 * the person watched the app play the clip and reasonably assumes the agent
 * heard it. Stating the limit lets the agent say so and ask for a transcript.
 */
export function unperceivedNotice(items: UnperceivedMedia[]): string | undefined {
  if (items.length === 0) return undefined;
  const kinds = [...new Set(items.map((i) => i.mime.split("/")[0]))].join(" and ");
  const list = items.map((i) => `${i.url} (${i.mime})`).join(", ");
  return (
    `This message carries ${kinds} you CANNOT perceive: ${list}. ` +
    `You have no ears and no video: do not describe, summarize, transcribe, or guess at its contents. ` +
    `Say plainly that you can't take in ${kinds} yet and ask for a transcript or a description if you need one.`
  );
}
