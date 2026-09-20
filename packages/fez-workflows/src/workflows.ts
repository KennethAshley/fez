#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { RelayConnection, CapabilityClient, resolveRelays } from "@fezchat/protocol";
import { loadServiceKey, resolveChannels } from "./service-common.js";
import { loadDefs, usesJudge } from "./defs.js";
import { judgeConfigFromEnv, type Ask } from "./judge.js";
import { askJudge } from "../../fez-orchestrator/src/typesafe.js";
import { startWorkflowEngine } from "./engine.js";

/**
 * fez-workflows, standalone host — the engine (engine.ts) under its own
 * service key, run via `fez run` like a channel agent. The desktop runs
 * the same engine inside its background worker as the owner (headless.ts);
 * this host is for headless machines and development.
 *
 * Config (env):
 *   FEZ_WORKFLOWS_DIR    definitions directory (default ~/.fez/workflows)
 *   FEZ_WORKFLOWS_STATE  suspended-run state file (default ~/.fez/workflows-state.json)
 *   FEZ_AGENT_OWNER      owner pubkey — the default approver and `from: owner`
 *   FEZ_JUDGE_URL/KEY    router judge for when / judge / wait_until
 */
async function main() {
  const relayUrls = resolveRelays();
  const dir = process.env.FEZ_WORKFLOWS_DIR || path.join(os.homedir(), ".fez", "workflows");
  const owner = process.env.FEZ_AGENT_OWNER;

  const defs = loadDefs(dir);
  if (defs.length === 0) {
    console.error(`No workflow definitions in ${dir} — add a .yaml file (see packages/fez-workflows/README.md)`);
    process.exit(1);
  }
  // Judged conditions (when / judge / wait_until) go through the fez
  // router's judge route with the same key routing uses. Refuse to start
  // a workflow that needs it without it — a `when:` that can never fire
  // would look like a workflow that simply never triggers.
  const judgeConfig = judgeConfigFromEnv(process.env);
  const needJudge = defs.filter(usesJudge).map((d) => d.name);
  if (needJudge.length > 0 && !judgeConfig) {
    console.error(`Workflows ${needJudge.join(", ")} use judged conditions — set FEZ_JUDGE_URL (router base, e.g. https://…/v1) and FEZ_JUDGE_KEY`);
    process.exit(1);
  }
  const ask: Ask | undefined = judgeConfig
    ? (state, questions) => askJudge(judgeConfig.url, judgeConfig.key, state, questions, { timeoutMs: 5000 })
    : undefined;

  const client = new CapabilityClient({ relay: relayUrls, privateKey: loadServiceKey("workflows") });
  // Workflows watch h-tagged channel messages, and a membership-gated
  // relay delivers those only over a NIP-42-authed connection. Without
  // the signer this process connects fine, subscribes fine, and simply
  // never receives anything — a service that looks healthy and does
  // nothing, which is the hardest kind of broken to notice.
  const relay = new RelayConnection({ urls: relayUrls, authSigner: client.authSigner });
  await relay.connect();

  const engine = await startWorkflowEngine({
    nostr: {
      pubkey: client.getPubkey(),
      publish: async (tmpl) => { const event = client.signEvent(tmpl); await relay.publish(event); return event; },
      subscribe: (filters, handler) => relay.subscribe(filters as never, handler),
      query: (filters) => relay.query(filters as never),
      sendDm: async (to, text, depth) => {
        const { toPeer, toSelf } = client.wrapDm(to, text, depth);
        await relay.publish(toPeer);
        await relay.publish(toSelf);
      },
    },
    owner,
    defs,
    ask,
    stateFile: process.env.FEZ_WORKFLOWS_STATE || path.join(os.homedir(), ".fez", "workflows-state.json"),
    channelIds: (spec) => resolveChannels(relay, [spec], relayUrls.join(", ")),
  });
  console.log(`   Relay: ${relayUrls.join(", ")} | Pubkey: ${client.getPubkey()}${owner ? "" : " | ⚠️ FEZ_AGENT_OWNER unset"}`);

  process.on("SIGINT", () => {
    engine.stop();
    relay.disconnect();
    console.log(`\n🔴 fez-workflows stopped.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
