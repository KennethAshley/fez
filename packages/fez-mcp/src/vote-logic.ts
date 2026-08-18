/**
 * Voting rules — pure and eval-pinned (fez-evals imports THIS), because
 * every client and tool must tally identically or "the vote" means
 * nothing. The rules Ken and I settled:
 *
 * - Reactions are ballots: signed, attributable, one key one vote.
 * - Eligibility = channel members (the roster is the voter roll).
 * - A key voting multiple options is AMBIGUOUS and counts for nothing.
 * - Approval gates: the owner's ✅/❌ always decides alone (override);
 *   a quorum N lets N distinct members' ✅ approve WITHOUT the owner —
 *   but quorum comes from persona/workflow config (owner-authored),
 *   never from the agent's runtime discretion, and the asking agent's
 *   own key never counts toward its own gate.
 */

export interface Ballot {
  pk: string;
  content: string;
}

export const OPTION_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

const APPROVE = /✅|👍/u;
const DENY = /❌|👎/u;

export function quorumDecision(
  ballots: Ballot[],
  config: { owner?: string; quorum?: number; members: ReadonlySet<string>; selfPk: string }
): "approved" | "denied" | undefined {
  const { owner, quorum, members, selfPk } = config;
  // owner always decides alone, either direction
  for (const ballot of ballots) {
    if (owner && ballot.pk === owner) {
      if (DENY.test(ballot.content)) return "denied";
      if (APPROVE.test(ballot.content)) return "approved";
    }
  }
  if (quorum && quorum >= 1) {
    const approvers = new Set<string>();
    for (const ballot of ballots) {
      if (!APPROVE.test(ballot.content)) continue;
      if (ballot.pk === selfPk) continue; // never self-approve
      if (!members.has(ballot.pk)) continue; // roster is the voter roll
      approvers.add(ballot.pk);
    }
    if (approvers.size >= quorum) return "approved";
  }
  return undefined;
}

export interface PollTally {
  counts: number[];
  voters: number;
  ambiguous: number;
  winner?: number; // option index; undefined on tie or no votes
}

export function tallyPoll(optionCount: number, ballots: Ballot[], members: ReadonlySet<string>): PollTally {
  const emojis = OPTION_EMOJI.slice(0, optionCount);
  const votesByPk = new Map<string, Set<number>>();
  for (const ballot of ballots) {
    const index = emojis.indexOf(ballot.content);
    if (index === -1) continue;
    if (!members.has(ballot.pk)) continue;
    let set = votesByPk.get(ballot.pk);
    if (!set) votesByPk.set(ballot.pk, (set = new Set()));
    set.add(index);
  }
  const counts = new Array<number>(optionCount).fill(0);
  let voters = 0;
  let ambiguous = 0;
  for (const set of votesByPk.values()) {
    if (set.size === 1) {
      counts[[...set][0]]++;
      voters++;
    } else {
      ambiguous++; // multiple options from one key counts for nothing
    }
  }
  const max = Math.max(...counts);
  const leaders = counts.flatMap((count, index) => (count === max && max > 0 ? [index] : []));
  return { counts, voters, ambiguous, winner: leaders.length === 1 ? leaders[0] : undefined };
}
