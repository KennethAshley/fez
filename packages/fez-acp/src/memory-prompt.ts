/**
 * How agent memory shows up in prompts — the pure half.
 *
 * All six of a live fleet's agents had EMPTY memory after weeks of
 * sessions. The machinery was fine (an explicit "remember this" wrote an
 * engram in ten seconds); the ambient "No core memory found. Create one
 * now…" aside in the system section was what never converted — the same
 * turn that saved an asked-for memory ignored it again. Models treat
 * system-section asides as lore and turn instructions as tasks, so the
 * no-core instruction moves NEXT TO the trigger as this-turn work.
 *
 * The rest is Buzz's insight, fez-sized (buzz base_prompt.md "Agent
 * Memory"): agents write memory when the prompt treats core as
 * load-bearing state, not when a nudge asks nicely. So the convention
 * makes capture a standing habit, and the core section rides EVERY turn
 * — the harness compacts its own context, and a compaction that drops
 * your identity is how an agent quietly becomes nobody mid-session.
 *
 * Three states, deliberately: "none" is the relay CONFIRMING no core
 * exists; "unknown" is an outage. Only "none" may invite a core write —
 * a core written blind during an outage would CLOBBER the real one when
 * the relay returns, because monotonic created_at makes the newer,
 * emptier write win (Buzz's engram_fetch draws the same line).
 */

export type CoreMemoryState = { core: string } | "none" | "unknown";

export interface MemoryPromptParts {
  /** The `[Agent Memory — core]` block for the top of a fresh prompt. */
  section: string | null;
  /** The standing conventions line — present in every state, because the
   *  habit ("save durable facts as you learn them") must not depend on
   *  whether a core happens to exist yet. */
  convention: string;
  /** This-turn work placed next to the trigger when no core exists. */
  firstTurnTask: string | null;
  /** What every LATER turn carries, so core survives the harness
   *  compacting its own context mid-session. */
  turnPreamble: string | null;
}

const CONVENTION = [
  `- Memory: fez_mem_set / fez_mem_get / fez_mem_list are your memory across sessions — chat context is not.`,
  `Keep "core" to a few lines (who you are, standing rules, durable context) and REWRITE it whole when it changes — never append forever; when something core tracks is finished, drop its line the same turn.`,
  `When you learn a durable fact about your user or your work (a preference, a decision, standing context), save it to mem/<topic> without being asked, and say you did.`,
  `Detail you don't need every turn goes in a mem/ slug you fez_mem_get on demand, not in core.`,
].join(" ");

const FIRST_TURN_TASK = [
  `You have no core memory yet, so every session starts you from nothing.`,
  `Before replying below: call fez_mem_set with slug "core" and two or three sentences — who you are, your standing rules, what you're for.`,
  `Write a first draft NOW from your persona (ask your user later if unsure — you can rewrite core any time), then answer the message.`,
].join(" ");

export function memoryPromptParts(state: CoreMemoryState): MemoryPromptParts {
  if (typeof state === "object") {
    const section = `[Agent Memory — core]\n${state.core}`;
    return { section, convention: CONVENTION, firstTurnTask: null, turnPreamble: section };
  }
  return {
    section: null,
    convention: CONVENTION,
    firstTurnTask: state === "none" ? FIRST_TURN_TASK : null,
    turnPreamble: null,
  };
}
