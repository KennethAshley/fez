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
import { addressees, proseMentions } from "../../fez-client/src/agent-mentions.js";
export { addressees };

export interface AddressableEvent {
  pubkey: string;
  content: string;
  tags: string[][];
}

/** Peers already dispatched by the source message need a reference, not a second task. */
export function withoutRepeatSummons(reply: string, source: string, self: string): string {
  const peers = new Set(addressees(source).filter(name => name !== self));
  for (const mention of proseMentions(reply).reverse()) {
    if (peers.has(mention.name)) reply = reply.slice(0, mention.index) + reply.slice(mention.index + 1);
  }
  return reply;
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
