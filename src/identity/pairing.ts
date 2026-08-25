import { unixNow } from "../shared/time.js";
import { createHash } from "node:crypto";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { nip44, type Event } from "nostr-tools";
import { RelayConnection } from "../protocol/relay.js";
import { KIND_PAIRING } from "../protocol/kinds.js";

/**
 * Device pairing — NIP-AB's decisions (Buzz's pairing-cli), fez-shaped:
 * move the keychain-held identity to a second device over ANY relay,
 * without ever showing the key or trusting the transport.
 *
 *   new device:  fez pair receive   → ephemeral key E2, prints a
 *                                     pairing URI to carry across
 *   old device:  fez pair send <uri> → ephemeral key E1, hello over
 *                                     kind 24134
 *
 * Both sides derive the SAME 6-digit SAS from the two ephemeral pubkeys
 * (sorted, hashed) and a HUMAN confirms the match on both screens — an
 * MITM substituting either ephemeral changes the SAS on one side, so
 * the confirmation IS the authentication (NIP-AB's short-auth-string).
 * Only after both confirm does the identity travel, NIP-44-encrypted
 * under the E1↔E2 conversation key.
 *
 * Kind 24134 sits in nostr's ephemeral range: handshake frames are
 * relayed live and never stored — a relay that misbehaves and stores
 * them anyway holds only ciphertext between two throwaway keys.
 * Freshness ±120s defeats replays.
 */

export { KIND_PAIRING };
const FRESHNESS_S = 120;
export const PAIRING_URI_PREFIX = "fez-pair:";

export interface PairingChannel {
  relayUrl: string;
  peerEphemeralPk: string;
}

/** fez-pair:<relayUrl>#<ephemeralPk> — what the new device displays and the old one types/pastes. */
export function buildPairingUri(relayUrl: string, ephemeralPk: string): string {
  return `${PAIRING_URI_PREFIX}${relayUrl}#${ephemeralPk}`;
}

export function parsePairingUri(uri: string): PairingChannel | undefined {
  if (!uri.startsWith(PAIRING_URI_PREFIX)) return undefined;
  const rest = uri.slice(PAIRING_URI_PREFIX.length);
  const hash = rest.lastIndexOf("#");
  if (hash <= 0) return undefined;
  const relayUrl = rest.slice(0, hash);
  const peerEphemeralPk = rest.slice(hash + 1).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(peerEphemeralPk)) return undefined;
  return { relayUrl, peerEphemeralPk };
}

/**
 * Short auth string: 6 digits both humans compare. Derived from BOTH
 * ephemeral pubkeys (sorted, so both sides compute identically) — any
 * MITM key substitution diverges the two screens.
 */
export function deriveSas(ephemeralPkA: string, ephemeralPkB: string): string {
  const [lo, hi] = [ephemeralPkA.toLowerCase(), ephemeralPkB.toLowerCase()].sort();
  const digest = createHash("sha256").update(`fez-pair-sas:${lo}:${hi}`).digest();
  return String(digest.readUIntBE(0, 6) % 1_000_000).padStart(6, "0");
}

type Payload =
  | { type: "hello" }
  | { type: "sas-ok" }
  | { type: "key"; key: string; account: string }
  | { type: "done" }
  | { type: "abort"; reason: string };

interface Session {
  relay: RelayConnection;
  secret: Uint8Array;
  myPk: string;
  peerPk: string;
  inbox: Payload[];
  waiters: ((p: Payload) => void)[];
  unsubscribe: () => void;
}

function openSession(relay: RelayConnection, secret: Uint8Array, peerPk: string): Session {
  const session: Session = {
    relay,
    secret,
    myPk: getPublicKey(secret),
    peerPk,
    inbox: [],
    waiters: [],
    unsubscribe: () => {},
  };
  session.unsubscribe = relay.subscribe(
    [{ kinds: [KIND_PAIRING], "#p": [session.myPk] }],
    (event: Event) => {
      if (event.pubkey !== peerPk) return; // only our counterparty's ephemeral
      if (Math.abs(unixNow() - event.created_at) > FRESHNESS_S) return;
      try {
        const payload = JSON.parse(
          nip44.decrypt(event.content, nip44.getConversationKey(secret, event.pubkey))
        ) as Payload;
        const waiter = session.waiters.shift();
        if (waiter) waiter(payload);
        else session.inbox.push(payload);
      } catch { /* not ours */ }
    }
  );
  return session;
}

async function send(session: Session, payload: Payload): Promise<void> {
  const event = finalizeEvent(
    {
      kind: KIND_PAIRING,
      created_at: unixNow(),
      tags: [["p", session.peerPk]],
      content: nip44.encrypt(JSON.stringify(payload), nip44.getConversationKey(session.secret, session.peerPk)),
    },
    session.secret
  );
  await session.relay.publish(event);
}

