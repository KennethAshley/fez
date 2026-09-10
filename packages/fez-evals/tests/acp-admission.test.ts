import { afterEach, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { startAcpRuntime, TEST_CHANNEL } from "./helpers/acp-runtime.js";

let runtime: Awaited<ReturnType<typeof startAcpRuntime>> | undefined;
afterEach(async () => { await runtime?.stop(); runtime = undefined; });

test("an owner-attested agent still cannot join through a foreign roster", async () => {
  const r = runtime = await startAcpRuntime();
  const stranger = generateSecretKey();
  const pk = getPublicKey(stranger);
  const threadTags = [["h", TEST_CHANNEL], ["e", "f".repeat(64), "", "root"]];
  await r.send("", [["p", pk]], 47006);
  await r.publish(finalizeEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000) + 1,
    tags: [["d", "roster"], ["p", pk, "bot"]], content: "" }, stranger));
  await r.publish(finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000),
    tags: threadTags, content: "@scope-test FORGED_MEMBER" }, stranger));
  await r.wait(() => r.prompts.length > 0 || r.output.includes("not on the workspace roster"), "foreign roster rejected");
  expect(r.prompts).toHaveLength(0);
  await r.send("@scope-test OWNER_STILL_ALLOWED", threadTags);
  await r.wait(() => r.prompts.length === 1, "owner admitted after forged roster");
  expect(r.prompts[0].instruction).not.toContain("FORGED_MEMBER");
}, 30_000);

test("workspace authority recovers without restart and stays separate from the agent owner", async () => {
  const r = runtime = await startAcpRuntime("steer", { relayInfoAvailable: false });
  expect(r.output).toContain("Workspace owner unavailable");
  await r.send("@scope-test BEFORE_RECOVERY");
  await r.wait(() => r.output.includes("not on the workspace roster"), "unclaimed workspace blocked");
  expect(r.prompts).toHaveLength(0);

  const workspaceKey = generateSecretKey();
  const workspaceOwner = getPublicKey(workspaceKey);
  r.relay.workspace.owner = workspaceOwner;
  await r.wait(() => r.output.includes("Workspace authority recovered"), "relay info recovery");
  await r.send("@scope-test LOCAL_OWNER_IS_NOT_WORKSPACE_OWNER");
  await r.wait(() => (r.output.match(/not on the workspace roster/g) ?? []).length === 2, "foreign roster ignored after recovery");
  expect(r.prompts).toHaveLength(0);

  await r.publish(finalizeEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000),
    tags: [["d", "roster"], ["p", workspaceOwner, "owner"], ["p", r.owner.getPubkey(), "member"], ["p", r.agentPk, "bot"]], content: "" }, workspaceKey));
  await r.send("@scope-test AFTER_REAL_INVITE");
  await r.wait(() => r.prompts.length === 1, "real workspace membership admitted");
  expect(r.prompts[0].instruction).toContain("AFTER_REAL_INVITE");
}, 30_000);

test("a workspace ban stops an otherwise trusted member from triggering the agent", async () => {
  const r = runtime = await startAcpRuntime();
  const member = generateSecretKey();
  const pk = getPublicKey(member);
  await r.send("", [["p", pk]], 47006);
  await r.publish(r.owner.signEvent({ kind: 47102, created_at: Math.floor(Date.now() / 1000) + 1,
    tags: [["d", "roster"], ["p", r.owner.getPubkey(), "owner"], ["p", r.agentPk, "bot"], ["p", pk, "member"]], content: "" }));
  const message = (content: string) => finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000), tags: [["h", TEST_CHANNEL]], content }, member);
  await r.publish(message("@scope-test BEFORE_BAN"));
  await r.wait(() => r.prompts.length === 1, "member admitted before ban");
  r.release(r.prompts[0], "member answered");
  await r.wait(() => r.relay.events.some(event => event.content === "member answered"), "first reply");
  await r.send("", [["d", "bans"], ["p", pk]], 30047);
  await r.publish(message("@scope-test AFTER_BAN"));
  await r.wait(() => r.prompts.length > 1 || r.output.includes("not on the workspace roster"), "ban applied");
  expect(r.prompts).toHaveLength(1);
}, 30_000);
