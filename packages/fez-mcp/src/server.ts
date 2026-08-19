#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { quorumDecision, OPTION_EMOJI } from "./vote-logic.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import {
  RelayConnection,
  getKey,
  resolveRelay,
  resolveRelays,
  buildDmWraps,
  conversationKey,
  engramHeads,
  buildEngramEvent,
  isValidSlug,
  KIND_AGENT_ENGRAM,
} from "@fez/protocol";

/**
 * fez-mcp — the agent's hands ON fez itself (GAPS §3 item 15; Buzz gives
 * its agents the `buzz` CLI inside buzz-dev-mcp — this is the fez-native
 * equivalent as proper MCP tools instead of shell strings).
 *
 * Runs as a stdio MCP server INSIDE a harness session, signed with the
 * AGENT's own key (FEZ_AGENT_PERSONA → local service key), so everything
 * an agent does through these tools is attributable to the agent — same
 * custody story as fez-acp itself. Attached automatically to every
 * fez-acp session; personas need declare nothing.
 *
 * Env (fez-acp fills these): FEZ_AGENT_PERSONA (required),
 * FEZ_RELAY, FEZ_AGENT_OWNER (enables memory tools).
 */

const persona = process.env.FEZ_AGENT_PERSONA;
if (!persona) {
  console.error("fez-mcp: FEZ_AGENT_PERSONA is required");
  process.exit(1);
}
const keyHex = getKey(`agent:${persona}`);
if (!keyHex) {
  console.error(`fez-mcp: no local key for agent "${persona}"`);
  process.exit(1);
}
const secret = Uint8Array.from(Buffer.from(keyHex, "hex"));
const myPubkey = getPublicKey(secret);
const owner = process.env.FEZ_AGENT_OWNER;
const relayUrls = resolveRelays();

const relay = new RelayConnection({
  urls: relayUrls,
  authSigner: async (tmpl) => finalizeEvent(tmpl as never, secret),
});

const sign = (tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }) =>
  finalizeEvent(
    { kind: tmpl.kind, created_at: tmpl.created_at ?? Math.floor(Date.now() / 1000), tags: tmpl.tags, content: tmpl.content },
    secret
  );

/** Channel roster — the voter roll for quorum gates and polls. */
async function channelMembers(channelId: string): Promise<Set<string>> {
  const events = await relay.query([{ kinds: [47102], "#d": [channelId] }]).catch(() => []);
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  return new Set((latest?.tags ?? []).filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
}

// ── Shared lookups ───────────────────────────────────────────────────────

let nameCache: Map<string, string> | undefined;
async function names(): Promise<Map<string, string>> {
  if (nameCache) return nameCache;
  nameCache = new Map();
  const events = await relay.query([{ kinds: [47000], limit: 200 }, { kinds: [0], limit: 200 }]);
  for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
    try {
      const meta = JSON.parse(event.content) as { name?: string; display_name?: string };
      const name = event.kind === 47000 ? meta.name : meta.display_name || meta.name;
      if (name) nameCache.set(event.pubkey, name);
    } catch { /* skip */ }
  }
  return nameCache;
}

async function displayName(pk: string): Promise<string> {
  return (await names()).get(pk) ?? `${pk.slice(0, 8)}…`;
}

async function resolvePubkey(who: string): Promise<string | undefined> {
  const raw = who.trim().replace(/^@/, "");
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw.toLowerCase();
  const wanted = raw.toLowerCase();
  for (const [pk, name] of await names()) if (name.toLowerCase() === wanted) return pk;
  return undefined;
}

type ChannelRef = { channelId: string; name: string };

/**
 * Name OR id OR id-prefix, within this workspace. A relay is a
 * workspace, so names are far likelier to be unique now than when two
 * #generals could sit on one relay — but an ambiguous name still
 * returns the candidate list as an error string so the model retries
 * with an id instead of silently posting into the wrong room.
 */
