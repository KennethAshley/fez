#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ApiPromise } from "@polkadot/api";

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

const FINNEY = process.env.FEZ_BITTENSOR_RPC || "wss://entrypoint-finney.opentensor.ai:443";
const TAOSTATS_KEY = process.env.TAOSTATS_API_KEY;

/** Chain identity fields are hex-encoded UTF-8 (0x…); decode to text. */
function hexToStr(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("0x")) return "";
  try {
    return Buffer.from(v.slice(2), "hex").toString("utf8").trim();
  } catch {
    return "";
  }
}

interface Subnet {
  netuid: number;
  name: string;
  description: string;
  github: string;
  url: string;
  contact: string;
  discord: string;
}

let apiPromise: Promise<ApiPromise> | undefined;
function chain(): Promise<ApiPromise> {
  if (!apiPromise) {
    // Dynamic import so the heavy @polkadot/api graph (WASM crypto init)
    // loads on the first query, not at process start — the MCP handshake
    // must answer instantly or a host (claude-code) gives up attaching it.
    apiPromise = import("@polkadot/api").then(({ ApiPromise, WsProvider }) =>
      ApiPromise.create({ provider: new WsProvider(FINNEY), noInitWarn: true })
    );
  }
  return apiPromise;
}

/** Every registered subnet with whatever identity its owner committed. One
 * multi-query for the netuid list, one for all identities — no N+1. */
async function allSubnets(): Promise<Subnet[]> {
  const api = await chain();
  const st = api.query.subtensorModule;
  const added = await st.networksAdded.entries();
  const netuids = added
    .filter(([, v]) => v.toJSON() === true)
    .map(([k]) => (k.args[0] as unknown as { toNumber(): number }).toNumber())
    .sort((a, b) => a - b);
  const identities = await st.subnetIdentitiesV3.multi(netuids);
  const subnets: Subnet[] = netuids.map((netuid, i) => {
    const id = (identities[i]?.toJSON() ?? {}) as Record<string, unknown>;
    return {
      netuid,
      name: hexToStr(id.subnetName) || `subnet ${netuid}`,
      description: hexToStr(id.description),
      github: hexToStr(id.githubRepo),
      url: hexToStr(id.subnetUrl),
      contact: hexToStr(id.subnetContact),
      discord: hexToStr(id.discord),
    };
  });
  return maybeEnrich(subnets);
}

/** Fill blank name/github from Taostats — only when a key is set and the
 * chain had nothing. Chain is the source of truth; this is a courtesy. */
async function maybeEnrich(subnets: Subnet[]): Promise<Subnet[]> {
  if (!TAOSTATS_KEY) return subnets;
  const missing = subnets.filter((s) => !s.github || s.name.startsWith("subnet "));
  if (missing.length === 0) return subnets;
  try {
    const res = await fetch("https://api.taostats.io/api/subnet/latest/v1?limit=256", {
      headers: { Authorization: TAOSTATS_KEY, accept: "application/json" },
    });
    if (!res.ok) return subnets;
    const json = (await res.json()) as { data?: { netuid?: number; name?: string; github_repo?: string; description?: string }[] };
    const byId = new Map((json.data ?? []).map((d) => [d.netuid, d]));
    for (const s of subnets) {
      const t = byId.get(s.netuid);
      if (!t) continue;
      if (s.name.startsWith("subnet ") && t.name) s.name = t.name;
      if (!s.github && t.github_repo) s.github = t.github_repo;
      if (!s.description && t.description) s.description = t.description;
    }
  } catch {
    /* Taostats is a courtesy — never let it fail the chain answer. */
  }
  return subnets;
}

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
      "Full on-chain identity for one subnet by netuid — name, description, GitHub repo, url, contact, discord. The github repo is what you read (via git-mcp) to learn how to actually use the subnet.",
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
        s.url && `- url: ${s.url}`,
        s.contact && `- contact: ${s.contact}`,
        s.discord && `- discord: ${s.discord}`,
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
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
    if (hits.length === 0) return text(`no subnet matches "${query}". Try a broader word, or bittensor_subnets to see them all.`);
    return text(`${hits.length} subnet(s) matching "${query}":\n${hits.map(line).join("\n")}`);
  }
);

await server.connect(new StdioServerTransport());
console.error(`fez-bittensor ready — subnet discovery over ${FINNEY}${TAOSTATS_KEY ? " (+ Taostats enrichment)" : ""}`);
