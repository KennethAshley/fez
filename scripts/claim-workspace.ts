/**
 * Claim a relay as your workspace.
 *
 *   npx tsx scripts/claim-workspace.ts wss://relay.example general random
 *
 * A relay IS a workspace, so there is nothing to create — the relay
 * already exists. This publishes the two things a workspace needs to be
 * usable: its first channel(s), and a roster naming you owner.
 *
 * It refuses unless the relay's NIP-11 document already names your key
 * as `pubkey`. That is deliberate: the owner is declared by the relay
 * operator (`fez-relay --owner`), and a client that could claim an
 * unclaimed relay by fiat would be exactly the land-grab the
 * unclaimed-workspace rule exists to prevent.
 *
 * Safe to re-run: an already-claimed workspace prints its channels and
 * changes nothing.
 */

import { execSync } from "node:child_process";
import { BrowserWire } from "../packages/fez-desktop/src/wire.js";
import { FezClient } from "../packages/fez-client/dist/index.js";

const [relay, ...channels] = process.argv.slice(2);
if (!relay) {
  console.error("usage: claim-workspace.ts <wss://relay> [channel ...]");
  process.exit(1);
}

const secret = execSync("security find-generic-password -s fez-keys -a default -w", {
  encoding: "utf8",
}).trim();

const wire = new BrowserWire([relay], secret);
const client = new FezClient(wire as never);
await client.start();

const ws = client.state.workspace;
console.log(`workspace : ${ws.name}`);
console.log(`relay     : ${ws.relay}`);
console.log(`owner     : ${ws.owner ? `${ws.owner.slice(0, 16)}…` : "NONE — unclaimed"}`);

if (!ws.owner) {
  console.error(
    "\nThis relay names no owner in its NIP-11 document, so nothing published\n" +
      "here could be valid. Start it with --owner <your pubkey> first."
  );
  process.exit(1);
}
if (!client.state.isOwner(client.pubkey)) {
  console.error(`\nThis workspace is owned by ${ws.owner.slice(0, 16)}… — not you.`);
  process.exit(1);
}

if (ws.channels.size > 0) {
  console.log(`\nalready claimed · channels: ${[...ws.channels.values()].map((c) => `#${c.name}`).join(" ")}`);
} else {
  const { channelId } = await client.claimWorkspace(channels[0] ?? "general");
  console.log(`\nclaimed   : #${channels[0] ?? "general"} (${channelId.slice(0, 8)})`);
  for (const name of channels.slice(1)) {
    const id = await client.createChannel(name);
    console.log(`channel   : #${name} (${id.slice(0, 8)})`);
  }
}

console.log(
  `roster    : ${[...client.state.workspace.members.entries()]
    .map(([pk, role]) => `${pk.slice(0, 8)}…:${role}`)
    .join(", ")}`
);
console.log(`\ninvite    : fez-join:${relay}`);
wire.close();
process.exit(0);
