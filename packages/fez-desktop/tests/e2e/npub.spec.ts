import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { decode, npubEncode } from "nostr-tools/nip19";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("both profile surfaces display real npubs and copy the same full identity", async ({ page, context }) => {
  page.setDefaultTimeout(5000);
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const lookalikeSecret = generateSecretKey(), lookalike = getPublicKey(lookalikeSecret);
  const invalidNpub = "npub1invalid";
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(address.port, { owner });
  const connection = new RelayConnection({ url: relay.url });
  const publish = (kind: number, tags: string[][], content: string) =>
    connection.publish(finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, secret));
  try {
    await connection.connect();
    await publish(47102, [["d", "roster"], ["p", owner, "owner"], ["p", lookalike, "bot"]], "");
    await connection.publish(finalizeEvent({ kind: 47000, tags: [], content: JSON.stringify({ name: invalidNpub }), created_at: Math.floor(Date.now() / 1000) }, lookalikeSecret));
    await publish(47101, [["d", "general"]], JSON.stringify({ name: "general" }));
    await publish(47103, [["h", "general"]], "Check this identity");
    await installMockBridge(page, {
      get_pubkey: () => owner, provider_key_present: () => true, list_personas: () => ["fez", "quill"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await expect(page.locator(".boot-splash")).toHaveCount(0);
    await page.locator("button.channel").filter({ hasText: "general" }).first().click();
    await page.locator(".bubble .avatar-btn").click();
    const card = page.locator(".ucard");
    const compact = card.getByRole("button", { name: "Copy npub" });
    await expect(compact).toHaveText(/^npub1.+…/);
    await page.screenshot({ path: "/tmp/fez-npub-card.png", animations: "disabled" });
    await compact.click();
    const npub = await page.evaluate(() => navigator.clipboard.readText());
    expect(decode(npub)).toEqual({ type: "npub", data: owner });
    await expect(compact).toHaveText("✓ copied");
    await page.locator(".menu-backdrop").click({ position: { x: 1, y: 1 } });
    await page.locator(".bubble .author").click();
    const full = page.locator(".pane").getByRole("button", { name: "Copy npub" });
    await expect(full).toHaveText(npub);
    await expect(full).toBeInViewport();
    await page.screenshot({ path: "/tmp/fez-npub-profile.png", animations: "disabled" });
    await full.focus();
    await page.keyboard.press("Enter");
    await expect(full).toHaveText("✓ copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(npub);
    await page.locator(".pane-close").click();
    await page.getByTitle("new direct message", { exact: true }).click();
    await page.locator(".new-dm-input").fill(invalidNpub);
    await expect(page.locator(".new-dm-suggest")).toHaveCount(0);
    await page.locator(".new-dm-input").press("Enter");
    await expect(page.locator(".new-dm-input")).toHaveCount(1);
    await page.locator(".new-dm-input").fill(npub);
    await page.locator(".new-dm-input").press("Enter");
    await expect(page.locator(".new-dm-input")).toHaveCount(0);
    await page.locator("button.channel").filter({ hasText: "general" }).first().click();
    await page.getByTitle("manage — channels, members, join or create a workspace", { exact: true }).click();
    const guest = getPublicKey(generateSecretKey());
    const invite = page.getByPlaceholder("@name, npub, or hex key");
    await invite.fill(invalidNpub);
    await invite.press("Enter");
    await expect(page.getByText("Invalid public key — use a valid npub or hex key", { exact: true })).toBeVisible();
    await invite.fill(npubEncode(guest));
    await invite.press("Enter");
    await expect.poll(async () => (await connection.query([{ kinds: [47102], authors: [owner] }]))
      .some(event => event.tags.some(tag => tag[0] === "p" && tag[1] === guest && tag[2] === "member"))).toBe(true);
    expect((await connection.query([{ kinds: [47102], authors: [owner] }]))
      .some(event => event.tags.some(tag => tag[0] === "p" && tag[1] === lookalike && tag[2] === "bot"))).toBe(true);
    await page.locator(".pane-close").click();
    await page.locator(".composer textarea").fill(`/dm ${invalidNpub}`);
    await page.locator(".composer textarea").press("Enter");
    await expect(page.locator(".composer textarea")).toHaveValue("");
    await expect(page.locator(".topbar .hash")).toHaveText("#");
  } finally {
    connection.disconnect();
    relay.kill();
  }
});
