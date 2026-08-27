import { describe, it, expect } from "vitest";
import { parseImeta } from "../../fez-client/dist/index.js";
import { imetaTag } from "../../fez-desktop/src/upload.js";

/**
 * NIP-92 imeta round-trip. The composer has always WRITTEN these tags
 * (upload.ts's imetaTag, attached in App.tsx's send path) and the client
 * has always dropped them on read — so every renderer was left sniffing
 * file extensions while the authoritative MIME sat unread on the same
 * event. A content-addressed blob URL is a bare hash with no extension,
 * which made that the difference between a player and a dead link.
 */
describe("parseImeta", () => {
  it("reads back exactly what the composer wrote", () => {
    const tag = imetaTag({ url: "https://blossom.example/abc", name: "clip.mp4", size: 4096, type: "video/mp4" });
    expect(parseImeta([tag])).toEqual([
      { url: "https://blossom.example/abc", mime: "video/mp4", size: 4096 },
    ]);
  });

  it("carries dim when the composer measured the media", () => {
    const tag = imetaTag({ url: "https://b.example/a", name: "a.png", size: 10, type: "image/png", dim: "1920x1080" });
    expect(parseImeta([tag])[0].dim).toBe("1920x1080");
  });

  it("keeps one entry per attachment, in order", () => {
    const entries = parseImeta([
      ["imeta", "url https://b.example/1", "m image/png"],
      ["imeta", "url https://b.example/2", "m video/mp4"],
    ]);
    expect(entries.map((e) => e.url)).toEqual(["https://b.example/1", "https://b.example/2"]);
  });

  it("ignores tags that are not imeta, and imeta with no url", () => {
    expect(parseImeta([["p", "abc"], ["imeta", "m image/png"], ["e", "def"]])).toEqual([]);
  });

  it("survives unknown and malformed fields rather than dropping the entry", () => {
    expect(parseImeta([["imeta", "url https://b.example/1", "blurhash", "alt a cat", "m image/png"]])).toEqual([
      { url: "https://b.example/1", mime: "image/png" },
    ]);
  });
});
