import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";
import { cloneBase, cloneUrl } from "../../fez-git/src/headless.js";

/**
 * A relay says where its git server is; clients do not guess.
 *
 * This replaced a real hack: the client derived the git URL from the
 * websocket address (ws→http, same host). That is right on a laptop and
 * silently wrong behind any proxy that terminates TLS or puts git
 * elsewhere — and it surfaces as a confusing `git push` failure far from
 * the code that guessed. Buzz reaches the same conclusion from the other
 * side: its NIP-34 repo announcements carry an explicit `clone` tag.
 */

const PORT = 7893;
const OWNER = "a".repeat(64);
let relay: RelayHandle;

const nip11 = async (): Promise<Record<string, unknown>> => {
  const res = await fetch(`http://127.0.0.1:${PORT}`, { headers: { Accept: "application/nostr+json" } });
  return (await res.json()) as Record<string, unknown>;
};

beforeAll(() => {
  relay = startRelay({ port: PORT, workspace: { name: "test", owner: OWNER }, log: () => {} });
});
afterAll(() => relay?.close());

describe("a relay advertising what its extensions added", () => {
  it("serves an advertised field in its NIP-11 document", async () => {
    relay.advertise("fez_git", { clone_base: "https://git.example.com/git" });
    expect((await nip11()).fez_git).toEqual({ clone_base: "https://git.example.com/git" });
  });

  it("still reports its own owner — an extension cannot overwrite pubkey", async () => {
    // The whole trust model rests on NIP-11's `pubkey`: only that key's
    // channel, roster and ban events count. A loaded module that could
    // rewrite it could hand the workspace to a key its owner never chose,
    // so the relay's own fields are written last and always win.
    relay.advertise("pubkey", "b".repeat(64));
    expect((await nip11()).pubkey).toBe(OWNER);
  });

  it("leaves the document untouched when nothing advertises", async () => {
    const bare = startRelay({ port: PORT + 1, workspace: { name: "bare" }, log: () => {} });
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}`, { headers: { Accept: "application/nostr+json" } });
      expect((await res.json()).fez_git).toBeUndefined();
    } finally {
      bare.close();
    }
  });
});

describe("reading the advertised clone base", () => {
  it("takes the base a relay published", () => {
    expect(cloneBase({ fez_git: { clone_base: "https://git.example.com/git" } })).toBe("https://git.example.com/git");
  });

  it("trims a trailing slash so the remote never doubles up", () => {
    expect(cloneUrl(cloneBase({ fez_git: { clone_base: "https://x.dev/git/" } })!, "thing")).toBe(
      "https://x.dev/git/thing.git"
    );
  });

  it("reports nothing when the relay serves no git", () => {
    // Undefined is the honest answer and the caller says so out loud.
    // The old code would have printed a plausible URL that fails on push.
    expect(cloneBase({})).toBeUndefined();
    expect(cloneBase(undefined)).toBeUndefined();
  });

  it("refuses a base that is not an http(s) URL", () => {
    // A relay is not trusted to be well-formed just because it answered.
    expect(cloneBase({ fez_git: { clone_base: "ws://x.dev/git" } })).toBeUndefined();
    expect(cloneBase({ fez_git: { clone_base: 42 } })).toBeUndefined();
    expect(cloneBase({ fez_git: "https://x.dev/git" })).toBeUndefined();
  });
});
