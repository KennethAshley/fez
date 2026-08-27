import { describe, it, expect } from "vitest";
import { MIME_BY_EXT } from "../../fez-media/src/blossom.js";
import { mediaKind, embedUrls, PLAYABLE_URL } from "../../fez-desktop/src/media-kind.js";

/**
 * The renderer's media table is a deliberate dependency-light mirror of
 * fez-media's MIME_BY_EXT — the same arrangement as fez-client's `K`
 * mirroring the kind registry, and gated the same way, because the webview
 * can't import the extension package.
 *
 * Drift here is silent and user-visible: a format fez-media happily uploads
 * that the renderer doesn't recognize arrives as a bare link, which is
 * exactly the "broken bubble" this work exists to remove.
 */
describe("media table mirrors fez-media", () => {
  const playable = Object.entries(MIME_BY_EXT).filter(([, mime]) =>
    /^(image|video|audio)\//.test(mime)
  );

  it("classifies every playable extension fez-media can upload", () => {
    const unclassified = playable.filter(
      ([ext]) => mediaKind(`https://blossom.example/blob.${ext}`) === undefined
    );
    expect(unclassified).toEqual([]);
  });

  it("agrees with fez-media on which kind each extension is", () => {
    for (const [ext, mime] of playable) {
      expect(mediaKind(`https://blossom.example/blob.${ext}`), ext).toBe(mime.split("/")[0]);
    }
  });

  it("leaves non-media formats alone so they stay ordinary links", () => {
    for (const ext of ["pdf", "txt", "md", "json", "zip"]) {
      expect(mediaKind(`https://blossom.example/blob.${ext}`), ext).toBeUndefined();
    }
  });
});

/**
 * NIP-92 imeta is the authority: the uploader knew the real type and said
 * so on the event (upload.ts's imetaTag). Extension sniffing is the legacy
 * fallback for messages that carry no imeta — and for content-addressed
 * blobs, whose URLs are a hash with no extension at all.
 */
describe("imeta outranks the URL", () => {
  it("uses the declared mime when the URL can't say", () => {
    expect(mediaKind("https://blossom.example/abc123", "video/mp4")).toBe("video");
    expect(mediaKind("https://blossom.example/abc123", "audio/ogg")).toBe("audio");
    expect(mediaKind("https://blossom.example/abc123", "image/avif")).toBe("image");
  });

  it("believes the declared mime over a misleading extension", () => {
    expect(mediaKind("https://blossom.example/clip.png", "video/mp4")).toBe("video");
  });

  it("falls back to the extension when imeta is absent or unhelpful", () => {
    expect(mediaKind("https://blossom.example/clip.mp4")).toBe("video");
    expect(mediaKind("https://blossom.example/clip.mp4", "application/octet-stream")).toBe("video");
  });

  it("classifies nothing it cannot identify — the link stays a link", () => {
    expect(mediaKind("https://blossom.example/abc123")).toBeUndefined();
    expect(mediaKind("https://example.com/page")).toBeUndefined();
  });
});

describe("PLAYABLE_URL", () => {
  it("matches media URLs with query strings and ignores case", () => {
    const found = "see https://blossom.example/a.MP4?x=1 and https://b.example/c.wav".match(PLAYABLE_URL);
    expect(found).toEqual(["https://blossom.example/a.MP4?x=1", "https://b.example/c.wav"]);
  });

  it("does not match a bare hash URL", () => {
    expect("https://blossom.example/abc123".match(PLAYABLE_URL)).toBeNull();
  });
});

/**
 * One url, one player. The markdown renderer draws `![](url)` itself, and
 * the bare-url sweep used to append a SECOND element for the same url —
 * invisible enough with images that it shipped, unmissable once a posted
 * clip became two stacked <video> players.
 */
describe("embedUrls", () => {
  it("does not append a player for media markdown already rendered", () => {
    expect(embedUrls("look: ![](https://b.example/clip.mp4)")).toEqual([]);
  });

  it("still appends a player for a bare url in the prose", () => {
    expect(embedUrls("look: https://b.example/clip.mp4")).toEqual(["https://b.example/clip.mp4"]);
  });

  it("appends the blob from fez-media's share line", () => {
    expect(embedUrls("📎 clip.mp4 (2.0 MB) https://b.example/abc.mp4")).toEqual(["https://b.example/abc.mp4"]);
  });

  it("shows a declared attachment the body never mentioned", () => {
    expect(embedUrls("here you go", [{ url: "https://b.example/hash", mime: "video/mp4" }])).toEqual([
      "https://b.example/hash",
    ]);
  });

  it("does not double a declared attachment that IS in the body as markdown", () => {
    expect(
      embedUrls("![](https://b.example/hash)", [{ url: "https://b.example/hash", mime: "image/png" }])
    ).toEqual([]);
  });

  it("lists a url once even when the share line and the sweep both find it", () => {
    const found = embedUrls("📎 a.png (1 KB) https://b.example/a.png https://b.example/a.png");
    expect(found).toEqual(["https://b.example/a.png"]);
  });
});
