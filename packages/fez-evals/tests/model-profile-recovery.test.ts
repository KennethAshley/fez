import { afterEach, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startAcpRuntime, TEST_CHANNEL } from "./helpers/acp-runtime.js";
let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });

it.each(["channel", "document", "dm"])("reports a disconnected identity model without replaying the %s task", async surface => {
  const provider = "ext-fixture-provider-mini", model = "test-model";
  const r = runtime = await startAcpRuntime("queue", { harness: "pi",
    frontmatter: `provider: ${provider}\nmodel: ${model}\nmodelProfile: ${provider}`,
    prepareHome: async home => {
      const directory = join(home, ".fez/model-profiles", provider, "scope-test");
      await mkdir(directory, { recursive: true });
      for (const [file, value] of Object.entries({
        "profile.json": { provider, model, persona: "scope-test" },
        "settings.json": { defaultProvider: provider, defaultModel: model, retry: { enabled: false } },
        "models.json": { providers: { [provider]: { apiKey: "test-token", models: [{ id: model }] } } },
      })) await writeFile(join(directory, file), JSON.stringify(value));
    },
  });
  if (surface === "dm") await r.publish(r.owner.wrapDm(r.agentPk, "ONE request on the shared model").toPeer);
  else await r.send("ONE request on the shared model", [["h", TEST_CHANNEL], ["p", r.agentPk],
    ...(surface === "document" ? [["d", "model-spec"], ["anchor", "first"]] : [])], surface === "document" ? 40101 : 47103);
  await r.wait(() => r.prompts.length === 1, "one model attempt");
  r.release(r.prompts[0], "", "ECONNRESET: connection reset by peer");
  const notices = () => surface === "dm" ? r.relay.events.flatMap(event => {
    const dm = r.owner.unwrapDm(event); return dm?.senderPk === r.agentPk ? [dm.text] : [];
  }) : r.relay.events.filter(e => e.pubkey === r.agentPk && e.kind === (surface === "document" ? 40101 : 47103)).map(e => e.content);
  await r.wait(() => r.prompts.length > 1 || notices().some(text => text.includes("connection reset")), "failure notice or unexpected replay");
  expect(r.prompts).toHaveLength(1);
  expect(notices().some(text => text.includes("connection reset"))).toBe(true);
}, 30000);
