#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, getKey, resolveRelay } from "@fez/protocol";
import { addCard, currentVersion, describeBoard, isBoard, moveCard, parseBoard, serializeBoard } from "./board.js";

/**
 * fez-kanban, skill part — how an agent moves its own card.
 *
 * A board is a document, so an agent could in principle move a card by
 * reading the page, editing the markdown and writing it back. In
 * practice that asks a language model to reproduce someone's document
 * byte-for-byte with one line different, and the failure mode is losing
 * a paragraph nobody notices for a week. These tools do the edit with
 * the same parser the board view uses: the agent names a card and a
 * column, and everything else in the page is guaranteed untouched.
 *
 * Custody is the usual one: the agent's own key, from
 * FEZ_AGENT_PERSONA — a card moved by @researcher is signed by
 * @researcher, and the page history says so.
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-kanban: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}
const keyHex = getKey(`agent:${persona}`);
if (!keyHex) {
  console.error(`fez-kanban: no local key for agent "${persona}"`);
  process.exit(1);
}
const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
const myPubkey = getPublicKey(secret);
const relay = new RelayConnection({
  url: process.env.FEZ_RELAY || resolveRelay(undefined),
  authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
});

const KIND_WIKI = 40100;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

interface Page {
  slug: string;
  title: string;
  content: string;
  channelId: string;
  communityId: string;
  baseId: string;
  baseTs: number;
}

/**
 * Find a page by slug or title. Boards are named things people say out
 * loud ("the sprint board"), so matching is forgiving — but ambiguity
 * is reported rather than resolved by picking the first hit, since the
 * wrong board is a worse answer than no board.
 *
 * "Latest version" is the TIP of the base chain — the version no other
 * version was written on top of — not the highest timestamp. An agent
 * making two moves in a row does both inside the same second, and
 * picking by timestamp then reads its own first move as a tie it can
 * lose: the second move lands on pre-move content and silently undoes
 * the first. The chain says which came after what regardless of clocks.
 */
async function resolvePage(spec: string): Promise<Page | { error: string }> {
  const events = await relay.query([{ kinds: [KIND_WIKI], limit: 500 }]);
  const bySlug = new Map<string, typeof events>();
  for (const event of events) {
    const slug = event.tags.find((t) => t[0] === "d")?.[1];
    if (!slug) continue; // no `d` tag = a channel doc, not a named page
    const list = bySlug.get(slug) ?? [];
    list.push(event);
    bySlug.set(slug, list);
  }

  const wanted = spec.trim().toLowerCase().replace(/\s+/g, " ");
  const pages: Page[] = [...bySlug.entries()].flatMap(([slug, versions]) => {
    const event = currentVersion(versions);
    if (!event) return [];
    return [{
      slug,
      title: event.tags.find((t) => t[0] === "title")?.[1] ?? slug,
      content: event.content,
      channelId: event.tags.find((t) => t[0] === "h")?.[1] ?? "",
      communityId: event.tags.find((t) => t[0] === "c")?.[1] ?? "",
      baseId: event.id,
      baseTs: event.created_at,
    }];
  });

  const hits = pages.filter(
    (page) => page.slug.toLowerCase() === wanted || page.title.toLowerCase().replace(/\s+/g, " ") === wanted
  );
  const loose = hits.length
    ? hits
    : pages.filter((page) => page.title.toLowerCase().includes(wanted) || page.slug.toLowerCase().includes(wanted));

  if (loose.length === 0) {
    const boards = pages.filter((page) => isBoard(page.content));
    return {
      error: `no page "${spec}". Boards on this relay: ${boards.map((b) => `"${b.title}"`).join(", ") || "(none yet)"}`,
    };
  }
  if (loose.length > 1) {
    return { error: `"${spec}" matches ${loose.map((p) => `"${p.title}"`).join(", ")} — name one exactly.` };
  }
  return loose[0];
}

async function publish(page: Page, markdown: string): Promise<void> {
  const event = finalizeEvent(
    {
      kind: KIND_WIKI,
      // Strictly newer than what it replaces. Everything else reading
      // this page sorts versions by time, and two moves inside one
      // second would otherwise tie — leaving which edit is "current" up
      // to whichever order a relay happened to return.
      created_at: Math.max(Math.floor(Date.now() / 1000), page.baseTs + 1),
      tags: [
        ["d", page.slug],
        ["h", page.channelId],
        ["c", page.communityId],
        ["title", page.title],
        ...(page.baseId ? [["base", page.baseId]] : []),
      ],
      content: markdown,
    },
    secret
  );
  await relay.publish(event);
}

const server = new McpServer({ name: "fez-kanban", version: "0.1.0" });

server.registerTool(
  "fez_board_read",
  {
    description:
      "Read a kanban board: its columns and the cards in each, with which are done. Boards are ordinary fez doc pages — columns are '## headings', cards are '- [ ]' lines. Use this before moving a card so you name the card and column exactly as written.",
    inputSchema: { page: z.string().describe("the board's page title or slug, e.g. 'Sprint 14'") },
  },
  async ({ page }) => {
    const found = await resolvePage(page);
    if ("error" in found) return text(found.error);
    const board = parseBoard(found.content);
    if (board.columns.length === 0) return text(`"${found.title}" has no columns — it isn't a board yet.`);
    return text(`${found.title}\n\n${describeBoard(board)}`);
  }
);

server.registerTool(
  "fez_board_move",
  {
    description:
      "Move a card to another column on a kanban board — this is how you report progress on work you were given. Move your card to the in-progress column when you start and to the done column when you finish; everyone watching the board sees it immediately. The rest of the page is left exactly as it was, and the move is signed by you.",
    inputSchema: {
      page: z.string().describe("the board's page title or slug"),
      card: z.string().describe("the card's text, or enough of the start of it to be unambiguous"),
      to: z.string().describe("the column to move it to, as written on the board"),
      position: z.number().optional().describe("0-based slot in the target column; default is the bottom"),
    },
  },
  async ({ page, card, to, position }) => {
    const found = await resolvePage(page);
    if ("error" in found) return text(found.error);
    const result = moveCard(parseBoard(found.content), card, to, position);
    if (result.error) return text(result.error);
    await publish(found, serializeBoard(result.board));
    return text(`${result.summary} on "${found.title}".`);
  }
);

server.registerTool(
  "fez_board_add",
  {
    description:
      "Add a card to a column on a kanban board. Put an @name in the card text to say whose it is. Use this to file work you discovered but aren't doing now, so it's on the board rather than only in a message someone has to remember.",
    inputSchema: {
      page: z.string().describe("the board's page title or slug"),
      column: z.string().describe("the column to add it to, as written on the board"),
      card: z.string().describe("the card text; include @name to assign it"),
    },
  },
  async ({ page, column, card }) => {
    const found = await resolvePage(page);
    if ("error" in found) return text(found.error);
    const result = addCard(parseBoard(found.content), column, card);
    if (result.error) return text(result.error);
    await publish(found, serializeBoard(result.board));
    return text(`${result.summary} on "${found.title}".`);
  }
);

await relay.connect();
console.error(`fez-kanban mcp: ${persona} (${myPubkey.slice(0, 8)}) ready`);
await server.connect(new StdioServerTransport());
