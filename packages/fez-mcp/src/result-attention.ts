import type { Attention } from "../../fez-acp/src/governor.js";

/**
 * A work result is addressed to the requester — the agent that handed the
 * work over — so when the owner asked @fez and fez delegated to drift, the
 * owner's inbox never saw drift's answer: only fez was p-tagged, and fez
 * accepted with a silent chit. Live 2026-09-20: "@quill ask drift when Zig
 * shipped, then tell me" ended with drift's one line reaching quill only.
 *
 * When the thread was started by the owner and the requester is someone
 * else, the result also tags the owner, with the sender's attention level,
 * so the answer lands where the question came from.
 */
export function ownerResultTags(opts: { rootAuthor: string | undefined; requester: string; owner: string | undefined; level: Attention }): string[][] {
  const { rootAuthor, requester, owner, level } = opts;
  if (!owner || rootAuthor !== owner || requester === owner) return [];
  return [["p", owner], ["attention", level]];
}
