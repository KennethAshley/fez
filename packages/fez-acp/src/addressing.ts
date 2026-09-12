/**
 * Message addressing — pure logic shared by the fez-acp runtime and
 * fez-evals. Every rule here was earned in live testing:
 *
 * - The FIRST @name in a message is its addressee; later @names are
 *   context or downstream handoffs ("@reviewer check it, if good ping
 *   @coder" must NOT fire coder immediately).
 * - A message with NO @name-like tokens falls back to the p-tag, but only
 *   from the OWNER: replies auto-p-tag whoever they answer, so between
 *   agents the fallback is a perpetual-motion machine (A answers B,
 *   summoning B to answer A, straight into the depth cap).
 * - Name matching is the auto-spawn bootstrap: a mention of a
 *   not-yet-running agent can't carry its p-tag.
 * - Explicit task tags address their worker independently of prose;
 *   the caller still verifies the signature, author policy, and roster.
 */
import { proseMentions } from "@fezchat/protocol";

export interface AddressableEvent {
  pubkey: string;
  content: string;
  tags: string[][];
}

/**
 * SEGMENT-START addressing (v2, earned in the comms battery): the first
 * @name addresses, and so does any @name that OPENS a new segment — a
 * sentence (after . ? !) or a line. "T1: @a X? @b Y? @c Z." fans out
 * to all three; "check it, if good ping @coder" still protects coder
 * (mid-sentence = downstream handoff, not an addressee).
 */
export function addressees(content: string): string[] {
  const names: string[] = [];
  for (const { name, index } of proseMentions(content)) {
    // Look back: only whitespace/quotes/brackets since a sentence end or line start?
    if (names.length === 0 || /[.?!\n]["')\]]*\s*$/.test(content.slice(0, index))) names.push(name);
  }
  return [...new Set(names)];
}

export function isAddressedTo(
  event: AddressableEvent,
  personaId: string,
  myPubkey: string,
  owner: string | undefined,
  /** The persona's "also answers to" nicknames — matched exactly like the id. */
  aliases: readonly string[] = []
): boolean {
  if (event.tags.some(t => t[0] === "task" && t[1] === myPubkey)) return true;
  const named = addressees(event.content);
  if (named.length > 0) {
    const mine = new Set([personaId, ...aliases].map((n) => n.toLowerCase()));
    return named.some((n) => mine.has(n));
  }
  // An ignored example/email must not turn its automatic p-tag into a call.
  if (/@[\w-]+/.test(event.content)) return false;
  return event.pubkey === owner && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey);
}
