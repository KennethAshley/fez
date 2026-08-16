import { createHmac } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { KIND_AGENT_ENGRAM } from "./kinds.js";

/**
 * NIP-AE Agent Engrams — persistent agent memory as nostr events
 * (Buzz's spec: buzz docs/nips/NIP-AE.md; implemented to the letter so
 * fez and Buzz agents share a memory format).
 *
 * kind:30174 addressable events, signed by the AGENT, encrypted with
 * the NIP-44 conversation key between agent and owner — symmetric, so
 * the owner can always read everything the agent remembers. One `core`
 * record per pair (identity/rules/goals) plus any number of `mem/...`
 * entries; latest-per-slug wins. The d tag is an HMAC of the slug under
 * the conversation key, so slugs leak nothing to observers.
 *
 * These helpers are pure protocol mechanics (validate/derive/select);
 * the behavior — when to read, what to inject, how agents write —
 * lives in fez-acp and the `fez mem` CLI.
 */

export { KIND_AGENT_ENGRAM };

const MEM_SLUG_RE = /^mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*$/;

export function isValidSlug(slug: string): boolean {
  return slug === "core" || (Buffer.byteLength(slug, "utf8") <= 255 && MEM_SLUG_RE.test(slug));
}

/** NIP-44 conversation key — either party's secret with the other's pubkey; identical both ways. */
export function conversationKey(secretKey: Uint8Array, peerPubkey: string): Uint8Array {
  return nip44.getConversationKey(secretKey, peerPubkey);
}

/** d = hex(HMAC-SHA256(K_c, "agent-memory/v1/d-tag" || 0x00 || slug)) — full 64 hex chars. */
export function engramDTag(convKey: Uint8Array, slug: string): string {
  return createHmac("sha256", Buffer.from(convKey))
    .update(Buffer.concat([Buffer.from("agent-memory/v1/d-tag", "utf8"), Buffer.from([0]), Buffer.from(slug, "utf8")]))
    .digest("hex");
}

export interface EngramBody {
  slug: string;
  /** memory bodies: the entry text, or null = tombstone. */
  value?: string | null;
  /** core bodies: the agent's identity/rules/goals. */
  profile?: string;
  [extra: string]: unknown; // unknown fields are permitted and ignored
}

/**
 * Strict JSON parse per head-selection rule (3): duplicate object keys
 * anywhere in the body make the event INVALID — lenient parsers would
 * silently first/last-win and diverge on head selection.
 */
export function parseBodyStrict(json: string): EngramBody {
  // JSON.parse validates syntax (run last); this walk only detects
  // duplicate keys, which JSON.parse silently last-wins. In valid JSON
  // a string is a key iff the next non-space char is ':', and a key
  // always belongs to the innermost '{' frame — arrays never hold keys
  // directly, so they need no frame at all.
  const objectKeys: Set<string>[] = [];
  let inString = false;
  let escaped = false;
  let current = "";
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        let j = i + 1;
        while (j < json.length && /\s/.test(json[j])) j++;
        if (json[j] === ":" && objectKeys.length > 0) {
          const keys = objectKeys[objectKeys.length - 1];
          if (keys.has(current)) throw new Error(`duplicate key "${current}"`);
          keys.add(current);
        }
      } else current += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current = "";
    } else if (ch === "{") objectKeys.push(new Set());
    else if (ch === "}") objectKeys.pop();
  }
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body is not an object");
  return parsed as EngramBody;
}

/** Body shape check per Bodies + head-selection rule (5). */
export function bodyIsValid(body: EngramBody): boolean {
  if (typeof body.slug !== "string" || !isValidSlug(body.slug)) return false;
  if (body.slug === "core") return typeof body.profile === "string";
  return typeof body.value === "string" || body.value === null;
}

export interface ValidEngram {
  event: Event;
  body: EngramBody;
}

/**
 * Validate one event per head-selection rules (1)-(5). Returns the
 * decoded body, or undefined if any rule fails.
 */
export function validateEngram(event: Event, agentPubkey: string, ownerPubkey: string, convKey: Uint8Array): EngramBody | undefined {
  if (event.kind !== KIND_AGENT_ENGRAM || event.pubkey !== agentPubkey) return undefined;
  const dTags = event.tags.filter((t) => t[0] === "d");
  const pTags = event.tags.filter((t) => t[0] === "p");
  if (dTags.length !== 1 || pTags.length !== 1 || pTags[0][1] !== ownerPubkey) return undefined;
  if (!verifyEvent(event)) return undefined; // rule (2): before decryption
  let body: EngramBody;
  try {
    body = parseBodyStrict(nip44.decrypt(event.content, convKey));
  } catch {
    return undefined;
  }
  if (!bodyIsValid(body)) return undefined;
  if (engramDTag(convKey, body.slug) !== dTags[0][1]) return undefined; // rule (4): slug re-derives to d
  return body;
}

/** Greatest created_at wins; ties break to the LOWEST event id (NIP-01). */
export function selectHead(candidates: ValidEngram[]): ValidEngram | undefined {
  return candidates.reduce<ValidEngram | undefined>((best, next) => {
    if (!best) return next;
    if (next.event.created_at > best.event.created_at) return next;
    if (next.event.created_at === best.event.created_at && next.event.id < best.event.id) return next;
    return best;
  }, undefined);
}

/**
 * Filter + decode + group a query result into heads per slug (the
 * Listing walk). Tombstones are RETAINED here (they're the head that
 * says "absent") — callers drop them for display.
 */
export function engramHeads(events: Event[], agentPubkey: string, ownerPubkey: string, convKey: Uint8Array): Map<string, ValidEngram> {
  const byD = new Map<string, ValidEngram[]>();
  for (const event of events) {
    const body = validateEngram(event, agentPubkey, ownerPubkey, convKey);
    if (!body) continue;
    const d = event.tags.find((t) => t[0] === "d")![1];
    const list = byD.get(d) ?? [];
    list.push({ event, body });
    byD.set(d, list);
  }
  const heads = new Map<string, ValidEngram>();
  for (const list of byD.values()) {
    const head = selectHead(list);
    if (head) heads.set(head.body.slug, head);
  }
  return heads;
}

/**
 * Build the encrypted content + tags for a write. created_at
 * monotonicity (max(now, priorHead+1)) is the CALLER's job — it knows
 * the prior head.
 */
export function buildEngramEvent(
  convKey: Uint8Array,
  ownerPubkey: string,
  body: EngramBody,
  createdAt: number
): { kind: number; created_at: number; tags: string[][]; content: string } {
  if (!bodyIsValid(body)) throw new Error(`invalid engram body for slug "${body.slug}"`);
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, "utf8") > 65_535) throw new Error("engram body exceeds NIP-44 plaintext limit (65535 bytes)");
  return {
    kind: KIND_AGENT_ENGRAM,
    created_at: createdAt,
    tags: [
      ["d", engramDTag(convKey, body.slug)],
      ["p", ownerPubkey],
      ["alt", "encrypted agent memory record"],
    ],
    content: nip44.encrypt(json, convKey),
  };
}
