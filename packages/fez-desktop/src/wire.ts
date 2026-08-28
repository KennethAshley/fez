import { invoke } from "@tauri-apps/api/core";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { nip44, nip59, type Event, type EventTemplate, type Filter } from "nostr-tools";
import type { Wire, WireEvent, WireFilter, DmRumor, RelayInfoDoc } from "@fezchat/client";
import { fetchRelayInfo } from "../../../src/protocol/nip11.js";
import { RelayConnection } from "../../../src/protocol/relay.js";

/**
 * Browser Wire for @fezchat/client — the same eight-function seam the TUI
 * assembles in node. Transport (reconnect watchdog, resubscribe with
 * seen-set dedup, union reads, first-acceptance publishes, NIP-42 auth)
 * is RelayConnection — the SAME pool the CLI runs on, which is the point:
 * this file used to be a second 540-line implementation of those rules,
 * and two implementations of the same guarantee is how a GUI ends up
 * quietly single-relay while the CLI is fine and every test passes.
 * SimplePool rides the webview's global WebSocket.
 *
 * What stays here is what the webview genuinely does differently:
 *
 * Custody: crypto goes through a SIGNER seam. The app passes rustSigner
 * — the key stays in Rust (macOS keychain → in-process cache), the
 * webview asks for signatures and DM crypto over the invoke bridge, and
 * a fully compromised webview could misuse those operations while the
 * app is open but cannot exfiltrate the identity (Buzz's model). Tests
 * and node hosts pass a 64-hex secret instead, which builds the
 * in-process localSigner — same seam, keys where the host wants them.
 */

const KIND_DM = 14;

