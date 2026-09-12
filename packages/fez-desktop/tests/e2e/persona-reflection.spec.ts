import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "../../../../src/protocol/relay";
import { parseFrontmatter } from "../../../../src/identity/personas";
import { reflectionConfig } from "../../../fez-client/src/reflection";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("reflection is editable from an agent profile and saves without interrupting the agent", async ({ page }) => {
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const agentSecret = generateSecretKey(), agent = getPublicKey(agentSecret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(address.port, { owner });
  const connection = new RelayConnection({ url: relay.url });
  const publish = (kind: number, tags: string[][], content: string, key = secret) =>
    connection.publish(finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, key));
  try {
    await connection.connect();
    await publish(47102, [["d", "roster"], ["p", owner, "owner"], ["p", agent, "bot"]], "");
    await publish(47000, [], JSON.stringify({ name: "scout", about: "Keeps documentation current." }), agentSecret);
    await publish(47101, [["d", "general"]], JSON.stringify({ name: "general" }));
    await publish(47103, [["h", "general"]], "Ready to help", agentSecret);
    const bridge = await installMockBridge(page, {
      provider_key_present: () => true, list_personas: () => ["fez", "scout"],
      read_persona: () => "---\nharness: pi\nmodel: keep-model\nrespondTo: owner\n---\nKeep these instructions.\n",
      update_persona: () => null, agent_alive: () => true,
      "plugin:event|listen": () => 1, "plugin:event|unlisten": () => null,
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(secret).toString("hex"), "agent:scout": Buffer.from(agentSecret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await page.routeWebSocket("wss://bazaar.fez.chat/**", ws => {
      ws.onMessage(message => {
        const [kind, id] = JSON.parse(String(message));
        if (kind === "REQ") ws.send(JSON.stringify(["EOSE", id]));
      });
    });
    await page.goto("/");
    await page.locator("button.channel").filter({ hasText: "general" }).first().click();
    await page.locator(".bubble .avatar-btn").click();
    await page.locator(".ucard .ucard-name").click();
    await page.getByRole("button", { name: "edit persona" }).click();
    const section = page.getByRole("region", { name: "reflection", exact: true });
    await expect(section.getByRole("switch", { name: "Periodic reflection" })).not.toBeChecked();
    await section.getByRole("switch", { name: "Periodic reflection" }).click();
    await section.getByLabel("Check every").fill("59s");
    await expect(page.getByRole("button", { name: "save", exact: true })).toBeDisabled();
    await expect(section.getByRole("alert")).toBeVisible();
    await section.getByLabel("Check every").fill("45m");
    await section.getByLabel("Reflection instructions").fill("Review unfinished documentation.\nMake one useful correction.");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/fez-reflection-editor.png", animations: "disabled" });
    const callsBeforeSave = bridge.calls.length;
    await page.getByRole("button", { name: "save", exact: true }).click();
    await expect.poll(() => bridge.calls.filter(call => call.cmd === "update_persona").length).toBe(1);
    const saved = bridge.calls.find(call => call.cmd === "update_persona")!.args as { name: string; content: string };
    expect(saved.name).toBe("scout");
    expect(reflectionConfig(parseFrontmatter(saved.content).extra)).toEqual({ everyMs: 2_700_000, prompt: "Review unfinished documentation. Make one useful correction." });
    expect(saved.content).toContain("Keep these instructions.");
    expect(bridge.calls.slice(callsBeforeSave).some(call => /^(kill_agent|spawn_agent|start_managed_agent)$/.test(call.cmd))).toBe(false);
    await expect(page.getByText(/saved — restart from its profile/)).toBeVisible();
  } finally {
    connection.disconnect();
    relay.kill();
  }
});
