import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChainAdapter } from "../src/chains/adapter.js";
import { appendLog, readLog, migrateLog, type SpendEntry } from "../src/log.js";
import { tmpHome } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-mirror-"));
  process.env.FEZ_EXTENSION_DATA_DIR = dir;
});

async function readState() {
  const { STORAGE_NAME } = await import("../src/storage-mirror.js");
  return JSON.parse(fs.readFileSync(path.join(dir, `${STORAGE_NAME}.json`), "utf8"));
}

describe("storage mirror", () => {
  it("records treasury + persona addresses and endpoint", async () => {
    const { mirrorAddresses, mirrorEndpoint } = await import("../src/storage-mirror.js");
    await mirrorAddresses({ treasury: "5Treasury" });
    await mirrorAddresses({ persona: { name: "scout", address: "5Scout" } });
    await mirrorEndpoint("wss://test.finney.opentensor.ai:443");
    const s = await readState();
    expect(s.addresses).toEqual({ treasury: "5Treasury", personas: { scout: "5Scout" } });
    expect(s.endpoint).toBe("wss://test.finney.opentensor.ai:443");
  });

  it("appends spend entries and caps at 500", async () => {
    const { mirrorSpend } = await import("../src/storage-mirror.js");
    for (let i = 0; i < 502; i++) {
      await mirrorSpend({ ts: String(i), persona: "scout", to: "5X", amount: "0.001", asset: "TAO", txHash: `0x${i}`, consent: "auto", network: "test" });
    }
    const s = await readState();
    expect(s.logs.test).toHaveLength(500);
    expect(s.logs.test[499].txHash).toBe("0x501");
    expect(s.logs.test[0].txHash).toBe("0x2");
  });

  it("never throws on unwritable dir", async () => {
    process.env.FEZ_EXTENSION_DATA_DIR = "/dev/null/nope";
    const { mirrorSpend } = await import("../src/storage-mirror.js");
    await expect(
      mirrorSpend({ ts: "t", persona: "p", to: "x", amount: "1", asset: "TAO", txHash: "0x", consent: "auto", network: "test" })
    ).resolves.toBeUndefined();
  });
});

describe("CLI command regression — mirror writes complete before exit", () => {
  let walletHome: string;
  let extensionDataDir: string;

  beforeEach(() => {
    walletHome = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-cli-"));
    extensionDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fez-extension-data-"));
    process.env.FEZ_WALLET_HOME = walletHome;
    process.env.FEZ_EXTENSION_DATA_DIR = extensionDataDir;
    process.env.FEZ_WALLET_STORE = "file";
  });

  it("cmdInit completes mirror writes before returning", async () => {
    const { cmdInit } = await import("../src/cli-commands.js");
    const { STORAGE_NAME } = await import("../src/storage-mirror.js");

    const io = { print: () => {} };
    await cmdInit(io);

    // Verify mirror file exists and contains expected data at resolve time
    const state = JSON.parse(fs.readFileSync(path.join(extensionDataDir, `${STORAGE_NAME}.json`), "utf8"));
    expect(state.addresses?.treasury).toBeDefined();
    expect(state.endpoint).toBeDefined();
  });

  it("cmdDerive completes mirror writes before returning", async () => {
    const { cmdInit, cmdDerive } = await import("../src/cli-commands.js");
    const { STORAGE_NAME } = await import("../src/storage-mirror.js");

    const io = { print: () => {} };
    await cmdInit(io);
    await cmdDerive(io, "scout");

    // Verify mirror file contains persona address at resolve time
    const state = JSON.parse(fs.readFileSync(path.join(extensionDataDir, `${STORAGE_NAME}.json`), "utf8"));
    expect(state.addresses?.personas?.scout).toBeDefined();
  });

  it("cmdFund completes mirror writes before returning", async () => {
    const { cmdInit, cmdDerive, cmdFund } = await import("../src/cli-commands.js");
    const { STORAGE_NAME } = await import("../src/storage-mirror.js");

    const io = { print: () => {} };
    await cmdInit(io);
    await cmdDerive(io, "scout");

    const fakeAdapter: ChainAdapter = {
      chain: "test",
      assets: [{ symbol: "TAO", decimals: 9 }],
      address: (pair) => pair.address,
      balance: async () => ({ raw: 10n ** 10n, decimals: 9, symbol: "TAO" }),
      transfer: async () => ({ txHash: "0xtest123" }),
    };

    await cmdFund(io, fakeAdapter, "scout", "1");

    // Verify mirror file contains spend entry at resolve time
    const state = JSON.parse(fs.readFileSync(path.join(extensionDataDir, `${STORAGE_NAME}.json`), "utf8"));
    expect(state.logs?.finney).toBeDefined();
    expect(state.logs.finney.length).toBeGreaterThan(0);
    expect(state.logs.finney[0].persona).toBe("treasury");
  });
});

function entry(over: Partial<SpendEntry> = {}): SpendEntry {
  return {
    ts: "2026-08-26T00:00:00.000Z",
    persona: "scout",
    to: "5Dest",
    amount: "0.05",
    asset: "TAO",
    txHash: "0xfeed",
    consent: "auto",
    network: "test",
    ...over,
  };
}

describe("per-network ledger", () => {
  beforeEach(() => tmpHome()); // same helper as Task 1

  it("keeps networks in separate files", () => {
    appendLog(entry({ network: "test", txHash: "0xtest" }));
    appendLog(entry({ network: "finney", txHash: "0xreal" }));
    expect(readLog("test", 10).map((e) => e.txHash)).toEqual(["0xtest"]);
    expect(readLog("finney", 10).map((e) => e.txHash)).toEqual(["0xreal"]);
  });

  it("reads a missing ledger as empty", () => {
    expect(readLog("finney", 10)).toEqual([]);
  });

  it("migrates the legacy log into the testnet ledger", () => {
    const home = process.env.FEZ_WALLET_HOME!;
    const legacy = { ...entry() } as Record<string, unknown>;
    delete legacy.network;
    fs.writeFileSync(path.join(home, "wallet-log.jsonl"), JSON.stringify(legacy) + "\n");
    migrateLog();
    expect(readLog("test", 10)).toHaveLength(1);
    expect(readLog("test", 10)[0].network).toBe("test");
    expect(fs.existsSync(path.join(home, "wallet-log.jsonl"))).toBe(false);
  });

  it("does not clobber an existing per-network ledger when migrating", () => {
    const home = process.env.FEZ_WALLET_HOME!;
    appendLog(entry({ txHash: "0xalready" }));
    fs.writeFileSync(path.join(home, "wallet-log.jsonl"), JSON.stringify(entry()) + "\n");
    migrateLog();
    expect(readLog("test", 10).map((e) => e.txHash)).toEqual(["0xalready"]);
  });
});
