import { test, expect, type Page } from "@playwright/test";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

async function workspace(name: string, ownerKey = generateSecretKey()) {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const owner = getPublicKey(ownerKey);
  const relay = await spawnRelay(address.port, { owner, name });
  const connection = new RelayConnection({ url: relay.url });
  await connection.connect();
  const publish = (kind: number, tags: string[][], content: string) =>
    connection.publish(finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, ownerKey));
  await publish(47102, [["d", "roster"], ["p", owner, "owner"]], "");
  await publish(47101, [["d", name]], JSON.stringify({ name }));
  return { ...relay, name, owner, ownerKey, connection, publish,
    close: () => { connection.disconnect(); relay.kill(); } };
}

async function boot(page: Page, home: Awaited<ReturnType<typeof workspace>>, agentKey: Uint8Array, saved = true) {
  page.setDefaultTimeout(5000);
  await installMockBridge(page, {
    provider_key_present: () => true, list_personas: () => ["fez", "quill", "drift"],
    ensure_local_relay: () => home.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
    read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    write_relays: () => null,
  }, { identities: { default: Buffer.from(home.ownerKey).toString("hex"), "agent:drift": Buffer.from(agentKey).toString("hex") } });
  if (saved) await page.addInitScript(url => {
    if (!localStorage.getItem("fez-relay")) localStorage.setItem("fez-relay", url);
  }, home.url);
  await page.goto("/");
  await page.locator("button.channel").filter({ hasText: home.name }).first().click();
  await page.getByTitle("manage — channels, members, join or create a workspace", { exact: true }).click();
}

test("fresh boot provisions its own workspace when the default port belongs to someone else", async ({ page }) => {
  const home = await workspace("my-workspace");
  try {
    await page.route("http://127.0.0.1:7777/**", route => route.fulfill({
      contentType: "application/nostr+json",
      body: JSON.stringify({ name: "foreign", pubkey: getPublicKey(generateSecretKey()) }),
    }));
    await page.routeWebSocket("ws://127.0.0.1:7777", socket => socket.close());
    await boot(page, home, generateSecretKey(), false);
    await expect(page.getByPlaceholder("channel name", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("fez-relay"))).toBe(home.url);
  } finally { home.close(); }
});

test("channel creation retries safely and invites a person plus a local agent", async ({ page }) => {
  const home = await workspace("general");
  const agentKey = generateSecretKey();
  try {
    await boot(page, home, agentKey);
    const name = page.getByPlaceholder("channel name", { exact: true });
    // Fail one native signing request: the app must keep the form for retry.
    await page.evaluate(() => {
      const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: { kind?: number }) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      let failed = false;
      bridge.invoke = (cmd, args) => {
        if (!failed && cmd === "sign_event" && args?.kind === 47101) {
          failed = true;
          return Promise.reject(new Error("test signing failure"));
        }
        return invoke(cmd, args);
      };
    });
    await name.fill("planning");
    await name.press("Enter");
    await expect(page.getByText("test signing failure", { exact: true })).toBeVisible();
    await expect(name).toHaveValue("planning");
    await name.press("Enter");
    await expect(page.locator("button.channel").filter({ hasText: "planning" })).toHaveCount(1);
    await expect(name).toHaveValue("");
    await expect(page.getByPlaceholder("workspace name", { exact: true })).toHaveCount(0);

    const person = getPublicKey(generateSecretKey());
    const invite = page.getByPlaceholder("@name, npub, or hex key");
    await invite.fill(npubEncode(person));
    await invite.press("Enter");
    await expect(invite).toHaveValue("");
    await page.locator(".manage-select").selectOption("bot");
    await invite.fill("@drift");
    await invite.press("Enter");
    await expect(invite).toHaveValue("");
    const members = async () => {
      const events = await home.connection.query([{ kinds: [47102], authors: [home.owner] }]);
      return events.sort((a, b) => b.created_at - a.created_at)[0].tags.filter(t => t[0] === "p");
    };
    await expect.poll(members).toEqual(expect.arrayContaining([
      ["p", home.owner, "owner"], ["p", person, "member"], ["p", getPublicKey(agentKey), "bot"],
    ]));
    await page.reload();
    await expect(page.locator("button.channel").filter({ hasText: "planning" })).toHaveCount(1);
  } finally { home.close(); }
});

test("joining an invite code connects to the invited workspace and survives reload", async ({ page }) => {
  const home = await workspace("original");
  const destination = await workspace("destination", home.ownerKey);
  try {
    await boot(page, home, generateSecretKey());
    const join = page.getByPlaceholder("fez-join:wss://…#…");
    await page.evaluate(() => {
      const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      let failed = false;
      bridge.invoke = (cmd, args) => {
        if (!failed && cmd === "write_relays") {
          failed = true;
          return Promise.reject(new Error("test settings save failure"));
        }
        return invoke(cmd, args);
      };
    });
    await join.fill(`fez-join:${destination.url}`);
    await join.press("Enter");
    await expect(page.getByText(/test settings save failure/)).toBeVisible();
    await expect(join).toHaveValue(`fez-join:${destination.url}`);
    expect(await page.evaluate(() => localStorage.getItem("fez-relay"))).toBe(home.url);
    await expect(page.locator("button.channel").filter({ hasText: "original" })).toBeVisible();
    await join.press("Enter");
    await expect(page.locator("button.channel").filter({ hasText: "destination" })).toBeVisible();
    await expect(page.locator("button.channel").filter({ hasText: "original" })).toHaveCount(0);
    await page.reload();
    await expect(page.locator("button.channel").filter({ hasText: "destination" })).toBeVisible();
  } finally { home.close(); destination.close(); }
});
