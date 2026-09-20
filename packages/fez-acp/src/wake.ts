import crypto from "node:crypto";
import { KIND_CHANNEL_MESSAGE } from "../../../src/protocol/kinds.js";

/**
 * A silent summons. The owner (in practice: the desktop's workflow
 * engine, which runs as the owner) can start an agent's turn in a thread
 * without posting a message — a `wake` frame on the owner-encrypted
 * control channel (kind 20005, the same pipe as `cancel`). Decryption
 * under the owner conversation key is the authorization; the agent then
 * treats the frame as an owner mention that nobody else can see.
 *
 * Why: every workflow summons used to be a visible "@quill one sentence
 * please" in the thread, signed by the owner — Ken read it as clutter he
 * never typed. The instruction is coordination, not conversation.
 */
export interface WakeFrame {
  cmd: "wake";
  ts: number;
  /** Channel the thread lives in — must be one the agent watches. */
  channel: string;
  /** Thread root the turn belongs to. Required: a reply needs a real root to hang from. */
  root: string;
  /** Message the agent's reply answers; defaults to the root. */
  reply?: string;
  /** Chain depth the summons carries (the agent replies at depth + 1). */
  depth?: number;
  /** The instruction, as if the owner had typed it in the thread. */
  text: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;
export const WAKE_TEXT_MAX = 8_000;

/** Validate a decrypted control frame as a wake; returns the reason it isn't one. */
export function parseWake(frame: unknown, channels: readonly string[]): WakeFrame | string {
  const f = frame as Partial<WakeFrame> | null;
  if (!f || typeof f !== "object" || f.cmd !== "wake") return "not a wake";
  if (typeof f.channel !== "string" || !channels.includes(f.channel)) return "channel not watched";
  if (typeof f.root !== "string" || !HEX64.test(f.root)) return "root must be an event id";
  if (f.reply !== undefined && (typeof f.reply !== "string" || !HEX64.test(f.reply))) return "reply must be an event id";
  if (f.depth !== undefined && (typeof f.depth !== "number" || !Number.isInteger(f.depth) || f.depth < 0)) return "depth must be a non-negative integer";
  if (typeof f.text !== "string" || !f.text.trim()) return "text required";
  if (f.text.length > WAKE_TEXT_MAX) return `text over ${WAKE_TEXT_MAX} chars`;
  return { cmd: "wake", ts: typeof f.ts === "number" ? f.ts : Date.now(), channel: f.channel, root: f.root.toLowerCase(),
    reply: f.reply?.toLowerCase(), depth: f.depth, text: f.text };
}

/**
 * The synthetic channel event the agent's normal turn path consumes: an
 * owner message in the thread, p-tagged to the agent, with a fresh id so
 * it collides with nothing the agent has seen or filed. This id is never
 * on the relay, so nothing may point at it: `wake` names the real message
 * the reply answers. It rides on the event (not as a call option) so it
 * survives the turn queue, which re-dispatches events, not options.
 */
export function wakeEvent(wake: WakeFrame, owner: string, myPubkey: string) {
  return {
    wake: wake.reply ?? wake.root,
    id: crypto.randomBytes(32).toString("hex"),
    kind: KIND_CHANNEL_MESSAGE,
    pubkey: owner,
    created_at: Math.floor(Date.now() / 1000),
    content: wake.text,
    tags: [
      ["h", wake.channel],
      ["e", wake.root, "", "root"],
      ["e", wake.reply ?? wake.root, "", "reply"],
      ["p", myPubkey],
      ...(wake.depth !== undefined ? [["depth", String(wake.depth)]] : []),
    ],
  };
}
