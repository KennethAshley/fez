/** The poll wire format — plain message text every client can read.
 *  📊 poll: <question>
 *  1️⃣ <option>
 *  2️⃣ <option>
 *  closes: <ISO timestamp>
 *  Votes are reactions with the option emoji; tally rules live in
 *  fez-mcp/src/vote-logic (shared, eval-pinned). */
import { OPTION_EMOJI } from "../../fez-mcp/src/vote-logic.js";

export { OPTION_EMOJI, tallyPoll } from "../../fez-mcp/src/vote-logic.js";

export const POLL_PREFIX = "📊 poll: ";

export function formatPoll(question: string, options: string[], closesAtMs: number): string {
  const lines = [POLL_PREFIX + question.trim()];
  options.slice(0, OPTION_EMOJI.length).forEach((option, i) => lines.push(`${OPTION_EMOJI[i]} ${option.trim()}`));
  lines.push(`closes: ${new Date(closesAtMs).toISOString()}`);
  return lines.join("\n");
}

export interface ParsedPoll {
  question: string;
  options: string[];
  closesAtMs: number;
}

export function parsePoll(content: string): ParsedPoll | undefined {
  if (!content.startsWith(POLL_PREFIX)) return undefined;
  const lines = content.split("\n");
  const question = lines[0].slice(POLL_PREFIX.length).trim();
  const options: string[] = [];
  let closesAtMs = 0;
  for (const line of lines.slice(1)) {
    const optionIndex = OPTION_EMOJI.findIndex((emoji) => line.startsWith(emoji));
    if (optionIndex === options.length) options.push(line.slice(OPTION_EMOJI[optionIndex].length).trim());
    else if (line.startsWith("closes: ")) closesAtMs = Date.parse(line.slice(8).trim());
  }
  if (!question || options.length < 2) return undefined;
  return { question, options, closesAtMs };
}

/** "/poll question | opt a | opt b | 15m" → parts. Duration suffix optional (default 60m). */
export function parsePollCommand(argText: string): { question: string; options: string[]; durationMs: number } | { error: string } {
  const parts = argText.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return { error: "usage: /poll question | option a | option b [| 15m]" };
  let durationMs = 60 * 60_000;
  const last = parts[parts.length - 1];
  const timed = /^(\d+)\s*(m|min|h|hr)$/i.exec(last);
  if (timed) {
    durationMs = Number(timed[1]) * (/^h/i.test(timed[2]) ? 3_600_000 : 60_000);
    parts.pop();
  }
  const [question, ...options] = parts;
  if (options.length < 2) return { error: "a poll needs at least two options" };
  if (options.length > OPTION_EMOJI.length) return { error: `at most ${OPTION_EMOJI.length} options` };
  return { question, options, durationMs };
}
