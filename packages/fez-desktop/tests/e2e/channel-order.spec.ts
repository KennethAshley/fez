import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("a member can reorder channels by drag, keyboard and menu, and keep the order after reload", async ({ page }) => {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const ownerKey = generateSecretKey();
  const memberKey = generateSecretKey();
  const owner = getPublicKey(ownerKey);
  const relay = await spawnRelay(address.port, { owner });
  const connection = new RelayConnection({ url: relay.url });
  await connection.connect();
  const publish = (kind: number, tags: string[][], content: string) =>
    connection.publish(finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, ownerKey));
  try {
    await publish(47102, [["d", "roster"], ["p", owner, "owner"], ["p", getPublicKey(memberKey), "member"]], "");
    for (const name of ["alpha", "bravo", "charlie"]) {
      await publish(47101, [["d", name]], JSON.stringify({ name }));
    }
    for (const name of ["repo-one", "repo-two"]) {
      await publish(47101, [["d", name]], JSON.stringify({ name, source: "fixture" }));
    }
    await installMockBridge(page, {
      provider_key_present: () => true, list_personas: () => ["fez"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
      "plugin:event|listen": () => 1, "plugin:event|unlisten": () => null, read_skills: () => "{}",
      list_gui_extensions: () => [["browser", `var __fezExt = { default: function(api) {
        api.registerSettingsPanel('Fixture', () => null, { source: 'fixture' });
      } };`, ""]],
      read_extension_grants: () => JSON.stringify({ browser: ["ui"] }),
    }, { identities: { default: Buffer.from(memberKey).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await page.goto("/");
    const rows = page.locator(".community button.channel").filter({ hasText: /# (alpha|bravo|charlie|delta)/ });
    await expect(rows).toHaveCount(3);
    const initial = await rows.allTextContents();
    const first = rows.filter({ hasText: initial[0].trim() });
    const last = rows.filter({ hasText: initial[2].trim() });
    await expect(last).toHaveAttribute("draggable", "true");
    await last.dragTo(first, { targetPosition: { x: 30, y: 2 } });
    await expect(rows).toHaveText([initial[2], initial[0], initial[1]]);
    await last.focus();
    await last.press("Alt+Shift+ArrowDown");
    await expect(rows).toHaveText([initial[0], initial[2], initial[1]]);
    await expect(last).toBeFocused();
    await last.click({ button: "right" });
    await page.getByRole("button", { name: "move down", exact: true }).click();
    await expect(rows).toHaveText(initial);
    await last.click({ button: "right" });
    await expect(page.getByRole("button", { name: "move down", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "move up", exact: true }).click();
    const saved = [initial[0], initial[2], initial[1]];
    await expect(rows).toHaveText(saved);
    await page.reload();
    await expect(rows).toHaveText(saved);
    await publish(47101, [["d", "delta"]], JSON.stringify({ name: "delta" }));
    await expect(rows).toHaveText([...saved, "# delta"]);

    const bridged = page.locator(".community button.channel").filter({ hasText: /# repo-/ });
    await expect(bridged).toHaveCount(2);
    const bridgeOrder = await bridged.allTextContents();
    await bridged.nth(1).dragTo(bridged.first(), { targetPosition: { x: 30, y: 2 } });
    await expect(bridged).toHaveText([...bridgeOrder].reverse());
    // Group boundaries are preserved for both drag and keyboard movement.
    await bridged.first().dragTo(rows.first(), { targetPosition: { x: 30, y: 2 } });
    await bridged.first().press("Alt+Shift+ArrowUp");
    await expect(bridged).toHaveText([...bridgeOrder].reverse());
    await expect(rows).toHaveText([...saved, "# delta"]);
    await page.reload();
    await expect(bridged).toHaveText([...bridgeOrder].reverse());
    await expect(rows).toHaveText([...saved, "# delta"]);

    await rows.first().click();
    const channelName = (text: string) => text.trim().replace(/^#\s*/, "");
    for (const text of saved.slice(1)) await publish(47103, [["h", channelName(text)]], `Unread in ${text}`);
    await expect(rows.nth(1).locator(".badge")).toBeVisible();
    await expect(rows.nth(2).locator(".badge")).toBeVisible();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(rows.nth(1)).toHaveClass(/active/);
    await rows.nth(2).click({ button: "right" });
    await page.getByRole("button", { name: "⊘ hide (just me)", exact: true }).click();
    await expect(rows).toHaveCount(3);
    await rows.first().click();
    await publish(47103, [["h", "delta"]], "Unread in delta");
    await expect(rows.last().locator(".badge")).toBeVisible();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(rows.last()).toHaveClass(/active/);
    await page.getByRole("button", { name: /1 hidden/ }).click();
    await page.getByTitle("unhide", { exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(2)).toContainText(saved[2].trim());
    // Reordering is a personal preference: channel definitions remain owner-signed and unchanged.
    const events = await connection.query([{ kinds: [47101] }]);
    expect(events).toHaveLength(6);
    expect(events.every(event => event.pubkey === owner)).toBe(true);
  } finally { connection.disconnect(); relay.kill(); }
});
