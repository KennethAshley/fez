/**
 * Turning "@name" into the pubkey it means — pure, eval-pinned.
 *
 * A name is not an identity. The identity is the key; a name is a
 * kind-0 profile someone published about themselves, unverified and
 * not unique, and nobody owns the namespace to make it otherwise. So
 * the only honest question is "@deployer *according to whom*", and the
 * answer has to be something with an authority behind it.
 *
 * The channel roster is that authority. Membership is creator-signed
 * and lists exactly who is in this room, so resolving names ONLY among
 * members makes the namespace small, shared by everyone present, and
 * governed by someone. The previous behaviour — a linear scan over
 * every name the client had ever seen, first match wins, iteration
 * order deciding — could tag a stranger who joined yesterday and
 * happened to call themselves "deployer", and would do it silently.
 *
 * Two rules do the rest, both from Buzz's implementation:
 *
 *  - **Longest match at each position.** A member called "dep" must not
 *    be tagged when someone writes "@deployer".
 *  - **Ties tag EVERYONE.** Two members genuinely called "deployer"
 *    both get the p tag. Ambiguity is preserved and surfaced rather
 *    than resolved by a coin flip the sender never sees.
 *
 * Both of those are the *fallback*. When a human picks a name out of the
 * composer's autocomplete they have already answered "which deployer",
 * so that answer is carried as a **binding** — name → the pubkey chosen
 * at that moment — and no lookup happens at send. Agents have no
 * autocomplete, so roster resolution is what protects them; bindings are
 * the layer on top for people.
 */

export interface MentionCandidate {
  pubkey: string;
  /** The name this pubkey publishes for itself (kind-0 or kind-47000). */
  name: string;
  /** Whether they are on this channel's creator-signed roster. */
  isMember: boolean;
  /** Extra names this pubkey answers to (an agent's announced "also answers to"). */
  aliases?: string[];
}

export interface MentionResolution {
  /** Pubkeys to p-tag. */
  pubkeys: string[];
  /** Names written that matched nobody in this room — worth telling the sender. */
  unresolved: string[];
  /** Names that matched more than one member. Both are tagged; the sender should know. */
  ambiguous: { name: string; pubkeys: string[] }[];
}

/** `@` followed by a name, at a word boundary so emails and paths don't match. */
const MENTION = /(^|[\s([{<,;:!?"'`])@([\p{L}\p{N}_.-]{1,64})/gu;

export const normalizeMentionName = (name: string) => name.trim().toLowerCase();
const normalize = normalizeMentionName;

/**
 * Names the sender bound to a specific pubkey while composing, keyed by
 * normalizeMentionName(). Build one with bindMention().
 */
export type MentionBindings = ReadonlyMap<string, string>;

/** Record that the sender chose `pubkey` for `name` — returns a new map. */
export function bindMention(bindings: MentionBindings, name: string, pubkey: string): MentionBindings {
  return new Map(bindings).set(normalize(name), pubkey);
}

/**
 * Resolve every @mention in a piece of text against a channel's roster.
 *
 * Non-members are ignored deliberately: tagging someone who cannot read
 * the channel produces a notification for a message they will never be
 * shown, which reads to them as a system fault.
 *
 * A binding short-circuits the name lookup for that name — but only if
 * the pubkey it names is *still* on the roster. Someone can be removed
 * from a channel between the moment you pick them and the moment you
 * hit send, and the binding must not be a way to route around the
 * membership rule; a stale one is dropped and the name falls back to
 * ordinary resolution, which reports it.
 */
export function resolveMentions(
  text: string,
  candidates: readonly MentionCandidate[],
  bindings?: MentionBindings
): MentionResolution {
  const members = candidates.filter((candidate) => candidate.isMember && candidate.pubkey && candidate.name);

  // Longest first, so the longest match at a position wins naturally.
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);

  const pubkeys = new Set<string>();
  const unresolved: string[] = [];
  const ambiguous: { name: string; pubkeys: string[] }[] = [];
  const seenNames = new Set<string>();

  for (const match of text.matchAll(MENTION)) {
    const written = match[2];
    // Trailing punctuation is prose, not part of a name: "@ana," is @ana.
    const cleaned = written.replace(/[.,;:!?]+$/, "");
    if (!cleaned) continue;
    const wanted = normalize(cleaned);
    if (seenNames.has(wanted)) continue;
    seenNames.add(wanted);

    // The sender already said who they meant. Honour it — unless they
    // are no longer in the room, in which case this is an ordinary
    // unresolved name and gets reported as one.
    const bound = bindings?.get(wanted);
    if (bound && members.some((member) => member.pubkey === bound)) {
      pubkeys.add(bound);
      continue;
    }

    // The longest candidate name that the written token starts with —
    // so "@deployer" prefers "deployer" over a member called "dep".
    // Aliases count as names: "also answers to" must tag, not just look addressed.
    const best = byLength.filter(
      (member) => wanted === normalize(member.name) || (member.aliases ?? []).some((a) => wanted === normalize(a))
    );
    if (best.length === 0) {
      unresolved.push(cleaned);
      continue;
    }
    for (const member of best) pubkeys.add(member.pubkey);
    if (best.length > 1) ambiguous.push({ name: cleaned, pubkeys: best.map((m) => m.pubkey) });
  }

  return { pubkeys: [...pubkeys], unresolved, ambiguous };
}

/**
 * One line for a sender whose mention went nowhere.
 *
 * Silence here is the bug we are fixing: a mention that resolves to
 * nobody currently looks identical to one that worked, so a person (or
 * an agent) believes they handed work off and nothing happened.
 */
export function describeMentionProblems(resolution: MentionResolution): string | undefined {
  const notes: string[] = [];
  if (resolution.unresolved.length > 0) {
    notes.push(
      `nobody here is called ${resolution.unresolved.map((n) => `@${n}`).join(", ")} — they weren't notified`
    );
  }
  for (const clash of resolution.ambiguous) {
    notes.push(`@${clash.name} matches ${clash.pubkeys.length} members — all of them were notified`);
  }
  return notes.length > 0 ? notes.join("; ") : undefined;
}
