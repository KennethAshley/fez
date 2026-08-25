/**
 * What a face says when you hover it — one very short line, pure
 * flavor. The cast speak in their own voices; every generated familiar
 * gets a line its pubkey picks, so the same key says the same words on
 * every surface (the sprite rule, applied to speech). Local and
 * deterministic: no truth claims, nothing fetched.
 */

const CAST_QUIPS: Record<string, string> = {
  fez: "ask me anything",
  scout: "charting subnets",
  loom: "still weaving",
  vault: "safe with me",
  chip: "cycles to spare",
  ember: "still burning",
  quill: "ink's still wet",
  forge: "hammer's warm",
  drift: "just passing through",
  score: "make it sing",
};

const QUIPS = [
  "hm?",
  "the relay hums",
  "live and burning",
  "who goes there?",
  "salt and signal",
  "still listening",
  "the wire sings",
  "carry on",
  "all quiet here",
  "watching the wire",
  "old paths, new keys",
  "signal's clean",
  "we endure",
  "many hands",
];

export function quipFor(pk: string, name?: string): string {
  const key = name?.toLowerCase().replace(/^@/, "");
  if (key && CAST_QUIPS[key]) return CAST_QUIPS[key];
  // A different pk byte than the animation tempo uses (Avatar reads
  // 8–10), so voice and gait vary independently.
  const byte = parseInt(pk.slice(10, 12), 16) || 0;
  return QUIPS[byte % QUIPS.length];
}
