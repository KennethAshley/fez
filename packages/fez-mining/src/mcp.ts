#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runMine, minersForPersona, mineArgs, classifyConfigKey } from "./mine-cli.js";
import type { ConfigField } from "@fezchat/extension-api";

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

server.registerTool(
  "mining_start",
  {
    description:
      "Start mining a Bittensor subnet as THIS agent. `machine: \"lium\"` rents a GPU pod (costs real money — the host will ask you to confirm); omit for a local miner. Requires any needed secret (e.g. the Lium key) to already be set in the mining cockpit.",
    inputSchema: {
      netuid: z.number().int().describe("the subnet to mine"),
      machine: z.enum(["local", "lium"]).optional().describe("where to run it (default local)"),
    },
  },
  async ({ netuid, machine }) => {
    const out = runMine(mineArgs.start(persona, netuid, machine));
    if (out.code !== 0) return text(`could not start netuid ${netuid}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`started mining netuid ${netuid}${machine === "lium" ? " on a Lium pod" : ""}. ${out.stdout.trim()}`);
  }
);

server.registerTool(
  "mining_stop",
  {
    description: "Stop THIS agent's miner on a subnet (tears down a rented pod if there is one).",
    inputSchema: { netuid: z.number().int().describe("the subnet to stop mining") },
  },
  async ({ netuid }) => {
    const out = runMine(mineArgs.stop(persona, netuid));
    if (out.code !== 0) return text(`could not stop netuid ${netuid}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`stopped mining netuid ${netuid}. ${out.stdout.trim()}`);
  }
);

server.registerTool(
  "mining_config",
  {
    description:
      "Set a NON-secret config parameter on THIS agent's miner for a subnet (e.g. daily cap, model). Secrets like API keys are REFUSED here — set those in the mining cockpit. The change applies on the next restart; ask the user before restarting (a Lium restart costs money).",
    inputSchema: {
      netuid: z.number().int().describe("the subnet"),
      key: z.string().describe("the config field to set"),
      value: z.string().describe("the new value"),
    },
  },
  async ({ netuid, key, value }) => {
    const desc = runMine(mineArgs.describe(netuid));
    if (desc.code !== 0) return text(`could not read netuid ${netuid} config schema: ${desc.stderr.trim()}`);
    let schema: ConfigField[] = [];
    try { schema = (JSON.parse(desc.stdout).config ?? []) as ConfigField[]; } catch { schema = []; }
    const verdict = classifyConfigKey(schema, key);
    if (verdict === "secret") return text(`"${key}" is a secret — set it in the mining cockpit, not chat.`);
    if (verdict === "unknown") {
      const settable = schema.filter((f) => f.type !== "secret").map((f) => f.key);
      return text(`netuid ${netuid} has no settable field "${key}". Settable: ${settable.join(", ") || "(none)"}.`);
    }
    const out = runMine(mineArgs.configSet(persona, netuid, key, value));
    if (out.code !== 0) return text(`could not set ${key}: ${out.stderr.trim() || out.stdout.trim()}`);
    return text(`set ${key} = ${value} for netuid ${netuid}. This applies on the next restart — say the word and I'll stop and restart the miner.`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
