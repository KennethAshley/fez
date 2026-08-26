import type { FezClient } from "@fezchat/client";
import { WELCOME_CHANNEL_ID } from "./welcome-core";

/**
 * The owner bootstrap, sequenced: owner known (NIP-11) → #general and
 * #welcome exist → caller may run the welcome. Extracted from App.tsx so
 * the cold-start eval can boot it against a real relay — including one
 * that comes up LATE, which is what a fresh install actually looks like
 * (the relay and the webview start concurrently).
 *
 * Returns true when the workspace is owned by this key and has a room.
 */
export async function ensureOwnerBootstrap(client: FezClient): Promise<boolean> {
  if (!client.state.isOwner(client.pubkey)) return false;
  if (client.state.workspace.channels.size === 0) {
    // FIXED id: racing creates converge — latest event for the d-tag
    // wins, duplicates cannot exist by construction (review finding F6).
    await client.ensureChannel({ name: "general", id: "bootstrap-general" }).catch(() => {});
    // The room the welcome choreography owns. visibility "closed" is
    // serialized-but-unenforced today (workspace roster is the real
    // gate); in a fresh solo workspace that's truthful in effect.
    await client.ensureChannel({ name: "welcome", id: WELCOME_CHANNEL_ID, visibility: "closed" }).catch(() => {});
  }
  const ok = client.state.workspace.channels.size > 0;
  if (ok && !client.state.scope) {
    // Land IN the room, not beside it. The client's own "land somewhere"
    // runs during start(), when a cold boot still has zero channels —
    // so the first channel this bootstrap just made needs an explicit
    // landing or the owner boots into "no channel — pick one".
    // Land in #welcome (the guided room), else general, else anything.
    const channelId = client.state.workspace.channels.has(WELCOME_CHANNEL_ID)
      ? WELCOME_CHANNEL_ID
      : client.state.workspace.channels.has("bootstrap-general")
        ? "bootstrap-general"
        : [...client.state.workspace.channels.keys()][0];
    client.setScope(channelId);
  }
  return ok;
}