function nextPayload(session: Session, timeoutMs: number): Promise<Payload> {
  const queued = session.inbox.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = session.waiters.indexOf(waiter);
      if (i >= 0) session.waiters.splice(i, 1);
      reject(new Error("pairing timed out waiting for the other device"));
    }, timeoutMs);
    const waiter = (p: Payload) => {
      clearTimeout(timer);
      resolve(p);
    };
    session.waiters.push(waiter);
  });
}

async function expect(session: Session, type: Payload["type"], timeoutMs: number): Promise<Payload> {
  const payload = await nextPayload(session, timeoutMs);
  if (payload.type === "abort") throw new Error(`peer aborted: ${(payload as { reason: string }).reason}`);
  if (payload.type !== type) throw new Error(`pairing protocol error: expected ${type}, got ${payload.type}`);
  return payload;
}

export interface PairingCallbacks {
  /** Show the SAS and ask the human "does the other screen show the same?" */
  confirmSas(sas: string): Promise<boolean>;
  /** Progress lines for the terminal. */
  log?(line: string): void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // humans are slow; the SAS gates safety, not speed

/**
 * NEW device: create the ephemeral, wait for hello, confirm SAS, receive
 * the identity. Returns {key, account} for the caller to store.
 */
export async function pairReceive(
  relayUrl: string,
  callbacks: PairingCallbacks,
  opts?: { timeoutMs?: number; onUri?: (uri: string) => void }
): Promise<{ key: string; account: string }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = callbacks.log ?? (() => {});
  const secret = generateSecretKey();
  const myPk = getPublicKey(secret);
  const relay = new RelayConnection({ url: relayUrl });
  await relay.connect();
  // Session opens against "whoever hellos us" — pinned to the first
  // counterparty and never re-pinned (the SAS covers exactly that pair).
  // Assigned once, but not where it is declared: the subscription
  // closure below reads it to ignore a second hello, so the declaration
  // has to precede the closure and const cannot compile here.
  // eslint-disable-next-line prefer-const
  let session: Session | undefined;
  const hello = await new Promise<{ from: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pairing timed out — no device sent a hello")), timeoutMs);
    const unsub = relay.subscribe([{ kinds: [KIND_PAIRING], "#p": [myPk] }], (event: Event) => {
      if (session) return;
      if (Math.abs(unixNow() - event.created_at) > FRESHNESS_S) return;
      try {
        const payload = JSON.parse(
          nip44.decrypt(event.content, nip44.getConversationKey(secret, event.pubkey))
        ) as Payload;
        if (payload.type !== "hello") return;
        clearTimeout(timer);
        unsub();
        resolve({ from: event.pubkey });
      } catch { /* not ours */ }
    });
    opts?.onUri?.(buildPairingUri(relayUrl, myPk));
  });

  session = openSession(relay, secret, hello.from);
  try {
    const sas = deriveSas(myPk, hello.from);
    log(`hello received — verifying`);
    if (!(await callbacks.confirmSas(sas))) {
      await send(session, { type: "abort", reason: "sas rejected on receiving device" });
      throw new Error("aborted: SAS mismatch");
    }
    await send(session, { type: "sas-ok" });
    const keyPayload = (await expect(session, "key", timeoutMs)) as { type: "key"; key: string; account: string };
    if (!/^[0-9a-f]{64}$/i.test(keyPayload.key)) throw new Error("pairing protocol error: malformed key");
    await send(session, { type: "done" });
    log(`identity received`);
    return { key: keyPayload.key.toLowerCase(), account: keyPayload.account || "default" };
  } finally {
    session.unsubscribe();
    relay.disconnect();
  }
}

/**
 * OLD device: hello the new device's ephemeral, confirm SAS, ship the
 * identity encrypted between ephemerals.
 */
export async function pairSend(
  uri: string,
  identityKeyHex: string,
  account: string,
  callbacks: PairingCallbacks,
  opts?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = callbacks.log ?? (() => {});
  const channel = parsePairingUri(uri);
  if (!channel) throw new Error(`not a pairing uri (expected ${PAIRING_URI_PREFIX}<relay>#<pubkey>)`);
  const secret = generateSecretKey();
  const relay = new RelayConnection({ url: channel.relayUrl });
  await relay.connect();
  const session = openSession(relay, secret, channel.peerEphemeralPk);
  try {
    await send(session, { type: "hello" });
    log("hello sent — verifying");
    const sas = deriveSas(session.myPk, channel.peerEphemeralPk);
    if (!(await callbacks.confirmSas(sas))) {
      await send(session, { type: "abort", reason: "sas rejected on sending device" });
      throw new Error("aborted: SAS mismatch");
    }
    await expect(session, "sas-ok", timeoutMs); // the other human confirmed too
    await send(session, { type: "key", key: identityKeyHex, account });
    await expect(session, "done", timeoutMs);
    log("identity delivered");
  } finally {
    session.unsubscribe();
    relay.disconnect();
  }
}
