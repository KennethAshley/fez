import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Where the media server lives, and who can see it.
 *
 * localStorage is the webview's fast cache; ~/.fez/settings.json is the
 * custody every other surface reads. relay.ts already learned this the hard
 * way — its own comment records a GUI that wrote only its cache and "left
 * the sentinel faithfully guarding a workspace the user had moved out of."
 *
 * The media server had the same shape and a quieter symptom: the settings
 * pane wrote localStorage alone, so an agent building its fetch allowlist
 * from settings.json never learned the workspace had moved, and every image
 * silently stopped reaching the model. Nothing errored. The agent simply
 * answered as though no screenshot had been posted.
 */

const DESKTOP = path.resolve(__dirname, "../../fez-desktop");
const read = (rel: string) => fs.readFileSync(path.join(DESKTOP, rel), "utf8");

describe("media server custody", () => {
  it("the settings pane never writes the media server to the cache alone", () => {
    const pane = read("src/SettingsPane.tsx");
    expect(pane).not.toMatch(/localStorage\.setItem\(\s*["']fez-media-server["']/);
  });

  it("the one setter writes through to settings.json", () => {
    const upload = read("src/upload.ts");
    expect(upload).toMatch(/export function setMediaServer/);
    expect(upload).toMatch(/write_media_server/);
  });

  it("boot writes a cached-only value through, so existing installs heal", () => {
    const app = read("src/App.tsx");
    expect(app).toMatch(/setMediaServer\(cachedMedia\)/);
  });

  it("the rust side persists it under the key the CLI and agents read", () => {
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toMatch(/fn write_media_server/);
    expect(lib).toMatch(/"mediaServer"/);
    // Registered, or the command exists and nothing can call it.
    expect(lib).toMatch(/generate_handler!\[[^\]]*write_media_server/s);
  });
});
