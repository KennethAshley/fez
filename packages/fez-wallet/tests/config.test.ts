import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    appendLog({ ts: "2026-08-25T00:00:00Z", persona: "scout", to: "5F...", amount: "0.01", asset: "TAO", txHash: "0x1", consent: "auto" });
    appendLog({ ts: "2026-08-25T00:01:00Z", persona: "scout", to: "5G...", amount: "0.5", asset: "TAO", txHash: "0x2", consent: "approved" });
    const rows = readLog(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("0x2");
  });
});
