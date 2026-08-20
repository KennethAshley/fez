import type { FezExtensionAPI } from "./api-types.js";
import { channelNameFor, checksFor, headline, ready, recentItems, validRepo, type Item } from "./github.js";
import {
  CONFIG_FILE,
  STATE_FILE,
  changeLine,
  keyFor,
  readJson,
  writeJson,
  type Config,
  type State,
} from "./state.js";

/**
 * fez-github, headless part — a repo's activity, in a channel.
 *
 * The shape: a repo is a CHANNEL, and each pull request or issue is a
 * THREAD in it. A channel per PR would bury the sidebar on any real
 * repo; a thread is already a room with its own timeline.
 *
 * What lands on the relay is what HAPPENED — "#3660 opened", "merged",
 * "2/14 checks failing" — because that is history, and history belongs
 * in the log. What is TRUE RIGHT NOW is not mirrored, because a copy of
 * it is wrong the moment somebody acts on github.com. Same split fez
 * already makes between messages and presence.
 *
 * One poller, one credential, on the owner's machine. Everyone else in
 * the workspace reads the result off the relay — so teammates and agents
 * with no GitHub access at all still see the work. That is the thing a
 * forge cannot do, and it is most of why bridging beats hosting here.
 */

interface ClientLike {
  pubkey: string;
  state: {
    isOwner(pk: string): boolean;
    workspace: { channels: Map<string, { id: string; name: string }> };
  };
  setScope(channelId: string): void;
  createChannel(name: string): Promise<string>;
  sendChannelMessage(text: string, opts?: { threadRootId?: string }): Promise<{ id: string }>;
}

export default function github(api: FezExtensionAPI): void {
  const client = api.client as unknown as ClientLike | undefined;
  if (!client) return;

  /** The repo's channel, created on first sight. */
  async function channelFor(repo: string): Promise<string | undefined> {
    const name = channelNameFor(repo);
    for (const channel of client!.state.workspace.channels.values()) {
      if (channel.name.toLowerCase() === name) return channel.id;
    }
    if (!client!.state.isOwner(client!.pubkey)) {
      console.warn(`⚠️  fez-github: no #${name} channel, and only the workspace owner can add one`);
      return undefined;
    }
    return await client!.createChannel(name);
  }

  async function pollRepo(repo: string, state: State): Promise<boolean> {
    let items: Item[];
    try {
      items = await recentItems(repo);
    } catch (err) {
      // A failed poll is just a poll. It must not take the sentinel down
      // and must not touch the watermark — a cleared watermark means the
      // next success republishes the repo's recent history as new.
      console.warn(`⚠️  fez-github ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    const channelId = await channelFor(repo);
    if (!channelId) return false;
    client!.setScope(channelId);

    let touched = false;
    // Oldest first, so a repo seen for the first time reads in the order
    // things actually happened rather than backwards.
    for (const item of [...items].reverse()) {
      const key = keyFor(repo, item.number);
      const before = state[key];
      const checks = item.kind === "pr" && item.state === "open" ? await checksFor(repo, item.number) : undefined;

      if (!before) {
        const root = await client!.sendChannelMessage(headline(item) + (checks ? `\n${checks}` : ""));
        state[key] = {
          updatedAt: item.updatedAt,
          state: item.state,
          merged: item.merged,
          comments: item.comments,
          checks,
          rootId: root.id,
        };
        touched = true;
        continue;
      }

      if (before.updatedAt === item.updatedAt) continue;
      const line = changeLine(before, item, checks);
      if (line) await client!.sendChannelMessage(line, { threadRootId: before.rootId });
      state[key] = {
        ...before,
        updatedAt: item.updatedAt,
        state: item.state,
        merged: item.merged,
        comments: item.comments,
        checks: checks ?? before.checks,
      };
      touched = true;
    }
    return touched;
  }

  async function poll(): Promise<string> {
    const config = await readJson<Config>(CONFIG_FILE, { repos: [] });
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
      if (await pollRepo(repo, state)) touched = true;
    }
    if (touched) await writeJson(STATE_FILE, state);
    return `synced ${config.repos.length} repo${config.repos.length === 1 ? "" : "s"}`;
  }

  // Registration cannot await, and the interval is a number we need now.
  // 3 minutes is the default; the floor is 60s because this spends
  // somebody else's API quota.
  let everyMs = 180_000;
  void readJson<Config>(CONFIG_FILE, { repos: [] }).then((c) => {
    everyMs = Math.max(60, c.pollSeconds ?? 180) * 1000;
  });
  api.registerScheduledTask("github-poll", everyMs, () => {
    void poll().catch((err) => console.warn(`⚠️  fez-github poll failed: ${err instanceof Error ? err.message : String(err)}`));
  });

  api.registerCommand("github", async (args, ctx) => {
    const [verb, value] = args.trim().split(/\s+/);
    const config = await readJson<Config>(CONFIG_FILE, { repos: [] });

    if (verb === "watch" && value) {
      if (!validRepo(value)) return ctx.reply(`⑂ "${value}" is not owner/name`);
      const gh = await ready();
      if (!gh.ok) return ctx.reply(`⑂ ${gh.why}`);
      if (!config.repos.includes(value)) config.repos.push(value);
      await writeJson(CONFIG_FILE, config);
      ctx.reply(`⑂ watching ${value} — its activity lands in #${channelNameFor(value)}`);
      ctx.reply(`⑂ ${await poll()}`);
      return;
    }

    if (verb === "forget" && value) {
      await writeJson(CONFIG_FILE, { ...config, repos: config.repos.filter((r) => r !== value) });
      ctx.reply(`⑂ stopped watching ${value} — the channel and everything in it stays`);
      return;
    }

    if (verb === "sync") {
      ctx.reply(`⑂ ${await poll()}`);
      return;
    }

    const gh = await ready();
    const health = gh.ok ? "gh ready" : gh.why;
    ctx.reply(
      config.repos.length === 0
        ? `⑂ ${health} · watching nothing\n/github watch owner/name`
        : `⑂ ${health} · watching ${config.repos.join(", ")}\n/github watch owner/name · /github forget owner/name · /github sync`
    );
  });
}
