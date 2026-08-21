import type { ChannelsAccess, CommandContext, FezExtensionAPI } from "./api-types.js";

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

/** `owner/name` is a GitHub shape; a fez repo is one plain name. */
const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Where this relay serves git, as the relay itself reports it.
 *
 * NOT derived from the websocket URL. That derivation is correct on a
 * laptop and silently wrong behind any proxy that terminates TLS or puts
 * git on another host — and the failure surfaces as a confusing `git
 * push` error far from the code that guessed. The relay's fez-git
 * extension advertises this in NIP-11 from the operator-stated --origin;
 * undefined here means the relay does not serve git, or was started
 * without an origin, and the honest move is to say so rather than print
 * a plausible URL.
 *
 * Buzz lands in the same place from the other direction: its NIP-34 repo
 * announcements carry an explicit `clone` tag instead of asking clients
 * to reconstruct one.
 */
export function cloneBase(info: Record<string, unknown> | undefined): string | undefined {
  const git = info?.["fez_git"] as { clone_base?: unknown } | undefined;
  const base = git?.clone_base;
  return typeof base === "string" && /^https?:\/\//i.test(base) ? base.replace(/\/+$/, "") : undefined;
}

/** The remote for one repo under a base this relay advertised. */
export const cloneUrl = (base: string, repo: string): string => `${base}/${repo}.git`;

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
  const openRepoChannel = (channels: ChannelsAccess, repo: string, base: string) =>
    channels.ensure({
      name: repo.toLowerCase(),
      source: "fez-git",
      meta: { repo, clone: cloneUrl(base, repo) },
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
          "Install `@fez/git` on the relay and start it with `--extensions --origin https://your-relay`. " +
          "The origin is what it publishes as the clone URL, so it has to be the address clients actually reach."
      );
    }

    const [verb, value] = args.trim().split(/\s+/);

    if (verb === "new" && value) {
      if (!REPO_NAME.test(value)) {
        return ctx.reply(`⑂ "${value}" is not a repo name — letters, digits, dot, dash, underscore`);
      }
      const id = await openRepoChannel(channels, value, base);
      if (!id) return ctx.reply("⑂ only the workspace owner can open a channel here");
      const url = cloneUrl(base, value);
      return ctx.reply(
        `⑂ **#${value.toLowerCase()}** is open. The repository appears on your first push:\n\n` +
          "```\n" +
          `git remote add origin ${url}\n` +
          "git push -u origin main\n" +
          "```\n" +
          "Set up once, if you haven't: `git config --global --unset-all credential.helper` then " +
          "`git config --global credential.helper fez` and `git config --global credential.useHttpPath true`."
      );
    }

    const repos = (await channels.list()).filter((c) => c.source === "fez-git");
    if (repos.length === 0) return ctx.reply("⑂ no repos yet — /repo new <name>");
    return ctx.reply(
      "⑂ repos here:\n" +
        repos.map((c) => `  #${c.name} — ${c.meta?.clone ?? cloneUrl(base, c.meta?.repo ?? c.name)}`).join("\n")
    );
  });
}
