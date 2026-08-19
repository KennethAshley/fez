/**
 * Invite pubkeys to a workspace.
 *
 *   npx tsx scripts/invite.ts ws://localhost:7777 <pubkey>[:role] ...
 *
 * One roster per workspace, so this is one event however many people
 * are named — and they land with access to every channel, including
 * ones created later. There is no per-channel invite.
 *
 * Owner only, because the roster is only valid under the owner's
 * signature. Re-running with someone already on the roster is a no-op
 * for them.
 */

import { execSync } from "node:child_process";
import { BrowserWire } from "../packages/fez-desktop/src/wire.js";
import { FezClient } from "../packages/fez-client/dist/index.js";

const [relay, ...specs] = process.argv.slice(2);
if (!relay || specs.length === 0) {
  console.error("usage: invite.ts <wss://relay> <pubkey>[:role] ...   (role: member|admin|bot)");
  process.exit(1);
}

const secret = execSync("security find-generic-password -s fez-keys -a default -w", {
  encoding: "utf8",
}).trim();

const wire = new BrowserWire([relay], secret);
const client = new FezClient(wire as never);
await client.start();

if (!client.state.isOwner(client.pubkey)) {
  console.error(
    `Only the workspace owner can invite. This one is owned by ` +
      `${client.state.workspace.owner?.slice(0, 16) ?? "nobody"}…`
  );
  process.exit(1);
}

console.log(`workspace : ${client.state.workspace.name}`);
for (const spec of specs) {
  const [pubkey, role = "member"] = spec.split(":");
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    console.error(`  skip ${pubkey.slice(0, 12)}… — not a 64-char hex pubkey`);
    continue;
  }
  if (client.state.isMember(pubkey)) {
    console.log(`  = ${pubkey.slice(0, 12)}… already on the roster`);
    continue;
  }
  const name = await client.invite(pubkey, role as "member" | "admin" | "bot");
  console.log(`  + ${pubkey.slice(0, 12)}… as ${role}${name && name !== pubkey ? ` (${name})` : ""}`);
}

console.log(
  `roster    : ${[...client.state.workspace.members.entries()]
    .map(([pk, role]) => `${pk.slice(0, 8)}…:${role}`)
    .join(", ")}`
);
wire.close();
process.exit(0);