/** A rumor as the signer hands it back — pre-signature event shape. */
interface Rumor {
  kind: number;
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

export interface WireSigner {
  pubkey: string;
  sign(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> | WireEvent;
  encrypt(peerPubkey: string, plaintext: string): Promise<string> | string;
  decrypt(peerPubkey: string, ciphertext: string): Promise<string> | string;
  /** ONE rumor wrapped for every recipient — a shared rumor id is what
   * makes a group DM one message instead of N. */
  wrapDm(kind: number, content: string, tags: string[][], recipients: string[]): Promise<{ rumorId: string; wraps: WireEvent[] }>;
  unwrap(event: WireEvent): Promise<Rumor | undefined> | (Rumor | undefined);
}

/** The app's signer: Rust holds the key; this side never sees it. */
export function rustSigner(pubkey: string): WireSigner {
  return {
    pubkey,
    async sign(tmpl) {
      return JSON.parse(
        await invoke<string>("sign_event", { kind: tmpl.kind, content: tmpl.content, tags: tmpl.tags, createdAt: tmpl.created_at })
      ) as WireEvent;
    },
    encrypt: (peer, plaintext) => invoke<string>("nip44_encrypt", { peer, plaintext }),
    decrypt: (peer, ciphertext) => invoke<string>("nip44_decrypt", { peer, ciphertext }),
    async wrapDm(kind, content, tags, recipients) {
      return JSON.parse(await invoke<string>("dm_wrap_all", { kind, content, tags, recipients })) as {
        rumorId: string;
        wraps: WireEvent[];
      };
    },
    async unwrap(event) {
      try {
        return JSON.parse(await invoke<string>("dm_unwrap", { event: JSON.stringify(event) })) as Rumor;
      } catch {
        return undefined; // not for us — same silence as the local path
      }
    },
  };
}

/** In-process signer for hosts that hold the key themselves (tests, node). */
export function localSigner(keyHex: string): WireSigner {
  const secret = Uint8Array.from(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const pubkey = getPublicKey(secret);
  return {
    pubkey,
    sign: (tmpl) =>
      finalizeEvent(
        { kind: tmpl.kind, created_at: tmpl.created_at ?? Math.floor(Date.now() / 1000), tags: tmpl.tags, content: tmpl.content },
        secret
      ) as WireEvent,
    encrypt: (peer, plaintext) => nip44.encrypt(plaintext, nip44.getConversationKey(secret, peer)),
    decrypt: (peer, ciphertext) => nip44.decrypt(ciphertext, nip44.getConversationKey(secret, peer)),
    async wrapDm(kind, content, tags, recipients) {
      const rumor = nip59.createRumor({ kind, tags, content } as EventTemplate, secret);
      const wraps = recipients.map((pk) => nip59.createWrap(nip59.createSeal(rumor, secret, pk), pk) as unknown as WireEvent);
      return { rumorId: (rumor as { id: string }).id, wraps };
    },
    unwrap(event) {
      try {
        return nip59.unwrapEvent(event as unknown as Event, secret) as unknown as Rumor;
      } catch {
        return undefined;
      }
    },
  };
}

export class BrowserWire implements Wire {
  readonly pubkey: string;
  private signer: WireSigner;
  /** As configured — RelayConnection normalizes its own copies. */
  private urls: string[];
  private relay: RelayConnection;
  onStatus?: (connected: boolean) => void;
  onError?: (message: string) => void;
  /** Per-relay picture, so the UI can say "2 of 3" instead of a green dot. */
  onRelayHealth?: (health: { url: string; connected: boolean }[]) => void;

  constructor(urls: string | string[], keyOrSigner: string | WireSigner) {
    this.urls = [...new Set((Array.isArray(urls) ? urls : [urls]).map((u) => u.trim()).filter(Boolean))];
    if (this.urls.length === 0) throw new Error("BrowserWire: no relay URLs given");
    this.signer = typeof keyOrSigner === "string" ? localSigner(keyOrSigner) : keyOrSigner;
    this.pubkey = this.signer.pubkey;
    this.relay = new RelayConnection({
      urls: this.urls,
      onError: (err) => this.onError?.(err.message),
      onRelayHealth: (health) => {
        this.onStatus?.(health.some((h) => h.connected));
        this.onRelayHealth?.(health);
      },
      // NIP-42: nostr-tools builds the kind-22242 challenge answer (with
      // THIS relay's url in the relay tag) and hands it here to sign.
      authSigner: async (tmpl) => (await this.signer.sign(tmpl)) as unknown as Event,
    });
    void this.relay.connect();
  }

  health(): { url: string; connected: boolean }[] {
    return this.relay.health();
  }

  relayUrls(): readonly string[] {
    return this.urls;
  }

  subscribe(filters: WireFilter[], onEvent: (event: WireEvent) => void): () => void {
    return this.relay.subscribe(filters as Filter[], onEvent as (event: Event) => void);
  }

  async query(filters: WireFilter[]): Promise<WireEvent[]> {
    return (await this.relay.query(filters as Filter[])) as WireEvent[];
  }

  /** The custody seam — whoever the signer is, the wire never holds a key. */
  private async sign(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    return this.signer.sign(tmpl);
  }

  async publish(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    const event = await this.sign(tmpl);
    await this.publishSigned(event);
    return event;
  }

  private async publishSigned(event: WireEvent): Promise<void> {
    try {
      await this.relay.publish(event as unknown as Event);
    } catch (err) {
      this.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Sign WITHOUT publishing — for events that travel outside the relay (Blossom auth headers). */
  /**
   * NIP-98, browser-shaped: same event the CLI credential helper signs
   * (src/nip98.ts builds it node-side), base64 via TextEncoder because
   * a webview has no Buffer. Signed over the URL the caller will be
   * verified against — for repo-scoped endpoints that is the PATH-ONLY
   * url (the server's verifier strips queries; see gitRepoPath).
   */
  async httpAuth(url: string, method: string): Promise<string> {
    const event = await this.sign({ kind: 27235, tags: [["u", url], ["method", method.toUpperCase()]], content: "" });
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return `Nostr ${btoa(binary)}`;
  }

  async signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Promise<WireEvent> {
    return this.sign(tmpl);
  }

  encrypt(peerPubkey: string, plaintext: string): string | Promise<string> {
    return this.signer.encrypt(peerPubkey, plaintext);
  }

  decrypt(peerPubkey: string, ciphertext: string): string | Promise<string> {
    return this.signer.decrypt(peerPubkey, ciphertext);
  }

  // NIP-17 — same wrap shape as src/dm.ts (kind-14 rumor, seal, gift
  // wrap to peer + self-copy; depth rides inside the rumor). ONE Rust
  // call wraps for every recipient so the rumor id is shared.
  async sendDm(recipientPubkey: string, text: string): Promise<string> {
    return this.sendGroupDm([recipientPubkey], text);
  }

  async sendGroupDm(recipientPubkeys: string[], text: string): Promise<string> {
    const others = [...new Set(recipientPubkeys)].filter((pk) => pk !== this.pubkey);
    const { rumorId, wraps } = await this.signer.wrapDm(
      KIND_DM,
      text,
      others.map((pk) => ["p", pk]),
      [...others, this.pubkey]
    );
    for (const wrap of wraps) await this.publishSigned(wrap);
    return rumorId;
  }

  /**
   * The workspace's identity card. Asked of the FIRST relay: under the
   * flat model a workspace is one relay, and any extra URLs are mirrors
   * of it, so the primary is the one that names the owner.
   */
  get relays(): string[] {
    return this.urls;
  }

  async relayInfo(relay?: string): Promise<RelayInfoDoc | undefined> {
    return fetchRelayInfo(relay || this.urls[0]);
  }

  async unwrapDm(event: WireEvent): Promise<DmRumor | undefined> {
    if (event.kind !== 1059) return undefined;
    try {
      const rumor = await this.signer.unwrap(event);
      if (!rumor || rumor.kind !== KIND_DM || typeof rumor.content !== "string") return undefined;
      const recipients = rumor.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]);
      const peerPk = rumor.pubkey === this.pubkey ? recipients[0] : rumor.pubkey;
      if (!peerPk) return undefined;
      return {
        senderPk: rumor.pubkey,
        peerPk,
        text: rumor.content,
        ts: rumor.created_at,
        depth: Number(rumor.tags.find((t) => t[0] === "depth")?.[1] ?? 0),
        id: rumor.id,
        participants: [...new Set([rumor.pubkey, ...recipients])].sort(),
      };
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.relay.disconnect();
  }
}
