/**
 * Frontmatter key names — the browser-safe mirror.
 *
 * The canonical list is KNOWN_EXTRA_KEYS in src/identity/personas.ts
 * (Node-only: it lives beside the persona loader). The editor needs the
 * same answer to "is this key a typo?" and cannot import Node, so the
 * list and the matcher are duplicated here and persona-typo.test.ts runs
 * BOTH over one table — a key added to one and not the other is a red
 * test, not an editor that disagrees with the CLI.
 *
 * Only the key check is mirrored. Size limits, harness checks and source
 * validation stay CLI-side; they are not what the editor needs to say.
 */
export const ALL_KNOWN_KEYS = [
  // parsed directly by parseFrontmatter
  "harness", "aliases", "mcpServers", "description",
  // KNOWN_EXTRA_KEYS, mirrored from src/identity/personas.ts:172
  "workdir", "repo", "branch", "scope",
  "provider", "model", "modelProfile", "effort", "packages",
  "routable", "idleExit", "idleTimeoutS", "turnTimeoutS",
  "reflectionEvery", "reflectionPrompt",
  "url", "channels", "owner", "respondTo",
  "maxReplyChars", "shareLevel", "approvalQuorum",
  "rate",
];

function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

/** The known key an unknown one was probably reaching for, or undefined. */
export function nearestKnownKey(key: string): string | undefined {
  if (key.length < 4) return undefined;
  let best: { key: string; distance: number } | undefined;
  for (const known of ALL_KNOWN_KEYS) {
    if (known === key) return undefined;
    const distance = editDistance(key.toLowerCase(), known.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { key: known, distance };
  }
  return best?.key;
}
