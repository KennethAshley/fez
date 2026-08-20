import type { FezExtensionAPI, NostrEvent, ScheduledTaskContext } from "./api-types.js";
import { channelNameFor, checksFor, headline, ready, recentItems, validRepo, type Item } from "./github.js";
import { STATE_FILE, changeLine, keyFor, readJson, writeJson, type State } from "./state.js";
import { loadConfig, saveConfig } from "./config.js";

/**
 * fez-github, headless part — a repo's activity, in a channel.
 *
 * A repo is a CHANNEL and each pull request or issue is a THREAD in it.
 * A channel per PR would bury the sidebar on any real repo.
 *
 * What lands on the relay is what HAPPENED — opened, merged, "2/30
 * checks failing" — because that is history. What is TRUE RIGHT NOW is
 * not mirrored: a copy of it is wrong the moment somebody acts on
 * github.com. Same split fez makes between messages and presence.
 *
 * Publishing goes through `nostr`, not `api.client`. The client is a
 * TUI-only convenience — the sentinel, which is where a poll loop
 * actually lives, does not have one. Building the events by hand is the
 * price of running somewhere headless, and it is the whole reason this
 * extension quietly did nothing the first time it was installed.
 */

/** Wire kinds, mirrored from src/kinds.ts. */
const KIND_CHANNEL = 47101;
const KIND_MESSAGE = 47103;

interface ChannelRef {
  id: string;
  name: string;
}

async function channelsOn(nostr: ScheduledTaskContext["nostr"], owner: string): Promise<ChannelRef[]> {
  const events = (await nostr.query([{ kinds: [KIND_CHANNEL], authors: [owner], limit: 200 }])) as NostrEvent[];
  const byId = new Map<string, ChannelRef>();
  for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
    const id = event.tags.find((t) => t[0] === "d")?.[1];
    if (!id) continue;
    try {
      const name = (JSON.parse(event.content) as { name?: string }).name;
      if (name) byId.set(id, { id, name });
    } catch { /* malformed channel */ }
  }
  return [...byId.values()];
}

