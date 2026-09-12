import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip59 } from "nostr-tools";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";
import { installCustomPanelBridge } from "./helpers/custom-panels";

test("agent profiles open from DM and channel surfaces and launch isolated Wallet stake", async ({ page }) => {
  test.setTimeout(60_000);
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
  const gui = await readFile(new URL("../../../fez-wallet/dist/gui.js", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../../../fez-wallet/package.json", import.meta.url), "utf8"));
  const grants = ["ui", "read:channels", "read:agents", "processes"];
  const walletCalls: Record<string, unknown>[] = [];
  try {
    await connection.connect();
    await publish(47102, [["d", "roster"], ["p", owner, "owner"], ["p", agent, "bot"]], "");
    await publish(47000, [], JSON.stringify({ name: "steph", about: "The greatest basketball shooter of all time.", skills: ["web"] }), agentSecret);
    await publish(47101, [["d", "general"]], JSON.stringify({ name: "general" }));
    await publish(47103, [["h", "general"]], "Ready to help", agentSecret);
    await publish(47008, [["d", agent], ["p", agent]], "A careful teammate");
    await installMockBridge(page, {
      provider_key_present: () => true, list_personas: () => ["fez", "steph"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
      list_gui_extensions: () => [["wallet", gui, "", null, manifest.fez.guiRuntime, manifest.fez.guiContributions]],
      read_extension_grants: () => JSON.stringify({ wallet: grants }), extension_storage_read: () => "{}",
    }, { identities: { default: Buffer.from(secret).toString("hex"), "agent:steph": Buffer.from(agentSecret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await page.exposeFunction("walletProfileStatus", (args: Record<string, unknown>) => {
      walletCalls.push(args);
      if (args.extension !== "wallet" || args.bin !== "fez-wallet" || JSON.stringify(args.args) !== JSON.stringify(["status", "steph", "--json"])) throw Error("Unexpected Wallet action");
      return { code: 0, stdout: JSON.stringify({ persona: "steph", address: "fixture-public-address", network: "test", netuid: 551, uid: 7, staked: "2.5" }), stderr: "" };
    });
    await page.addInitScript(() => {
      const internal = Reflect.get(window, "__TAURI_INTERNALS__") as { invoke(command: string, args: unknown): Promise<unknown> };
      const original = internal.invoke;
      internal.invoke = (command, args) => command === "run_extension_bin" ? Reflect.get(window, "walletProfileStatus")(args) : original(command, args);
    });
    const startPanels = await installCustomPanelBridge(page, { wallet: { code: gui, grants } });
    // The public commons is empty in this test; workspace evidence is real.
    await page.routeWebSocket("wss://bazaar.fez.chat/**", ws => {
      ws.onMessage(message => {
        const [kind, id] = JSON.parse(String(message));
        if (kind === "REQ") ws.send(JSON.stringify(["EOSE", id]));
      });
    });
    await page.goto("/");
    await expect(page.locator(".shell")).toBeVisible();
    await startPanels();
    await page.locator("button.channel").filter({ hasText: "general" }).first().click();
    const profile = page.locator(".pane");
    const expectProfile = async () => {
      await expect(profile.locator(".portrait-name")).toHaveText("steph");
      await expect(profile.getByRole("region", { name: "Vouched by" })).toContainText("A careful teammate");
      await expect(profile.getByRole("region", { name: "Chits" })).toContainText("No accepted-work chits found");
      await expect(profile.getByRole("button", { name: "edit persona" })).toBeVisible();
    };

    // Cross the actual gap with the mouse: teleporting straight to click
    // misses popovers that disappear between their trigger and their card.
    const hoverProfile = async () => {
      const row = page.locator(".community button.channel").filter({ hasText: "steph" });
      await row.getByRole("img", { name: "steph", exact: true }).hover();
      const card = page.locator("button.hovercard");
      await expect(card).toBeVisible();
      await page.waitForTimeout(350); // avatar quip's 250ms delay
      await expect(page.locator(".quip-bubble")).toHaveCount(0);
      const trigger = await row.boundingBox(), target = await card.boundingBox();
      if (!trigger || !target) throw Error("missing hover geometry");
      await page.mouse.move(trigger.x + 24, trigger.y + trigger.height / 2);
      await page.mouse.move(target.x + 24, target.y + target.height / 2, { steps: 20 });
      await expect(card).toBeVisible();
      await card.click();
      await expectProfile();
      await expect(page.locator(".topbar .hash")).toHaveText("#");
      await profile.locator(".pane-close").click();
    };
    await hoverProfile(); // agent offered in the rail, before any DM exists

    await page.locator(".bubble .avatar-btn").click();
    await page.locator(".ucard .ucard-name").click();
    await expect(page.locator(".ucard")).toHaveCount(0);
    await expectProfile();
    await profile.locator(".pane-close").click();

    // A genuine encrypted incoming DM adds the other sidebar row variant.
    const wrap = nip59.wrapEvent({ kind: 14, tags: [["p", owner]], content: "Hello from steph", created_at: Math.floor(Date.now() / 1000) }, agentSecret, owner);
    await page.exposeFunction("profileUnwrap", (event: string) => JSON.stringify(nip59.unwrapEvent(JSON.parse(event), secret)));
    await page.evaluate(() => {
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: { event: string }) => Promise<unknown> }; profileUnwrap: (event: string) => Promise<string> };
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "dm_unwrap" ? w.profileUnwrap(args.event) : original(cmd, args);
    });
    await connection.publish(wrap);
    await expect(page.locator(".community button.channel.cast").filter({ hasText: "steph" })).toHaveCount(0);
    await hoverProfile();
    await page.locator(".community button.channel").filter({ hasText: "steph" }).click();
    await expect(page.locator(".timeline")).toContainText("Hello from steph");
    await page.locator(".dm-profile-trigger").getByRole("img", { name: "steph", exact: true }).click();
    await expectProfile();
    await page.screenshot({ path: "/tmp/fez-profile-navigation.png", animations: "disabled" });
    await profile.locator(".pane-close").click();
    await page.locator(".dm-profile-trigger").focus();
    await page.keyboard.press("Enter");
    await expectProfile();
    // Profile details stay host-owned; custom code starts only after opening Stake.
    expect(walletCalls).toEqual([]);
    await expect(page.locator('iframe[data-custom-kind="profile"]')).toHaveCount(0);
    await profile.getByRole("button", { name: "Stake", exact: true }).click();
    const stake = page.frameLocator('iframe[data-custom-kind="profile"]');
    await expect(stake.getByText("2.5 tα self stake", { exact: true })).toBeVisible();
    await expect(stake.getByText("Testnet · test funds · subnet 551 · uid 7", { exact: true })).toBeVisible();
    await expect(page.getByText("2.5 tα self stake", { exact: true })).toHaveCount(0);
    expect(walletCalls).toEqual([{ extension: "wallet", bin: "fez-wallet", args: ["status", "steph", "--json"] }]);
    const probe = await page.evaluate(() => Reflect.get(window, "customPanelProbe"));
    expect(probe.openings).toHaveLength(1);
    expect(probe.openings[0].custom).toEqual({ kind: "profile", index: 0, pubkey: agent, persona: "steph" });
    await page.locator(".extension-pane .pane-close").click();
    await expect(page.locator('iframe[data-custom-kind="profile"]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "customPanelProbe").closed.length)).toBe(1);
  } finally {
    connection.disconnect();
    relay.kill();
  }
});
