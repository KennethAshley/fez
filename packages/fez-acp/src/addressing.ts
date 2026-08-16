/**
 * Message addressing — pure logic shared by the fez-acp runtime and
 * fez-evals. Every rule here was earned in live testing:
 *
 * - The FIRST @name in a message is its addressee; later @names are
 *   context or downstream handoffs ("@reviewer check it, if good ping
 *   @coder" must NOT fire coder immediately).
 * - A message with NO text mentions falls back to the p-tag, but only
 *   from the OWNER: replies auto-p-tag whoever they answer, so between
 *   agents the fallback is a perpetual-motion machine (A answers B,
 *   summoning B to answer A, straight into the depth cap).
 * - Name matching is the auto-spawn bootstrap: a mention of a
 *   not-yet-running agent can't carry its p-tag.
 */
export interface AddressableEvent {
  pubkey: string;
  content: string;
  tags: string[][];
}

export function isAddressedTo(
  event: AddressableEvent,
  personaId: string,
  myPubkey: string,
  owner: string | undefined
): boolean {
  const first = event.content.match(/@([\w-]+)/)?.[1];
  if (first) return first.toLowerCase() === personaId.toLowerCase();
  return event.pubkey === owner && event.tags.some((t) => t[0] === "p" && t[1] === myPubkey);
}
