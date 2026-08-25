import { unixNow } from "../shared/time.js";
import { createHash } from "node:crypto";
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";

/** node:crypto rather than a new dependency — src/pairing.ts already hashes this way. */
const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * NIP-98 — HTTP auth by signed nostr event.
 *
 * The client signs a kind-27235 event naming the URL and method it is
 * about to request and puts it in `Authorization: Nostr <base64>`. The
 * server verifies the signature and learns a pubkey. No password, no
 * bearer token to leak, nothing to revoke centrally: the key that signs
 * your messages is the key that opens the door.
 *
 * fez needs this the moment the relay serves something over HTTP that
 * is not public — git is the first, and it is why this exists. Git's
 * credential protocol asks for a username and password; a NIP-98 event
 * IS the password, so `git push` works unmodified against a relay that
 * has never heard of accounts.
 *
 * Blossom's BUD-02 (fez-media) is the same idea with a different kind,
 * and stays where it is: it authorizes an upload by content hash, not a
 * request by URL, and folding them together would mean one module with
 * two meanings.
 */

export const KIND_HTTP_AUTH = 27235;

/**
 * How far out of step a clock may be. NIP-98 suggests 60s; this is the
 * replay window, so it is short on purpose — an intercepted header is
 * reusable until it expires.
 */
export const DEFAULT_TOLERANCE_S = 60;

export type Nip98Result =
  | { ok: true; pubkey: string; event: Event }
  | { ok: false; reason: string };

/** Build the header value. `body` is hashed into the event when given. */
export function buildNip98Header(
  secretKey: Uint8Array,
  url: string,
  method: string,
  body?: Uint8Array
): string {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (body && body.length > 0) tags.push(["payload", sha256Hex(body)]);
  const event = finalizeEvent(
    { kind: KIND_HTTP_AUTH, created_at: unixNow(), tags, content: "" },
    secretKey
  );
  // base64 of the JSON event, per the NIP. Buffer is fine here: this
  // half only ever runs on node (a CLI credential helper).
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

export interface VerifyOptions {
  /** The method the server actually received. */
  method: string;
  /** Path (with query) the server actually received. */
  path: string;
  /**
   * Origins this server answers to, e.g. ["https://relay.fez.chat"].
   *
   * The `u` tag must match one of them. This is NOT ceremony: without an
   * origin check, an event a user signed for some other NIP-98 service
   * could be replayed here, and their key would open a door they never
   * pointed at. It is configurable rather than derived from the Host
   * header because fez runs behind Caddy — the relay sees the internal
   * address while the client signed the public one, so trusting Host
   * would either break TLS deployments or trust a header an attacker
   * sets.
   *
   * Empty means "match the path only", which is what a local dev relay
   * wants and what a public one must not use.
   */
  origins?: readonly string[];
  /** Raw request body, when the client hashed one in. */
  body?: Uint8Array;
  /**
   * Require the signed `method` tag to match the request. Default true.
   *
   * git turns this off, and not as a shortcut. Git's credential protocol
   * asks the helper for a password ONCE and reuses it for every request
   * in the operation — the GET that fetches refs and the POST that sends
   * the pack — so the event is necessarily signed for one method and
   * presented for another. Verified against Buzz, which arrived at the
   * same exemption and says so in a comment.
   *
   * The URL is what carries the security here: a token is locked to one
   * repo for 60 seconds. Turning this off for a protocol that does not
   * re-sign is honest; turning it off anywhere else is not.
   */
  checkMethod?: boolean;
  toleranceSeconds?: number;
  now?: number;
}

/**
 * Verify a header. Returns the pubkey it proves, or why it proves nothing.
 *
 * Every failure is a distinct reason because the ones that matter are
 * indistinguishable from the outside: a clock skew and a replay both
 * look like "denied" to a user staring at `git push`.
 *
 * NOTE ON REPLAY: event ids are deliberately NOT deduplicated. One signed
 * token is reused across the requests of a single git operation, so
 * rejecting a repeat would break every clone. The window is the ±60s
 * timestamp plus the URL lock — same trade Buzz documents.
 */
export function verifyNip98Header(header: string | undefined, opts: VerifyOptions): Nip98Result {
  if (!header) return { ok: false, reason: "no Authorization header" };
  const [scheme, encoded] = header.split(/\s+/, 2);
  if (!/^nostr$/i.test(scheme ?? "")) return { ok: false, reason: "Authorization is not a Nostr scheme" };
  if (!encoded) return { ok: false, reason: "Authorization carries no event" };

  let event: Event;
  try {
    event = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8")) as Event;
  } catch {
    return { ok: false, reason: "Authorization event is not base64 JSON" };
  }

  if (event.kind !== KIND_HTTP_AUTH) return { ok: false, reason: `wrong kind ${event.kind}, want ${KIND_HTTP_AUTH}` };
  if (!verifyEvent(event)) return { ok: false, reason: "bad signature" };

  const now = opts.now ?? unixNow();
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_S;
  if (Math.abs(now - event.created_at) > tolerance) {
    // Both directions: a future timestamp is as suspicious as an old one,
    // and a wrong local clock is the commonest cause of either.
    return { ok: false, reason: `timestamp is ${Math.abs(now - event.created_at)}s out (tolerance ${tolerance}s)` };
  }

  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];

  if (opts.checkMethod !== false) {
    const method = tag("method");
    if (!method || method.toUpperCase() !== opts.method.toUpperCase()) {
      return { ok: false, reason: `signed for method ${method ?? "(none)"}, request is ${opts.method}` };
    }
  }

  const u = tag("u");
  if (!u) return { ok: false, reason: "no u tag" };
  let signed: URL;
  try {
    signed = new URL(u);
  } catch {
    return { ok: false, reason: "u tag is not a URL" };
  }
  const signedPath = signed.pathname + signed.search;
  if (signedPath !== opts.path) {
    return { ok: false, reason: `signed for ${signedPath}, request is ${opts.path}` };
  }
  if (opts.origins && opts.origins.length > 0) {
    const wanted = opts.origins.map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin;
      }
    });
    if (!wanted.includes(signed.origin)) {
      return { ok: false, reason: `signed for ${signed.origin}, which this server does not answer to` };
    }
  }

  // A payload tag is a promise about the body; if it is there it must
  // hold, or a valid header could be lifted onto a different push.
  const payload = tag("payload");
  if (payload) {
    const actual = sha256Hex(opts.body ?? new Uint8Array());
    if (actual !== payload) return { ok: false, reason: "body does not match the signed payload hash" };
  }

  return { ok: true, pubkey: event.pubkey, event };
}
