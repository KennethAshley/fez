import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

it("evaluation MCP denies money tools before reading wallet keys; query tools stay available", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-evaluation-mcp-"));
  const server = join(dir, "mcp.mjs");
  buildSync({ entryPoints: [fileURLToPath(new URL("../../fez-wallet/src/mcp.ts", import.meta.url))],
    outfile: server, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" } });
  const client = new Client({ name: "wallet-evaluation-check", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { PATH: process.env.PATH ?? "", FEZ_AGENT_PERSONA: "scout", FEZ_EVALUATION_ACTIVE: "1",
      FEZ_WALLET_STORE: "file", FEZ_WALLET_HOME: dir, FEZ_EXTENSION_DATA_DIR: join(dir, "extension-data") },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const mutations = [
      { name: "wallet_send", arguments: { to: "5Destination", amount: "0.1", asset: "TAO" } },
      { name: "x402_fetch", arguments: { url: "https://unused.example/paid", maxUsd: 1 } },
      { name: "wallet_stake", arguments: { amount: "0.1" } },
      { name: "wallet_unstake", arguments: { amount: "0.1" } },
      { name: "wallet_rent", arguments: { miner: "a".repeat(64), hours: 1 } },
      { name: "wallet_escrow_release", arguments: { poster: "poster", arbiter: "arbiter", amount: "0.1" } },
    ];
    for (const call of mutations) {
      const result = await client.callTool(call);
      expect(JSON.stringify(result), call.name).toMatch(/disabled during agent evaluation/);
      expect(result.isError).toBe(true);
    }
    const address = await client.callTool({ name: "wallet_address", arguments: {} });
    expect(JSON.stringify(address)).toMatch(/no wallet for/);
    const escrow = await client.callTool({ name: "wallet_escrow_release", arguments: {
      poster: "poster", arbiter: "arbiter", amount: "0.1", check_only: true,
    } });
    expect(JSON.stringify(escrow)).toMatch(/no wallet for/);
  } finally {
    await client.close();
    await transport.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
