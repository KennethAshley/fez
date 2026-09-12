import { afterEach, expect, test } from "vitest";
import { startAcpRuntime, TEST_CHANNEL } from "./helpers/acp-runtime.js";

let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });
const manual = { id: "i-have-adhd", setting: "lite", content: "---\nname: i-have-adhd\ndescription: PRIVATE_MANUAL_DESCRIPTION\ndisable-model-invocation: true\n---\nMANUAL_SKILL_INSTRUCTIONS. Read references/focus.md.\n" };

test("channel owner slash activation loads the selected skill with its setting and base path", async () => {
  const r = runtime = await startAcpRuntime("queue", { skills: [manual] });
  await r.send("@scope-test /i-have-adhd help me start");
  await r.wait(() => r.prompts.length === 1, "manual channel skill");
  expect(r.prompts[0].instruction).toContain("MANUAL_SKILL_INSTRUCTIONS");
  expect(r.prompts[0].instruction).toContain("/test-skills/skills/i-have-adhd");
  expect(r.prompts[0].instruction).toContain("[Attached setting: lite]");
  r.release(r.prompts[0]);
}, 30_000);

test("an owner's current DM activates a manual skill, while history and unrelated input do not", async () => {
  const r = runtime = await startAcpRuntime("queue", { skills: [manual] });
  await r.send("Earlier we discussed /i-have-adhd", [["h", TEST_CHANNEL]]);
  await r.send("@scope-test ordinary task");
  await r.wait(() => r.prompts.length === 1, "ordinary channel turn");
  expect(r.prompts[0].instruction).not.toContain("MANUAL_SKILL_INSTRUCTIONS");
  expect(r.prompts[0].instruction).not.toContain("PRIVATE_MANUAL_DESCRIPTION");
  r.release(r.prompts[0]);
  await r.wait(() => r.relay.events.some(event => event.content === "fixture reply"), "ordinary reply");
  const { toPeer } = r.owner.wrapDm(r.agentPk, "/skill i-have-adhd focus please");
  await r.publish(toPeer);
  await r.wait(() => r.prompts.length === 2, "manual DM skill");
  expect(r.prompts[1].instruction).toContain("MANUAL_SKILL_INSTRUCTIONS");
  expect(r.prompts[1].instruction).toContain("[Attached setting: lite]");
  r.release(r.prompts[1]);
}, 30_000);
