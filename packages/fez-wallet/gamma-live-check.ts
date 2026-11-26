// The buy tool against real gamma services, with a key made for this run and
// never funded: discovery, Zils and the signed request are real, and the
// expected end is "no balance" (HTTP 402). Spends nothing.
// Usage (from packages/fez-wallet):
//   bun --env-file=$HOME/.fez/zils.env gamma-live-check.ts "<need>" <daily limit in dollars> <url> [method]
//   bun gamma-live-check.ts routes <netuid>      (list the routes a service's spec allows)
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { askJudge, ZILS_URL } from "../fez-orchestrator/src/judge.js";
import { connectSubtensor } from "./src/chains/subtensor.js";
import { deriveAgentPair, generateWalletMnemonic } from "./src/derive.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverGammaServices, gammaCacheDir } from "./src/gamma-services.js";
import { endpointFor } from "./src/networks.js";
import { walletGammaBuy, walletGammaTopup } from "./src/tools.js";

const [need, limit, url, method] = process.argv.slice(2);
const api = await connectSubtensor(endpointFor("finney"));
if (need === "routes") {
  const service = (await discoverGammaServices(api)).services.find((s) => s.netuid === Number(limit));
  console.log(service ? service.routes.join("\n") : "no such service");
  process.exit(0);
}
if (need === "topup") {
  // bun gamma-live-check.ts topup <netuid> <dollars>: the top-up tool with an empty throwaway key.
  // The quote and the balance check are real; the expected end is "has 0 TAO free". Sends nothing.
  await cryptoWaitReady();
  const { services } = await discoverGammaServices(api, { cacheDir: gammaCacheDir("finney") });
  console.log(await walletGammaTopup(
    { pair: deriveAgentPair(generateWalletMnemonic(), "live-check"), api, persona: "live-check", dir: mkdtempSync(join(tmpdir(), "gamma-live-")), dailyLimitUsd: 5, services },
    { netuid: Number(limit), usd: Number(url) }));
  process.exit(0);
}
if (!need || !limit || !url) throw new Error('usage: gamma-live-check.ts "<need>" <daily limit in dollars> <url> [method]');
await cryptoWaitReady();
const key = process.env.ZILS_API_KEY ?? "";
console.log(await walletGammaBuy({
  pair: deriveAgentPair(generateWalletMnemonic(), "live-check"),
  api,
  dailyLimitUsd: Number(limit),
  ask: async (state, questions) => {
    const result = await askJudge(ZILS_URL, key, state, questions);
    console.log("zils:", JSON.stringify(result.answers));
    return result;
  },
}, { need, url, method }));
process.exit(0);
