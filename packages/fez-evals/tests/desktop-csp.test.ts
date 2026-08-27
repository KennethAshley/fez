import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The CSP is a place where a missing line fails silently and looks like a
 * broken feature. `img-src` allowed `https:` while `media-src` was absent
 * entirely, so it inherited `default-src 'self'` — meaning a <video> or
 * <audio> pointing at any Blossom server rendered as a dead player with no
 * console error worth noticing. Buzz pins its directives in a test
 * (desktop/src-tauri/tests/csp.rs) for the same reason.
 */

const CONF = path.resolve(__dirname, "../../fez-desktop/src-tauri/tauri.conf.json");

function directive(name: string): string[] {
  const conf = JSON.parse(fs.readFileSync(CONF, "utf8"));
  const csp = conf.app.security.csp as Record<string, string>;
  return (csp[name] ?? "").split(/\s+/).filter(Boolean);
}

describe("desktop CSP", () => {
  it("lets remote blobs load for every media element, not just images", () => {
    for (const name of ["img-src", "media-src"]) {
      expect(directive(name), name).toContain("https:");
    }
  });

  it("allows the local and in-memory sources a player needs", () => {
    for (const name of ["img-src", "media-src"]) {
      expect(directive(name), name).toContain("'self'");
      expect(directive(name), name).toContain("blob:");
    }
  });
});
