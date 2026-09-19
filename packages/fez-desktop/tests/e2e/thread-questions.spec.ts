import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44, nip59 } from "nostr-tools";
import { RelayConnection, CapabilityClient, requestInput, type InputOrigin } from "../../../../dist/index.js";
import { inputForm } from "../../../fez-client/dist/agent-input.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

for (const kind of ["channel", "dm"] as const) test(`${kind}: questions open in their conversation, survive reload, and leave a private receipt`, async ({ page }) => {
  test.setTimeout(90_000);
  const ownerSecret = generateSecretKey(), agentSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret), agentPk = getPublicKey(agentSecret), peer = getPublicKey(generateSecretKey());
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(port, { owner });
  const connection = new RelayConnection({ urls: [relay.url] });
  const agent = new CapabilityClient({ relay: relay.url, privateKey: Buffer.from(agentSecret).toString("hex") });
  const human = new CapabilityClient({ relay: relay.url, privateKey: Buffer.from(ownerSecret).toString("hex") });
  const abort = new AbortController();
  try {
    await connection.connect();
    await connection.publish(human.signEvent({ kind: 47102, tags: [["d", "roster"], ["p", owner, "owner"], ["p", agentPk, "bot"], ["p", peer, "member"]], content: "" }));
    await connection.publish(human.signEvent({ kind: 47101, tags: [["d", "general"]], content: JSON.stringify({ name: "general" }) }));
    await connection.publish(agent.signEvent({ kind: 47000, tags: [], content: JSON.stringify({ name: "quill" }) }));
    const root = human.signEvent({ kind: 47103, tags: [["h", "general"]], content: "Original design discussion", created_at: Math.floor(Date.now() / 1000) - 3600 });
    await connection.publish(root);
    const dm = human.wrapGroupDm([agentPk, peer], "Private design discussion");
    for (const wrap of dm.wraps) await connection.publish(wrap);
    const origin: InputOrigin = kind === "channel"
      ? { kind, channelId: "general", rootId: root.id, messageId: root.id }
      : { kind, participants: [owner, agentPk, peer], messageId: dm.id };
    await installMockBridge(page, {
      get_pubkey: () => owner, provider_key_present: () => true, list_personas: () => ["fez", "quill"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(ownerSecret).toString("hex") } });
    await page.exposeFunction("inputCrypto", (cmd: string, args: { peer: string; plaintext: string; ciphertext: string; event: string }) => {
      if (cmd === "dm_unwrap") return JSON.stringify(nip59.unwrapEvent(JSON.parse(args.event), ownerSecret));
      const key = nip44.getConversationKey(ownerSecret, args.peer);
      return cmd === "nip44_encrypt" ? nip44.encrypt(args.plaintext, key) : nip44.decrypt(args.ciphertext, key);
    });
    await page.addInitScript(({ relayUrl }) => {
      localStorage.setItem("fez-relay", relayUrl);
      localStorage.setItem("fez-notify", JSON.stringify({ enabled: true, whileFocused: true, sound: false }));
      Object.defineProperty(window, "Notification", { value: class { static permission = "granted"; } });
      const w = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        inputCrypto: (cmd: string, args: unknown) => Promise<unknown>;
        questionBanners: { args: unknown; click: () => void }[];
      };
      w.questionBanners = [];
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "notify_with_click") return new Promise(resolve => w.questionBanners.push({ args, click: () => resolve(true) }));
        return ["nip44_encrypt", "nip44_decrypt", "dm_unwrap"].includes(cmd) ? w.inputCrypto(cmd, args) : original(cmd, args);
      };
    }, { relayUrl: relay.url });
    await page.goto("/");
    await expect(page.locator(".shell")).toBeVisible();
    // Questions live in the home inbox now: the rail badge counts them and the
    // inbox view lists each one as a blocked loop.
    const inbox = page.locator(".home-link", { hasText: "inbox" });
    const inboxBadge = inbox.locator(".badge");
    const openInbox = async () => { await inbox.click(); await expect(page.locator(".loops-band")).toBeVisible(); };
    const pending = requestInput({
      pubkey: agentPk,
      publish: async template => { const event = agent.signEvent(template); await connection.publish(event); return event; },
      subscribe: (filters, receive) => connection.subscribe(filters, receive),
      encrypt: (peer, text) => agent.encryptTo(peer, text), decrypt: (peer, text) => agent.decryptFrom(peer, text),
    }, owner, inputForm({ mode: "form", message: "Choose the private layout", requestedSchema: { properties: {
      layout: { type: "string", title: "Layout", enum: ["Grid", "List"] },
      custom: { type: "string", title: "Details" },
    }, required: ["layout"] } }), { origin, signal: abort.signal, timeoutMs: 80_000 });
    await expect(inboxBadge).toHaveText("1");
    await expect(page.locator(".agent-input")).toBeHidden();
    if (kind === "dm") await expect(page.locator("main .timeline")).not.toContainText("Waiting for your answer");
    await expect.poll(() => page.evaluate(() => (window as unknown as { questionBanners: unknown[] }).questionBanners.length)).toBe(1);
    const banner = await page.evaluate(() => {
      const banner = (window as unknown as { questionBanners: { args: unknown; click: () => void }[] }).questionBanners[0];
      banner.click(); return banner.args;
    });
    expect(banner).toEqual({ title: "quill needs your input", body: "Open Fez to answer privately." });
    const inline = page.locator("main .timeline .conversation-question");
    await expect(inline.getByRole("region", { name: "Questions from quill" })).toBeVisible();
    await expect(inline.getByText("Waiting for your answer")).toBeVisible();
    await expect(page.locator("main .timeline").getByText("Waiting for your answer", { exact: true })).toHaveCount(1);
    await expect(page.getByText(kind === "channel" ? "Original design discussion" : "Private design discussion", { exact: true })).toBeVisible();
    await inline.getByRole("radio", { name: "Grid", exact: true }).check();
    await inline.getByRole("button", { name: "Next", exact: true }).click();
    await inline.getByRole("textbox", { name: "Details", exact: true }).fill("Compact spacing");
    if (kind === "channel") {
      await page.getByRole("button", { name: "← back to channel" }).click();
      await expect(inline).toHaveCount(0);
      await page.locator(".root-live .input-thread-link").click();
      await expect(inline).toBeVisible();
      // Put the origin outside the latest-50 window before restarting the client.
      for (let i = 0; i < 60; i++) await connection.publish(human.signEvent({ kind: 47103, tags: [["h", "general"]], content: `Another topic ${i}` }));
    }
    await page.reload();
    await expect(page.locator(".shell")).toBeVisible();
    await openInbox();
    await page.getByRole("button", { name: "Answer question →" }).click();
    await expect(inline).toBeVisible();
    await expect(page.getByText(kind === "channel" ? "Original design discussion" : "Private design discussion", { exact: true })).toBeVisible();
    await expect(inline.getByRole("textbox", { name: "Details", exact: true })).toHaveValue("Compact spacing");
    await expect(inline.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await inline.getByRole("button", { name: "Back", exact: true }).click();
    const grid = inline.getByRole("radio", { name: "Grid", exact: true });
    await expect(grid).toBeChecked();
    await grid.focus();
    await page.keyboard.press("ArrowRight");
    await expect(inline.getByRole("radio", { name: "List", exact: true })).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(grid).toBeChecked();
    await page.screenshot({ path: `/tmp/fez-question-${kind}.png` });
    await inline.screenshot({ path: `/tmp/fez-question-card-${kind}.png` });
    await inline.getByRole("button", { name: "Next", exact: true }).click();
    await inline.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pending).resolves.toEqual({ action: "accept", content: { layout: "Grid", custom: "Compact spacing" } });
    await expect(inline.getByText("Received by agent")).toBeVisible();
    await page.reload();
    await expect(page.locator(".shell")).toBeVisible();
    await expect(inboxBadge).toHaveCount(0);
    await inbox.click();
    await page.getByRole("button", { name: "Question history", exact: true }).click();
    await page.locator(".agent-input .input-thread-link").click();
    await expect(inline.getByText("Received by agent")).toBeVisible();
    await inline.locator("summary").click();
    await expect(inline.getByText("Grid", { exact: true })).toBeVisible();
  } finally {
    abort.abort(); connection.disconnect(); agent.disconnect(); human.disconnect(); relay.kill();
  }
});
