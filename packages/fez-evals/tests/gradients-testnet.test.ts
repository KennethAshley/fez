import { describe, expect, it } from "vitest";
import miners from "../../fez-gradients/src/miner-part.js";
import { assertMinerPreflight, resolveConfig } from "../../fez-mining/src/config.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

describe("Gradients testnet enrollment", () => {
  const descriptor = miners[0];
  const values = { trainingRepo: "https://github.com/example/training", trainingCommit: "a".repeat(40), tournamentType: "text" };
  const published = { ...descriptor, container: { ...descriptor.container!, image: `ghcr.io/fezchat/gradients-miner@sha256:${"a".repeat(64)}` } };
  const config = () => resolveConfig(descriptor.config, values, () => undefined);

  it("only exposes 241, with fixed testnet enrollment and runtime", () => {
    expect(miners.map(m => m.netuid)).toEqual([241]);
    expect(descriptor.network).toBe("test");
    expect(descriptor.container?.env).toMatchObject({ NETUID: "241", SUBTENSOR_NETWORK: "test" });
    expect(descriptor.container?.register?.command).toEqual(expect.arrayContaining(["--netuid", "241", "--subtensor.network", "test"]));
    expect(descriptor.config?.some(f => f.key === "subtensorNetwork")).toBe(false);
  });

  it("rejects mainnet and unknown wallet networks; accepts testnet", () => {
    expect(() => assertMinerPreflight(published, config(), "finney")).toThrow(/test/);
    expect(() => assertMinerPreflight(published, config(), undefined)).toThrow(/network/);
    expect(() => assertMinerPreflight(published, config(), "test")).not.toThrow();
  });

  it("refuses an unpublished image and invalid submission before launch", () => {
    expect(() => assertMinerPreflight({ ...published, container: { ...published.container, image: "ghcr.io/fezchat/gradients-miner@sha256:REPLACED_AT_PUBLISH" } }, config(), "test")).toThrow(/image/);
    for (const override of [{ trainingCommit: "main" }, { trainingRepo: "https://github.com/u/r?token=secret" }, { tournamentType: "all" }]) {
      expect(() => assertMinerPreflight(published, { ...config(), ...override }, "test")).toThrow(/config/i);
    }
    expect(() => assertMinerPreflight(published, {}, "test")).toThrow(/config/i);
  });

  it("the real CLI refuses mainnet before export, register, or spawning a runner", () => {
    const home = mkdtempSync(join(tmpdir(), "gradients-preflight-"));
    try {
      mkdirSync(join(home, "miners"));
      writeFileSync(join(home, "miners/gradients.js"), `export default ${JSON.stringify([published])};`);
      const calls = join(home, "wallet-calls");
      const wallet = join(home, "wallet");
      writeFileSync(wallet, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log('network: finney\\nendpoint: wss://mainnet.invalid');\n`, { mode: 0o700 });
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../fez-mining/dist/cli.js", import.meta.url)), "start", "--netuid", "241", "--persona", "fixture", "--machine", "do"], {
        env: { ...process.env, FEZ_MINE_HOME: home, FEZ_WALLET_BIN: wallet }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("requires wallet network test");
      expect(readFileSync(calls, "utf8")).toBe('["network"]\n');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