async function resolveChannel(spec: string): Promise<ChannelRef | { error: string }> {
  const raw = spec.trim().replace(/^#/, "");
  const wanted = raw.toLowerCase();
  const channels = await relay.query([{ kinds: [47101], limit: 200 }]);
  const seen = new Map<string, ChannelRef>();
  for (const event of channels) {
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (!d || seen.has(d)) continue;
    let name = d;
    try {
      name = (JSON.parse(event.content).name as string) ?? d;
    } catch { /* keep id */ }
    seen.set(d, { channelId: d, name });
  }
  const byId = [...seen.values()].filter((ch) => ch.channelId === raw || (raw.length >= 6 && ch.channelId.startsWith(raw.replace(/\.+$/, ""))));
  if (byId.length === 1) return byId[0];
  const byName = [...seen.values()].filter((ch) => ch.name.toLowerCase() === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    return {
      error: `"${raw}" is ambiguous — ${byName.length} channels share that name. Retry with an id: ${byName.map((ch) => `${ch.channelId} (#${ch.name})`).join(", ")}`,
    };
  }
  return { error: `No channel "${raw}" on this relay.` };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// ── Server + tools ───────────────────────────────────────────────────────

const server = new McpServer({ name: "fez", version: "0.1.0" });

server.registerTool(
  "fez_send_message",
  {
    description:
      "Post a message to a fez channel as yourself (the agent). Use for announcements or cross-channel notes outside the current conversation — your normal reply already reaches the channel you were mentioned in.",
    inputSchema: { channel: z.string().describe("channel name or id"), message: z.string() },
  },
  async ({ channel, message }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    await relay.publish(sign({ kind: 47103, tags: [["h", ref.channelId]], content: message }));
    return text(`Posted to #${ref.name}.`);
  }
);


server.registerTool(
  "fez_request_approval",
  {
    description:
      "Ask your OWNER to approve a risky or irreversible action BEFORE doing it — deploys, deletions, publishing, spending money, anything hard to undo. Posts an approval request in the channel and BLOCKS until the owner reacts ✅ (approved) or ❌ (denied), or the timeout passes. Proceed ONLY on APPROVED; on DENIED or TIMEOUT, stop and say so.",
    inputSchema: {
      channel: z.string().describe("channel name or id to ask in"),
      action: z.string().describe("exactly what you want to do — specific, one line"),
      timeoutS: z.number().optional().describe("seconds to wait (default 300, max 3600)"),
    },
  },
  async ({ channel, action, timeoutS }) => {
    if (!owner) return text("DENIED — no owner configured (FEZ_AGENT_OWNER); treat approval as impossible.");
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    // Quorum is OWNER-AUTHORED config (persona approvalQuorum → this env),
    // never the agent's choice — an agent must not pick its own electorate.
    const quorum = Number(process.env.FEZ_APPROVAL_QUORUM) >= 1 ? Number(process.env.FEZ_APPROVAL_QUORUM) : undefined;
    const ask = sign({
      kind: 47103,
      tags: [["h", ref.channelId], ["t", "approval-request"], ["p", owner]],
      content: `⛔ approval needed: ${action}\n(react ✅ to approve, ❌ to deny${quorum ? ` — ${quorum} member approval${quorum === 1 ? "" : "s"} suffice` : ""})`,
    });
    await relay.publish(ask);
    const members = quorum ? await channelMembers(ref.channelId) : new Set<string>();
    const deadline = Date.now() + Math.min(timeoutS ?? 300, 3600) * 1000;
    while (Date.now() < deadline) {
      const reactions = await relay.query([{ kinds: [7], "#e": [ask.id] }]).catch(() => []);
      const verdict = quorumDecision(
        reactions.map((r) => ({ pk: r.pubkey, content: r.content })),
        { owner, quorum, members, selfPk: myPubkey }
      );
      if (verdict === "approved") return text("APPROVED — proceed with exactly the stated action.");
      if (verdict === "denied") return text("DENIED by your owner — do NOT proceed; acknowledge and stop.");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return text("TIMED OUT — no decision arrived. Do NOT proceed; say you are still waiting for approval.");
  }
);


server.registerTool(
  "fez_ask_owner",
  {
    description:
      "Ask your OWNER to choose between options when a decision is theirs to make and you genuinely cannot pick — approach A vs B, which target, proceed-now vs wait. Posts the question with numbered options and BLOCKS until the owner answers (reacting with the option number) or the timeout passes. Mark at most one option as recommended when you have a lean. Returns the chosen option; on timeout, stop and say you are waiting.",
    inputSchema: {
      channel: z.string().describe("channel name or id to ask in"),
      question: z.string(),
      options: z.array(z.object({ label: z.string(), recommended: z.boolean().optional() })).min(2).max(OPTION_EMOJI.length),
      timeoutS: z.number().optional().describe("seconds to wait (default 600, max 3600)"),
    },
  },
  async ({ channel, question, options, timeoutS }) => {
    if (!owner) return text("NO OWNER configured — you cannot ask; decide conservatively or stop.");
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const lines = [
      `❓ choose: ${question}`,
      ...options.map((option, i) => `${OPTION_EMOJI[i]} ${option.label}${option.recommended ? " (recommended)" : ""}`),
      "(asking my owner — react with the number to answer)",
    ];
    const ask = sign({
      kind: 47103,
      tags: [["h", ref.channelId], ["t", "choice-request"], ["p", owner]],
      content: lines.join("\n"),
    });
    await relay.publish(ask);
    const emojis = OPTION_EMOJI.slice(0, options.length);
    const deadline = Date.now() + Math.min(timeoutS ?? 600, 3600) * 1000;
    while (Date.now() < deadline) {
      const reactions = await relay.query([{ kinds: [7], "#e": [ask.id], authors: [owner] }]).catch(() => []);
      for (const reaction of reactions) {
        const index = emojis.indexOf(reaction.content);
        if (index !== -1) return text(`OWNER CHOSE: "${options[index].label}" — proceed accordingly.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return text("TIMED OUT — no answer. Do not pick for them; say you are still waiting.");
  }
);

server.registerTool(
  "fez_read_channel",
  {
    description: "Read the most recent messages in a fez channel.",
    inputSchema: { channel: z.string().describe("channel name or id"), limit: z.number().optional().describe("default 20") },
  },
  async ({ channel, limit }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const events = await relay.query([{ kinds: [47103], "#h": [ref.channelId], limit: Math.min(limit ?? 20, 50) }]);
    if (events.length === 0) return text(`#${ref.name} is empty.`);
    const lines = await Promise.all(
      events
        .sort((a, b) => a.created_at - b.created_at)
        .map(async (e) => `[${new Date(e.created_at * 1000).toISOString().slice(5, 16)}] ${await displayName(e.pubkey)}: ${e.content}`)
    );
    return text(lines.join("\n"));
  }
);

server.registerTool(
  "fez_send_dm",
  {
    description: "Send an end-to-end encrypted private DM to an agent or person.",
    inputSchema: { to: z.string().describe("name or pubkey"), message: z.string() },
  },
  async ({ to, message }) => {
    const pk = await resolvePubkey(to);
    if (!pk) return text(`No one named "${to}" on this relay.`);
    const { toPeer, toSelf } = buildDmWraps(secret, pk, message, 1); // depth 1: agent-originated
    await relay.publish(toPeer);
    await relay.publish(toSelf);
    return text(`DM sent to ${await displayName(pk)}.`);
  }
);

server.registerTool(
  "fez_search",
  {
    description: "Full-text search across fez channel messages and docs (NIP-50). DMs are encrypted and not searchable.",
    inputSchema: { query: z.string(), channel: z.string().optional().describe("restrict to one channel (name or id)") },
  },
  async ({ query, channel }) => {
    const filter: Record<string, unknown> = { kinds: [47103, 40100], search: query, limit: 20 };
    if (channel) {
      const ref = await resolveChannel(channel);
      if ("error" in ref) return text(ref.error);
      filter["#h"] = [ref.channelId];
    }
    const events = await relay.query([filter as never]);
    if (events.length === 0) return text(`Nothing matching "${query}".`);
    const lines = await Promise.all(
      events
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 10)
        .map(async (e) => `• ${await displayName(e.pubkey)}: ${e.content.replace(/\s+/g, " ").slice(0, 120)}`)
    );
    return text(lines.join("\n"));
  }
);

server.registerTool(
  "fez_list_agents",
  { description: "List the agents announced on this relay (name + pubkey).", inputSchema: {} },
  async () => {
    const events = await relay.query([{ kinds: [47000], limit: 200 }]);
    const latest = new Map<string, { name?: string; about?: string }>();
    for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
      try {
        latest.set(event.pubkey, JSON.parse(event.content));
      } catch { /* skip */ }
    }
    const rows = [...latest.entries()].map(([pk, m]) => `• @${m.name ?? pk.slice(0, 8)}${m.about ? ` — ${m.about}` : ""} (${pk.slice(0, 12)}…)`);
    return text(rows.join("\n") || "No agents announced.");
  }
);

// ── Memory (NIP-AE engrams) — requires an owner ──────────────────────────

async function memHeads() {
  if (!owner) throw new Error("memory tools need FEZ_AGENT_OWNER");
  const events = await relay.query([{ kinds: [KIND_AGENT_ENGRAM], authors: [myPubkey], "#p": [owner] }]);
  const convKey = conversationKey(secret, owner);
  return { convKey, heads: engramHeads(events as never, myPubkey, owner, convKey) };
}

server.registerTool(
  "fez_mem_set",
  {
    description:
      'Write a persistent memory record that survives session recycles. slug "core" = your identity/rules/goals (a full rewrite); "mem/<topic>" = an individual fact.',
    inputSchema: { slug: z.string(), value: z.string() },
  },
  async ({ slug, value }) => {
    if (!isValidSlug(slug)) return text(`Bad slug "${slug}" — use "core" or mem/<lowercase-alnum>.`);
    const { convKey, heads } = await memHeads();
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (heads.get(slug)?.event.created_at ?? 0) + 1);
    const body = slug === "core" ? { slug, profile: value } : { slug, value };
    const template = buildEngramEvent(convKey, owner!, body as never, createdAt);
    await relay.publish(finalizeEvent({ ...template, pubkey: myPubkey } as never, secret));
    return text(`${slug} written (${value.length} chars).`);
  }
);

server.registerTool(
  "fez_mem_get",
  { description: "Read one of your persistent memory records.", inputSchema: { slug: z.string() } },
  async ({ slug }) => {
    const { heads } = await memHeads();
    const head = heads.get(slug);
    if (!head || head.body.value === null) return text(`(no entry for ${slug})`);
    return text(String(slug === "core" ? head.body.profile : head.body.value));
  }
);

server.registerTool(
  "fez_mem_list",
  { description: "List your persistent memory slugs.", inputSchema: {} },
  async () => {
    const { heads } = await memHeads();
    const rows = [...heads.values()]
      .filter((h) => h.body.value !== null || h.body.slug === "core")
      .map((h) => `• ${h.body.slug}`);
    return text(rows.join("\n") || "(no memory yet)");
  }
);

// ── Channel doc ──────────────────────────────────────────────────────────

async function latestDoc(channelId: string) {
  const versions = await relay.query([{ kinds: [40100], "#h": [channelId], limit: 200 }]);
  return versions
    .filter((v) => !v.tags.some((t) => t[0] === "d")) // named wiki pages aren't the channel doc
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1))
    .at(-1);
}

server.registerTool(
  "fez_doc_get",
  { description: "Read a channel's shared markdown doc.", inputSchema: { channel: z.string() } },
  async ({ channel }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const latest = await latestDoc(ref.channelId);
    return text(latest?.content ?? `#${ref.name} has no doc yet.`);
  }
);

server.registerTool(
  "fez_doc_append",
  {
    description: "Append markdown to a channel's shared doc (appends never clobber another agent's edit).",
    inputSchema: { channel: z.string(), markdown: z.string() },
  },
  async ({ channel, markdown }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const latest = await latestDoc(ref.channelId);
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1);
    await relay.publish(
      sign({
        kind: 40100,
        created_at: createdAt,
        tags: [["h", ref.channelId], ...(latest ? [["base", latest.id]] : [])],
        content: latest ? `${latest.content}\n\n${markdown}` : markdown,
      })
    );
    return text(`Appended to #${ref.name}'s doc.`);
  }
);

// ── Wiki pages ───────────────────────────────────────────────────────────
// Named 40100 docs (["d", slug]) — the community's notion+obsidian layer.
// Pages [[link]] to each other by name; the GUI docs view renders the
// same events, so an agent's edit appears there live.

/** Same slug rule as @fez/client wikiSlug — the two must agree or links break. */
const wikiSlug = (name: string) =>
  name.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-");

async function latestWikiPage(slug: string) {
  const versions = await relay.query([{ kinds: [40100], "#d": [slug], limit: 200 }]);
  return versions
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1))
    .at(-1);
}

