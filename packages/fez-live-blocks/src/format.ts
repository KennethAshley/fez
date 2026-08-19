/**
 * Live block grammar — pure, so every part (gui, headless, and any
 * future scheduler) agrees on what a live block is.
 *
 *   ```fez:live agent=researcher every=1d
 *   Summarize what changed in the repo this week.
 *   ---
 *   (last output goes here, written by the agent)
 *   ```
 *
 * The declaration (agent + cadence + prompt) is authored by a human; the
 * output below the `---` fence is the agent's, replaced on each refresh.
 * Keeping both inside the block means the page is still just markdown:
 * a bare client shows the whole thing, no viewer required.
 */

export const LIVE_LANG = "fez:live";
export const OUTPUT_SEPARATOR = "---";

export interface LiveBlock {
  agent?: string;
  /** cadence in ms, from every=30m|4h|1d|1w; undefined = manual only */
  everyMs?: number;
  prompt: string;
  output?: string;
  /** unix seconds of the last agent write, from updated=<ts> */
  updatedAt?: number;
}

const DURATION = /^(\d+)(m|h|d|w)$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text.trim());
  if (!match) return undefined;
  return Number(match[1]) * UNIT_MS[match[2]];
}

/** Parse the fence info line (`agent=x every=1d updated=123`) plus body. */
export function parseLiveBlock(info: string, body: string): LiveBlock {
  const attrs = new Map<string, string>();
  for (const match of info.matchAll(/([a-z]+)=("[^"]*"|\S+)/gi)) {
    attrs.set(match[1].toLowerCase(), match[2].replace(/^"|"$/g, ""));
  }
  const separatorIndex = body.split("\n").findIndex((line) => line.trim() === OUTPUT_SEPARATOR);
  const lines = body.split("\n");
  const prompt = (separatorIndex === -1 ? lines : lines.slice(0, separatorIndex)).join("\n").trim();
  const output = separatorIndex === -1 ? undefined : lines.slice(separatorIndex + 1).join("\n").trim();
  const updated = Number(attrs.get("updated"));
  return {
    agent: attrs.get("agent"),
    everyMs: attrs.get("every") ? parseDuration(attrs.get("every")!) : undefined,
    prompt,
    output: output || undefined,
    updatedAt: Number.isFinite(updated) && updated > 0 ? updated : undefined,
  };
}

/** Is this block due for a refresh? Manual-only blocks never are. */
export function isDue(block: LiveBlock, nowMs: number): boolean {
  if (!block.everyMs || !block.agent) return false;
  if (!block.updatedAt) return true; // never run
  return nowMs - block.updatedAt * 1000 >= block.everyMs;
}

/** Render a block back to markdown (used when inserting one). */
export function formatLiveBlock(block: LiveBlock): string {
  const attrs = [
    block.agent ? `agent=${block.agent}` : "",
    block.everyMs ? `every=${humanDuration(block.everyMs)}` : "",
    block.updatedAt ? `updated=${block.updatedAt}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = block.output ? `${block.prompt}\n${OUTPUT_SEPARATOR}\n${block.output}` : block.prompt;
  return `\`\`\`${LIVE_LANG}${attrs ? " " + attrs : ""}\n${body}\n\`\`\``;
}

export function humanDuration(ms: number): string {
  for (const [unit, size] of [["w", UNIT_MS.w], ["d", UNIT_MS.d], ["h", UNIT_MS.h], ["m", UNIT_MS.m]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / UNIT_MS.m)}m`;
}

/** "3h ago" / "just now" — freshness is the whole point of a live block. */
export function ago(updatedAtS: number | undefined, nowMs: number): string {
  if (!updatedAtS) return "never run";
  const seconds = Math.max(0, Math.floor(nowMs / 1000 - updatedAtS));
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `/live @agent every=1d <prompt>` → a block, or an error to show. */
export function parseLiveCommand(args: string): { block: LiveBlock } | { error: string } {
  const text = args.trim();
  if (!text) return { error: "usage: /live @agent [every=1d] <what it should keep up to date>" };
  const agentMatch = /^@([\w-]+)\s*/.exec(text);
  if (!agentMatch) return { error: "name the agent that owns the block: /live @researcher every=1d <prompt>" };
  let rest = text.slice(agentMatch[0].length);
  let everyMs: number | undefined;
  const everyMatch = /^every=(\S+)\s*/.exec(rest);
  if (everyMatch) {
    everyMs = parseDuration(everyMatch[1]);
    if (!everyMs) return { error: `"${everyMatch[1]}" isn't a cadence — use 30m, 4h, 1d, 1w` };
    rest = rest.slice(everyMatch[0].length);
  }
  if (!rest.trim()) return { error: "say what the block should keep up to date" };
  return { block: { agent: agentMatch[1], everyMs, prompt: rest.trim() } };
}
