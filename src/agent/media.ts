/**
 * What an agent knows about the files in a message — and what it costs to
 * find out.
 *
 * Attachments are DESCRIBED for free and fetched only when the model asks.
 * The description comes from the NIP-92 imeta the sender already wrote, so
 * listing them costs no network at all; the bytes are spent by a deliberate
 * `fez_view_attachment` call. The alternative fez shipped first — fetching
 * every image on every addressed turn — spent megabytes of base64 on memes
 * nobody asked the agent to look at.
 *
 * Buzz reaches the same place from the other side: images enter its agents
 * only as tool results, under a byte budget, because a tool result is
 * somewhere it already meters bytes.
 */

/** The public Blossom server the desktop uploader defaults to. */
const DEFAULT_MEDIA_HOST = "blossom.primal.net";

/** Big enough for a screenshot, small enough not to eat a turn's context. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface Attachment {
  url: string;
  /** From imeta. Absent for a bare pasted URL — only a fetch can say. */
  mime?: string;
  size?: number;
}

export type FetchedAttachment =
  | { ok: true; data: string; mimeType: string }
  | { ok: false; reason: string };

function hostOf(value: string): string | undefined {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host;
  } catch {
    return undefined;
  }
}

/**
 * Hosts an agent will fetch from. A channel message is UNTRUSTED text —
 * anyone in the room wrote it — so following an arbitrary URL out of it is
 * an SSRF hole (a link-local metadata endpoint is one paste away), whether
 * a human or a model chose to follow it.
 *
 * A UNION, not a precedence chain: settings.json's `mediaServer` and
 * `FEZ_MEDIA_SERVER` are two spellings of "where this workspace keeps its
 * blobs", written by two different surfaces. Consulting only one meant a
 * person who moved off the default had every image silently refused.
 */
export function allowedMediaHosts(opts: {
  settingsMediaServer?: string;
  env?: { FEZ_MEDIA_SERVER?: string };
}): Set<string> {
  const hosts = new Set([DEFAULT_MEDIA_HOST]);
  for (const candidate of [opts.settingsMediaServer, opts.env?.FEZ_MEDIA_SERVER]) {
    if (!candidate) continue;
    const host = hostOf(candidate);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Everything attached to a message, from its own tags and body. No network.
 *
 * imeta is the good source — the sender declared the type and size — and
 * it is the ONLY source that can describe a content-addressed blob, whose
 * URL is a bare sha256 with no extension to read. Bare URLs in the body are
 * listed too, undescribed, because an agent pasting a link is still
 * offering something to look at.
 */
export function attachmentsOf(event: { content: string; tags: string[][] }): Attachment[] {
  const byUrl = new Map<string, Attachment>();
  for (const tag of event.tags) {
    if (tag[0] !== "imeta") continue;
    const fields = new Map<string, string>();
    for (const part of tag.slice(1)) {
      const space = part.indexOf(" ");
      if (space > 0) fields.set(part.slice(0, space), part.slice(space + 1));
    }
    const url = fields.get("url");
    if (!url) continue;
    const size = Number(fields.get("size"));
    byUrl.set(url, {
      url,
      ...(fields.get("m") ? { mime: fields.get("m") } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    });
  }
  for (const match of event.content.matchAll(/https?:\/\/[^\s)]+/g)) {
    if (!byUrl.has(match[0])) byUrl.set(match[0], { url: match[0] });
  }
  return [...byUrl.values()];
}

const human = (bytes?: number): string =>
  bytes === undefined ? "" : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The prompt line that makes the tool reachable.
 *
 * Load-bearing, not decoration: without it the model never learns there is
 * anything to look at, and an on-demand tool nobody calls is the same as no
 * vision at all.
 *
 * Audio and video are listed as flatly unavailable rather than offered to
 * the tool. Sending the model to fetch something that can only answer "you
 * can't hear this" spends a turn to learn what we already know.
 */
export function attachmentNotice(items: Attachment[]): string | undefined {
  if (items.length === 0) return undefined;
  const unperceivable = items.filter((a) => /^(audio|video)\//.test(a.mime ?? ""));
  const viewable = items.filter((a) => !unperceivable.includes(a));
  const lines: string[] = [];
  if (viewable.length > 0) {
    lines.push(
      `This message has ${viewable.length} attachment(s). You have NOT seen them. ` +
        `Call fez_view_attachment with a url below to look at one, and only if looking would actually help:`,
      ...viewable.map((a) => `- ${a.url}${a.mime ? ` (${a.mime}${a.size ? `, ${human(a.size)}` : ""})` : ""}`)
    );
  }
  if (unperceivable.length > 0) {
    const kinds = [...new Set(unperceivable.map((a) => a.mime!.split("/")[0]))].join(" and ");
    lines.push(
      `This message also carries ${kinds} you CANNOT perceive: ${unperceivable.map((a) => a.url).join(", ")}. ` +
        `You have no ears and no video, and no tool will give you them: do not describe, summarize, transcribe, or guess. ` +
        `Say plainly that you can't take in ${kinds} yet and ask for a transcript or a description if you need one.`
    );
  }
  return lines.join("\n");
}

/**
 * Fetch one attachment, on purpose, because something asked for it.
 *
 * Classified by the SERVED content-type rather than the file extension: a
 * Blossom URL is a bare sha256, so the response is the only honest source.
 * Every refusal explains itself — the model is about to write a sentence to
 * a person about why it couldn't look, and "failed" is not a reason.
 */
export async function fetchAttachment(
  url: string,
  opts: { hosts: Set<string>; timeoutMs?: number }
): Promise<FetchedAttachment> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { ok: false, reason: `"${url}" is not a url` };
  }
  if (!opts.hosts.has(host)) {
    return {
      ok: false,
      reason: `${host} is not this workspace's media server, so it will not be fetched (settings.json mediaServer or FEZ_MEDIA_SERVER sets that)`,
    };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) return { ok: false, reason: `the server answered ${res.status}` };
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (/^(audio|video)\//.test(mime)) {
      return { ok: false, reason: `this is ${mime} — you have no ears and no video, so there is nothing here you can take in` };
    }
    if (!mime.startsWith("image/")) {
      return { ok: false, reason: `this is ${mime}, which is not something you can look at` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, reason: "the file is empty" };
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      return { ok: false, reason: `the image is too large to look at (${human(buf.length)}, limit 8.0 MB)` };
    }
    return { ok: true, data: buf.toString("base64"), mimeType: mime };
  } catch (err) {
    return { ok: false, reason: `couldn't be fetched (${err instanceof Error ? err.message : String(err)})` };
  }
}
