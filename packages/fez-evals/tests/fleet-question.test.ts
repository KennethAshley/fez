import { describe, expect, test } from "vitest";
import { fleetQuestion } from "../../fez-orchestrator/src/route-logic";

/**
 * Fleet meta-questions must never reach the router — found live:
 * "@fez what can researcher do?" routed to reviewer (a 26M router has
 * no concept of questions ABOUT the fleet). These pin the deterministic
 * layer that answers them from the roster instead.
 */

const NAMES = ["researcher", "reviewer", "pilot", "scout"];

describe("fleetQuestion", () => {
  test.each([
    ["what can researcher do?", "researcher"],
    ["what can @researcher do", "researcher"],
    ["what does reviewer do?", "reviewer"],
    ["who is pilot?", "pilot"],
    ["what is scout good at?", "scout"],
    ["tell me about researcher", "researcher"],
    ["what are reviewer's skills?", "reviewer"],
    ["describe pilot", "pilot"],
  ])("agent question: %s", (text, name) => {
    expect(fleetQuestion(text, NAMES)).toEqual({ kind: "agent", name });
  });

  test.each([
    "what agents are there?",
    "who's available?",
    "list your agents",
    "who is on deck",
    "what agents do you have",
  ])("roster question: %s", (text) => {
    expect(fleetQuestion(text, NAMES)).toEqual({ kind: "roster" });
  });

  test.each([
    "review this diff for style problems",
    "researcher, dig up the NIP-17 spec",
    "have someone review what researcher wrote",
    "what can we do about the failing deploy?",
    "who wrote this function?",
    "summarize what researcher said yesterday",
  ])("task (must route, not answer): %s", (text) => {
    expect(fleetQuestion(text, NAMES)).toBeUndefined();
  });

  test("unknown agent name is not an agent question", () => {
    expect(fleetQuestion("what can nonexistent do?", NAMES)).toBeUndefined();
  });
});
