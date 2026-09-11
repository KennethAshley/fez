import { validateEvent, verifyEvent, type Event } from "nostr-tools/pure";
import { parseThreadRef } from "./thread-ref.js";
export { replaceableEventWins } from "./workspace-state.js";

export interface GuestOffer { payTo?: string; rateTaoHr?: number }
export interface GuestProfile { name?: string; picture?: string }
export interface GuestScope { guestPk: string; selfPk?: string; nowS?: number; validatePayTo?: (address: string) => boolean }
export type GuestResultStatus = "success" | "failure" | "error" | "declined" | "cancelled" | "timeout";
export type GuestProtocolEvent =
  | { type: "profile"; event: Event; profile: GuestProfile | null }
  | { type: "announce"; event: Event; offer: GuestOffer | null }
  | { type: "binding"; event: Event; retired: boolean }
  | { type: "task"; event: Event }
  | { type: "progress"; event: Event; taskId: string; message: string }
  | { type: "result"; event: Event; taskId: string; status: GuestResultStatus; result: string };
export type GuestReply = Extract<GuestProtocolEvent, { type: "progress" | "result" }>;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const one = (event: Event, key: string): string | undefined => {
  const values = event.tags.filter(tag => tag[0] === key);
  return values.length === 1 ? values[0][1] : undefined;
};
const json = (content: string): unknown => { try { return JSON.parse(content); } catch { return undefined; } };
export const GUEST_METADATA_FUTURE_S = 60;

/** Same address shape accepted by the wallet's TAO commands; checksum and chain checks belong to settlement. */
export const isGuestPayTo = (value: unknown): value is string => typeof value === "string" && /^5[1-9A-HJ-NP-Za-km-z]{47,48}$/.test(value);

/** Missing fields withdraw old values. A conflicting address or malformed quote cannot authorize a payment. */
export function parseGuestOffer(payload: unknown, validatePayTo: (address: string) => boolean = isGuestPayTo): GuestOffer | null {
  if (!object(payload) || (payload.rate !== undefined && !object(payload.rate))) return null;
  const rate = object(payload.rate) ? payload.rate : undefined;
  const payees = [payload.pay_to, rate?.pay_to].filter(value => value !== undefined);
  try {
    if (!payees.every(value => isGuestPayTo(value) && validatePayTo(value))) return null;
  } catch { return null; }
  if (payees.length === 2 && payees[0] !== payees[1]) return null;
  const amount = rate?.tao_hr;
  if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) return null;
  return { ...(payees.length ? { payTo: payees[0] as string } : {}),
    ...(typeof amount === "number" && amount > 0 ? { rateTaoHr: amount } : {}) };
}

function profile(payload: unknown): GuestProfile | null {
  if (!object(payload)) return null;
  for (const key of ["name", "display_name", "picture"]) {
    const value = payload[key];
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted profile fields.
    if (value !== undefined && (typeof value !== "string" || value.length > (key === "picture" ? 4096 : 200) || /[\u0000-\u001f\u007f]/.test(value))) return null;
  }
  const name = (typeof payload.name === "string" ? payload.name : typeof payload.display_name === "string" ? payload.display_name : "").trim();
  const picture = typeof payload.picture === "string" ? payload.picture : "";
  if (picture) {
    try {
      const url = new URL(picture);
      if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    } catch { return null; }
  }
  return { ...(name ? { name } : {}), ...(picture ? { picture } : {}) };
}

function taskRoot(event: Event): string | undefined {
  const refs = event.tags.filter(tag => tag[0] === "e");
  if (!refs.length || !refs.every(tag => hex(tag[1]))) return;
  const roots = refs.filter(tag => tag[3] === "root"), replies = refs.filter(tag => tag[3] === "reply");
  if (roots.length > 1 || replies.length > 1) return;
  if (roots.length && replies.length && roots[0][1] !== replies[0][1]) return;
  if (roots.length || replies.length) {
    if (refs.some(tag => !["root", "reply", "mention"].includes(tag[3]))) return;
    return parseThreadRef(event.tags).rootId;
  }
  // Legacy SDK results use exactly one unmarked e-tag.
  return refs.length === 1 && !refs[0][3] ? refs[0][1] : undefined;
}

/** Relay filters are advisory. Verify fresh protocol bytes before allowing any guest state update.
 * Invalid newest metadata retains a null payload so callers clear old offers instead of reviving them. */
export function parseGuestEvent(raw: unknown, scope: GuestScope): GuestProtocolEvent | null {
  let event: Event;
  try {
    if (!hex(scope.guestPk) || !object(raw) || !validateEvent(raw) || !hex(raw.id) || typeof raw.sig !== "string" || !/^[a-f0-9]{128}$/.test(raw.sig) ||
        !Number.isSafeInteger(raw.created_at) || raw.created_at < 0 || raw.content.length > 1_000_000) return null;
    event = { id: raw.id, sig: raw.sig, pubkey: raw.pubkey, kind: raw.kind, content: raw.content,
      created_at: raw.created_at, tags: raw.tags.map(tag => [...tag]) };
    if (!verifyEvent(event)) return null;
  } catch { return null; }
  if ([0, 47000, 47041].includes(event.kind)) {
    const now = scope.nowS ?? Math.floor(Date.now() / 1000);
    if (event.pubkey !== scope.guestPk || !Number.isFinite(now) || event.created_at > now + GUEST_METADATA_FUTURE_S) return null;
    if (event.kind === 0) return { type: "profile", event, profile: profile(json(event.content)) };
    if (event.kind === 47000) return { type: "announce", event, offer: parseGuestOffer(json(event.content), scope.validatePayTo) };
    return { type: "binding", event, retired: event.content === "" };
  }
  if (!hex(scope.selfPk) || scope.selfPk === scope.guestPk) return null;
  if (event.kind === 47001) return event.pubkey === scope.selfPk && one(event, "p") === scope.guestPk ? { type: "task", event } : null;
  if (![47002, 47003].includes(event.kind) || event.pubkey !== scope.guestPk || one(event, "p") !== scope.selfPk) return null;
  const taskId = taskRoot(event);
  if (!taskId) return null;
  const body = json(event.content);
  if (event.kind === 47002) {
    const message = object(body) ? (typeof body.message === "string" ? body.message : typeof body.status === "string" ? body.status : "") : body === undefined ? event.content : "";
    return message.trim() ? { type: "progress", event, taskId, message } : null;
  }
  if (!object(body) || typeof body.status !== "string" || !["success", "failure", "error", "declined", "cancelled", "timeout"].includes(body.status)) return null;
  const status = body.status as GuestResultStatus;
  const result = typeof body.result === "string" ? body.result : object(body.result) ? JSON.stringify(body.result)
    : object(body.error) && typeof body.error.message === "string" ? body.error.message : status === "success" ? "" : status;
  return result.trim() ? { type: "result", event, taskId, status, result } : null;
}

/** Both arguments must come from parseGuestEvent. Staged replies are not displayable/delivered until this matches. */
export function isGuestReplyTo(reply: GuestProtocolEvent, task: GuestProtocolEvent): reply is GuestReply {
  return (reply?.type === "progress" || reply?.type === "result") && task?.type === "task" && reply.taskId === task.event.id &&
    reply.event.pubkey === one(task.event, "p") && one(reply.event, "p") === task.event.pubkey;
}
