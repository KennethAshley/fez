import type { FezClient } from "@fezchat/client";

/**
 * The owner bootstrap, sequenced: owner known (NIP-11) → #general exists
 * → caller may run the welcome. Extracted from App.tsx so the cold-start
 * eval can boot it against a real relay — including one that comes up
 * LATE, which is what a fresh install actually looks like (the relay and
 * the webview start concurrently).
 *
 * Returns true when the workspace is owned by this key and has a room.
 */
export async function ensureOwnerBootstrap(client: FezClient): Promise<boolean> {
  if (!client.state.isOwner(client.pubkey)) return false;
  if (client.state.workspace.channels.size === 0) {
    // FIXED id: racing creates converge — latest event for the d-tag
    // wins, duplicates cannot exist by construction (review finding F6).
    await client.ensureChannel({ name: "general", id: "bootstrap-general" }).catch(() => {});
  }
  return client.state.workspace.channels.size > 0;
}
