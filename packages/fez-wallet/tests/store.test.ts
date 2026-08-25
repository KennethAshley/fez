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
});
