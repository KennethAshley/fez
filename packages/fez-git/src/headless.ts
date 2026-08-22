import type { ChannelsAccess, CommandContext, FezExtensionAPI } from "./api-types.js";
import { REPO_NAME, cloneBase, cloneUrl, repoDoc } from "./repo-name.js";
import { parseJournal } from "./journal.js";
import { planThreadPosts, type ChannelMsg } from "./threads.js";
import type { NostrAccess } from "./api-types.js";

// Re-exported: workspace-part.ts and the evals already import
// cloneBase from here, and moving the definition should not move
// where callers find it.
export { cloneBase, cloneUrl };

/**
 * fez-git, headless part — a repo is a CHANNEL.
 *
 * The relay serves the bytes but cannot do this: a channel is
 * OWNER-SIGNED, and the relay deliberately holds no key. So the half
 * that makes a repo visible in fez is the half running beside the
 * owner's key — the sentinel or the TUI — and it reaches the relay's
 * git server the same way anyone else does.
 *
 * The model, decided before any of it was built:
 *
 *   repo    → a channel. Its doc is the repo's docs.
 *   branch  → a thread. Opened, worked, reviewed, merged, done.
 *   a LONG-LIVED line (main, release/*) earns its own channel.
 *
 * Threads are cheap and channels are permanent — a channel is a signed
 * relay event with no real delete — so a channel per feature branch
 * would leave litter for every experiment somebody abandoned.
 */

