import type { BridgeNostr, BridgeEvent, BridgeStorage } from "../../fez-client/src/bridge-work.js";
export interface ScheduledTaskContext {
  nostr: BridgeNostr & { subscribe(filters: Record<string, unknown>[], callback: (event: BridgeEvent) => void): () => void };
  ownerPubkey: string;
  channels: { list(): Promise<{ id: string; name: string; archived?: boolean }[]> };
  missedWindow: boolean;
}
export interface FezExtensionAPI {
  storage: BridgeStorage;
  workspace?: { owner?: string; relayUrl?: string };
  registerScheduledTask(name: string, everyMs: number, run: (ctx: ScheduledTaskContext) => void | Promise<void>): void;
}
