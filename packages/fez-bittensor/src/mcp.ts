#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { allSubnets, type Subnet } from "./subnets.js";

/**
 * fez-bittensor, skill part — subnet DISCOVERY for agents.
 *
 * Read-only, no spend. It answers three questions an agent has before it
 * can use Bittensor: what subnets exist, what does each one do, and where
 * is its code. The answers come straight from the chain (@polkadot/api
 * against finney) — sovereign, no third-party API, no key — with an
 * optional Taostats fallback only to fill an identity a subnet owner never
 * committed on-chain.
 *
 * Once an agent has a subnet's github_repo, it reads the repo (via a
 * companion git-mcp skill) to learn the interface. Actually CALLING a
 * subnet (Chutes inference), paying TAO, and adopting a repo into fez-git
 * are later phases; this is the map, not the territory.
 */

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const line = (s: Subnet) => `- **${s.netuid} · ${s.name}**${s.github ? ` — ${s.github}` : ""}${s.description ? `\n    ${s.description}` : ""}`;

const server = new McpServer({ name: "fez-bittensor", version: "0.1.0" });

server.registerTool(
  "bittensor_subnets",
  {
    description:
      "List every Bittensor subnet on-chain, with its netuid, name, one-line description and GitHub repo. Read-only, straight from finney. Use this to see the whole map of what the network can do.",
    inputSchema: {
      limit: z.number().optional().describe("Max subnets to return (default all)."),
    },
  },
  async ({ limit }) => {
    const subnets = await allSubnets();
    const shown = limit && limit > 0 ? subnets.slice(0, limit) : subnets;
    return text(`${subnets.length} Bittensor subnets:\n${shown.map(line).join("\n")}`);
  }
);

server.registerTool(
  "bittensor_subnet",
  {
    description:
      "Full on-chain identity for one subnet by netuid — name, description, GitHub repo. The github repo is what you read (via git-mcp) to learn how to actually use the subnet.",
    inputSchema: { netuid: z.number().describe("The subnet's netuid, e.g. 64 for Chutes.") },
  },
  async ({ netuid }) => {
    const s = (await allSubnets()).find((x) => x.netuid === netuid);
    if (!s) return text(`no subnet with netuid ${netuid}.`);
    return text(
      [
        `# ${s.netuid} · ${s.name}`,
        s.description && `\n${s.description}`,
        s.github && `\n- repo: ${s.github}`,
        `\nTo learn its interface, read ${s.github || "the repo"} with git-mcp.`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
);

server.registerTool(
  "bittensor_find",
  {
    description:
      "Find subnets whose name or description matches a capability you need (e.g. 'inference', 'storage', 'image', 'scraping'). Returns the candidates with their repos so you can dig in.",
    inputSchema: { query: z.string().describe("What the subnet should do, in plain words.") },
  },
  async ({ query }) => {
    const q = query.toLowerCase();
    const hits = (await allSubnets()).filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q)
    );
    if (hits.length === 0) return text(`no subnet matches "${query}". Try a broader word, or bittensor_subnets to see them all.`);
    return text(`${hits.length} subnet(s) matching "${query}":\n${hits.map(line).join("\n")}`);
  }
);

await server.connect(new StdioServerTransport());
console.error("fez-bittensor ready — subnet discovery");