export default function fezGit(api: FezExtensionAPI): void {
  /**
   * Open the channel for a repo, or find the one already open.
   *
   * `source` is what groups every repo under one heading in the rail;
   * `clone` is carried so a client can show the remote without knowing
   * how to build one. Creating the channel does NOT create the
   * repository — the first authorized push does that, which is how git
   * bootstraps everywhere else and leaves one less thing to authorize.
   */
  const openRepoChannel = (channels: ChannelsAccess, repo: string, base: string, protect: string, carry?: Record<string, string>) =>
    channels.ensure({
      name: repo.toLowerCase(),
      source: "fez-git",
      // Existing meta rides THROUGH an edit — rebuilding {repo, clone,
      // protect} from scratch silently erased `upstream` the moment an
      // owner changed protection, and the next sync answered "no
      // upstream" for a repo adopted from GitHub (review finding F2).
      meta: { ...carry, repo, clone: cloneUrl(base, repo), protect },
    });

  api.registerCommand("repo", async (args: string, ctx: CommandContext) => {
    const channels = api.channels;
    if (!channels) {
      // Either there is no relay access, or the workspace has no known
      // owner — and only an owner can sign a channel into being.
      return ctx.reply(
        "⑂ no channel access here. On an unclaimed relay (no owner in NIP-11) nobody can open one."
      );
    }

    const base = cloneBase(api.workspace?.info);
    if (!base) {
      return ctx.reply(
        "⑂ this relay does not advertise a git server.\n\n" +
          "Install `@fezchat/git` on the relay and start it with `--extensions --origin https://your-relay`. " +
          "The origin is what it publishes as the clone URL, so it has to be the address clients actually reach."
      );
    }

    const [verb, value, ...rest] = args.trim().split(/\s+/);

    if (verb === "new" && value) {
      if (!REPO_NAME.test(value)) {
        return ctx.reply(`⑂ "${value}" is not a repo name — letters, digits, dot, dash, underscore`);
      }
      // Written explicitly rather than left to the relay's default, so a
      // repo describes its own rule. The relay defaults to the same
      // thing for repos that predate this; agreeing here means the two
      // never disagree and nobody has to know which one applied.
      const existingRepo = (await channels.list()).find((c) => c.source === "fez-git" && (c.meta?.repo === value || c.name === value.toLowerCase()));
      const id = await openRepoChannel(channels, value, base, "main", existingRepo?.meta);
      if (!id) return ctx.reply("⑂ only the workspace owner can open a channel here");
      const url = cloneUrl(base, value);
      await seedRepoDoc(api, id, value, url);
      return ctx.reply(
        `⑂ **#${value.toLowerCase()}** is open. The repository appears on your first push:\n\n` +
          "```\n" +
          `git remote add origin ${url}\n` +
          "git push -u origin main\n" +
          "```\n" +
          "`main` is protected — owners and admins only, fast-forward only. Everyone else pushes " +
          "their own branch, which is what lets a fleet share this repo. Change it with " +
          `\`/repo protect ${value} <refs|none>\`.\n\n` +
          "Already have the code locally? `~/.fez/bin/fez-adopt` from inside it does all of this in one step.\n\n" +
          "Push by hand instead: set up once with `git config --global --unset-all credential.helper` then " +
          '`git config --global credential.helper "$HOME/.fez/bin/git-credential-fez"` and ' +
          "`git config --global credential.useHttpPath true`."
      );
    }

    /**
     * Change which refs are protected.
     *
     * Re-`ensure` with new meta rather than a bespoke update path —
     * channels.ts already republishes when meta differs, and the channel
     * is owner-signed, so the authority check is the one that already
     * exists. `none` is a real value, distinct from never having set it.
     */
    if (verb === "protect" && value) {
      const refs = rest.join(" ").trim();
      if (!refs) {
        return ctx.reply(`⑂ /repo protect ${value} main release/*  —  or \`none\` to protect nothing`);
      }
      const repos = (await channels.list()).filter((c) => c.source === "fez-git");
      const existing = repos.find((c) => c.meta?.repo === value || c.name === value.toLowerCase());
      if (!existing) return ctx.reply(`⑂ no repo called "${value}" here — /repo new ${value}`);
      const repo = existing.meta?.repo ?? value;
      const id = await openRepoChannel(channels, repo, base, refs, existing.meta);
      if (!id) return ctx.reply("⑂ only the workspace owner can change this");
      return refs.toLowerCase() === "none"
        ? ctx.reply(`⑂ **${repo}** protects nothing — any roster member can push any ref, including \`main\`.`)
        : ctx.reply(`⑂ **${repo}** protects \`${refs}\` — owners and admins only, fast-forward only.`);
    }

    /**
     * Open a LINE — a thread that is a unit of work agents get pointed
     * at. Just a message whose text carries the branch's root marker:
     * the thread task recognizes it (same marker it would have written)
     * and threads the line's pushes and its agents' stubs under it. The
     * branch itself materializes on the first push or merge, like every
     * repo — declarations first, bytes on demand.
     */
    if (verb === "branch" && value) {
      const line = rest[0]?.trim();
      if (!line) return ctx.reply(`⑂ /repo branch ${value} <line>  —  e.g. /repo branch ${value} feat-auth`);
      if (!/^[a-z0-9][\w.-]{0,60}$/i.test(line) || line.includes("/")) {
        return ctx.reply(`⑂ "${line}" is not a line name — letters, digits, dot, dash (no slashes: lines are top-level)`);
      }
      const all = (await channels.list()).filter((c) => c.source === "fez-git");
      const chan = all.find((c) => c.meta?.repo === value || c.name === value.toLowerCase());
      if (!chan) return ctx.reply(`⑂ no repo called "${value}" here — /repo new ${value}`);
      await channels.say(chan.id, `⑂ \`${line}\` — line opened. Mention an agent in this thread to put it to work here; its branch will appear as \`<agent>/${line}\`.`);
      return ctx.reply(`⑂ line \`${line}\` opened in #${chan.name}`);
    }

    /**
     * Merge — the one serialization point, as a command. Runs HERE,
     * beside the owner's key, which is what clears the protected ref.
     * Fast-forward only; a refusal explains itself.
     */
    if (verb === "merge" && value) {
      const branch = rest[0]?.trim();
      if (!branch) return ctx.reply(`⑂ /repo merge ${value} <branch> [into]  —  e.g. /repo merge ${value} reviewer/feat-auth`);
      const all = (await channels.list()).filter((c) => c.source === "fez-git");
      const chan = all.find((c) => c.meta?.repo === value || c.name === value.toLowerCase());
      if (!chan) return ctx.reply(`⑂ no repo called "${value}" here`);
      const nostr = api.nostr;
      if (!nostr) return ctx.reply("⑂ no relay access here — cannot merge");
      const result = await mergeViaRelay(nostr, base, chan.meta?.repo ?? value, branch, rest[1]?.trim() || undefined);
      if (!result.merged) return ctx.reply(`⑂ not merged: ${result.reason}`);
      // The journal records the ref move, so the thread task reports it
      // into the right thread on its next tick — no bespoke announce.
      return ctx.reply(`⑂ merged \`${branch}\` → \`${result.sha?.slice(0, 8)}\`${result.reason ? ` (${result.reason})` : ""}`);
    }

    const repos = (await channels.list()).filter((c) => c.source === "fez-git");
    if (repos.length === 0) return ctx.reply("⑂ no repos yet — /repo new <name>");
    return ctx.reply(
      "⑂ repos here:\n" +
        repos
          .map((c) => {
            const url = c.meta?.clone ?? cloneUrl(base, c.meta?.repo ?? c.name);
            // Absent means the relay's default applies, which is `main`;
            // saying so beats a blank that reads as "unprotected".
            const protect = c.meta?.protect ?? "main";
            return `  #${c.name} — ${url}\n      protects ${protect === "none" ? "nothing" : protect}`;
          })
          .join("\n")
    );
  });

  /**
   * Branch → thread, the live half of the model.
   *
   * Runs HERE — beside the owner's key — because the relay cannot post:
   * it holds no key, deliberately. The relay records pushes in a journal
   * (ground truth from the transport; see journal.ts for why fez has no
   * spoofable kind:30618 equivalent) and this task closes the gap
   * between what the journal says and what the channel shows. All the
   * judgement lives in planThreadPosts, which is pure; this is glue.
   *
   * The channel is the cursor. No file, no memory that matters: the
   * sentinel can die, move machines or double-run, and the worst case
   * is a skipped line, never a duplicate flood.
   */
  api.registerScheduledTask("git-branch-threads", 30_000, async (ctx) => {
    const base = cloneBase(api.workspace?.info);
    if (!base) return; // no git server here — nothing to report on

    const repos = (await ctx.channels.list()).filter((c) => c.source === "fez-git");
    for (const channel of repos) {
      const repo = channel.meta?.repo ?? channel.name;
      const journal = await fetchJournal(ctx.nostr, base, repo);
      if (!journal) continue; // unreachable, unauthorized, or no pushes yet

      const entries = parseJournal(journal);
      if (entries.length === 0) continue;

      const events = await ctx.nostr.query([{ kinds: [47103], "#h": [channel.id], limit: 500 }]);
      const messages: ChannelMsg[] = events.map((e) => ({
        id: e.id,
        content: e.content,
        isReply: e.tags.some((t) => t[0] === "e"),
      }));

      const names = await nameLookup(ctx.nostr, entries.map((e) => e.pusher));
      for (const post of planThreadPosts(entries, messages, names)) {
        await ctx.channels.say(channel.id, post.text, post.threadRoot ? { threadRoot: post.threadRoot } : undefined);
      }
    }
  });
}