server.registerTool(
  "fez_wiki_read",
  {
    description:
      "Read a named wiki page from the community a channel belongs to. Pages are shared markdown, versioned and editable by everyone (agents and humans); [[Page Name]] inside a page links to another page.",
    inputSchema: { channel: z.string().describe("any channel in the community"), page: z.string().describe("page name, e.g. 'release checklist'") },
  },
  async ({ channel, page }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const latest = await latestWikiPage(wikiSlug(page));
    if (!latest) return text(`No page named "${page}" in this community yet — fez_wiki_write creates it.`);
    return text(latest.content);
  }
);

server.registerTool(
  "fez_wiki_write",
  {
    description:
      "Create or update a named wiki page (full replacement — read it first if you're editing). Link related pages with [[Their Name]]. Owners see your edit live in the docs view with your signature on the version.",
    inputSchema: {
      channel: z.string().describe("any channel in the community"),
      page: z.string().describe("page name"),
      markdown: z.string().describe("the full new page content"),
    },
  },
  async ({ channel, page, markdown }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const slug = wikiSlug(page);
    if (!slug) return text(`"${page}" makes an empty page name.`);
    const latest = await latestWikiPage(slug);
    const createdAt = Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1);
    await relay.publish(
      sign({
        kind: 40100,
        created_at: createdAt,
        tags: [
          ["h", ref.channelId],
          ["d", slug],
          ["title", page.trim()],
          ...(latest ? [["base", latest.id]] : []),
        ],
        content: markdown,
      })
    );
    return text(`${latest ? "Updated" : "Created"} wiki page "${page}".`);
  }
);

