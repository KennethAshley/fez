import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChainAdapter } from "../src/chains/adapter.js";

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
      await mirrorSpend({ ts: String(i), persona: "scout", to: "5X", amount: "0.001", asset: "TAO", txHash: `0x${i}`, consent: "auto" });
    }
    const s = await readState();
    expect(s.log).toHaveLength(500);
    expect(s.log[499].txHash).toBe("0x501");
    expect(s.log[0].txHash).toBe("0x2");
  });

  it("never throws on unwritable dir", async () => {
    process.env.FEZ_EXTENSION_DATA_DIR = "/dev/null/nope";
    const { mirrorSpend } = await import("../src/storage-mirror.js");
    await expect(
      mirrorSpend({ ts: "t", persona: "p", to: "x", amount: "1", asset: "TAO", txHash: "0x", consent: "auto" })
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
    expect(state.log).toBeDefined();
    expect(state.log.length).toBeGreaterThan(0);
    expect(state.log[0].persona).toBe("treasury");
  });
});