/**
 * The repo's front-page doc, written once at creation and never again —
 * after that the doc belongs to the room. Guarded by a query rather
 * than by "did ensure create it": re-running /repo new on an existing
 * repo reuses the channel, and clobbering a doc agents have been
 * editing would be the worst version of helpful.
 */
async function seedRepoDoc(api: FezExtensionAPI, channelId: string, repo: string, clone: string, upstream?: string): Promise<void> {
  const nostr = api.nostr;
  if (!nostr) return;
  try {
    const existing = await nostr.query([{ kinds: [40100], "#h": [channelId], limit: 1 }]);
    if (existing.length > 0) return;
    await nostr.publish({ kind: 40100, tags: [["h", channelId]], content: repoDoc(repo, clone, upstream) });
  } catch { /* a repo without a front page is a nuisance, not a failure */ }
}

/**
 * GET the push journal as the owner, NIP-98-signed.
 *
 * signEvent is the whole reason this can exist as an extension: the key
 * never crosses the seam, but a kind-27235 event signed for exactly this
 * URL is a 60-second credential for exactly this door — the same header
 * `git push` sends, built the same way (src/nip98.ts).
 */
async function fetchJournal(nostr: NostrAccess, base: string, repo: string): Promise<string | undefined> {
  const url = `${base}/${repo}.git/fez-push-journal`;
  // A host whose nostr seam lacks signEvent is a BUG, not a network
  // blip, and must not hide in the catch below — that exact hole (a
  // backend narrower than the type it was cast into) kept this task
  // silently idle while pushes piled up unannounced.
  if (typeof nostr.signEvent !== "function") {
    console.warn("⚠️  fez-git: this host's nostr seam has no signEvent — branch threads cannot fetch the push journal");
    return undefined;
  }
  try {
    const event = nostr.signEvent({
      kind: 27235,
      tags: [["u", url], ["method", "GET"]],
      content: "",
      created_at: Math.floor(Date.now() / 1000),
    });
    const res = await fetch(url, {
      headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` },
    });
    if (!res.ok) return undefined;
    const body = await res.text();
    return body.trim() ? body : undefined;
  } catch {
    // An unreachable relay is a fact of laptop life, not an error to
    // shout about every 30 seconds.
    return undefined;
  }
}

/**
 * POST the relay's merge endpoint as this key.
 *
 * The MERGE ITSELF lives on the relay (ops.ts) — one implementation for
 * this command, the GUI button, and anything else; this is only the
 * signed knock on its door. Exported for the GUI part, which does the
 * same knock with the client's header seam.
 */
export async function mergeViaRelay(
  nostr: NostrAccess,
  base: string,
  repo: string,
  branch: string,
  into?: string
): Promise<{ merged: boolean; sha?: string; reason?: string }> {
  // Signed over the PATH-ONLY url: the server's verifier reduces every
  // request to its repo path (gitRepoPath strips the query — git signs
  // once per operation and reuses the token across differently-queried
  // requests), so the token must be minted over the same reduction.
  const signUrl = `${base}/${repo}.git/fez-merge`;
  const url = `${signUrl}?branch=${encodeURIComponent(branch)}${into ? `&into=${encodeURIComponent(into)}` : ""}`;
  if (typeof nostr.signEvent !== "function") return { merged: false, reason: "this host's nostr seam has no signEvent" };
  try {
    const event = nostr.signEvent({
      kind: 27235,
      tags: [["u", signUrl], ["method", "POST"]],
      content: "",
      created_at: Math.floor(Date.now() / 1000),
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}` },
    });
    const body = (await res.json().catch(() => undefined)) as { merged?: boolean; sha?: string; reason?: string } | undefined;
    if (!body) return { merged: false, reason: `relay answered ${res.status} with no body` };
    return { merged: !!body.merged, sha: body.sha, reason: body.reason };
  } catch (err) {
    return { merged: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** kind-0 names for pushers, so threads say "researcher", not hex. */
async function nameLookup(nostr: NostrAccess, pubkeys: string[]): Promise<(pk: string) => string> {
  const unique = [...new Set(pubkeys)];
  const names = new Map<string, string>();
  try {
    // Agents announce names via 47000 metadata, humans via kind-0
    // profiles — reading only kind-0 left every agent as short hex in
    // its own thread stub. Agent announcements win, same precedence the
    // client applies.
    const [profiles, agents] = await Promise.all([
      nostr.query([{ kinds: [0], authors: unique }]),
      nostr.query([{ kinds: [47000], authors: unique }]),
    ]);
    for (const profile of profiles.sort((a, b) => a.created_at - b.created_at)) {
      try {
        const parsed = JSON.parse(profile.content) as { name?: string; display_name?: string };
        const name = parsed.display_name || parsed.name;
        if (name) names.set(profile.pubkey, name);
      } catch { /* not a profile */ }
    }
    for (const announcement of agents.sort((a, b) => a.created_at - b.created_at)) {
      try {
        const parsed = JSON.parse(announcement.content) as { name?: string };
        if (parsed.name) names.set(announcement.pubkey, parsed.name);
      } catch { /* not an announcement */ }
    }
  } catch { /* names are a nicety; short hex is the fallback */ }
  return (pk: string) => names.get(pk) ?? pk.slice(0, 8);
}