// ── Doc comments ─────────────────────────────────────────────────────────
// Notion-style margin notes (40101) anchored to a LINE of a doc/page.
// This is how work arrives inside a document: an owner comments
// "@you tighten this" on a line, and you answer in that thread.

server.registerTool(
  "fez_doc_comments",
  {
    description:
      "List comment threads on a wiki page or channel doc — each has an anchor (the line it's attached to), the note, replies, and whether it's resolved. Read this when someone comments on a doc and asks you to act.",
    inputSchema: {
      channel: z.string().describe("the channel (for a channel doc) or any channel in the community (for a page)"),
      page: z.string().optional().describe("wiki page name; omit for the channel's own doc"),
      includeResolved: z.boolean().optional(),
    },
  },
  async ({ channel, page, includeResolved }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const filter = page
      ? { kinds: [40101], "#d": [wikiSlug(page)], limit: 500 }
      : { kinds: [40101], "#h": [ref.channelId], limit: 500 };
    const events = (await relay.query([filter]))
      .sort((a, b) => a.created_at - b.created_at);
    const roots = events.filter((e) => !e.tags.some((t) => t[0] === "e"));
    const resolved = new Set(
      events.filter((e) => e.tags.some((t) => t[0] === "resolved" && t[1] === "1")).map((e) => e.tags.find((t) => t[0] === "e")?.[1])
    );
    const shown = roots.filter((r) => includeResolved || !resolved.has(r.id));
    if (!shown.length) return text(page ? `No open comments on "${page}".` : `No open comments on #${ref.name}'s doc.`);
    const lines = shown.map((root) => {
      const replies = events.filter((e) => e.tags.find((t) => t[0] === "e")?.[1] === root.id && e.content.trim());
      const anchor = root.tags.find((t) => t[0] === "anchor")?.[1] ?? "(whole doc)";
      const body = [
        `— comment ${root.id.slice(0, 12)} ${resolved.has(root.id) ? "(resolved) " : ""}on line: "${anchor}"`,
        `  ${root.content}`,
        ...replies.map((r) => `  ↳ ${r.content}`),
      ];
      return body.join("\n");
    });
    return text(lines.join("\n\n"));
  }
);

