import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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

  it("carries a secretSeed that reconstructs the SAME key (fiber's only load path)", async () => {
    const { mnemonicToMiniSecret, sr25519PairFromSeed, encodeAddress } = await import("@polkadot/util-crypto");
    const { hexToU8a } = await import("@polkadot/util");
    const m = generateWalletMnemonic();
    const k = keyfileFor(m);
    expect(k.secretSeed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(k.secretSeed).toBe(`0x${Buffer.from(mnemonicToMiniSecret(m)).toString("hex")}`);
    // The seed round-trips to the advertised address — what fiber's
    // Keypair.create_from_seed will produce on the miner's machine.
    const rebuilt = sr25519PairFromSeed(hexToU8a(k.secretSeed));
    expect(encodeAddress(rebuilt.publicKey, 42)).toBe(k.ss58Address);
  });
});

describe("exportRemoteHotkey", () => {
  beforeEach(() => {
    process.env.FEZ_WALLET_STORE = "file";
    process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-remote-hotkey-"));
  });

  it("includes the treasury coldkeypub (public half ONLY) when a root exists", async () => {
    const { writeRootEntry } = await import("../src/store.js");
    const { treasuryPair, generateWalletMnemonic: gen } = await import("../src/derive.js");
    const root = gen();
    writeRootEntry(root);
    const r = await exportRemoteHotkey("gauss");
    expect(r.coldkeypub).toBeDefined();
    // Exactly the public fields — a secret leaking in here would ship the
    // treasury to a rented box.
    expect(Object.keys(r.coldkeypub!).sort()).toEqual(["accountId", "publicKey", "ss58Address"]);
    expect(r.coldkeypub!.ss58Address).toBe(treasuryPair(root).address);
    expect(JSON.stringify(r.coldkeypub)).not.toContain(root.split(" ")[0]);
  });

  it("creates a fresh standalone key on first export", async () => {
    const r = await exportRemoteHotkey("quill");
    expect(r.persona).toBe("quill");
    expect(r.created).toBe(true);
    expect(r.ss58Address).toBe(r.keyfile.ss58Address);
    expect((r.keyfile as { secretPhrase: string }).secretPhrase.split(" ")).toHaveLength(24);
  });

  it("existing-only refuses a missing key without creating any wallet entry", async () => {
    await expect(exportRemoteHotkey("quill", { existing: true })).rejects.toThrow(/existing.*hotkey/i);
    expect(fs.readdirSync(process.env.FEZ_WALLET_HOME!)).toEqual([]);
  });

  it("existing-only reuses a stored key without changing it", async () => {
    const first = await exportRemoteHotkey("quill");
    const file = path.join(process.env.FEZ_WALLET_HOME!, "wallet-store", "remote-hotkey", "quill");
    const before = fs.statSync(file).mtimeMs;
    const second = await exportRemoteHotkey("quill", { existing: true });
    expect(second).toEqual({ ...first, created: false });
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it("CLI --existing refuses missing keys and exports a stored key without changing it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-existing-cli-"));
    const outfile = path.join(dir, "wallet.mjs");
    try {
      await build({ entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))], outfile,
        bundle: true, platform: "node", format: "esm", logLevel: "silent",
        banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" } });
      const invoke = () => spawnSync(process.execPath, [outfile, "export-hotkey", "--existing", "quill", "--json"], {
        encoding: "utf8", timeout: 15000, env: { ...process.env, FEZ_EXTENSION_DATA_DIR: dir },
      });
      const missing = invoke();
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).toMatch(/existing.*hotkey/i);
      expect(fs.readdirSync(process.env.FEZ_WALLET_HOME!)).toEqual([]);
      const first = await exportRemoteHotkey("quill");
      const existing = invoke();
      expect(existing.status).toBe(0);
      const result = JSON.parse(existing.stdout);
      expect(result.created).toBe(false);
      expect(result.ss58Address).toBe(first.ss58Address);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
