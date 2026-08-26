import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-test-"));
  process.env.FEZ_WALLET_STORE = "file";
  process.env.FEZ_WALLET_HOME = home;
});

describe("store (file backend)", () => {
  it("round-trips an entry", async () => {
    const { writeEntry, readEntry } = await import("../src/store.js");
    writeEntry("scout", '{"hello":"world"}');
    expect(readEntry("scout")).toBe('{"hello":"world"}');
  });

  it("returns undefined for a missing entry", async () => {
    const { readEntry } = await import("../src/store.js");
    expect(readEntry("nobody")).toBeUndefined();
  });

  it("writes files 0600", async () => {
    const { writeEntry } = await import("../src/store.js");
    writeEntry("scout", "x");
    const mode = fs.statSync(path.join(home, "wallet-store", "scout")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects traversal- and dotfile-shaped names on both read and write", async () => {
    const { readEntry, writeEntry } = await import("../src/store.js");
    for (const bad of ["../x", "a/b", ".hidden", "/etc/passwd"]) {
      expect(() => readEntry(bad)).toThrow(/invalid entry name/i);
      expect(() => writeEntry(bad, "x")).toThrow(/invalid entry name/i);
    }
    // and none of those attempts touched the filesystem outside wallet-store
    expect(fs.existsSync(path.join(home, "wallet-store"))).toBe(false);
  });

  it("rejects the reserved root name via the generic entry path", async () => {
    const { readEntry, writeEntry } = await import("../src/store.js");
    expect(() => readEntry("root")).toThrow(/reserved/i);
    expect(() => writeEntry("root", "x")).toThrow(/reserved/i);
  });

  it("rejects case variants of the reserved name (case-insensitive filesystems alias them)", async () => {
    const { readEntry, writeEntry, writeRootEntry } = await import("../src/store.js");
    writeRootEntry("secret words here");
    for (const alias of ["ROOT", "Root", "rOoT"]) {
      expect(() => readEntry(alias)).toThrow(/reserved/i);
      expect(() => writeEntry(alias, "x")).toThrow(/reserved/i);
    }
  });

  it("readRootEntry/writeRootEntry reach the reserved entry the generic path refuses", async () => {
    const { readRootEntry, writeRootEntry, readEntry } = await import("../src/store.js");
    expect(readRootEntry()).toBeUndefined();
    writeRootEntry("twenty four words go here");
    expect(readRootEntry()).toBe("twenty four words go here");
    expect(() => readEntry("root")).toThrow(/reserved/i); // still refused generically
  });
});
