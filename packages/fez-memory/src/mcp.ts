#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays, fetchRelayInfo } from "@fezchat/protocol";
import { readTeamMemory, teamMemoryHeads, buildTeamMemory } from "../../fez-client/src/memory.js";

/**
 * fez-memory, skill part — shared team memory for agents.
 *
 * Memory is not private here: it lives as signed events on the relay, so
 * every agent (and person) in a channel reads the same team memory. Each
 * `fez_remember` is its OWN append-only event — not an edit of a shared
 * doc — so two agents remembering at once never clobber each other, and
 * every memory bears the name of the agent who wrote it. `fez_recall`
 * reads them back, newest first, optionally filtered by keyword.
 *
 * This is the lightweight, fez-native answer to shared memory: the relay
 * IS the shared substrate, so sharing is the default. Recall defaults to
 * keyword + recency, with optional embeddings. Corrections and forgetting
 * retain the original fact's id and signed history.
 *
 * Custody is the usual one: the agent's own key from FEZ_AGENT_PERSONA —
 * a memory written by @researcher is signed by @researcher.
 */
const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-memory: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}
const keyHex = getKey(`agent:${persona}`);
if (!keyHex) {
  console.error(`fez-memory: no local key for agent "${persona}"`);
  process.exit(1);
}
const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
const myPubkey = getPublicKey(secret);
const relayUrls = resolveRelays();
const relay = new RelayConnection({
  urls: relayUrls,
  authSigner: async (tmpl) => finalizeEvent(tmpl, secret),
});

const KIND_AGENT = 47000;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function readMemory(channel: string, memoryId?: string) {
  const info = await fetchRelayInfo(relayUrls[0]);
  return readTeamMemory(relay, info?.pubkey, channel, myPubkey, memoryId);
}

/** pubkey → display name, from kind-47000 agent metadata; short hex otherwise. */
async function names(): Promise<Map<string, string>> {
  const meta = await relay.query([{ kinds: [KIND_AGENT], limit: 500 }]).catch(() => []);
  const map = new Map<string, string>();
  for (const e of meta) {
    try {
      const name = (JSON.parse(e.content) as { name?: string }).name;
      if (name) map.set(e.pubkey, name);
    } catch { /* skip */ }
  }
  return map;
}

// Optional semantic recall. If FEZ_EMBED_URL (an OpenAI-compatible
// embeddings endpoint) is set, memories are embedded on write and the
// vector is stored IN the event (an `emb` tag) — so the index lives on
// the shared relay too, no vector DB. Recall then ranks by cosine
// similarity, falling back to keyword for memories with no vector.
const EMBED_URL = process.env.FEZ_EMBED_URL;
const EMBED_MODEL = process.env.FEZ_EMBED_MODEL || "text-embedding-3-small";
const EMBED_KEY = process.env.FEZ_EMBED_KEY;