export default function github(api: FezExtensionAPI): void {
  /**
   * The repo's channel, created on first sight.
   *
   * Only the workspace owner may sign a channel into being, and the
   * sentinel runs as the owner — so this is the one place the bridge
   * writes anything other than a message.
   */
  async function channelFor(
    nostr: ScheduledTaskContext["nostr"],
    owner: string,
    repo: string
  ): Promise<string | undefined> {
    const want = channelNameFor(repo);
    const existing = (await channelsOn(nostr, owner)).find((c) => c.name.toLowerCase() === want);
    if (existing) return existing.id;
    if (nostr.pubkey !== owner) {
      console.warn(`⚠️  fez-github: no #${want} channel, and only the workspace owner can add one`);
      return undefined;
    }
    const id = crypto.randomUUID();
    await nostr.publish({
      kind: KIND_CHANNEL,
      tags: [["d", id]],
      content: JSON.stringify({ name: want, visibility: "open" }),
    });
    console.log(`   ⑂ fez-github: created #${want}`);
    return id;
  }

  async function say(
    nostr: ScheduledTaskContext["nostr"],
    channelId: string,
    text: string,
    threadRootId?: string
  ): Promise<string> {
    const tags: string[][] = [["h", channelId]];
    if (threadRootId) tags.push(["e", threadRootId, "", "root"]);
    const event = await nostr.publish({ kind: KIND_MESSAGE, tags, content: text });
    return event.id;
  }

  async function pollRepo(ctx: ScheduledTaskContext, repo: string, state: State): Promise<boolean> {
    let items: Item[];
    try {
      items = await recentItems(repo);
    } catch (err) {
      // A failed poll is just a poll: it must not take the sentinel down,
      // and must not touch the watermark — a cleared watermark means the
      // next success republishes the repo's recent history as new.
      console.warn(`⚠️  fez-github ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const channelId = await channelFor(ctx.nostr, ctx.ownerPubkey, repo);
    if (!channelId) return false;

    // FIRST SIGHT: record the watermark, say one line, publish nothing
    // else. Backfilling looked harmless until it was counted — pointing
    // this at an active repo would have signed 50 root messages into the
    // workspace, permanently, because a relay has no real delete. And it
    // is wrong even for a repo you want: you did not ask for its history,
    // you asked to be told what happens next. So the first poll
    // establishes "now" and everything after it is genuine news.
    // "Have I seen this repo" is a SEPARATE fact from "which items have
    // I seen". Deriving it from the item keys meant an empty repo
    // recorded nothing, looked unseen on the next tick, and posted its
    // summary again — every three minutes, forever.
    const seenKey = `${repo}#!`;
    if (!state[seenKey]) {
      state[seenKey] = { updatedAt: new Date().toISOString(), state: "watching", comments: 0, rootId: "" };
      for (const item of items) {
        state[keyFor(repo, item.number)] = {
          updatedAt: item.updatedAt,
          state: item.state,
          merged: item.merged,
          comments: item.comments,
          rootId: "", // no root yet — the first CHANGE opens the thread
        };
      }
      const open = items.filter((i) => i.state === "open");
      const prs = open.filter((i) => i.kind === "pr").length;
      await say(
        ctx.nostr,
        channelId,
        `⑂ watching **${repo}** — ${prs} open pull request${prs === 1 ? "" : "s"}, ` +
          `${open.length - prs} open issue${open.length - prs === 1 ? "" : "s"}. Changes from here.`
      );
      return true;
    }

    let touched = false;
    // Oldest first, so a batch reads in the order things happened.
    for (const item of [...items].reverse()) {
      const key = keyFor(repo, item.number);
      const before = state[key];
      const checks = item.kind === "pr" && item.state === "open" ? await checksFor(repo, item.number) : undefined;

      if (!before) {
        const rootId = await say(ctx.nostr, channelId, headline(item) + (checks ? `\n${checks}` : ""));
        state[key] = {
          updatedAt: item.updatedAt,
          state: item.state,
          merged: item.merged,
          comments: item.comments,
          checks,
          rootId,
        };
        touched = true;
        continue;
      }

      if (before.updatedAt === item.updatedAt) continue;
      const line = changeLine(before, item, checks);

      // An item recorded by the first-sight watermark carries no root —
      // it was never published. The first thing that HAPPENS to it opens
      // its thread, so a reply never dangles off an id nobody has.
      let rootId = before.rootId;
      if (line) {
        if (!rootId) rootId = await say(ctx.nostr, channelId, headline(item) + (checks ? `\n${checks}` : ""));
        await say(ctx.nostr, channelId, line, rootId);
      }

      // ONE write. Doing it twice spread `before` the second time and
      // discarded the rootId just earned, so every later change opened
      // another thread for the same pull request.
      state[key] = {
        updatedAt: item.updatedAt,
        state: item.state,
        merged: item.merged,
        comments: item.comments,
        checks: checks ?? before.checks,
        rootId,
      };
      touched = true;
    }
    return touched;
  }

  async function poll(ctx: ScheduledTaskContext): Promise<string> {
    const config = await loadConfig(ctx.nostr, ctx.ownerPubkey);
    if (config.repos.length === 0) return "watching nothing — /github watch owner/name";
    const gh = await ready();
    if (!gh.ok) {
      console.warn(`⚠️  fez-github: ${gh.why}`);
      return gh.why;
    }
    const state = await readJson<State>(STATE_FILE, {});
    let touched = false;
    for (const repo of config.repos) {
      if (!validRepo(repo)) {
        console.warn(`⚠️  fez-github: "${repo}" is not owner/name — skipped`);
        continue;
      }
      if (await pollRepo(ctx, repo, state)) touched = true;
    }
    if (touched) await writeJson(STATE_FILE, state);
    return `synced ${config.repos.length} repo${config.repos.length === 1 ? "" : "s"}`;
  }

  // Registered unconditionally. Gating this on api.client — a TUI-only
  // convenience — is exactly why the first version installed cleanly,
  // logged nothing, and never ran.
  api.registerScheduledTask("github-poll", 180_000, async (ctx) => {
    await poll(ctx).catch((err) =>
      console.warn(`⚠️  fez-github poll failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  });

  api.registerCommand("github", async (args, ctx) => {
    const nostr = api.nostr;
    if (!nostr) return ctx.reply("⑂ this client gave the extension no relay access");
    const [verb, value] = args.trim().split(/\s+/);
    const config = await loadConfig(nostr, nostr.pubkey);

    if (verb === "watch" && value) {
      if (!validRepo(value)) return ctx.reply(`⑂ "${value}" is not owner/name`);
      const gh = await ready();
      if (!gh.ok) return ctx.reply(`⑂ ${gh.why}`);
      if (config.repos.includes(value)) return ctx.reply(`⑂ already watching ${value}`);
      await saveConfig(nostr, { ...config, repos: [...config.repos, value] });
      ctx.reply(
        `⑂ watching ${value} — #${channelNameFor(value)} opens on the next poll with a summary, ` +
          `then only what changes from here`
      );
      return;
    }

    if (verb === "forget" && value) {
      await saveConfig(nostr, { ...config, repos: config.repos.filter((r) => r !== value) });
      ctx.reply(`⑂ stopped watching ${value} — the channel and everything in it stays`);
      return;
    }

    const gh = await ready();
    const health = gh.ok ? `connected as ${gh.login}` : gh.why;
    ctx.reply(
      config.repos.length === 0
        ? `⑂ ${health} · watching nothing\n/github watch owner/name`
        : `⑂ ${health} · watching ${config.repos.join(", ")}\n/github watch owner/name · /github forget owner/name`
    );
  });
}
