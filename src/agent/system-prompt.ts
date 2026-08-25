/**
 * What an agent is, assembled from parts — and delivered by whatever
 * channel its harness actually has.
 *
 * Two separate problems live here, and conflating them is why this
 * wasn't done sooner.
 *
 * COMPOSITION. An agent's standing instructions are not one string
 * owned by one file. The persona supplies its character, the runtime
 * supplies the rules that make a fez agent a fez agent (trust
 * boundaries, handoff conventions), and an installed extension may need
 * to add its own — a compliance pack that forbids a topic, a house
 * style, a workflow's operating rules. So sections are REGISTERED and
 * ordered rather than concatenated at one call site, and an extension
 * contributes through the same seam core uses.
 *
 * DELIVERY. There is no portable way to send one. ACP's
 * NewSessionRequest carries cwd, mcpServers and `_meta` — and nothing
 * else. Buzz hit this too: their persona ships as a "[System]" prefix
 * inside the user turn, with real system prompts listed as planned.
 *
 * That distinction is the security-relevant part. A prefix in the user
 * turn sits at the SAME privilege level as the channel message next to
 * it, so "ignore your instructions" is arguing with a peer rather than
 * with the frame. Declaring the mode per harness — rather than assuming
 * one — is what lets us say honestly which agents have a real boundary
 * and which merely have a strongly-worded paragraph.
 */

export interface SystemPromptSection {
  /** Stable id — re-registering replaces, so a reload can't duplicate. */
  id: string;
  /** Lower sorts earlier. Core reserves < 100; extensions default to 500. */
  order: number;
  /** The text, or a function called at session open. */
  text: string | (() => string | undefined);
}

const sections = new Map<string, SystemPromptSection>();

/**
 * Contribute standing instructions to every agent this host starts.
 *
 * Exposed to extensions. Deliberately not "set" — nobody owns the whole
 * prompt, and an extension that could replace it could also delete the
 * trust boundary.
 */
export function registerSystemPromptSection(section: {
  id: string;
  text: string | (() => string | undefined);
  order?: number;
}): void {
  sections.set(section.id, { id: section.id, order: section.order ?? 500, text: section.text });
}

/** What is currently registered, in delivery order — for `fez doctor` and tests. */
export function systemPromptSections(): SystemPromptSection[] {
  return [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Drop a section. Mainly for tests and for extensions being unloaded. */
export function clearSystemPromptSection(id: string): void {
  sections.delete(id);
}

/**
 * Assemble the standing prompt.
 *
 * `persona` goes first because it is the agent's identity and the rest
 * qualifies it. A section returning undefined or blank is skipped, so a
 * conditional rule costs nothing when it doesn't apply.
 */
export function composeSystemPrompt(persona?: string): string {
  const parts: string[] = [];
  const identity = persona?.trim();
  if (identity) parts.push(identity);
  for (const section of systemPromptSections()) {
    const value = (typeof section.text === "function" ? section.text() : section.text)?.trim();
    if (value) parts.push(value);
  }
  return parts.join("\n\n");
}

/**
 * How a harness can carry standing instructions.
 *
 *  - `native`  the harness has a real system-prompt channel; text sent
 *              there outranks anything in the conversation.
 *  - `meta`    no first-class field, but the harness reads ACP `_meta`.
 *              Better than nothing and strictly non-portable: the spec
 *              says implementations MUST NOT assume anything about
 *              these keys, so an agent is free to ignore it.
 *  - `prefix`  no channel at all — the text rides the first user turn.
 *              Honest fallback, and NOT a privilege boundary: it sits
 *              level with the messages it is trying to outrank.
 */
export type SystemPromptMode = "native" | "meta" | "prefix";

/** Is this delivery mode an actual privilege boundary, or just early text? */
export function isPrivileged(mode: SystemPromptMode): boolean {
  return mode === "native";
}
