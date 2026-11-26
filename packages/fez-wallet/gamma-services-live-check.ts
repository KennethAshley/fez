// Service discovery against the real chain and the real services. Sends only
// GET requests, signed by a key made for this run and never funded. Spends nothing.
// Usage (from packages/fez-wallet): bun gamma-services-live-check.ts [finney|test]
import { connectSubtensor } from "./src/chains/subtensor.js";
import { discoverGammaServices } from "./src/gamma-services.js";
import { endpointFor, type Network } from "./src/networks.js";

const api = await connectSubtensor(endpointFor((process.argv[2] ?? "finney") as Network));
const report = await discoverGammaServices(api);
const mark = { pass: "+", fail: "x", unknown: "?" };
console.log(`block ${report.block}, ${report.services.length} services, ${report.services.filter((s) => s.ready).length} ready`);
for (const s of report.services) {
  console.log(`${String(s.netuid).padStart(4)} ${s.checks.map((c) => mark[c.status]).join("")} ${s.ready ? "ready" : "     "} ${s.name ?? s.url}`);
}
process.exit(0);
