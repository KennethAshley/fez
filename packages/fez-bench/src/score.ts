import { CASES } from "./cases.js";
import type { RosterAgent } from "./cases.js";
import { runBench } from "./runner.js";

/**
 * Score YOUR roster, not the frozen one.
 *
 * The frozen battery grades against fixed expectations
 * (researcher/reviewer/deployer), which makes it a regression gate for
 * fez itself: hold the roster still and a moving score means the model,
 * the request shape, or the pre-layers changed. That is exactly why it
 * says nothing about the personas actually on this machine — and
 * personas are local files that drift per device, so "the bench is at
 * 93%" can be true while your own @fez shrugs at everything.
 *
 * Grading arbitrary agents against those labels is impossible: a roster
 * of `scout`/`critic`/`pilot` has no correct answer in a battery whose
 * expectations name three other agents. So this does not grade. It
 * measures COVERAGE, which needs no labels:
 *
 *   - how often the router declines a prompt that is plainly a task
 *   - how the picks distribute across your agents
 *   - which agents are never picked at all
 *
 * An agent that never wins a single prompt is the finding. Its
 * description is invisible to the router, and no amount of mentioning
 * it by name will change that — @fez will keep not suggesting it.
 */

/** Categories where declining is the CORRECT answer, so they prove nothing about coverage. */
const DECLINE_IS_RIGHT = new Set(["smalltalk", "fleet-meta", "no-fit", "adversarial"]);

export interface RosterScore {
  model: string;
  /** Prompts that should reach somebody. */
  taskCount: number;
  /** Of those, how many the router declined. */
  declined: number;
  /** Picks per agent name, including zeros. */
  picks: Map<string, number>;
  /** Agents that never won a prompt — the actionable finding. */
  silent: string[];
  /** A sample of declined task prompts, so the wording gap is visible. */
  examples: string[];
}

export async function scoreRoster(base: string, roster: RosterAgent[]): Promise<RosterScore> {
  // Deterministic pre-layers answer some cases without the router at
  // all; those are counted as handled, not declined, because they ARE.
  const { results, model } = await runBench(base, roster, CASES);

  const picks = new Map<string, number>(roster.map((a) => [a.name, 0]));
  let taskCount = 0;
  let declined = 0;
  const examples: string[] = [];

  for (const r of results) {
    if (DECLINE_IS_RIGHT.has(r.bench.category)) continue;
    taskCount++;
    if (r.got === "none") {
      declined++;
      if (examples.length < 8) examples.push(r.bench.q);
      continue;
    }
    picks.set(r.got, (picks.get(r.got) ?? 0) + 1);
  }

  return {
    model,
    taskCount,
    declined,
    picks,
    silent: [...picks.entries()].filter(([, n]) => n === 0).map(([name]) => name),
    examples,
  };
}

export function formatRosterScore(s: RosterScore): string {
  const reached = s.taskCount - s.declined;
  const pct = s.taskCount === 0 ? 0 : Math.round((reached / s.taskCount) * 100);
  const lines = [
    `routing coverage — ${s.model}`,
    `  ${reached}/${s.taskCount} task prompts reached an agent (${pct}%)`,
    "",
  ];
  const width = Math.max(...[...s.picks.keys()].map((n) => n.length), 8);
  for (const [name, n] of [...s.picks.entries()].sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(Math.round((n / Math.max(1, s.taskCount)) * 20));
    lines.push(`  ${name.padEnd(width)}  ${String(n).padStart(3)}  ${bar}`);
  }
  if (s.silent.length > 0) {
    lines.push(
      "",
      `⚠ never picked: ${s.silent.join(", ")}`,
      "  The router cannot see these. Their `description:` is what it reads —",
      "  give it the verbs and nouns people actually use for that work."
    );
  }
  if (s.examples.length > 0) {
    lines.push("", "declined, and probably should not have been:");
    for (const q of s.examples) lines.push(`  · ${q}`);
    lines.push("  Wording like this is missing from every description you have.");
  }
  return lines.join("\n");
}
