import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { buildNip98Header, verifyNip98Header } from "@fez/protocol";
import { gitRepoPath, gitAuthUrl } from "../../fez-git/src/auth.js";
import { parseGitPath, isWrite } from "../../fez-git/src/serve.js";

/**
 * The gate on serving code.
 *
 * Everything here decides whether a stranger can read or write a
 * repository, so the tests are written as attempts rather than as
 * demonstrations: the interesting case is always the one that should
 * fail.
 */

const sk = generateSecretKey();
const pk = getPublicKey(sk);
const REPO_URL = "https://relay.example/git/thing.git";

describe("NIP-98 verification", () => {
  it("accepts a header signed for this repo", () => {
    const header = buildNip98Header(sk, REPO_URL, "GET");
    const result = verifyNip98Header(header, {
      method: "GET",
      path: "/git/thing.git",
      origins: ["https://relay.example"],
    });
    expect(result).toMatchObject({ ok: true, pubkey: pk });
  });

  it("refuses a header signed for a DIFFERENT repo", () => {
    // The whole point of the u tag: a token for one repo must not open
    // another one on the same relay.
    const header = buildNip98Header(sk, "https://relay.example/git/other.git", "GET");
    const result = verifyNip98Header(header, {
      method: "GET",
      path: "/git/thing.git",
      origins: ["https://relay.example"],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a header signed for another server entirely", () => {
    // Without the origin check, a NIP-98 event a user signed for some
    // other service could be replayed here and open a door they never
    // pointed at.
    const header = buildNip98Header(sk, "https://someone-else.example/git/thing.git", "GET");
    const result = verifyNip98Header(header, {
      method: "GET",
      path: "/git/thing.git",
      origins: ["https://relay.example"],
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a stale header", () => {
    const header = buildNip98Header(sk, REPO_URL, "GET");
    const result = verifyNip98Header(header, {
      method: "GET",
      path: "/git/thing.git",
      origins: ["https://relay.example"],
      now: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a tampered event", () => {
    const header = buildNip98Header(sk, REPO_URL, "GET");
    const raw = JSON.parse(Buffer.from(header.split(" ")[1], "base64").toString());
    raw.tags = [["u", "https://relay.example/git/other.git"], ["method", "GET"]];
    const forged = `Nostr ${Buffer.from(JSON.stringify(raw)).toString("base64")}`;
    expect(verifyNip98Header(forged, { method: "GET", path: "/git/other.git" })).toMatchObject({
      ok: false,
      reason: "bad signature",
    });
  });

  it("refuses junk without throwing", () => {
    for (const header of [undefined, "", "Basic abc", "Nostr", "Nostr !!!!", "Nostr " + Buffer.from("{}").toString("base64")]) {
      expect(verifyNip98Header(header, { method: "GET", path: "/git/thing.git" }).ok).toBe(false);
    }
  });

  it("lets git reuse one token across the operation", () => {
    // Git signs ONCE with GET and reuses that token for the POST that
    // sends the pack. Verifying the method would break every clone on
    // its second request — the exemption is deliberate, so it is tested.
    const header = buildNip98Header(sk, REPO_URL, "GET");
    const asPost = verifyNip98Header(header, {
      method: "POST",
      path: "/git/thing.git",
      origins: ["https://relay.example"],
      checkMethod: false,
    });
    expect(asPost).toMatchObject({ ok: true, pubkey: pk });
    // …and still refuses when a caller DOES want the method checked.
    expect(
      verifyNip98Header(header, { method: "POST", path: "/git/thing.git", origins: ["https://relay.example"] })
    ).toMatchObject({ ok: false });
  });
});

describe("the repo a request is authenticated against", () => {
  // Client and server must reduce to the SAME url or every clone fails
  // on its second request. These are the three shapes git actually
  // sends.
  const cases: [string, string][] = [
    ["/git/thing.git/info/refs?service=git-upload-pack", "/git/thing.git"],
    ["/git/thing.git/info/refs?service=git-receive-pack", "/git/thing.git"],
    ["/git/thing.git/git-upload-pack", "/git/thing.git"],
    ["/git/thing.git/git-receive-pack", "/git/thing.git"],
    ["/git/thing.git", "/git/thing.git"],
  ];

  for (const [input, want] of cases) {
    it(`reduces ${input}`, () => {
      expect(gitRepoPath(input)).toBe(want);
    });
  }

  it("builds the URL a credential helper signs", () => {
    expect(gitAuthUrl("https", "relay.example", "/git/thing.git/info/refs?service=git-upload-pack")).toBe(
      "https://relay.example/git/thing.git"
    );
  });

});

describe("routing", () => {
  it("finds the repo in a git path", () => {
    expect(parseGitPath("/git/thing.git/info/refs")).toEqual({ repo: "thing", rest: "/info/refs" });
    expect(parseGitPath("/git/thing.git")).toEqual({ repo: "thing", rest: "/" });
  });

  it("is not a filesystem", () => {
    // The repo name becomes a path under the repo root. Anything that is
    // not plainly a name is refused rather than cleaned, because a
    // cleaner is a thing you have to be right about every time.
    for (const path of [
      "/git/../../etc/passwd.git/info/refs",
      "/git/..%2f..%2fetc.git/info/refs",
      "/git/.git/info/refs",
      "/git/a/b.git/info/refs",
      "/notgit/thing.git/info/refs",
    ]) {
      expect(parseGitPath(path)).toBeUndefined();
    }
  });

  it("knows a push from a fetch", () => {
    // Backwards here means either refusing every clone or letting
    // strangers push, so it gets its own test.
    expect(isWrite("/git/t.git/git-receive-pack", "")).toBe(true);
    expect(isWrite("/git/t.git/info/refs", "?service=git-receive-pack")).toBe(true);
    expect(isWrite("/git/t.git/git-upload-pack", "")).toBe(false);
    expect(isWrite("/git/t.git/info/refs", "?service=git-upload-pack")).toBe(false);
  });
});
