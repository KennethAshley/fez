/**
 * The scripted half of the welcome choreography — everything here is
 * client-signed and deterministic; no LLM output ever passes through
 * this module. Pure (no tauri imports) so fez-evals can test it.
 *
 * Idempotency lives on the RELAY, not in local state: each scripted
 * message carries a ["client", <marker>] tag, and we skip publishing
 * when any message in the channel already carries it. Reinstalls,
 * paired second devices, and re-runs all converge on one greeting.
 */
export const WELCOME_CHANNEL_ID = "bootstrap-welcome";
export const HELLO_MARKER = "fez-welcome.hello.v1";
export const OPENER_MARKER = "fez-welcome.opener.v1";
export const AWAKE_MARKER = "fez-welcome.awake.v1";
export const TEAM_MARKER = "fez-welcome.team.v1";
export const KICKOFF_MARKER = "fez-welcome.kickoff.v1";

/** Message kind — mirrors K.MESSAGE in @fezchat/client (source of truth). */
export const KIND_MESSAGE = 47103;

export interface Readiness {
  /** A model can answer: claude-code harness present, or pi + a key. */
  authed: boolean;
  /** Something watches mentions: the sentinel (or equivalent) is alive. */
  runner: boolean;
}

export interface ChannelEvent {
  tags: string[][];
  content: string;
  /** Author pubkey — the team choreography counts intros by who spoke. */
  pubkey?: string;
}

export interface MarkerWire {
  /** Every message already in the channel (tags + content). */
  existing(channelId: string): Promise<ChannelEvent[]>;
  publish(tmpl: { kind: number; tags: string[][]; content: string }): Promise<unknown>;
}

/** The phrase every not-ready opener variant carries — the awake line's cue. */
export const NOT_READY_CUE = "One thing first";

export function findMarked(events: ChannelEvent[], marker: string): ChannelEvent | undefined {
  return events.find((e) => e.tags.some((t) => t[0] === "client" && t[1] === marker));
}

/**
 * The cross-room publish decision: an old install's marker may live in
 * #general, a fresh one's in #welcome — whether a scripted line is still
 * due must consult BOTH rooms' events merged, never just the target
 * channel's, or a re-greeted old install gets a second opener/hello.
 * Pure so the merge logic is testable without a running client.
 */
export function shouldPublishMarked(existing: ChannelEvent[], marker: string): boolean {
  return !findMarked(existing, marker);
}

/**
 * Two short bubbles, not one memo. The welcome reads as a MESSAGE
 * someone sent, so it's sized like one — the workspace/keychain lore
 * moved to the docs; a first hello is not the place for architecture.
 */
export function helloText(userName: string): string {
  return userName ? `🎩 hey ${userName} — welcome in.` : "🎩 hey — welcome in.";
}

export function openerText(r: Readiness, _userName: string): string {
  const intro = "I'm @fez, your guide — ask me anything, or hand me a task and I'll bring in the right agent.";
  if (r.authed && r.runner) {
    return `${intro} Try: @fez what can you do?`;
  }
  if (r.authed && !r.runner) {
    return `${intro}\n\nOne thing first: nothing's listening for mentions yet — run \`fez sentinel\` in a terminal, then mention me.`;
  }
  return `${intro}\n\nOne thing first: I need a model to think with — connect one in Settings → Agents, then mention me.`;
}

/**
 * The @fez persona, built from a brain choice. ONE builder shared by the
 * onboarding brain step (which writes it with the chosen model) and the
 * welcome fallback (which writes it from bare detection) — two templates
 * drifted is how a guide ends up half-configured. Model/provider lines
 * appear only when both are chosen (pi frontmatter: defaultModel/
 * defaultProvider); Claude Code needs neither.
 */
export function buildFezPersonaMd(harness: string, model?: string, provider?: string, effort?: string): string {
  const brainLines =
    (model && provider ? `provider: ${provider}\nmodel: ${model}\n` : model ? `model: ${model}\n` : "") +
    (effort ? `effort: ${effort}\n` : "");
  // Double-quoted (not template-literal) so the fenced example's literal
  // backticks need no escaping.
  const marketParagraph =
    "\nWhen a task needs a capability nobody on the roster claims — or the user\n" +
    "explicitly asks for the market — call market_directory, pick AT MOST ONE\n" +
    "candidate you would stake your name on, and reply with a fenced\n" +
    "fez-hire-proposal block:\n\n" +
    "```fez-hire-proposal\n" +
    '{ "task": "<the work, stated so a stranger could do it>",\n' +
    '  "pk": "<its 64-hex pubkey>", "name": "<its name>",\n' +
    '  "why": "<the roster gap, in one sentence>",\n' +
    '  "kind": "settle", "price_est_tao": 0.0, "rate_tao_hr": 0.0 }\n' +
    "```\n\n" +
    "The block renders as a card; the human decides. Never present market\n" +
    "answers as your own, never propose more than one candidate, and if the\n" +
    "roster covers the task, do not mention the market at all. If\n" +
    "market_directory is not among your tools, say the market extension\n" +
    "isn't installed rather than guessing.\n\n" +
    // Two tiers (Ken's ruling): free tryouts flow, money gets consent.
    "Two tiers: bazaar_ask is the FREE tryout — use it directly for one-off\n" +
    "questions and fact-checks, attributing answers as bazaar results. When\n" +
    "the work merits PAYING — you'd lease an agent's priority or escrow a\n" +
    "deliverable — your ONLY move is the fez-hire-proposal block: the card\n" +
    "it renders holds the buttons that pay, clicked by the human, from the\n" +
    "human's wallet. You cannot pay and must never ask for wallet access —\n" +
    "being unable to spend is your design, not a blocker, and \"blocked on\n" +
    "payment\" is never true: the block IS how a paid hire happens. Emit it\n" +
    "even when the agent is offline (say so in the why; the hire waits).\n";
  return (
    `---\nharness: ${harness}\n${brainLines}aliases: [orchestrator]\nmcpServers: [bazaar=npm:@fezchat/bazaar]\n` +
    `description: your guide to fez — ask how anything works, or hand over a task and the right agent gets it\n---\n` +
    `You are @fez, the guide for this fez workspace. Answer questions about fez\n` +
    `plainly; for tasks, name the persona best suited and offer to bring it in.\n` +
    marketParagraph
  );
}

