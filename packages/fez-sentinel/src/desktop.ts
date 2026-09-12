#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  adoptUserPath, CapabilityClient, getKey, RelayConnection, resolveRelays,
  setWorkspaceBackend, watchRelaySet,
} from "@fezchat/protocol";
import { backgroundExtensions, prepareBackgroundTasks } from "./background.js";

// stdout is the native handshake; extension diagnostics belong in the log.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

async function runDesktopBackground(): Promise<void> {
  const parent = Number(process.env.FEZ_DESKTOP_PARENT_PID);
  if (!Number.isSafeInteger(parent) || parent <= 1 || parent !== process.ppid) {
    throw new Error("Invalid desktop parent PID");
  }
  const owner = process.env.FEZ_DESKTOP_OWNER;
  if (!owner || !/^[a-f0-9]{64}$/.test(owner)) throw new Error("Invalid desktop owner pubkey");

  let host: Awaited<ReturnType<typeof prepareBackgroundTasks>> | undefined;
  let relay: RelayConnection | undefined, client: CapabilityClient | undefined;
  let unwatch: (() => void) | undefined, startRequested = false, started = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = (error?: unknown) => {
    if (error) console.error(`Background worker failed: ${error instanceof Error ? error.message : error}`);
    clearInterval(parentWatch);
    unwatch?.();
    void host?.stop();
    relay?.disconnect();
    client?.disconnect();
    // Extension HTTP calls cannot always be cancelled; process lifetime is the final boundary.
    process.exit(error ? 1 : 0);
  };
  const parentWatch = setInterval(() => {
    if (process.ppid !== parent) stop();
    try { process.kill(parent, 0); } catch { stop(); }
  }, 1000);
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
  input.on("close", () => stop());
  process.stdin.on("error", error => stop(error));
  const activate = async () => {
    if (!host || !startRequested || started) return;
    started = true;
    try {
      await host.start();
      process.stdout.write("FEZ_BACKGROUND_STARTED\n");
    } catch (error) { stop(error); }
  };
  input.on("line", line => {
    if (line !== "start") { stop(new Error("Expected desktop control command: start")); return; }
    startRequested = true;
    void activate();
  });

  try {
    // The desktop changes settings at runtime; an inherited shell pin must not strand this worker.
    delete process.env.FEZ_RELAY;
    const selected = process.env.FEZ_BACKGROUND_EXTENSIONS?.split(",").map(name => name.trim()).filter(Boolean);
    const extensions = backgroundExtensions(selected);
    adoptUserPath();
    const key = getKey("default");
    if (!key) throw new Error("No local fez identity for desktop background tasks");
    const relays = resolveRelays();
    client = new CapabilityClient({ relay: relays, privateKey: key });
    if (client.getPubkey() !== owner) throw new Error("Desktop owner does not match the local default identity");
    relay = new RelayConnection({ urls: relays, authSigner: client.authSigner });
    await relay.connect();
    if (!relay.health().some(entry => entry.connected)) throw new Error("Desktop background worker cannot connect to any configured relay");
    const connection = relay, identity = client;
    const updateRelays = (next: string[]) => {
      try {
        const previous = relays[0];
        connection.setRelays(next);
        identity.setRelays(next);
        relays.splice(0, relays.length, ...next);
        if (next[0] !== previous) setWorkspaceBackend({ relayUrl: next[0] });
        console.log(`Background relay set changed → ${next.join(", ")}`);
      } catch (error) { console.error(`Background relay change refused: ${error instanceof Error ? error.message : error}`); }
    };
    unwatch = watchRelaySet(updateRelays);
    // Connection/auth can take seconds; pick up settings saved before the watcher existed too.
    const current = resolveRelays();
    if (current.join(",") !== relays.join(",")) updateRelays(current);
    host = await prepareBackgroundTasks(client, relay, () => relays[0], extensions, true);
    process.stdout.write("FEZ_BACKGROUND_READY\n");
    await activate();
  } catch (error) { stop(error); }
}

// This file is exclusively a program: compiled Bun binaries also enter here.
runDesktopBackground().catch(error => {
  console.error(`Background worker failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
