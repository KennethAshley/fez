// The buy tool against real gamma services, with a key made for this run and
// never funded: discovery, Zils and the signed request are real, and the
// expected end is "no balance" (HTTP 402). Spends nothing.
// Usage (from packages/fez-wallet):
//   bun --env-file=$HOME/.fez/zils.env gamma-live-check.ts "<need>" "<policy>" <url> [method]
//   bun gamma-live-check.ts routes <netuid>      (list the routes a service's spec allows)
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { askJudge, ZILS_URL } from "../fez-orchestrator/src/judge.js";
import { connectSubtensor } from "./src/chains/subtensor.js";
import { deriveAgentPair, generateWalletMnemonic } from "./src/derive.js";
import { discoverGammaServices } from "./src/gamma-services.js";
import { endpointFor } from "./src/networks.js";
import { walletGammaBuy } from "./src/tools.js";

const [need, policy, url, method] = process.argv.slice(2);
const api = await connectSubtensor(endpointFor("finney"));
if (need === "routes") {
  const service = (await discoverGammaServices(api)).services.find((s) => s.netuid === Number(policy));
  console.log(service ? service.routes.join("\n") : "no such service");
  process.exit(0);
}
if (!need || !policy || !url) throw new Error('usage: gamma-live-check.ts "<need>" "<policy>" <url> [method]');
await cryptoWaitReady();
const key = process.env.ZILS_API_KEY ?? "";
console.log(await walletGammaBuy({
  pair: deriveAgentPair(generateWalletMnemonic(), "live-check"),
  api,
  policy,
  ask: async (state, questions) => {
    const result = await askJudge(ZILS_URL, key, state, questions);
    console.log("zils:", JSON.stringify(result.answers));
    return result;
  },
}, { need, url, method }));
process.exit(0);
