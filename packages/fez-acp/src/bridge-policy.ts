/**
 * Bridge output policy — pure, eval-pinned (fez-evals imports THIS).
 * The cap is enforced in CODE at every publish site: a bridge talked
 * into dumping a channel log still cannot publish more than the cap.
 */
export function capReply(text: string, maxChars: number | undefined): string {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n✂ [capped at ${maxChars} chars — bridge output policy]`;
}