server.registerTool(
  "fez_comment_reply",
  {
    description:
      "Reply in a doc comment thread (and optionally resolve it). Use this to answer the person who commented — say what you changed, right where they asked. Resolve only when the request is actually done.",
    inputSchema: {
      channel: z.string(),
      commentId: z.string().describe("the comment id from fez_doc_comments (12+ chars is fine)"),
      reply: z.string(),
      resolve: z.boolean().optional(),
    },
  },
  async ({ channel, commentId, reply, resolve }) => {
    const ref = await resolveChannel(channel);
    if ("error" in ref) return text(ref.error);
    const candidates = await relay.query([{ kinds: [40101], limit: 500 }]);
    const root = candidates.find((e) => e.id.startsWith(commentId) || e.id === commentId);
    if (!root) return text(`No comment "${commentId}" found — list them with fez_doc_comments first.`);
    const slug = root.tags.find((t) => t[0] === "d")?.[1];
    await relay.publish(
      sign({
        kind: 40101,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["h", root.tags.find((t) => t[0] === "h")?.[1] ?? ref.channelId],
          ...(slug ? [["d", slug]] : []),
          ["e", root.id],
          ...(resolve ? [["resolved", "1"]] : []),
        ],
        content: reply,
      })
    );
    return text(`Replied in comment thread ${root.id.slice(0, 12)}${resolve ? " and resolved it" : ""}.`);
  }
);

// ── Boot ─────────────────────────────────────────────────────────────────

await relay.connect();
await server.connect(new StdioServerTransport());
