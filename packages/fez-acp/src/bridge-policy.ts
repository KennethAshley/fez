/**
 * Bridge output policy — pure, eval-pinned (fez-evals imports THIS).
 * The cap is enforced in CODE at every publish site: a bridge talked
 * into dumping a channel log still cannot publish more than the cap.
 */
export function capReply(text: string, maxChars: number | undefined): string {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n✂ [capped at ${maxChars} chars — bridge output policy]`;
}

/**
 * Strip harness plumbing that leaks into reply text. pi-acp prepends an
 * npm update banner to a session's first output — meaningless for the
 * bundled pi and never channel-worthy (it opened the starter team's
 * very first introduction). A reply that was ONLY noise becomes empty,
 * and the empty-reply rejection already handles that honestly.
 */
export function stripHarnessNoise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^New version available: v[\d.]+ \(installed v[\d.]+\)\. Run: `npm i -g @earendil-works\/pi-coding-agent`\s*$/.test(line))
    .join("\n")
    .trim();
}