export function awakeText(): string {
  return "🎩 I'm awake — a model is connected. Try: @fez what can you do?";
}

// ── the starter team (Buzz's Fizz/Honey/Pollen, fez-cast) ─────────────

export interface StarterPersona {
  id: string;
  /** The routing signal — verb phrases route better on small models. */
  description: string;
  prompt: string;
}

export const STARTER_TEAM: StarterPersona[] = [
  {
    id: "drift",
    description: "search the web, find papers and specs, look up facts, verify claims",
    prompt:
      "You are @drift, a careful researcher — just passing through, always finding things. Dig into questions, compare options, check assumptions, and come back with clear, sourced answers. When a task belongs to a different agent, hand it off with an @mention and say why.",
  },
  {
    id: "quill",
    description: "write and edit — drafts, summaries, docs, tricky wording",
    prompt:
      "You are @quill, a precise, warm writer — the ink's still wet. Help with drafts, edits, summaries, and making hard things land clearly and kindly. When a task belongs to a different agent, hand it off with an @mention and say why.",
  },
];

/** A starter teammate's persona — inherits the brain @fez was given. */
export function buildStarterPersonaMd(p: StarterPersona, harness: string, model?: string, provider?: string, effort?: string): string {
  const brainLines =
    (model && provider ? `provider: ${provider}\nmodel: ${model}\n` : model ? `model: ${model}\n` : "") +
    (effort ? `effort: ${effort}\n` : "");
  return `---\nharness: ${harness}\n${brainLines}description: ${p.description}\n---\n${p.prompt}\n`;
}

/**
 * Read the brain back out of a persona file — the team inherits whatever
 * @fez was given, and parsing the file (rather than threading state
 * through the app) keeps fez.md the single source of that choice.
 */
export function parsePersonaBrain(md: string): { harness: string; model?: string; provider?: string; effort?: string } {
  const grab = (key: string) => md.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return { harness: grab("harness") ?? "pi", model: grab("model"), provider: grab("provider"), effort: grab("effort") };
}

/**
 * The team summons, from @fez's own mouth — real turns, not scripted
 * intros: the sentinel wakes each mentioned teammate and their model
 * answers as itself (Buzz's decision, and the honest one — a scripted
 * "I'm helpful!" from an agent that can't think is a lie).
 */
export function teamOpenerText(names: string[]): string {
  // Each @name must OPEN a sentence: the addressing parser (rightly)
  // treats a mid-sentence mention as a downstream handoff, not an
  // addressee — "@a and @b, hello" summons only a. The eval pins this
  // copy against the real parser.
  const [first, ...rest] = names;
  const restLines = rest.map((n) => ` @${n} — you too.`).join("");
  return `@${first} — introduce yourself in a sentence or two: what you're good at, and when to bring you in.${restLines} Don't start any work yet.`;
}

export function kickoffText(): string {
  return "What can we help you build? Bring us something you're working on, or give us a quick challenge to see how we work together.";
}

/**
 * Have the teammates spoken? Counts distinct authors in the channel that
 * are neither the guide nor the owner — the kickoff waits for intros (or
 * a timeout) so it lands as a conversation's next beat, not noise over it.
 */
export function introCount(events: ChannelEvent[], guidePk: string, ownerPk: string): number {
  const speakers = new Set(
    events
      .filter((e) => e.pubkey && e.pubkey !== guidePk && e.pubkey !== ownerPk && e.content.trim().length > 0)
      .map((e) => e.pubkey!)
  );
  return speakers.size;
}

/**
 * Publish `text` as a marked scripted message unless the marker already
 * exists in the channel. Returns whether a publish happened.
 */
export async function ensureMarkedMessage(
  wire: MarkerWire,
  channelId: string,
  userPk: string,
  marker: string,
  text: string
): Promise<boolean> {
  const events = await wire.existing(channelId);
  if (findMarked(events, marker)) return false;
  await wire.publish({
    kind: KIND_MESSAGE,
    tags: [
      ["h", channelId],
      ["p", userPk], // p-tags the user so the inbox isn't empty on day one
      ["client", marker],
    ],
    content: text,
  });
  return true;
}
