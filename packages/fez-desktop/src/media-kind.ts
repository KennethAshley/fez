/**
 * What kind of thing is at the end of this URL — and therefore which
 * element should render it.
 *
 * A dependency-light mirror of fez-media's MIME_BY_EXT, the same
 * arrangement as fez-client's `K` mirroring the kind registry: the webview
 * can't import the extension package, so the table lives here and a test
 * (fez-evals/tests/media-kind.test.ts) makes drift a failure instead of a
 * silently unrenderable format.
 */

export type MediaKind = "image" | "video" | "audio";

const KIND_BY_EXT: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  mp4: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
};

/** Bare media URLs in message prose — the same shape as a markdown-less paste. */
export const PLAYABLE_URL = new RegExp(
  `https?://\\S+\\.(?:${Object.keys(KIND_BY_EXT).join("|")})(?:\\?\\S*)?`,
  "gi"
);

/** 📎 name.ext (size) url — fez-media's share line, one format for every surface. */
export const MEDIA_LINE = new RegExp(
  `📎\\s+(\\S+\\.(?:${Object.keys(KIND_BY_EXT).join("|")}))\\s+\\([^)]*\\)\\s+(https?://\\S+)`,
  "i"
);

function extensionOf(url: string): string {
  const last = url.split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
}

/**
 * NIP-92 imeta wins when present: the uploader knew the real type and put
 * it on the event (upload.ts's imetaTag), which is the only thing that can
 * classify a content-addressed blob whose URL is a bare hash. The
 * extension is the fallback for messages that carry no imeta — agent posts,
 * pasted links, anything authored outside the composer.
 *
 * Returns undefined for everything it can't identify, and that is a
 * deliberate answer, not a failure: an unrecognized URL stays an ordinary
 * link rather than becoming a player that will never play.
 */
export function mediaKind(url: string, mime?: string): MediaKind | undefined {
  const declared = /^(image|video|audio)\//.exec(mime ?? "")?.[1];
  if (declared) return declared as MediaKind;
  return KIND_BY_EXT[extensionOf(url)];
}

/**
 * Which urls in a message body deserve their own player, appended below
 * the prose.
 *
 * Markdown media syntax is EXCLUDED, because the markdown renderer already
 * drew it: `![](clip.mp4)` matched both the img component override and the
 * bare-url sweep, so a posted video rendered two players stacked on top of
 * each other (harmless-looking for images, which is why it survived; very
 * obvious once the same URL became a <video>).
 *
 * Attachments the sender declared but never wrote into the body are added
 * too — an imeta-only message would otherwise be an empty bubble.
 */
export function embedUrls(text: string, media?: { url: string; mime?: string }[]): string[] {
  // Blank out ![alt](url) first; what the markdown renderer handles is not
  // ours to append.
  const prose = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  const shareLine = prose.match(MEDIA_LINE);
  const urls = new Set([...(prose.match(PLAYABLE_URL) ?? []), ...(shareLine ? [shareLine[2]] : [])]);
  for (const entry of media ?? []) {
    if (mediaKind(entry.url, entry.mime) && !text.includes(`](${entry.url})`)) urls.add(entry.url);
  }
  return [...urls];
}
