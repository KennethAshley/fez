import { afterEach, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { startAcpRuntime, TEST_CHANNEL } from "./helpers/acp-runtime.js";

let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });

it("refuses a new relay-advertised owner after restart instead of accepting its roster", async () => {
  const r = runtime = await startAcpRuntime();
  const replacementKey = generateSecretKey(), replacement = getPublicKey(replacementKey);
  await r.restart(async () => {
    r.relay.workspace.owner = replacement;
    r.relay.events.push(finalizeEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000) + 1,
      tags: [["d", "roster"], ["p", r.owner.getPubkey(), "member"], ["p", r.agentPk, "bot"]], content: "" }, replacementKey));
  });
  await r.send("@scope-test MUST_NOT_RUN_UNDER_REPLACEMENT_AUTHORITY", [["h", TEST_CHANNEL]]);
  await r.wait(() => r.prompts.length > 0 || r.output.includes("not on the workspace roster"), "replacement authority decision");
  expect(r.prompts).toHaveLength(0);
}, 45_000);
