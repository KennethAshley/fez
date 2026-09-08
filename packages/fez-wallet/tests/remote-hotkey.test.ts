import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyfileFor, exportRemoteHotkey } from "../src/cli-commands.js";
import { generateWalletMnemonic } from "../src/derive.js";

beforeAll(async () => {
  await cryptoWaitReady();
});

describe("remote hotkey keyfile", () => {
  it("shapes a btcli-loadable keyfile from a mnemonic", () => {
    const m = generateWalletMnemonic();
    const k = keyfileFor(m);
    expect(k.secretPhrase).toBe(m);
    expect(k.ss58Address).toMatch(/^5/);
    expect(k.publicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(k.accountId).toBe(k.publicKey);
  });
  it("is deterministic for the same mnemonic", () => {
    const m = generateWalletMnemonic();
    expect(keyfileFor(m)).toEqual(keyfileFor(m));
  });
});

describe("exportRemoteHotkey", () => {
  beforeEach(() => {
    process.env.FEZ_WALLET_STORE = "file";
    process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-remote-hotkey-"));
  });

  it("creates a fresh standalone key on first export", async () => {
    const r = await exportRemoteHotkey("quill");
    expect(r.persona).toBe("quill");
    expect(r.created).toBe(true);
    expect(r.ss58Address).toBe(r.keyfile.ss58Address);
    expect((r.keyfile as { secretPhrase: string }).secretPhrase.split(" ")).toHaveLength(24);
  });

  it("loads the same key on a second export (create-or-load, idempotent)", async () => {
    const first = await exportRemoteHotkey("quill");
    const second = await exportRemoteHotkey("quill");
    expect(second.created).toBe(false);
    expect(second.ss58Address).toBe(first.ss58Address);
    expect(second.keyfile).toEqual(first.keyfile);
  });

  it("gives distinct personas distinct keys", async () => {
    const a = await exportRemoteHotkey("quill");
    const b = await exportRemoteHotkey("scout");
    expect(a.ss58Address).not.toBe(b.ss58Address);
  });

  it("never touches the root entry — stored under its own namespaced file", async () => {
    const home = process.env.FEZ_WALLET_HOME as string;
    await exportRemoteHotkey("quill");
    expect(fs.existsSync(path.join(home, "wallet-store", "root"))).toBe(false);
    expect(fs.existsSync(path.join(home, "wallet-store", "remote-hotkey", "quill"))).toBe(true);
  });
});