async function embed(input: string): Promise<number[] | undefined> {
  if (!EMBED_URL) return undefined;
  try {
    const res = await fetch(`${EMBED_URL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(EMBED_KEY ? { authorization: `Bearer ${EMBED_KEY}` } : {}) },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    return json.data?.[0]?.embedding;
  } catch {
    return undefined;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const server = new McpServer({ name: "fez-memory", version: "0.1.0" });

server.registerTool(
  "fez_remember",
  {
    description:
      "Save a durable fact to the channel's SHARED team memory — something worth remembering across sessions and visible to every agent and person in the channel (a decision, a preference, a gotcha, a convention). Not for chit-chat. Write the fact in plain language and name people by their @name, never by pubkey — everyone in the channel reads these.",
    inputSchema: {
      channel: z.string().describe("The channel (name like #general, or its id) whose team memory to add to."),
      text: z.string().trim().min(1).max(4000).describe("The thing to remember, in one or two sentences."),
      replaces: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("The original memory id from fez_recall to correct. Only its author or a workspace moderator may replace it."),
    },
  },
  async ({ channel, text: memory, replaces }) => {
    const context = await readMemory(channel, replaces);
    const template = buildTeamMemory(context, myPubkey, memory, replaces);
    const vec = await embed(template.content);
    if (vec) template.tags.push(["emb", JSON.stringify(vec)]);
    const event = finalizeEvent(template, secret);
    await relay.publish(event);
    return text(`${replaces ? "corrected" : "remembered"} in #${context.channel.name}: "${template.content}"\nmemory id: ${replaces ?? event.id}`);
  }
);

server.registerTool(
  "fez_recall",
  {
    description:
      "Read the channel's SHARED team memory — current durable facts from workspace members, with original memory ids for correction or forgetting. Optionally filter by keyword (semantic when configured). Use this before answering when prior context might exist. A history-window warning means older facts may exist.",
    inputSchema: {
      channel: z.string().describe("The channel (name or id) whose team memory to read."),
      query: z.string().optional().describe("Optional keyword filter — only memories containing it are returned."),
      limit: z.number().int().min(1).max(100).optional().describe("Max memories to return (default 20, newest first)."),
    },
  },
  async ({ channel, query, limit }) => {
    const context = await readMemory(channel);
    const heads = teamMemoryHeads(context.events, context.channel.id, context.state);
    const ids = new Map([...heads].map(([id, event]) => [event.id, id]));
    const events = [...heads.values()].filter(e => e.content.trim());
    const nameMap = await names();
    const q = query?.trim().toLowerCase();
    const cap = limit ?? 20;

    // Semantic when a query + an embeddings endpoint are both present;
    // keyword + recency otherwise.
    const qvec = query && EMBED_URL ? await embed(query) : undefined;
    let ranked = events;
    if (qvec) {
      ranked = events
        .map((e) => {
          const embTag = e.tags.find((t) => t[0] === "emb")?.[1];
          let score = 0;
          if (embTag) {
            try {
              score = cosine(qvec, JSON.parse(embTag) as number[]);
            } catch { /* bad vector */ }
          } else if (q && e.content.toLowerCase().includes(q)) {
            score = 0.25; // no vector on this memory — keyword fallback
          }
          return { e, score };
        })
        .filter((r) => r.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.e);
    } else {
      ranked = events
        .filter((e) => (q ? e.content.toLowerCase().includes(q) : true))
        .sort((a, b) => b.created_at - a.created_at);
    }
    const rows = ranked
      .slice(0, cap)
      .map((e) => {
        const who = nameMap.get(e.pubkey) ?? `${e.pubkey.slice(0, 8)}…`;
        const when = new Date(e.created_at * 1000).toISOString().slice(0, 10);
        return `- [${when}] @${who} (${e.pubkey}): ${e.content}\n  memory id: ${ids.get(e.id)}`;
      });
    const window = context.windowed ? "\nHistory window: searched the newest 500 memory events per relay; older facts may exist." : "";
    if (rows.length === 0) return text(`No current facts ${q ? `matching "${query}" ` : ""}in the loaded memory for #${context.channel.name}.${window}`);
    return text(`Team memory for #${context.channel.name}${q ? ` (matching "${query}")` : ""}:\n${rows.join("\n")}${window}`);
  }
);

server.registerTool("fez_forget", {
  description: "Forget a shared fact by its original memory id from fez_recall. Only its author or a workspace moderator may do this. The signed history remains on the relay; this is not erasure.",
  inputSchema: {
    channel: z.string().describe("Channel name or id."),
    memoryId: z.string().regex(/^[a-f0-9]{64}$/).describe("Full original memory id from fez_recall."),
  },
}, async ({ channel, memoryId }) => {
  const context = await readMemory(channel, memoryId);
  await relay.publish(finalizeEvent(buildTeamMemory(context, myPubkey, "", memoryId), secret));
  return text(`Forgot memory ${memoryId} in #${context.channel.name}. Its signed history remains on the relay.`);
});

await relay.connect();
await server.connect(new StdioServerTransport());
console.error(`fez-memory ready as @${persona} (${myPubkey.slice(0, 8)}…)`);
