import { RelayConnection } from "../../../src/protocol/relay.js";
import { mkdir, open, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import { KIND_MEMBERSHIP, ROSTER_D } from "../../../src/protocol/kinds.js";
import { replaceableEventWins } from "../../fez-client/src/workspace-state.js";
import { startRelay, type RelayHandle } from "../../fez-relay/src/relay.js";
import { startMeshHost, workspaceAccess } from "./mesh.js";
export interface ProviderOptions {
  upstream: string; model: string; owner: string; store: string;
  port: number; relayPort: number; maxTokens: number;
}
export async function checkProvider(options: ProviderOptions): Promise<void> {
  const [model, host, relay] = await Promise.all([
    fetch(options.upstream + "/models", { signal: AbortSignal.timeout(5000) }),
    fetch(`http://127.0.0.1:${options.port}/v1/models`, { signal: AbortSignal.timeout(5000) }),
    fetch(`http://127.0.0.1:${options.relayPort}`, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(5000) }),
  ]);
  if (!model.ok || host.status !== 401 || !relay.ok) throw new Error("Model, signed host and relay must all be available");
  const models = await model.json() as { data?: { id: string }[] };
  const workspace = await relay.json() as { pubkey?: string };
  await host.body?.cancel();
  if (!models.data?.some(row => row.id === options.model) || workspace.pubkey !== options.owner) throw new Error("Provider model or workspace identity does not match its configuration");
}
export async function startProvider(options: ProviderOptions) {
  await mkdir(dirname(options.store), { recursive: true, mode: 0o700 });
  await (await open(options.store, "a", 0o600)).close();
  await chmod(options.store, 0o600);
  let relay!: RelayHandle;
  const relayUrl = await new Promise<string>(resolve => {
    relay = startRelay({ port: options.relayPort, host: "127.0.0.1", store: options.store,
      workspace: { owner: options.owner, name: "Mini mesh" }, log: () => {},
      onListening: port => resolve(`ws://127.0.0.1:${port}`) });
  });
  const wire = new RelayConnection({ url: relayUrl });
  try {
    await wire.connect();
    const host = await startMeshHost({ ...options, timeoutMs: 120000, isMember: workspaceAccess(wire, options.owner) });
    let closed = false;
    return { url: host.url, wire, close: async () => {
      if (closed) return;
      closed = true;
      await host.close(); wire.disconnect(); relay.close();
    } };
  } catch (error) { wire.disconnect(); relay.close(); throw error; }
}

/** Only an explicit owner action changes admission; service startup never grants access. */
export async function updateMember(wire: RelayConnection, owner: Uint8Array, pubkey: string, admit: boolean): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(pubkey)) throw new Error("A hex member pubkey is required");
  const result = await wire.queryWithStatus([{ kinds: [KIND_MEMBERSHIP], authors: [getPublicKey(owner)], "#d": [ROSTER_D] }], 3000);
  if (result.failures.length) throw new Error("Cannot update an incomplete roster");
  let latest: Event | undefined;
  for (const event of result.events) {
    if (event.pubkey === getPublicKey(owner) && verifyEvent(event) && replaceableEventWins(event, latest)) latest = event;
  }
  const tags = (latest?.tags ?? [["d", ROSTER_D]]).filter(tag => tag[0] !== "p" || tag[1] !== pubkey);
  if (admit) tags.push(["p", pubkey, "bot"]);
  // ponytail: one operator changes this pilot roster; concurrent administrators need a shared write queue.
  await wire.publish(finalizeEvent({ kind: KIND_MEMBERSHIP, tags, content: latest?.content ?? "",
    created_at: Math.max(Math.floor(Date.now() / 1000), (latest?.created_at ?? 0) + 1) }, owner));
}
