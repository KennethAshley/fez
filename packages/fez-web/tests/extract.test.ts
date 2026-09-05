import { describe, expect, it } from "vitest";
import { extractReadable } from "../src/extract.js";

const ARTICLE = `<!doctype html><html><head><title>Octopus Hearts</title></head><body>
<nav>Home | About | Junk sidebar links</nav>
<article><h1>Octopus Hearts</h1><p>${"Octopuses have three hearts. ".repeat(40)}</p>
<p>The blood is blue because of hemocyanin.</p></article>
<footer>© 2026 junk</footer></body></html>`;

describe("extractReadable", () => {
  it("pulls the article, drops the chrome", () => {
    const r = extractReadable(ARTICLE, "https://example.com/octopus");
    expect(r.title).toContain("Octopus");
    expect(r.text).toContain("hemocyanin");
    expect(r.text).not.toContain("Junk sidebar");
  });
  it("caps and marks truncation", () => {
    const r = extractReadable(ARTICLE, "https://example.com/octopus", 200);
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.truncated).toBe(true);
  });
  it("survives garbage html without throwing", () => {
    const r = extractReadable("<div<<<>>>not html at all", "https://example.com/x");
    expect(typeof r.text).toBe("string");
  });
});
