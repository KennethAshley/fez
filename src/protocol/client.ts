import { unixNow } from "../shared/time.js";
import { hexToBytes } from "../shared/codec.js";
import { type Event, type Filter, type UnsignedEvent, finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { RelayConnection } from "./relay.js";
import { KIND_AGENT_CAPABILITY, KIND_AGENT_METADATA, KIND_AGENT_RESULT, KIND_AGENT_TASK } from "./kinds.js";
import { buildDmWraps, buildGroupDmWraps, unwrapDm, type DmRumor } from "./dm.js";

export interface ClientConfig {
  /** One relay URL, or the whole relay set. */
  relay: string | string[];
  /** Optional private key (auto-generated if not provided) */
  privateKey?: string;
}

export interface Capability {
  pubkey: string;
  name: string;
  type: string;
  description?: string;
  pricing?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface TaskOptions {
  /** Target agent pubkey */
  to: string;
  /** Task type identifier */
  taskType: string;
  /** Natural language instruction */
  instruction: string;
  /** Optional parameters */
  params?: Record<string, unknown>;
  /** Optional context */
  context?: Record<string, unknown>;
  /** Optional deadline (unix timestamp) */
  deadline?: number;
  /** Optional budget */
  budget?: { currency: string; amount: string };
  /** Optional: reference to a parent task */
  parentTaskId?: string;
  /** Callback for progress updates */
  onProgress?: (event: Event) => void;
}

export interface TaskResult {
  event: Event;
  status: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message: string };
  cost?: { currency: string; amount: string };
}

/**
 * Fez Client — for calling agents from your app, script, or another agent.
 *
 * ```typescript
 * const client = new CapabilityClient({ relay: "wss://relay.example.com" });
 *
 * // Discover agents
 * const storageAgents = await client.findCapabilities({ type: "storage" });
 *
 * // Call one
 * const result = await client.sendTask({
 *   to: storageAgents[0].pubkey,
 *   taskType: "store",
 *   instruction: "Store this file",
 *   params: { data: "..." },
 * });
 * ```
 */
export class CapabilityClient {
  private relay: RelayConnection;
  private privateKey: Uint8Array;
  private pubkey: string;

  constructor(config: ClientConfig) {
    this.relay = new RelayConnection({
      urls: Array.isArray(config.relay) ? config.relay : [config.relay],
      authSigner: this.authSigner,
    });

    if (config.privateKey) {
      this.privateKey = hexToBytes(config.privateKey);
    } else {
      this.privateKey = generateSecretKey();
    }
    this.pubkey = getPublicKey(this.privateKey);
  }

  /** Live-swap the relay set — delegates to the connection's diff. */
  setRelays(urls: string[]): void {
    this.relay.setRelays(urls);
  }

  getPubkey(): string {
    return this.pubkey;
  }

  /**
   * Sign an arbitrary event template with the user's key. The one sanctioned
   * path for anything outside this class (e.g. extensions via
   * FezExtensionAPI.nostr.publish) to author events as the user — the
   * private key itself stays private.
   */
  /** NIP-42 auth signer for RelayConnection — same custody rationale as signEvent. */
  authSigner = async (template: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<Event> =>
    this.signEvent(template);

  signEvent(tmpl: { kind: number; tags: string[][]; content: string; created_at?: number }): Event {
    const event: UnsignedEvent = {
      kind: tmpl.kind,
      pubkey: this.pubkey,
      // created_at override exists for monotonic bumps (roster updates
      // must strictly advance past the previous winning 47102 even
      // within the same second), not for backdating.
      created_at: tmpl.created_at ?? unixNow(),
      tags: tmpl.tags,
      content: tmpl.content,
    };
    return finalizeEvent(event, this.privateKey);
  }

  /**
   * NIP-44 encrypt to a peer — the crypto seam for private pipes over
   * public relays (observer frames, future DMs). Same custody rationale
   * as signEvent: the private key never leaves this class.
   */
  encryptTo(peerPubkey: string, plaintext: string): string {
    return nip44.encrypt(plaintext, nip44.getConversationKey(this.privateKey, peerPubkey));
  }

  /** NIP-44 decrypt from a peer. Throws on wrong key/garbage — callers decide whether that's ignorable. */
  decryptFrom(peerPubkey: string, ciphertext: string): string {
    return nip44.decrypt(ciphertext, nip44.getConversationKey(this.privateKey, peerPubkey));
  }

  /**
   * Send a NIP-17 private DM: publishes two gift wraps — one to the
   * recipient, one to self (so the sender's other clients see it too).
   * Returns the rumor id (stable across both copies).
   */
  async sendDm(recipientPubkey: string, text: string, depth = 0): Promise<string> {
    const { toPeer, toSelf, id } = this.wrapDm(recipientPubkey, text, depth);
    await this.relay.publish(toPeer);
    await this.relay.publish(toSelf);
    return id;
  }

  /** Build both DM wraps without publishing — for callers with their own relay connection. */
  wrapDm(recipientPubkey: string, text: string, depth = 0): { toPeer: Event; toSelf: Event; id: string } {
    const { toPeer, toSelf } = buildDmWraps(this.privateKey, recipientPubkey, text, depth);
    return { toPeer, toSelf, id: unwrapDm(toSelf, this.privateKey)?.id ?? "" };
  }

  /** Group DM: one rumor to every recipient, one wrap each + self-copy. */
  wrapGroupDm(recipientPubkeys: string[], text: string, depth = 0): { wraps: Event[]; id: string } {
    return buildGroupDmWraps(this.privateKey, recipientPubkeys, text, depth);
  }

  async sendGroupDm(recipientPubkeys: string[], text: string, depth = 0): Promise<string> {
    const { wraps, id } = this.wrapGroupDm(recipientPubkeys, text, depth);
    for (const wrap of wraps) await this.relay.publish(wrap);
    return id;
  }

  /** Unwrap a kind-1059 gift wrap addressed to us; undefined if not ours / not a DM. */
  unwrapDm(event: Event): DmRumor | undefined {
    return unwrapDm(event, this.privateKey);
  }

  /** Connect to the relay */
  async connect(): Promise<void> {
    await this.relay.connect();
  }

  disconnect(): void {
    this.relay.disconnect();
  }

  /**
   * Discover agents by capability type.
   */
  async findCapabilities(filter: { type?: string; name?: string }): Promise<Capability[]> {
    const filters: Filter[] = [{ kinds: [KIND_AGENT_CAPABILITY], limit: 100 }];

    if (filter.type) {
      filters[0]["#capability_type"] = [filter.type];
    }

    const events = await this.relay.query(filters);

    return events
      .map((event) => {
        try {
          const content = JSON.parse(event.content);
          const capType = event.tags.find((t) => t[0] === "capability_type")?.[1];
          return {
            pubkey: event.pubkey,
            name: content.name || event.tags.find((t) => t[0] === "d")?.[1] || "unnamed",
            type: capType || "unknown",
            description: content.description,
            pricing: content.pricing,
            inputSchema: content.input_schema,
            outputSchema: content.output_schema,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Capability[];
  }

  /**
   * Discover agents by name from metadata events.
   */
  async findAgentsByName(name: string): Promise<{ pubkey: string; name: string; supportedTasks: string[] }[]> {
    const filters: Filter[] = [
      {
        kinds: [KIND_AGENT_METADATA],
        limit: 100,
      },
    ];

    const events = await this.relay.query(filters);

    return events
      .map((event) => {
        try {
          const content = JSON.parse(event.content);
          if (content.name?.toLowerCase().includes(name.toLowerCase())) {
            return {
              pubkey: event.pubkey,
              name: content.name,
              supportedTasks: content.supported_tasks || [],
            };
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { pubkey: string; name: string; supportedTasks: string[] }[];
  }

  /**
   * Send a task to an agent and wait for the result.
   */
  async sendTask(options: TaskOptions): Promise<TaskResult> {
    const event: UnsignedEvent = {
      kind: KIND_AGENT_TASK,
      pubkey: this.pubkey,
      created_at: unixNow(),
      tags: [
        ["p", options.to],
        ["task_type", options.taskType],
        ...(options.deadline ? [["deadline", options.deadline.toString()]] : []),
        ...(options.budget ? [["budget", options.budget.currency, options.budget.amount]] : []),
        ...(options.parentTaskId ? [["e", options.parentTaskId]] : []),
      ],
      content: JSON.stringify({
        instruction: options.instruction,
        params: options.params,
        context: options.context,
      }),
    };

    const signed = finalizeEvent(event, this.privateKey);
    await this.relay.publish(signed);

    // Subscribe for result
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error("Task timed out waiting for result"));
      }, 60000);

      const unsub = this.relay.subscribe(
        [
          {
            kinds: [KIND_AGENT_RESULT],
            "#e": [signed.id],
            "#p": [this.pubkey],
          },
        ],
        (resultEvent) => {
          try {
            const content = JSON.parse(resultEvent.content);
            clearTimeout(timeout);
            unsub();
            resolve({
              event: resultEvent,
              status: content.status,
              result: content.result,
              error: content.error,
              cost: content.cost,
            });
          } catch {
            // ignore parse errors
          }
        }
      );
    });
  }
}

