/**
 * Copy every event from one relay to another.
 *
 *   node deploy/mirror.mjs ws://localhost:7777 wss://67-205-188-204.sslip.io
 *
 * Adding a relay to your set only affects events published AFTER you
 * added it — fan-out is not replication, and nothing in the protocol
 * back-fills. So a freshly stood-up relay knows nothing about the
 * community it just joined, and a client reading the union sees the old
 * history only while the original relay is alive. That is a single
 * point of failure wearing a second relay as a disguise.
 *
 * Events are signed and content-addressed, so this is safe to re-run:
 * the destination dedupes by id, and nothing here can alter history —
 * it can only fail to copy it, which the counts at the end will show.
 */
import { RelayConnection } from "../dist/index.js";

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error("usage: node deploy/mirror.mjs <source-relay> <destination-relay>");
  process.exit(1);
}

const source = new RelayConnection({ url: from });
const destination = new RelayConnection({ url: to });
await Promise.all([source.connect(), destination.connect()]);

if (!source.health()[0]?.connected) {
  console.error(`✗ cannot reach source ${from}`);
  process.exit(1);
}
if (!destination.health()[0]?.connected) {
  console.error(`✗ cannot reach destination ${to}`);
  process.exit(1);
}

// Ephemeral kinds (2xxxx) are live-only by definition — copying them
// would replay stale presence and observer frames as if they were now.
const events = (await source.query([{ limit: 100000 }], 30_000)).filter(
  (event) => !(event.kind >= 20000 && event.kind < 30000)
);
console.log(`read ${events.length} durable events from ${from}`);

let copied = 0;
let refused = 0;
const reasons = new Map();
for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
  try {
    await destination.publish(event);
    copied++;
  } catch (err) {
    refused++;
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 90);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  if ((copied + refused) % 250 === 0) process.stdout.write(`  ${copied + refused}/${events.length}\r`);
}

console.log(`\ncopied ${copied}, refused ${refused}`);
for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${String(count).padStart(5)} × ${reason}`);
}

// Verify against the destination rather than trusting the loop.
const landed = await destination.query([{ limit: 100000 }], 30_000);
console.log(`destination now holds ${landed.length} events`);
source.disconnect();
destination.disconnect();
process.exit(refused > 0 && copied === 0 ? 1 : 0);
