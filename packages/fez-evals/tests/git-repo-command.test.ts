import { describe, it, expect } from "vitest";
import fezGit from "../../fez-git/src/headless.js";
import type { ChannelsAccess, CommandContext, FezExtensionAPI } from "../../fez-git/src/api-types.js";

/**
 * The /repo command, actually run.
 *
 * Everything under it was unit-tested and the transport was verified
 * against real git, but the command itself had never been executed — so
 * its failure messages and the spec it hands to channels.ensure were
 * claims, not results. This runs the real handler.
 */

/** Capture what the extension registers, the way a host would. */
function drive(opts: { info?: Record<string, unknown>; channels?: ChannelsAccess }) {
  let handler!: (args: string, ctx: CommandContext) => void | Promise<void>;
  const api = {
    registerCommand: (_name: string, h: typeof handler) => {
      handler = h;
    },
    registerScheduledTask: () => {},
    channels: opts.channels,
    workspace: opts.info ? { info: opts.info } : undefined,
  } as unknown as FezExtensionAPI;
  fezGit(api);
  const replies: string[] = [];
  const run = async (args: string) => {
    await handler(args, { reply: (c: string) => replies.push(c) });
    return replies.at(-1) ?? "";
  };
  return { run };
}

const ensured: { name: string; source?: string; meta?: Record<string, string> }[] = [];
const channels: ChannelsAccess = {
  list: async () => [{ id: "id-1", name: "existing", source: "fez-git", meta: { repo: "existing", clone: "https://x.dev/git/existing.git" } }],
  ensure: async (spec) => {
    ensured.push(spec);
    return "new-id";
  },
  say: async () => "",
};

const ADVERTISING = { pubkey: "a".repeat(64), fez_git: { clone_base: "https://relay.example/git" } };

describe("/repo on a relay that serves git", () => {
  it("opens a channel and prints the advertised remote", async () => {
    const out = await drive({ info: ADVERTISING, channels }).run("new demo");
    expect(out).toContain("git remote add origin https://relay.example/git/demo.git");
    expect(out).toContain("#demo");
    expect(ensured.at(-1)).toEqual({
      name: "demo",
      source: "fez-git",
      meta: { repo: "demo", clone: "https://relay.example/git/demo.git" },
    });
  });

  it("lists repos with the clone url the channel already carries", async () => {
    const out = await drive({ info: ADVERTISING, channels }).run("");
    expect(out).toContain("#existing");
    expect(out).toContain("https://x.dev/git/existing.git");
  });

  it("refuses a name that is not a repo name", async () => {
    const out = await drive({ info: ADVERTISING, channels }).run("new ../../etc/passwd");
    expect(out).toContain("is not a repo name");
    // The traversal attempt must not have reached the channels seam.
    expect(ensured.some((s) => s.name.includes(".."))).toBe(false);
  });

  it("says so when the owner refuses the channel", async () => {
    const refusing: ChannelsAccess = { ...channels, ensure: async () => undefined };
    const out = await drive({ info: ADVERTISING, channels: refusing }).run("new nope");
    expect(out).toContain("only the workspace owner");
  });
});

describe("/repo when git is not available", () => {
  it("says the relay advertises no git server, and does NOT invent a url", async () => {
    // The old code derived ws://→http:// and printed a plausible remote
    // that fails on push. This is the message that replaced it.
    const out = await drive({ info: { pubkey: "a".repeat(64) }, channels }).run("new demo");
    expect(out).toContain("does not advertise a git server");
    expect(out).toContain("--origin");
    expect(out).not.toMatch(/https?:\/\/[^\s]*\.git/);
  });

  it("says so when the workspace has no known owner", async () => {
    const out = await drive({ info: ADVERTISING, channels: undefined }).run("new demo");
    expect(out).toContain("unclaimed");
  });
});
