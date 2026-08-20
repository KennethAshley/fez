import { describe, expect, test } from "vitest";
import { changeLine, keyFor, type Seen } from "../../fez-github/src/state.js";
import { channelNameFor, headline, validRepo, type Item } from "../../fez-github/src/github.js";

/**
 * The bridge's judgement calls, isolated from the network.
 *
 * Two failure modes matter and neither shows up in a demo: posting the
 * same thing twice (a channel full of duplicates) and posting nothing
 * when something real happened (a bridge nobody trusts). Both live in
 * changeLine and the watermark around it, so both get tested here rather
 * than discovered on a busy repo.
 */

const item = (over: Partial<Item> = {}): Item => ({
  kind: "pr",
  number: 42,
  title: "fix the thing",
  author: "someone",
  state: "open",
  merged: false,
  url: "https://github.com/o/r/pull/42",
  updatedAt: "2026-08-19T00:00:00Z",
  comments: 0,
  ...over,
});

const seen = (over: Partial<Seen> = {}): Seen => ({
  updatedAt: "2026-08-19T00:00:00Z",
  state: "open",
  merged: false,
  comments: 0,
  rootId: "root",
  ...over,
});

describe("only real changes get a message", () => {
  test("a label or a rebase moves updated_at and says nothing", () => {
    // The poll loop reaches changeLine precisely because updated_at
    // changed; it is this function's job to decide it doesn't matter.
    expect(changeLine(seen(), item({ updatedAt: "2026-08-19T09:00:00Z" }))).toBeUndefined();
  });

  test("merged is reported, and outranks closed", () => {
    const line = changeLine(seen(), item({ state: "closed", merged: true }));
    expect(line).toBe("merged");
    expect(line).not.toContain("closed");
  });

  test("closed without a merge is closed", () => {
    expect(changeLine(seen(), item({ state: "closed", merged: false }))).toBe("closed");
  });

  test("reopening is reported", () => {
    expect(changeLine(seen({ state: "closed" }), item({ state: "open" }))).toBe("reopened");
  });
});

describe("checks don't repeat themselves", () => {
  test("a new rollup is reported", () => {
    expect(changeLine(seen(), item(), "2/14 checks failing")).toBe("2/14 checks failing");
  });

  /** Every poll re-reads the rollup; only a CHANGED one is news. */
  test("an unchanged rollup says nothing", () => {
    const before = seen({ checks: "14 checks passing" });
    expect(changeLine(before, item(), "14 checks passing")).toBeUndefined();
  });

  test("green after red is reported", () => {
    const before = seen({ checks: "2/14 checks failing" });
    expect(changeLine(before, item(), "14 checks passing")).toBe("14 checks passing");
  });
});

describe("comments ride along, never alone", () => {
  test("comments alone are not worth a message", () => {
    expect(changeLine(seen(), item({ comments: 5 }))).toBeUndefined();
  });

  test("but they annotate a change that is", () => {
    expect(changeLine(seen(), item({ state: "closed", comments: 3 }))).toBe("closed · 3 new comments");
  });

  test("one comment is singular", () => {
    expect(changeLine(seen(), item({ state: "closed", comments: 1 }))).toBe("closed · 1 new comment");
  });

  /** A deleted comment must not render "-2 new comments". */
  test("a falling count is not reported", () => {
    expect(changeLine(seen({ comments: 5 }), item({ state: "closed", comments: 3 }))).toBe("closed");
  });
});

describe("repo names are constrained before they reach a path", () => {
  test.each(["KennethAshley/fez", "a/b", "some-org/some.repo"])("%s is a repo", (repo) => {
    expect(validRepo(repo)).toBe(true);
  });

  test.each([
    ["path traversal", "../../etc/passwd"],
    ["no owner", "fez"],
    ["query smuggling", "o/r?per_page=1"],
    ["extra segment", "o/r/pulls"],
    ["whitespace", "o/r x"],
    ["empty", ""],
  ])("%s is refused", (_why, repo) => {
    expect(validRepo(repo)).toBe(false);
  });
});

describe("channel names", () => {
  test("the repo's short name, lowercased", () => {
    expect(channelNameFor("KennethAshley/fez")).toBe("fez");
    expect(channelNameFor("vectorize-io/hindsight")).toBe("hindsight");
  });

  test("punctuation collapses to hyphens so it stays a channel name", () => {
    expect(channelNameFor("o/My.Repo_Name")).toBe("my-repo_name".replace(/[^a-z0-9-]+/g, "-"));
  });

  test("two items in the same repo key apart", () => {
    expect(keyFor("o/r", 1)).not.toBe(keyFor("o/r", 2));
    expect(keyFor("o/r", 1)).not.toBe(keyFor("o/other", 1));
  });
});

/**
 * The headline carries a title and a link and NOT the body. On a public
 * repo a body is attacker-authored prose, and putting it in a channel
 * puts it in front of every agent reading the room.
 */
describe("headlines quote the title, never the body", () => {
  test("title, author, state and link — nothing else", () => {
    const text = headline(item({ title: "fix\n  the   thing" }));
    expect(text).toContain("#42");
    expect(text).toContain("fix the thing"); // whitespace flattened
    expect(text).toContain("https://github.com/o/r/pull/42");
    expect(text).toContain("someone");
  });

  test("a merged PR reads merged, not closed", () => {
    expect(headline(item({ state: "closed", merged: true }))).toContain("merged");
  });

  test("issues are not PRs", () => {
    expect(headline(item({ kind: "issue", merged: undefined, state: "open" }))).toContain("open");
  });
});
