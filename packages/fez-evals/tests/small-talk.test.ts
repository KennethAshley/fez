import { describe, expect, test } from "vitest";
import { isSmallTalk } from "../../fez-orchestrator/src/route-logic.js";

/**
 * Small talk never reaches the router (measured: a tiny router sends "yo" to
 * an agent and returns nothing for "how are you?"). The regex must stay
 * tight — a greeting-prefixed TASK must still route.
 */
const SMALL_TALK = [
    "ok cool",
    "sounds good","yo", "hey", "hey there!", "how are you?", "good morning fez", "thanks!", "thank you", "what's up", "ok", "nice one", "gm"];
const TASKS = [
  "hey review my relay changes",
  "yo find me papers on nostr",
  "ok ship v2 now",
  "dig up recent papers",
  "how are you handling retries",
  "thanks — now deploy it",
  "good morning, please summarize the thread",
];

describe("small-talk gate", () => {
  for (const q of SMALL_TALK) {
    test(`small talk: "${q}"`, () => expect(isSmallTalk(q)).toBe(true));
  }
  for (const q of TASKS) {
    test(`task (must route): "${q}"`, () => expect(isSmallTalk(q)).toBe(false));
  }
});

describe("chained pleasantries", () => {
  // Each half matched alone but the pair did not, so these fell through
  // to the router and paid a model call to be told nobody fits.
  test.each([
    "hey how's it going",
    "hi there thanks",
    "ok cool thanks",
    "hello, how are you",
    "yo sup",
  ])("absorbs %j", (text) => {
    expect(isSmallTalk(text)).toBe(true);
  });

  // The repetition must not swallow a real request that merely opens
  // with a greeting — the tail has to match too, or nothing does.
  test.each([
    "hi there is a bug in relay.ts",
    "thanks for nothing, now deploy v2",
    "cool, can you review my patch",
  ])("still routes %j", (text) => {
    expect(isSmallTalk(text)).toBe(false);
  });
});
