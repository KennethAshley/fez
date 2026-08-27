import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { reconcileMediaServer } from "../../fez-desktop/src/upload.js";

/**
 * Where the media server lives, and who wins when two places disagree.
 *
 * localStorage is the webview's fast cache; ~/.fez/settings.json is the
 * custody every other surface reads — the CLI, and every agent building
 * its media fetch allowlist. relay.ts records the same lesson: a GUI that
 * wrote only its cache "left the sentinel faithfully guarding a workspace
 * the user had moved out of."
 *
 * The first pass at this healed the cache INTO settings.json on every
 * boot, which made the cache permanently outrank custody: edit
 * settings.json from the CLI and the next launch silently reverted it —
 * against exactly the bring-your-own-server person the change was for.
 */
describe("reconcileMediaServer", () => {
  it("lets custody win — a settings.json edit reaches the GUI", () => {
    expect(reconcileMediaServer({ stored: "https://mine.example", cached: "https://old.example" })).toEqual({
      setCache: "https://mine.example",
    });
  });

  it("heals an install whose value only ever reached the cache", () => {
    expect(reconcileMediaServer({ stored: "", cached: "https://old.example" })).toEqual({
      writeThrough: "https://old.example",
    });
  });

  it("does nothing when the two already agree", () => {
    expect(reconcileMediaServer({ stored: "https://same.example", cached: "https://same.example" })).toEqual({});
  });

  it("does nothing on a fresh install with neither", () => {
    expect(reconcileMediaServer({ stored: "", cached: "" })).toEqual({});
  });

  it("treats whitespace as absence rather than writing a blank through", () => {
    expect(reconcileMediaServer({ stored: "  ", cached: "  " })).toEqual({});
  });
});

/**
 * The pieces that can only be checked in the source, kept to the smallest
 * claims a grep can honestly make.
 */
describe("media server wiring", () => {
  const DESKTOP = path.resolve(__dirname, "../../fez-desktop");
  const read = (rel: string) => fs.readFileSync(path.join(DESKTOP, rel), "utf8");

  it("the settings pane never writes the media server to the cache alone", () => {
    expect(read("src/SettingsPane.tsx")).not.toMatch(/localStorage\.setItem\(\s*["']fez-media-server["']/);
  });

  it("saving reports failure instead of flashing success over it", () => {
    const pane = read("src/SettingsPane.tsx");
    expect(pane).toMatch(/await setMediaServer\(/);
    expect(pane).toMatch(/catch/);
  });

  it("the rust side persists and reads it under the key the CLI and agents use", () => {
    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toMatch(/fn write_media_server/);
    expect(lib).toMatch(/fn read_media_server/);
    expect(lib).toMatch(/"mediaServer"/);
    expect(lib).toMatch(/generate_handler!\[[^\]]*write_media_server/s);
    expect(lib).toMatch(/generate_handler!\[[^\]]*read_media_server/s);
  });
});
