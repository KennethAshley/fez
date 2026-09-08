/** quill's DM when a miner needs a human. Pure so the wording is testable. */
export function attentionDmText(netuid: number, persona: string, reason: string): string {
  return `⛏ heads up — your netuid ${netuid} miner needs you: ${reason}. Reply and I'll act (e.g. "stop it").`;
}

/** DM only on a TRANSITION: the current attention reason differs from the last
 *  one we DM'd (a cleared marker is stored as "" → any real reason re-fires). */
export function shouldDmAttention(prevMarker: string | undefined, currentAttention: string): boolean {
  return (prevMarker ?? "") !== currentAttention;
}
