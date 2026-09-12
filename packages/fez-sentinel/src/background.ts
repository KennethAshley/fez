import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  fetchRelayInfo, loadExtensions, loadSettings, makeChannels, registeredScheduledTasks,
  pinWorkspaceOwner,
  setNostrBackend, setWorkspaceBackend,
  type CapabilityClient, type NostrAccess, type RelayConnection, type ScheduledTask,
} from "@fezchat/protocol";

/** A delayed NIP-11 response must never reinstall the workspace the user just left. */
export async function refreshWorkspace(
  currentRelay: () => string, read = fetchRelayInfo, write = setWorkspaceBackend,
): Promise<string | undefined> {
  const relayUrl = currentRelay();
  const info = await read(relayUrl);
  if (currentRelay() !== relayUrl) return undefined;
  let owner: string | undefined;
  try { owner = pinWorkspaceOwner(relayUrl, info?.pubkey); }
  catch (error) { write({ relayUrl, owner: undefined, info: undefined }); throw error; }
  write({ relayUrl, owner, info });
  return owner;
}

export function backgroundExtensions(only?: readonly string[]): string[] {
  const enabled = loadSettings().backgroundExtensions ?? [];
  for (const name of only ?? []) {
    if (!enabled.includes(name)) throw new Error(`Background extension "${name}" is not enabled`);
  }
  return only === undefined ? enabled : enabled.filter(name => only.includes(name));
}

export function assertHeadlessOwnership(home = path.join(os.homedir(), ".fez")): void {
  let owned = false;
  try {
    const row = JSON.parse(fs.readFileSync(path.join(home, "desktop-runtime.json"), "utf8"));
    if (Number.isSafeInteger(row.pid) && row.pid > 1 && typeof row.executable === "string" && path.isAbsolute(row.executable)) {
      const executable = process.platform === "linux" ? fs.readlinkSync(`/proc/${row.pid}/exe`) : execFileSync("ps", ["-p", String(row.pid), "-o", "comm="], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      owned = executable === row.executable;
    }
  } catch { /* Missing, stale or malformed receipts confer no ownership. */ }
  if (owned) throw new Error("Fez desktop owns local runtime; quit Fez before headless");
}

/** The OS releases this claim on crashes too; standby workers acquire it only at activation. */
export async function acquireBackgroundOwnership(home = path.join(os.homedir(), ".fez")): Promise<() => Promise<void>> {
  // ponytail: per-home port collisions refuse startup; use OS file locks if multi-user collisions matter.
  const port = 20_000 + createHash("sha256").update(fs.realpathSync(home)).digest().readUInt32BE(0) % 40_000;
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", error => reject(new Error(`Background task host already running or lock port ${port} unavailable: ${error.message}`)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  let released: Promise<void> | undefined;
  return () => released ??= new Promise(resolve => server.close(() => resolve()));
}

/** One in-flight invocation per task; shutdown waits for tasks already running. */
export function startScheduledTasks(
  tasks: readonly ScheduledTask[], nostr: NostrAccess, resolveOwner: () => Promise<string | undefined>,
): () => Promise<void> {
  let stopped = false;
  const running = new Set<Promise<void>>();
  const timers = tasks.map(task => {
    const everyMs = Math.min(2 ** 31 - 1, Math.max(60_000, Number.isFinite(task.everyMs) ? task.everyMs : 60_000));
    let busy = false, lastTickAt = Date.now();
    const tick = () => {
      if (stopped || busy) return;
      busy = true;
      const missedWindow = Date.now() - lastTickAt > everyMs * 2;
      lastTickAt = Date.now();
      const work = (async () => {
        try {
          // Retry after relay boot failures; workspace owner and local signer are different authorities.
          const owner = await resolveOwner();
          if (!stopped) await task.run({ nostr, ownerPubkey: nostr.pubkey, channels: makeChannels(nostr, owner ?? ""), missedWindow });
        } catch (err) {
          console.warn(`⚠️  scheduled task "${task.name}" failed: ${err instanceof Error ? err.message : err}`);
        } finally { busy = false; }
      })();
      running.add(work);
      void work.finally(() => running.delete(work));
    };
    const timer = setInterval(tick, everyMs);
    timer.unref();
    tick();
    console.log(`   ⏱  scheduled task "${task.name}" every ${Math.round(everyMs / 60_000)}m`);
    return timer;
  });
  return async () => {
    stopped = true;
    timers.forEach(clearInterval);
    await Promise.allSettled(running);
  };
}

/** Prepare permitted extensions without running their tasks; start is the ownership handoff. */
export async function prepareBackgroundTasks(
  client: CapabilityClient, relay: RelayConnection, currentRelay: () => string, extensions = backgroundExtensions(), strict = false,
): Promise<{ start(): Promise<void>; stop(): Promise<void> }> {
  let active = false, stopped = false;
  const subscriptions = new Set<() => void>();
  const requireActive = () => {
    if (!active) throw new Error("Background task host is not active");
  };
  const nostr: NostrAccess = {
    pubkey: client.getPubkey(),
    publish: async template => { requireActive(); const event = client.signEvent(template); await relay.publish(event); return event; },
    signEvent: template => { requireActive(); return client.signEvent(template); },
    subscribe: (filters, handler) => {
      requireActive();
      const close = relay.subscribe(filters, event => { if (active) handler(event); });
      subscriptions.add(close);
      return () => { subscriptions.delete(close); close(); };
    },
    query: filters => { requireActive(); return relay.query(filters); },
    queryWithStatus: filters => { requireActive(); return relay.queryWithStatus(filters); },
    encrypt: (peer, text) => { requireActive(); return client.encryptTo(peer, text); },
    decrypt: (peer, text) => { requireActive(); return client.decryptFrom(peer, text); },
    sendDm: async (peer, text) => {
      requireActive();
      const { toPeer, toSelf, id } = client.wrapDm(peer, text);
      await relay.publish(toPeer);
      requireActive();
      await relay.publish(toSelf);
      return id;
    },
    unwrapDm: event => { requireActive(); return client.unwrapDm(event); },
  };
  setNostrBackend(nostr);
  const resolveOwner = () => refreshWorkspace(currentRelay);
  if (!await resolveOwner()) console.log("   ⏱  relay is unclaimed (no owner in NIP-11) — channel-scoped tasks cannot publish");
  if (!extensions.length) console.log("   ⏱  no background extensions installed");
  await loadExtensions(undefined, extensions, { strict });
  let starting: Promise<void> | undefined, release: (() => Promise<void>) | undefined, stopTasks: (() => Promise<void>) | undefined;
  return {
    start() {
      return starting ??= (async () => {
        if (stopped) throw new Error("Background task host is stopped");
        release = await acquireBackgroundOwnership();
        if (stopped) { await release(); throw new Error("Background task host is stopped"); }
        active = true;
        stopTasks = startScheduledTasks(registeredScheduledTasks(), nostr, resolveOwner);
      })();
    },
    async stop() {
      stopped = true;
      active = false;
      subscriptions.forEach(close => close());
      subscriptions.clear();
      await stopTasks?.();
      await release?.();
    },
  };
}
