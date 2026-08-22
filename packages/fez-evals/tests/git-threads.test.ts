import { describe, expect, it } from "vitest";
import { planThreadPosts, rootMarker, stubMarker, lineOf, type ChannelMsg } from "../../fez-git/src/threads.js";
import type { PushEntry } from "../../fez-git/src/journal.js";
import { parseJournal } from "../../fez-git/src/journal.js";

/**
 * Branch → thread, the judgement half.
 *
 * The scheduled task is glue; every decision — what opens a thread,
 * what replies, what stays silent — lives in planThreadPosts, and this
 * is where those decisions are pinned. The channel is the only cursor,
 * so the properties that matter are all about re-running: the same
 * journal against a channel that already shows it must plan NOTHING.
 */

const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const alice = "1".repeat(64);

const push = (ref: string, oldSha: string, newSha: string, ts = 100): PushEntry => ({
  ts,
  pusher: alice,
  old: oldSha,
  new: newSha,
  ref,
});
const msg = (id: string, content: string, isReply = false): ChannelMsg => ({ id, content, isReply });

describe("a branch becomes a thread", () => {
  it("opens a root on first sight, with the pusher named", () => {
    const posts = planThreadPosts([push("refs/heads/alice/work", ZERO, A)], [], () => "researcher");
    expect(posts).toEqual([
      { branch: "alice/work", text: "⑂ `alice/work` — researcher pushed `aaaaaaaa`" },
    ]);
  });

  it("replies under the existing root on later pushes", () => {
    const root = msg("root-1", `${rootMarker("alice/work")} — researcher pushed \`${A.slice(0, 8)}\``);
    const posts = planThreadPosts([push("refs/heads/alice/work", ZERO, A), push("refs/heads/alice/work", A, B, 200)], [root], () => "researcher");
    expect(posts).toEqual([
      { branch: "alice/work", threadRoot: "root-1", text: "⑂ researcher pushed `bbbbbbbb`" },
    ]);
  });

  it("plans NOTHING against a channel that already shows everything", () => {
    // The idempotence the whole design leans on: the channel is the
    // cursor, so re-running must be free.
    const messages = [
      msg("root-1", `${rootMarker("alice/work")} — researcher pushed \`${A.slice(0, 8)}\``),
      msg("r-2", `⑂ researcher pushed \`${B.slice(0, 8)}\``, true),
    ];
    const entries = [push("refs/heads/alice/work", ZERO, A), push("refs/heads/alice/work", A, B, 200)];
    expect(planThreadPosts(entries, messages)).toEqual([]);
  });

  it("waits rather than double-rooting when two pushes arrive in one poll", () => {
    // The root's id does not exist until it is published; the second
    // push threads under it on the NEXT poll instead of opening a twin.
    const entries = [push("refs/heads/f", ZERO, A), push("refs/heads/f", A, B, 200)];
    const posts = planThreadPosts(entries, [], () => "w");
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain(A.slice(0, 8));
    // ...and the next poll, with the root now visible, catches B up.
    const later = planThreadPosts(entries, [msg("root", posts[0].text)], () => "w");
    expect(later).toEqual([{ branch: "f", threadRoot: "root", text: "⑂ w pushed `bbbbbbbb`" }]);
  });

  it("reports a deletion into the thread, once", () => {
    const root = msg("root-1", `${rootMarker("gone")} — w pushed \`${A.slice(0, 8)}\``);
    const del = push("refs/heads/gone", A, ZERO, 300);
    const posts = planThreadPosts([del], [root], () => "w");
    expect(posts).toEqual([{ branch: "gone", threadRoot: "root-1", text: "⑂ w deleted (was `aaaaaaaa`)" }]);
    // Re-run with the deletion now visible: silence.
    expect(planThreadPosts([del], [root, msg("r-2", posts[0].text, true)])).toEqual([]);
  });

  it("stays silent about a branch that lived and died unseen", () => {
    const posts = planThreadPosts([push("refs/heads/blip", A, ZERO)], []);
    expect(posts).toEqual([]);
  });

  it("threads heads only — a tag is not a conversation", () => {
    expect(planThreadPosts([push("refs/tags/v1", ZERO, C)], [])).toEqual([]);
  });

  it("skips a sha the room is already discussing, rather than repeating it", () => {
    const chat = msg("m1", `deployed ${B.slice(0, 8)} to staging`);
    const posts = planThreadPosts([push("refs/heads/x", A, B)], [chat, msg("root", rootMarker("x"))]);
    expect(posts).toEqual([]);
  });
});

describe("lines — threads as units of work", () => {
  it("derives the line from the name, or none for a top-level branch", () => {
    expect(lineOf("reviewer/feat-auth")).toBe("feat-auth");
    expect(lineOf("feat-auth")).toBeUndefined();
    expect(lineOf("main")).toBeUndefined();
  });

  it("stubs an agent's branch into its line's open thread", () => {
    // /repo branch opened the line; reviewer's first push both opens
    // reviewer's own thread AND leaves the index entry in the line's.
    const lineRoot = msg("line-1", `${rootMarker("feat-auth")} — line opened.`);
    const posts = planThreadPosts([push("refs/heads/reviewer/feat-auth", ZERO, A)], [lineRoot], () => "reviewer");
    expect(posts).toHaveLength(2);
    expect(posts[0].text).toContain(rootMarker("reviewer/feat-auth"));
    expect(posts[0].threadRoot).toBeUndefined();
    expect(posts[1]).toEqual({
      branch: "reviewer/feat-auth",
      threadRoot: "line-1",
      text: `${stubMarker("reviewer/feat-auth")} — reviewer is working this line`,
    });
  });

  it("stubs once — re-runs stay silent", () => {
    const lineRoot = msg("line-1", `${rootMarker("feat-auth")} — line opened.`);
    const first = planThreadPosts([push("refs/heads/reviewer/feat-auth", ZERO, A)], [lineRoot], () => "reviewer");
    const after = [
      lineRoot,
      msg("r-1", first[0].text),
      msg("s-1", first[1].text, true),
    ];
    expect(planThreadPosts([push("refs/heads/reviewer/feat-auth", ZERO, A)], after)).toEqual([]);
  });

  it("no line root, no stub — a plain agent branch is not on a line", () => {
    const posts = planThreadPosts([push("refs/heads/researcher/work", ZERO, A)], [], () => "researcher");
    expect(posts).toHaveLength(1); // just its own root
  });
});

describe("the journal format", () => {
  it("round-trips, with the ref last so no legal refname can break a field", () => {
    const line = `100\t${alice}\t${A}\t${B}\trefs/heads/weird"quote`;
    expect(parseJournal(line)).toEqual([
      { ts: 100, pusher: alice, old: A, new: B, ref: 'refs/heads/weird"quote' },
    ]);
  });

  it("skips garbage instead of failing the poll", () => {
    expect(parseJournal(`not a line\n\n100\t${alice}\t${A}\t${B}\trefs/heads/ok`)).toHaveLength(1);
  });
});
