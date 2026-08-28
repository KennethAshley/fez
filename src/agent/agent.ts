import { unixNow } from "../shared/time.js";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import {
  type Event,
  type UnsignedEvent,
  type Filter,
  getPublicKey,
  finalizeEvent,
  generateSecretKey,
} from "nostr-tools";
import { RelayConnection } from "../protocol/relay.js";
import {
  KIND_AGENT_METADATA,
  KIND_AGENT_TASK,
  KIND_AGENT_PROGRESS,
  KIND_AGENT_RESULT,
  KIND_AGENT_CANCEL,
} from "../protocol/kinds.js";

export interface AgentConfig {
  /** Nostr private key (hex). Auto-generated if not provided. */
  privateKey?: string;
  /** Relay URL to connect to */
  relay: string | string[];
  /** Agent name (for metadata) */
  name: string;
  /** Task types this agent supports */
  supportedTasks: string[];
  /** Optional: description, pricing, etc. */
  metadata?: Record<string, unknown>;
  /** How often to republish metadata (ms). Default: 24h */
  heartbeatInterval?: number;
}

export interface TaskPayload {
  /** The task event that triggered this handler */
  event: Event;
  /** Parsed content */
  content: {
    instruction: string;
    params?: Record<string, unknown>;
    context?: Record<string, unknown>;
  };
  /** Reply function to send result */
  reply: (result: TaskResult) => Promise<void>;
  /** Send progress update */
  progress: (percent: number, message?: string) => Promise<void>;
}

export interface TaskResult {
  status: "success" | "failure" | "cancelled" | "timeout";
  result?: Record<string, unknown>;
  error?: {
    code?: string;
    message: string;
  };
  cost?: {
    currency: string;
    amount: string;
  };
}

/**
 * Core Fez Agent class.
 *
 * Connects to a Nostr relay, publishes metadata, subscribes to tasks,
 * and routes them to your handler.
 *
 * ```typescript
 * const agent = await Agent.create({
 *   relay: "wss://relay.example.com",
 *   name: "ditto",
 *   supportedTasks: ["record", "summarize"],
 * });
 *
 * agent.onTask(async (task) => {
 *   const data = await doWork(task);
 *   await task.reply({ status: "success", result: data });
 * });
 *
 * await agent.start();
 * ```
 */
export class Agent {
  private relay: RelayConnection;
  private privateKey: Uint8Array;
  private pubkey: string;
  private config: AgentConfig;
  private taskHandler?: (task: TaskPayload) => Promise<void>;
  private unsub?: () => void;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(config: AgentConfig) {
    this.config = config;
    this.relay = new RelayConnection({ urls: Array.isArray(config.relay) ? config.relay : [config.relay] });

    if (config.privateKey) {
      this.privateKey = hexToBytes(config.privateKey);
    } else {
      this.privateKey = generateSecretKey();
      console.log(
        "⚡ Generated new keypair:",
        bytesToHex(this.privateKey),
        "\n   Save this to reuse the same identity."
      );
    }
    this.pubkey = getPublicKey(this.privateKey);
  }

  static async create(config: AgentConfig): Promise<Agent> {
    const agent = new Agent(config);
    await agent.relay.connect();
    return agent;
  }

  /** Your agent's public key (npub format) */
  getPubkey(): string {
    return this.pubkey;
  }

  /** Set the handler for incoming tasks */
  onTask(handler: (task: TaskPayload) => Promise<void>): void {
    this.taskHandler = handler;
  }

  /**
   * Start the agent: publish metadata and subscribe to tasks.
   */
  async start(): Promise<void> {
    // Publish metadata
    await this.publishMetadata();

    // Start heartbeat
    const interval = this.config.heartbeatInterval || 24 * 60 * 60 * 1000;
    this.heartbeatTimer = setInterval(() => this.publishMetadata(), interval);

    // Subscribe to tasks addressed to us
    const filters: Filter[] = [
      {
        kinds: [KIND_AGENT_TASK],
        "#p": [this.pubkey],
        since: unixNow(),
      },
      {
        kinds: [KIND_AGENT_CANCEL],
        "#p": [this.pubkey],
        since: unixNow(),
      },
    ];

    this.unsub = this.relay.subscribe(
      filters,
      (event) => this.handleEvent(event),
      () => {
        // EOSE — subscription ready
      }
    );

    console.log(`🟢 Agent "${this.config.name}" listening on ${this.config.relay}`);
    console.log(`   Pubkey: ${this.pubkey}`);
  }

  /**
   * Stop the agent.
   */
  stop(): void {
    this.unsub?.();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.relay.disconnect();
    console.log(`🔴 Agent "${this.config.name}" stopped.`);
  }

  private async publishMetadata(): Promise<void> {
    const event: UnsignedEvent = {
      kind: KIND_AGENT_METADATA,
      pubkey: this.pubkey,
      created_at: unixNow(),
      tags: [],
      content: JSON.stringify({
        name: this.config.name,
        supported_tasks: this.config.supportedTasks,
        ...this.config.metadata,
      }),
    };

    const signed = finalizeEvent(event, this.privateKey);
    console.log(`📤 Publishing metadata (kind ${KIND_AGENT_METADATA})...`);
    try {
      await this.relay.publish(signed);
      console.log(`✅ Metadata published, event id: ${signed.id.slice(0, 16)}...`);
    } catch (err) {
      console.error(`❌ Failed to publish metadata:`, err);
    }
  }

  private async handleEvent(event: Event): Promise<void> {
    if (event.kind === KIND_AGENT_TASK) {
      await this.handleTask(event);
    } else if (event.kind === KIND_AGENT_CANCEL) {
      // TODO: signal cancellation to in-flight tasks
      console.log(`🚫 Cancel received for task: ${event.tags.find((t) => t[0] === "e")?.[1]}`);
    }
  }

  private async handleTask(event: Event): Promise<void> {
    if (!this.taskHandler) {
      console.warn("No task handler set. Ignoring task.", event.id);
      return;
    }

    let content: TaskPayload["content"];
    try {
      content = JSON.parse(event.content);
    } catch {
      console.warn("Invalid task content JSON", event.id);
      return;
    }

    const taskId = event.id;
    const callerPubkey = event.pubkey;

    const reply = async (result: TaskResult) => {
      const resultEvent: UnsignedEvent = {
        kind: KIND_AGENT_RESULT,
        pubkey: this.pubkey,
        created_at: unixNow(),
        tags: [
          ["e", taskId],
          ["p", callerPubkey],
        ],
        content: JSON.stringify(result),
      };
      const signed = finalizeEvent(resultEvent, this.privateKey);
      await this.relay.publish(signed);
    };

    const progress = async (percent: number, message?: string) => {
      const progressEvent: UnsignedEvent = {
        kind: KIND_AGENT_PROGRESS,
        pubkey: this.pubkey,
        created_at: unixNow(),
        tags: [
          ["e", taskId],
          ["p", callerPubkey],
        ],
        content: JSON.stringify({
          status: "in_progress",
          percent_complete: percent,
          message,
        }),
      };
      const signed = finalizeEvent(progressEvent, this.privateKey);
      await this.relay.publish(signed);
    };

    await this.taskHandler({ event, content, reply, progress });
  }
}

// Helpers

