#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { pairFromStored } from "./derive.js";
import { readEntry, readAgentNostrKey } from "./store.js";
import { loadConfig } from "./config.js";
import { substrateAdapter } from "./chains/substrate.js";
import { evmAdapter } from "./chains/evm.js";
import { poolRelay } from "./consent.js";
import { walletAddress, walletBalance, walletSend, walletHistory, type ToolDeps } from "./tools.js";

/**
 * fez-wallet, skill part — the calling agent's OWN allowance account.
 *
 * Identity comes from FEZ_AGENT_PERSONA (set by fez-acp in the harness
 * env), NEVER from tool arguments: this process can only ever load one
 * derived key, and the root mnemonic entry is not referenced anywhere
 * in this import graph (spec invariants 1 and 2).
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-wallet: FEZ_AGENT_PERSONA is not set — this skill only runs inside an agent harness.");
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const server = new McpServer({ name: "fez-wallet", version: "0.1.0" });

/** Deps are built lazily per call: config edits and newly derived keys
 * apply without restarting the agent, and startup stays instant for the
 * MCP handshake. */
async function deps(): Promise<ToolDeps> {
  await cryptoWaitReady();
  const stored = readEntry(persona!);
  if (!stored) {
    throw new Error(`no wallet for "${persona}" — run: fez-wallet derive ${persona}`);
  }
  const config = loadConfig();
  const relays = (process.env.FEZ_RELAY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    persona: persona!,
    pair: pairFromStored(stored),
    adapters: [substrateAdapter({ endpoint: config.endpoints.tao }), evmAdapter()],
    config,
    ownerPk: process.env.FEZ_AGENT_OWNER,
    agentNostrKey: readAgentNostrKey(persona!),
    relay: relays.length ? () => poolRelay(relays) : undefined,
  };
}

server.registerTool(
  "wallet_address",
  {
    description: "Your own receive address — where someone sends you money. Currently TAO (bittensor).",
    inputSchema: { chain: z.string().optional().describe("Chain id, e.g. 'tao'. Default: the first enabled chain.") },
  },
  async ({ chain }) => text(walletAddress(await deps(), { chain }))
);

server.registerTool(
  "wallet_balance",
  {
    description: "Your current balance. This balance IS your spending cap — there is no other budget.",
    inputSchema: {
      chain: z.string().optional().describe("Chain id, e.g. 'tao'."),
      asset: z.string().optional().describe("Asset symbol, e.g. 'TAO'."),
    },
  },
  async ({ chain, asset }) => text(await walletBalance(await deps(), { chain, asset }))
);

server.registerTool(
  "wallet_send",
  {
    description:
      "Send money from your allowance. Small amounts go through immediately; larger amounts post a consent request to the owner and wait up to 10 minutes for their ✅ — you'll be told the outcome either way.",
    inputSchema: {
      to: z.string().describe("Destination: a raw address, or a local persona name (e.g. 'vault')."),
      amount: z.string().describe("Decimal amount, e.g. '0.05'."),
      asset: z.string().describe("Asset symbol, e.g. 'TAO'."),
      memo: z.string().optional().describe("Short human-readable reason — shown in the consent request."),
    },
  },
  async ({ to, amount, asset, memo }) => text(await walletSend(await deps(), { to, amount, asset, memo }))
);

server.registerTool(
  "wallet_history",
  {
    description: "Your recent transfers (from this machine's spend log).",
    inputSchema: { limit: z.number().optional().describe("Max rows (default 20).") },
  },
  async ({ limit }) => text(walletHistory(await deps(), { limit }))
);

await server.connect(new StdioServerTransport());
console.error(`fez-wallet ready — allowance account for "${persona}"`);
