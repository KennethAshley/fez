import { describe, expect, test } from "vitest";
import { isSmallTalk } from "../../fez-orchestrator/src/route-logic";

/**
 * Small talk never reaches the router (measured: needle routes "yo" to
 * an agent and returns nothing for "how are you?"). The regex must stay
 * tight — a greeting-prefixed TASK must still route.
 */
const SMALL_TALK = ["yo", "hey", "hey there!", "how are you?", "good morning fez", "thanks!", "thank you", "what's up", "ok", "nice one", "gm"];
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
