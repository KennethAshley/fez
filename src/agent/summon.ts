/**
 * Summon policy shared by every summoning host (sentinel, desktop).
 * Extracted from fez-sentinel so the GUI can summon while open without
 * the daemon — one policy, two hosts, no drift.
 */

/**
 * A string safe to interpolate into a SHELL COMMAND — the repo/line an
 * agent is summoned onto reach a live terminal via herdr, so they are
 * validated like git validates refs: letters, digits, dot, dash, slash,
 * underscore, no `..`, bounded length. Not escaped — REFUSED. Exported
 * so the source (work-context resolution) and the sinks (herdr command
 * line, the desktop's Rust spawn) share ONE definition of "safe".
 */
export function isSafeWork(value: string | undefined): boolean {
  return !!value && /^[\w][\w./-]{0,200}$/.test(value) && !value.includes("..");
}

/**
 * Mention ≠ summon. An @name in PROSE is a call; one inside a code fence,
 * inline backticks, or quotes is speech ABOUT an agent (example text, tool
 * source, a quoted message) and must not spawn it. Unbalanced delimiters
 * fail open — a spare summon is harmless (the agent reads the thread and
 * stands down), a silently dropped one is a no-show.
 */
export function summonMentions(content: string): string[] {
  const prose = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ");
  return [...new Set([...prose.matchAll(/@([\w-]+)/g)].map((m) => m[1].toLowerCase()))];
}