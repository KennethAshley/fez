import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, endpointFor, readPrefs, migratePrefs } from "../src/config.js";
import { mirrorPrefs } from "../src/storage-mirror.js";
import { tmpHome } from "./helpers.js";

beforeEach(() => {
  process.env.FEZ_WALLET_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fez-wallet-cfg-"));
});

describe("config", () => {
  it("defaults when no file exists", async () => {
    const { loadConfig, thresholdFor } = await import("../src/config.js");
    const c = loadConfig();
    expect(thresholdFor(c, "scout")).toBe("0.01");
    expect(c.endpoints.tao).toContain("finney");
  });

  it("persona threshold overrides default and round-trips through save", async () => {
    const { loadConfig, saveConfig, thresholdFor } = await import("../src/config.js");
    const c = loadConfig();
    c.thresholds.scout = "0.05";
    saveConfig(c);
    expect(thresholdFor(loadConfig(), "scout")).toBe("0.05");
    expect(thresholdFor(loadConfig(), "vault")).toBe("0.01");
  });

  it("assigns stable, distinct EVM indexes", async () => {
    const { loadConfig, saveConfig, assignEvmIndex } = await import("../src/config.js");
    const c = loadConfig();
    expect(assignEvmIndex(c, "scout")).toBe(0);
    expect(assignEvmIndex(c, "vault")).toBe(1);
    expect(assignEvmIndex(c, "scout")).toBe(0); // stable on re-ask
    saveConfig(c);
    expect(assignEvmIndex(loadConfig(), "vault")).toBe(1);
  });

  it("spend log appends and reads back newest-first with limit", async () => {
    const { appendLog, readLog } = await import("../src/log.js");
    appendLog({ ts: "2026-08-25T00:00:00Z", persona: "scout", to: "5F...", amount: "0.01", asset: "TAO", txHash: "0x1", consent: "auto", network: "test" });
    appendLog({ ts: "2026-08-25T00:01:00Z", persona: "scout", to: "5G...", amount: "0.5", asset: "TAO", txHash: "0x2", consent: "approved", network: "test" });
    const rows = readLog("test", 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("0x2");
  });
});

describe("network preferences", () => {
  beforeEach(() => tmpHome());

  it("defaults to finney with its endpoint", () => {
    const c = loadConfig();
    expect(c.network).toBe("finney");
    expect(c.endpoints.tao).toBe("wss://entrypoint-finney.opentensor.ai:443");
  });

  it("derives the endpoint from a prefs network", async () => {
    await mirrorPrefs({ network: "test" });
    const c = loadConfig();
    expect(c.network).toBe("test");
    expect(c.endpoints.tao).toBe("wss://test.finney.opentensor.ai:443");
  });

  it("lets an explicit endpoint override the derived one", async () => {
    await mirrorPrefs({ network: "test" });
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({ endpoints: { tao: "ws://127.0.0.1:9944" } })
    );
    expect(loadConfig().endpoints.tao).toBe("ws://127.0.0.1:9944");
  });

  it("prefers a prefs threshold over the legacy wallet.json one", async () => {
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({ thresholds: { default: "0.5" } })
    );
    await mirrorPrefs({ thresholds: { default: "0.02" } });
    expect(loadConfig().thresholds.default).toBe("0.02");
  });

  it("migrates legacy thresholds and a recognised endpoint into prefs", async () => {
    const walletJson = path.join(process.env.FEZ_WALLET_HOME!, "wallet.json");
    fs.writeFileSync(
      walletJson,
      JSON.stringify({
        thresholds: { default: "0.5" },
        endpoints: { tao: "wss://test.finney.opentensor.ai:443" },
      })
    );
    migratePrefs();
    expect(readPrefs().thresholds).toEqual({ default: "0.5" });
    // A recognised endpoint becomes the network, so the selector can move it.
    expect(readPrefs().network).toBe("test");
    const after = JSON.parse(fs.readFileSync(walletJson, "utf-8"));
    expect(after.thresholds).toBeUndefined();
    expect(after.endpoints?.tao).toBeUndefined();
  });

  it("leaves an unrecognised endpoint alone when migrating", () => {
    const walletJson = path.join(process.env.FEZ_WALLET_HOME!, "wallet.json");
    fs.writeFileSync(walletJson, JSON.stringify({ endpoints: { tao: "ws://127.0.0.1:9944" } }));
    migratePrefs();
    expect(JSON.parse(fs.readFileSync(walletJson, "utf-8")).endpoints.tao).toBe("ws://127.0.0.1:9944");
  });

  it("maps both networks to their endpoints", () => {
    expect(endpointFor("test")).toBe("wss://test.finney.opentensor.ai:443");
    expect(endpointFor("finney")).toBe("wss://entrypoint-finney.opentensor.ai:443");
  });
});
