import { parseThreadRef } from "./thread-ref.js";
import type { Filter, Event } from "nostr-tools";

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

/** Only a direct instruction summons a worker; conditional downstream mentions wait. */
export function addressees(content: string): string[] {
  const names: string[] = [];
  for (const { name, index } of proseMentions(content)) {
    const prefix = content.slice(0, index);
    const clause = prefix.split(/[.?!\n]/).at(-1) ?? "";
    const nextInstruction = /\bthen\s*$/i.test(clause) && !/\b(if|unless|when|once)\b/i.test(clause);
    if (names.length === 0 || nextInstruction || /[.?!\n]["')\]]*\s*$/.test(prefix)) names.push(name);
  }
  return [...new Set(names)];
}

export const HANDOFF_BRIEF_LIMIT = 4000;

/** A global history limit cannot prove name uniqueness; read each member's latest profiles. */
export async function agentProfiles(members: string[], query: (filters: Filter[]) => Promise<Event[]>): Promise<Event[]> {
  return (await Promise.all(members.map(pubkey => query([
    { kinds: [0], authors: [pubkey], limit: 1 }, { kinds: [47000], authors: [pubkey], limit: 1 },
  ])))).flat();
}

/**
 * Resolve an exact published workspace name; callers verify membership.
 * Unknown → undefined (the name is dropped, never guessed). Ambiguous →
 * throws, so a handoff can never pick a member at random.
 */
export function resolveAgentName(name: string, events: { pubkey: string; id: string; created_at: number; content: string }[]): string | undefined {
  const profiles = new Map<string, { name?: string; aliases?: unknown }>();
  for (const event of [...events].sort((a, b) => a.created_at - b.created_at || b.id.localeCompare(a.id))) {
    try { profiles.set(event.pubkey, JSON.parse(event.content)); } catch { /* invalid profile */ }
  }
  const matches = [...profiles].filter(([, profile]) =>
    typeof profile?.name === "string" && profile.name.toLowerCase() === name.toLowerCase() ||
    Array.isArray(profile?.aliases) && profile.aliases.some(alias => typeof alias === "string" && alias.toLowerCase() === name.toLowerCase()));
  if (matches.length > 1) throw new Error(`@${name} resolves to ${matches.length} workspace members. Use one unambiguous published name before handing off work.`);
  return matches[0]?.[0];
}

/** Both model replies and MCP sends use the same thread, mention and assignment rules.
 * Callers resolve identities against verified membership and owner attestations. */
export async function agentMessageTags(content: string, options: {
  channel: string; sender: string; owner?: string;
  source?: { id: string; pubkey: string; tags: string[][] };
  resolve: (name: string) => Promise<string | undefined>;
  isWorker: (pubkey: string) => Promise<boolean>;
}): Promise<string[][]> {
  const { source, channel, sender, owner, resolve, isWorker } = options;
  if (source && (source.tags.filter(t => t[0] === "h").length !== 1 ||
      !source.tags.some(t => t[0] === "h" && t[1] === channel))) throw new Error("The source message belongs to a different channel.");
  const depth = Number(source?.tags.find(t => t[0] === "depth")?.[1] ?? 0);
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("Invalid source message depth.");
  const root = source && parseThreadRef(source.tags).rootId;
  const tags = [["h", channel],
    ...(root ? [["e", root, "", "root"]] : []),
    ...(source ? [["e", source.id, "", "reply"], ["p", source.pubkey]] : []),
    ["depth", String(source ? depth + 1 : 0)],
  ];
  tags.push(...await mentionTags(content, resolve, [sender, ...tags.filter(t => t[0] === "p").map(t => t[1])]));
  for (const name of addressees(content)) {
    const pk = await resolve(name);
    if (pk && pk !== sender && pk !== owner && pk !== source?.pubkey && await isWorker(pk) &&
        !tags.some(t => t[0] === "task" && t[1] === pk)) tags.push(["task", pk]);
  }
  if (tags.some(t => t[0] === "task") && content.length > HANDOFF_BRIEF_LIMIT) {
    throw new Error(`Handoff brief exceeds ${HANDOFF_BRIEF_LIMIT} characters. Send task, relevant facts, constraints, expected result and references; leave history at its source.`);
  }
  return tags;
}
