import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import type { ChainAdapter } from "../src/chains/adapter.js";

beforeEach(async () => {
  process.env.FEZ_WALLET_STORE = "file";
  process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-cli-"));
  process.env.FEZ_EXTENSION_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-ext-"));
  await cryptoWaitReady();
});

function collect() {
  const lines: string[] = [];
  return { io: { print: (l: string) => lines.push(l) }, lines };
}

function fakeAdapter() {
  const transfers: { to: string; raw: bigint }[] = [];
  const adapter: ChainAdapter = {
    chain: "tao",
    assets: [{ symbol: "TAO", decimals: 9 }],
    address: (p) => p.address,
    balance: async () => ({ raw: 5_000_000_000n, decimals: 9, symbol: "TAO" }),
    transfer: async (_p, to, amount) => {
      transfers.push({ to, raw: amount.raw });
      return { txHash: "0xcafe" };
    },
  };
  return { adapter, transfers };
}

describe("cli ceremony", () => {
  it("init generates and stores a mnemonic, printing it exactly once", async () => {
    const { cmdInit } = await import("../src/cli-commands.js");
    const { readRootEntry } = await import("../src/store.js");
    const { io, lines } = collect();
    await cmdInit(io);
    const root = readRootEntry();
    expect(root!.split(" ")).toHaveLength(24);
    expect(lines.join("\n")).toContain(root!); // shown for paper backup
    await expect(cmdInit(io)).rejects.toThrow(/already/i); // refuses a second init
  });

  it("derive stores the pair, assigns an index, and is idempotent", async () => {
    const { cmdInit, cmdDerive } = await import("../src/cli-commands.js");
    const { readEntry } = await import("../src/store.js");
    const { loadConfig } = await import("../src/config.js");
    const { pairFromStored } = await import("../src/derive.js");
    const { io, lines } = collect();
    await cmdInit(io);
    await cmdDerive(io, "scout");
    const stored = pairFromStored(readEntry("scout")!);
    expect(loadConfig().personas.scout.index).toBe(0);
    expect(lines.join("\n")).toContain(stored.address);
    await cmdDerive(io, "scout"); // no throw, same address printed again
    expect(pairFromStored(readEntry("scout")!).address).toBe(stored.address);
  });

  it("fund moves treasury → persona via the adapter", async () => {
    const { cmdInit, cmdDerive, cmdFund } = await import("../src/cli-commands.js");
    const { readEntry } = await import("../src/store.js");
    const { pairFromStored } = await import("../src/derive.js");
    const { io } = collect();
    await cmdInit(io);
    await cmdDerive(io, "scout");
    const { adapter, transfers } = fakeAdapter();
    await cmdFund(io, adapter, "scout", "1.5");
    expect(transfers[0].to).toBe(pairFromStored(readEntry("scout")!).address);
    expect(transfers[0].raw).toBe(1_500_000_000n);
  });

  it("status lists treasury and derived personas", async () => {
    const { cmdInit, cmdDerive, cmdStatus } = await import("../src/cli-commands.js");
    const { io, lines } = collect();
    await cmdInit(io);
    await cmdDerive(io, "scout");
    const { adapter } = fakeAdapter();
    await cmdStatus(io, adapter);
    const out = lines.join("\n");
    expect(out).toContain("treasury");
    expect(out).toContain("scout");
    expect(out).toContain("5 TAO");
  });

  it("status refreshes the extension-data mirror with treasury address and endpoint", async () => {
    const { cmdInit, cmdStatus } = await import("../src/cli-commands.js");
    const { io } = collect();
    await cmdInit(io);
    const { adapter } = fakeAdapter();
    await cmdStatus(io, adapter);
    // Verify mirror was written to the temp FEZ_EXTENSION_DATA_DIR, not the real home
    const mirrorFile = path.join(process.env.FEZ_EXTENSION_DATA_DIR!, "wallet.json");
    const mirror = JSON.parse(await fs.promises.readFile(mirrorFile, "utf8"));
    expect(mirror.addresses?.treasury).toBeDefined();
    expect(mirror.endpoint).toBeDefined();
  });

  it("derive without init explains itself", async () => {
    const { cmdDerive } = await import("../src/cli-commands.js");
    const { io } = collect();
    await expect(cmdDerive(io, "scout")).rejects.toThrow(/fez-wallet init/);
  });

  it("derive refuses the reserved root name — clearly, before touching the mnemonic", async () => {
    const { cmdInit, cmdDerive } = await import("../src/cli-commands.js");
    const { io } = collect();
    await cmdInit(io);
    await expect(cmdDerive(io, "root")).rejects.toThrow(/reserved/i);
  });

  it("derive refuses traversal-shaped persona names", async () => {
    const { cmdInit, cmdDerive } = await import("../src/cli-commands.js");
    const { io } = collect();
    await cmdInit(io);
    await expect(cmdDerive(io, "../x")).rejects.toThrow(/invalid persona name/i);
    await expect(cmdDerive(io, "a/b")).rejects.toThrow(/invalid persona name/i);
  });
});
