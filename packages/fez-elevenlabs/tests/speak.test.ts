import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkText, imetaFor, matchChannel, readVoicePrefs } from "../src/speak.js";

describe("checkText", () => {
  it("passes normal text", () => {
    expect(checkText("hello channel")).toBeUndefined();
  });
  it("rejects empty and whitespace", () => {
    expect(checkText("   ")).toMatch(/empty/i);
  });
  it("rejects over 2500 chars with a loud, actionable error", () => {
    const err = checkText("x".repeat(2501));
    expect(err).toMatch(/2500/);
    expect(err).toMatch(/shorten/i);
  });
  it("2500 exactly is allowed", () => {
    expect(checkText("x".repeat(2500))).toBeUndefined();
  });
});

describe("imetaFor", () => {
  it("matches the composer's NIP-92 shape", () => {
    expect(imetaFor("https://x/abc.mp3", 1234)).toEqual([
      "imeta",
      "url https://x/abc.mp3",
      "m audio/mpeg",
      "size 1234",
    ]);
  });
});

describe("matchChannel", () => {
  const channels = [
    { tags: [["d", "abc123"], ["name", "general"]], content: "" },
    { tags: [["d", "def456"]], content: JSON.stringify({ name: "random" }) },
  ];

  it("matches by id", () => {
    expect(matchChannel(channels, "abc123")).toBe("abc123");
  });
  it("matches by name tag, case-insensitive, # stripped", () => {
    expect(matchChannel(channels, "#General")).toBe("abc123");
  });
  it("matches by name parsed from content JSON", () => {
    expect(matchChannel(channels, "random")).toBe("def456");
  });
  it("a successful query with no match returns undefined — distinct from a query failure", () => {
    expect(matchChannel(channels, "nope")).toBeUndefined();
    expect(matchChannel([], "anything")).toBeUndefined();
  });
});

describe("readVoicePrefs", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-elevenlabs-prefs-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns {} when neither file exists", () => {
    expect(readVoicePrefs(dir)).toEqual({});
  });

  it("reads the de-scoped npm name (elevenlabs.json) when present", () => {
    fs.writeFileSync(
      path.join(dir, "elevenlabs.json"),
      JSON.stringify({ prefs: { voices: { quill: "abc" } } })
    );
    expect(readVoicePrefs(dir)).toEqual({ quill: "abc" });
  });

  it("falls back to the link name (fez-elevenlabs.json) when elevenlabs.json is missing", () => {
    fs.writeFileSync(
      path.join(dir, "fez-elevenlabs.json"),
      JSON.stringify({ prefs: { voices: { quill: "def" } } })
    );
    expect(readVoicePrefs(dir)).toEqual({ quill: "def" });
  });

  it("falls back when elevenlabs.json exists but has no voices", () => {
    fs.writeFileSync(path.join(dir, "elevenlabs.json"), JSON.stringify({ prefs: {} }));
    fs.writeFileSync(
      path.join(dir, "fez-elevenlabs.json"),
      JSON.stringify({ prefs: { voices: { quill: "ghi" } } })
    );
    expect(readVoicePrefs(dir)).toEqual({ quill: "ghi" });
  });

  it("prefers elevenlabs.json over fez-elevenlabs.json when both have voices", () => {
    fs.writeFileSync(
      path.join(dir, "elevenlabs.json"),
      JSON.stringify({ prefs: { voices: { quill: "npm" } } })
    );
    fs.writeFileSync(
      path.join(dir, "fez-elevenlabs.json"),
      JSON.stringify({ prefs: { voices: { quill: "link" } } })
    );
    expect(readVoicePrefs(dir)).toEqual({ quill: "npm" });
  });
});
