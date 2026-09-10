/**
 * Mentions — the one place that turns "@name" in a message into the p
 * tags that make it reach someone.
 *
 * A name is text. Nothing downstream reads text: the inbox, unread
 * counts, notifications and an agent's own subscription
 * ({"#p": [self]}) all read p tags. So a publish path that writes the
 * name and not the tag produces a message that LOOKS addressed and
 * reaches nobody — silently, because there is no error to raise.
 *
 * That happened three times in one afternoon, on three paths that each
 * built their tags by hand: channel replies, the GUI's highlight, and
 * the MCP doc-comment tool. Each needed its own fix. Hence this: every
 * publish path resolves names the same way, and a new path gets the
 * behaviour by calling one function rather than by remembering to.
 */

/**
 * The @ must open a word. Without this, "ken@example.com" mentions
 * @example and "user@host" mentions @host — a message quoting an email
 * address would tag a stranger who happened to share the domain name.
 */
const MENTION = /(?:^|[^\w@/])@([\w-]+)/g;

/**
 * Agent calls exclude quoted examples and code. Keep original offsets so
 * running agents can inspect sentence boundaries without losing punctuation.
 * Unbalanced delimiters fail open, matching the summon policy.
 */
export function proseMentions(content: string): { name: string; index: number }[] {
  const mask = (text: string) => " ".repeat(text.length);
  const prose = content
    .replace(/```[\s\S]*?```/g, mask)
    .replace(/`[^`\n]*`/g, mask)
    .replace(/"[^"\n]*"/g, mask)
    .replace(/“[^”\n]*”/g, mask);
  return [...prose.matchAll(MENTION)].map((match) => ({
    name: match[1].toLowerCase(),
    index: match.index + match[0].indexOf("@"),
  }));
}

/** Every name a message @-mentions, lowercased, in first-seen order. */
export function mentionedNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(MENTION)) {
    const name = match[1].toLowerCase();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * p tags for the people a message names.
 *
 * `resolve` is the caller's — each surface knows a different roster (an
 * agent walks the workspace roster, the MCP server has a name cache) —
 * but every surface must be able to FAIL to resolve. An unresolvable
 * name is dropped, never guessed: tagging a key because a name looked
 * close is worse than not tagging at all.
 *
 * `exclude` keeps a path from double-tagging (the trigger author is
 * usually already tagged) and from tagging itself.
 */
export async function mentionTags(
  content: string,
  resolve: (name: string) => Promise<string | undefined> | string | undefined,
  exclude: Iterable<string> = []
): Promise<string[][]> {
  const skip = new Set(exclude);
  const tags: string[][] = [];
  for (const name of mentionedNames(content)) {
    let pubkey: string | undefined;
    try {
      pubkey = await resolve(name);
    } catch {
      continue; // a lookup that failed is an unresolved name, not a crash
    }
    if (!pubkey || skip.has(pubkey)) continue;
    skip.add(pubkey);
    tags.push(["p", pubkey]);
  }
  return tags;
}
