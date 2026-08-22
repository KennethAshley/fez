#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelays } from "@fezchat/protocol";
import { formatPoll, tallyPoll, OPTION_EMOJI } from "./format.js";

/**
 * fez-polls, skill part — an MCP server giving agents fez_poll: post a
 * question, wait for the vote, act on the outcome. Same custody model
 * as fez-mcp (the agent's own key, from FEZ_AGENT_PERSONA); same tally
 * rules as every client (shared vote-logic: member roll, one key one
 * vote, ambiguous excluded).
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-polls: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}
const keyHex = getKey(`agent:${persona}`);
if (!keyHex) {
  console.error(`fez-polls: no local key for agent "${persona}"`);
  process.exit(1);
}
const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
const myPubkey = getPublicKey(secret);
const relay = new RelayConnection({
  urls: resolveRelays(),
  authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function resolveChannel(spec: string): Promise<{ channelId: string; name: string } | { error: string }> {
  const raw = spec.trim().replace(/^#/, "");
  const wanted = raw.toLowerCase();
  const channels = await relay.query([{ kinds: [47101], limit: 200 }]);
  for (const event of channels) {
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (!d) continue;
    let name = d;
    try {
      name = (JSON.parse(event.content).name as string) ?? d;
    } catch { /* keep id */ }
    if (name.toLowerCase() === wanted || d === raw || (raw.length >= 6 && d.startsWith(raw))) {
      return { channelId: d, name };
    }
  }
  return { error: `no channel "${spec}" on this relay` };
}

const server = new McpServer({ name: "fez-polls", version: "0.1.0" });

server.registerTool(
  "fez_poll",
  {
    description:
      "Run a poll in a fez channel and WAIT for the outcome: posts the question with numbered options, members vote by reacting, and after the duration you get the winner and counts. Use when a decision should reflect the room, then act on the returned winner. One key one vote; only channel members count; a key voting multiple options counts for nothing.",
    inputSchema: {
      channel: z.string().describe("channel name or id"),
      question: z.string(),
      options: z.array(z.string()).min(2).max(OPTION_EMOJI.length),
      durationS: z.number().optional().describe("seconds the poll stays open (default 300, max 3600)"),
    },
  },
  async ({ channel, question, options, durationS }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const closesAtMs = Date.now() + Math.max(30, Math.min(durationS ?? 300, 3600)) * 1000;
    const poll = finalizeEvent(
      {
        kind: 47103,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", ref.channelId], ["t", "poll"]],
        content: formatPoll(question, options, closesAtMs),
      },
      secret
    );
    await relay.publish(poll);
    await new Promise((resolve) => setTimeout(resolve, closesAtMs - Date.now()));

    const [reactions, membershipEvents] = await Promise.all([
      relay.query([{ kinds: [7], "#e": [poll.id] }]).catch(() => []),
      relay.query([{ kinds: [47102], "#d": [ref.channelId] }]).catch(() => []),
    ]);
    const latestMembership = membershipEvents.sort((a, b) => b.created_at - a.created_at)[0];
    const members = new Set((latestMembership?.tags ?? []).filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
    members.delete(myPubkey); // the pollster never votes in its own poll
    const tally = tallyPoll(options.length, reactions.map((r) => ({ pk: r.pubkey, content: r.content })), members);

    const lines = options.map((option, i) => `${OPTION_EMOJI[i]} ${option}: ${tally.counts[i]}`);
    if (tally.winner !== undefined) {
      return text(`POLL CLOSED — winner: "${options[tally.winner]}" (${tally.voters} voters).\n${lines.join("\n")}`);
    }
    return text(
      `POLL CLOSED — no clear winner (${tally.voters} voters${tally.counts.some((c) => c > 0) ? ", tie" : ""}). Do not treat any option as chosen; report the counts.\n${lines.join("\n")}`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
