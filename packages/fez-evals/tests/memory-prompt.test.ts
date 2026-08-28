import { describe, it, expect } from "vitest";
import { memoryPromptParts } from "../../fez-acp/src/memory-prompt.js";

/**
 * Why this module exists: all six agents had EMPTY memory after weeks of
 * sessions. The machinery worked (proven live: an explicit "remember
 * this" wrote an engram in 10s) — the ambient MEM_NUDGE in the system
 * section was what never converted, and it also taught the shell command
 * while the conventions said to prefer the fez_mem_* tools. Buzz has the
 * same weak nudge; what makes THEIR agents write memory is that the
 * surrounding prompt treats core as load-bearing state. This is the
 * fez-sized port: the no-core instruction becomes a this-turn task next
 * to the trigger, the convention makes capture a standing habit, and
 * core rides every turn so harness-side compaction can't drop it.
 */
describe("memoryPromptParts", () => {
  const withCore = memoryPromptParts({ core: "I am drift. I check my answers." });
  const none = memoryPromptParts("none");
  const unknown = memoryPromptParts("unknown");

  it("a stored core becomes the section AND the every-turn preamble", () => {
    expect(withCore.section).toContain("[Agent Memory — core]");
    expect(withCore.section).toContain("I am drift.");
    expect(withCore.turnPreamble).toBe(withCore.section);
    expect(withCore.firstTurnTask).toBeNull();
  });

  it("confirmed-no-core becomes a this-turn task, not an ambient aside", () => {
    expect(none.section).toBeNull();
    expect(none.turnPreamble).toBeNull();
    expect(none.firstTurnTask).toContain("fez_mem_set");
    expect(none.firstTurnTask).toContain("core");
    // It must read as work for THIS turn, ordered before the reply.
    expect(none.firstTurnTask!.toLowerCase()).toContain("before");
  });

  it("an unknown state (relay outage) never invites a core write", () => {
    // A core written during an outage would CLOBBER the real one when the
    // relay returns — monotonic created_at means the blind write wins.
    expect(unknown.firstTurnTask).toBeNull();
    expect(unknown.section).toBeNull();
    expect(unknown.turnPreamble).toBeNull();
  });

  it("the convention is standing, tool-consistent, and habit-shaped", () => {
    for (const parts of [withCore, none, unknown]) {
      expect(parts.convention).toContain("fez_mem_set");
      expect(parts.convention).toContain("mem/");
      expect(parts.convention.toLowerCase()).toContain("without being asked");
    }
  });

  it("nothing anywhere teaches the shell spelling", () => {
    for (const parts of [withCore, none, unknown]) {
      for (const text of [parts.section, parts.convention, parts.firstTurnTask, parts.turnPreamble]) {
        expect(text ?? "").not.toMatch(/fez mem set/);
      }
    }
  });
});
