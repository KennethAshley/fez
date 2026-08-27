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

  // The bug this pins: loadConfig() DERIVES endpoints.tao from the active
  // network, and saveConfig used to write that whole object back — turning
  // the derived endpoint into a permanent explicit override. Asserting only
  // `config.network` is what let it ship: the label moved and the socket
  // did not, so the session said "testnet" while spending real TAO.
  it("a save/load round-trip never pins the endpoint — network and endpoint move TOGETHER", async () => {
    const { saveConfig } = await import("../src/config.js");
    saveConfig(loadConfig()); // `fez-wallet derive` / rememberPayee do exactly this
    await mirrorPrefs({ network: "test" });
    const c = loadConfig();
    expect(c.network).toBe("test");
    expect(c.endpoints.tao).toBe("wss://test.finney.opentensor.ai:443");
    // and back again, so this is not one-way luck
    await mirrorPrefs({ network: "finney" });
    const back = loadConfig();
    expect(back.network).toBe("finney");
    expect(back.endpoints.tao).toBe("wss://entrypoint-finney.opentensor.ai:443");
    expect(JSON.parse(fs.readFileSync(path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"), "utf-8")).network)
      .toBeUndefined();
  });

  it("a genuine explicit endpoint survives a save/load round-trip and still wins", async () => {
    const { saveConfig } = await import("../src/config.js");
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({ endpoints: { tao: "ws://127.0.0.1:9944" } })
    );
    const c = loadConfig();
    expect(c.endpoints.tao).toBe("ws://127.0.0.1:9944");
    saveConfig(c);
    expect(loadConfig().endpoints.tao).toBe("ws://127.0.0.1:9944");
    // still an override after the network moves — a local node is not finney
    await mirrorPrefs({ network: "test" });
    const after = loadConfig();
    expect(after.network).toBe("test");
    expect(after.endpoints.tao).toBe("ws://127.0.0.1:9944");
  });

  it("a save never leaks a prefs threshold into wallet.json (spec §6: deleting prefs resets)", async () => {
    const { saveConfig } = await import("../src/config.js");
    await mirrorPrefs({ thresholds: { default: "5" } }); // loosened in the panel
    saveConfig(loadConfig());
    fs.rmSync(path.join(process.env.FEZ_EXTENSION_DATA_DIR!, "wallet.json"), { force: true });
    expect(loadConfig().thresholds.default).toBe("0.01");
  });

  it("keeps a per-persona threshold that only wallet.json holds", async () => {
    const { saveConfig, thresholdFor } = await import("../src/config.js");
    const c = loadConfig();
    c.thresholds.scout = "0.05";
    saveConfig(c);
    expect(thresholdFor(loadConfig(), "scout")).toBe("0.05");
  });

  // The write-side strip only cleans files written AFTER it shipped. Every
  // `fez-wallet derive` before it wrote a recognised endpoint into
  // wallet.json, and migratePrefs — the only thing that heals one — runs
  // solely from `fez-wallet network`. So the read side has to apply the same
  // rule, or legacy state resurrects the original Critical.
  it("ignores a legacy recognised endpoint that names the WRONG network", async () => {
    await mirrorPrefs({ network: "test" });
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      // as `fez-wallet derive` wrote it, back when finney was active
      JSON.stringify({ endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" } })
    );
    const c = loadConfig();
    expect(c.network).toBe("test");
    expect(c.endpoints.tao).toBe("wss://test.finney.opentensor.ai:443"); // agrees, no migratePrefs
  });

  it("still honours an unrecognised endpoint on read, across a network flip", async () => {
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({ endpoints: { tao: "ws://127.0.0.1:9944" } })
    );
    expect(loadConfig().endpoints.tao).toBe("ws://127.0.0.1:9944");
    await mirrorPrefs({ network: "test" });
    expect(loadConfig().endpoints.tao).toBe("ws://127.0.0.1:9944");
    await mirrorPrefs({ network: "finney" });
    expect(loadConfig().endpoints.tao).toBe("ws://127.0.0.1:9944");
  });

  // The panel path exactly: the Rust command writes prefs and nothing else,
  // so migratePrefs is never reached and cannot be what saves the owner.
  it("a panel-only network flip over a legacy pinned wallet.json still agrees", async () => {
    fs.writeFileSync(
      path.join(process.env.FEZ_WALLET_HOME!, "wallet.json"),
      JSON.stringify({
        personas: { scout: { index: 0 } },
        endpoints: { tao: "wss://entrypoint-finney.opentensor.ai:443" },
      })
    );
    await mirrorPrefs({ network: "test" }); // the panel selector, no CLI
    const c = loadConfig();
    expect(c.network).toBe("test");
    expect(c.endpoints.tao).toBe(endpointFor("test"));
    expect(c.personas.scout.index).toBe(0); // ceremony state untouched
  });

  it("maps both networks to their endpoints", () => {
    expect(endpointFor("test")).toBe("wss://test.finney.opentensor.ai:443");
    expect(endpointFor("finney")).toBe("wss://entrypoint-finney.opentensor.ai:443");
  });
});
