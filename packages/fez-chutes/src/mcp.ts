#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * fez-chutes, skill part — inference on Bittensor subnet 64 (Chutes).
 *
 * Phase 2 of the Bittensor integration: from the map (discovery) to the
 * territory (running models). Chutes is serverless AI compute exposed as
 * an OpenAI-compatible HTTPS API, so this is a thin, honest wrapper — the
 * decentralization is in WHERE the tokens are produced (miner GPUs), not
 * in how you call it.
 *
 * The API key is custody: it lives in the OS keychain (fez-skill-env),
 * set by the human in SKILLS & SECRETS, injected here as CHUTES_API_KEY.
 * An API key, not a coldkey — revocable, scoped to Chutes spending, so a
 * leak costs at most the balance, never the wallet.
 */

const BASE = (process.env.CHUTES_BASE_URL || "https://llm.chutes.ai/v1").replace(/\/$/, "");
const KEY = process.env.CHUTES_API_KEY;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function auth(): Record<string, string> {
  return { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
}

const server = new McpServer({ name: "fez-chutes", version: "0.1.0" });

server.registerTool(
  "chutes_models",
  {
    description: "List the models available on Chutes (Bittensor subnet 64) that you can run inference on.",
    inputSchema: { filter: z.string().optional().describe("Optional substring to filter model ids by.") },
  },
  async ({ filter }) => {
    if (!KEY) return text("No CHUTES_API_KEY set — add it in SKILLS & SECRETS to use Chutes.");
    try {
      const res = await fetch(`${BASE}/models`, { headers: auth() });
      if (!res.ok) return text(`Chutes models request failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
      const json = (await res.json()) as { data?: { id?: string }[] };
      let ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
      if (filter) ids = ids.filter((id) => id.toLowerCase().includes(filter.toLowerCase()));
      return text(ids.length ? `${ids.length} Chutes models:\n${ids.map((id) => `- ${id}`).join("\n")}` : "no models matched.");
    } catch (e) {
      return text(`couldn't reach Chutes: ${String((e as Error)?.message ?? e)}`);
    }
  }
);

server.registerTool(
  "chutes_infer",
  {
    description:
      "Run inference on Chutes (Bittensor subnet 64) — send a prompt to a model on decentralized GPU compute and get the completion. Use chutes_models first if you don't know the exact model id.",
    inputSchema: {
      model: z.string().describe("The Chutes model id, e.g. from chutes_models."),
      prompt: z.string().describe("The user prompt."),
      system: z.string().optional().describe("Optional system prompt."),
      max_tokens: z.number().optional().describe("Cap the response length (default 512)."),
      temperature: z.number().optional().describe("Sampling temperature (default 0.7)."),
    },
  },
  async ({ model, prompt, system, max_tokens, temperature }) => {
    if (!KEY) return text("No CHUTES_API_KEY set — add it in SKILLS & SECRETS to use Chutes.");
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ];
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ model, messages, max_tokens: max_tokens ?? 512, temperature: temperature ?? 0.7 }),
      });
      if (!res.ok) return text(`Chutes inference failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 400));
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
      const out = json.choices?.[0]?.message?.content ?? "(empty response)";
      const used = json.usage?.total_tokens ? `\n\n_(${json.usage.total_tokens} tokens on ${model} via Chutes)_` : "";
      return text(out + used);
    } catch (e) {
      return text(`couldn't reach Chutes: ${String((e as Error)?.message ?? e)}`);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error(`fez-chutes ready — inference over ${BASE}${KEY ? "" : " (no key yet — set CHUTES_API_KEY in SKILLS & SECRETS)"}`);
