#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runMine, minersForPersona, mineArgs } from "./mine-cli.js";

/**
 * fez-mining, skill part — an MCP server that lets a running agent inspect
 * and (Task A2) direct ITS OWN miner. Same custody model as fez-polls: the
 * persona is fixed to FEZ_AGENT_PERSONA, so quill's tools act on quill's
 * miner and nothing else. No secret ever transits a tool call.
 */
const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-mining: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

const server = new McpServer({ name: "fez-mining", version: "0.1.0" });

server.registerTool(
  "mining_status",
  {
    description:
      "Report the status of THIS agent's own Bittensor miners (subnet, running/stopped, machine). Use when asked how mining is going or what you're mining.",
    inputSchema: {},
  },
  async () => {
    const out = runMine(mineArgs.status());
    if (out.code !== 0) return text(`could not read mining status: ${out.stderr.trim()}`);
    const mine = minersForPersona(out.stdout, persona);
    if (mine.length === 0) return text(`${persona} has no miners running.`);
    return text(JSON.stringify(mine, null, 2));
  }
);

server.registerTool(
  "mining_metagraph",
  {
    description:
      "Live on-chain performance of THIS agent's miner on a subnet — incentive, emission, trust, rank, stake, immunity. Use when asked how a specific netuid is performing.",
    inputSchema: { netuid: z.number().int().describe("the subnet netuid") },
  },
  async ({ netuid }) => {
    const out = runMine(mineArgs.metagraph(persona, netuid));
    if (out.code !== 0) return text(`could not read metagraph for netuid ${netuid}: ${out.stderr.trim()}`);
    return text(out.stdout.trim() || "{}");
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
