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
export const HELLO_MARKER = "fez-welcome.hello.v1";
export const OPENER_MARKER = "fez-welcome.opener.v1";
export const AWAKE_MARKER = "fez-welcome.awake.v1";

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

export function awakeText(): string {
  return "🎩 I'm awake — a model is connected. Try: @fez what can you do?";
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
