import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";
import { RelayConnection, CapabilityClient, requestInput } from "../../../../dist/index.js";
import { inputForm } from "../../../fez-client/dist/agent-input.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("answers several agent questions privately and restores a waiting form after reload", async ({ page }) => {
  test.setTimeout(60_000);
  const ownerSecret = generateSecretKey(), agentSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret), agentPk = getPublicKey(agentSecret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(port, { owner });
  const connection = new RelayConnection({ urls: [relay.url] });
  const agent = new CapabilityClient({ relay: relay.url, privateKey: Buffer.from(agentSecret).toString("hex") });
  const human = new CapabilityClient({ relay: relay.url, privateKey: Buffer.from(ownerSecret).toString("hex") });
  const abort = new AbortController();
  const notifications: { title: string; body: string }[] = [];
  try {
    await connection.connect();
    await connection.publish(human.signEvent({ kind: 47102, tags: [["d", "roster"], ["p", owner, "owner"], ["p", agentPk, "bot"]], content: "" }));
    await connection.publish(human.signEvent({ kind: 47101, tags: [["d", "general"]], content: JSON.stringify({ name: "general" }) }));
    await connection.publish(agent.signEvent({ kind: 47000, tags: [], content: JSON.stringify({ name: "quill" }) }));
    await installMockBridge(page, {
      get_pubkey: () => owner, provider_key_present: () => true, list_personas: () => ["fez", "quill"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(ownerSecret).toString("hex") } });
    await page.exposeFunction("inputCrypto", (cmd: string, args: { peer: string; plaintext: string; ciphertext: string }) => {
      const key = nip44.getConversationKey(ownerSecret, args.peer);
      return cmd === "nip44_encrypt" ? nip44.encrypt(args.plaintext, key) : nip44.decrypt(args.ciphertext, key);
    });
    await page.exposeFunction("recordInputNotification", (title: string, body: string) => notifications.push({ title, body }));
    await page.addInitScript(({ relayUrl }) => {
      localStorage.setItem("fez-relay", relayUrl);
      localStorage.setItem("fez-notify", JSON.stringify({ enabled: true, whileFocused: true, sound: false }));
      Object.defineProperty(window, "Notification", { value: class {
        static permission = "granted";
        constructor(title: string, options: { body: string }) {
          void (window as unknown as { recordInputNotification: (title: string, body: string) => Promise<void> }).recordInputNotification(title, options.body);
        }
      } });
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }; inputCrypto: (cmd: string, args: unknown) => Promise<unknown> };
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "nip44_encrypt" || cmd === "nip44_decrypt" ? w.inputCrypto(cmd, args) : original(cmd, args);
    }, { relayUrl: relay.url });
    await page.goto("/");
    await expect(page.locator(".shell")).toBeVisible();
    const form = inputForm({ mode: "form", message: "Choose the layout and features", requestedSchema: { properties: {
      layout: { type: "string", title: "Layout", oneOf: [{ const: "grid", title: "Grid", description: "Cards in columns" }, { const: "list", title: "List" }] },
      features: { type: "array", title: "Features", items: { anyOf: [{ const: "search", title: "Search" }, { const: "filters", title: "Filters" }] } },
      count: { type: "integer", title: "Count" },
      custom: { type: "string", title: "Other" },
    }, required: ["layout"] } });
    const pending = requestInput({
      pubkey: agentPk,
      publish: async template => { const event = agent.signEvent(template); await connection.publish(event); return event; },
      subscribe: (filters, receive) => connection.subscribe(filters, receive),
      encrypt: (peer, text) => agent.encryptTo(peer, text), decrypt: (peer, text) => agent.decryptFrom(peer, text),
    }, owner, form, { signal: abort.signal, timeoutMs: 45_000 });
    await expect(page.getByRole("region", { name: "Questions from quill" })).toBeVisible();
    await expect(page.getByLabel("1 pending question request")).toHaveText("1");
    await expect.poll(() => notifications.length).toBe(1);
    expect(notifications[0]).toEqual({ title: "quill needs your input", body: "Open Fez to answer privately." });
    await page.getByRole("radio", { name: /Grid/ }).check();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("checkbox", { name: "Search" }).check();
    await page.getByRole("checkbox", { name: "Filters" }).check();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Count", exact: true }).pressSequentially("1e");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Count: enter a complete number");
    await expect(page.getByText("Question 3 of 4", { exact: true })).toBeVisible();
    await page.getByRole("spinbutton", { name: "Count", exact: true }).fill("0");
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("textbox", { name: "Other", exact: true }).fill("Compact spacing");
    await page.reload();
    await expect(page.getByRole("region", { name: "Questions from quill" })).toBeVisible();
    await expect(page.getByText("Question 4 of 4", { exact: true })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Grid/, includeHidden: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Search", includeHidden: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Filters", includeHidden: true })).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Other", exact: true })).toHaveValue("Compact spacing");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await page.screenshot({ path: "/tmp/fez-agent-input-desktop.png" });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(pending).resolves.toEqual({ action: "accept", content: { layout: "grid", features: ["search", "filters"], count: 0, custom: "Compact spacing" } });
    await expect(page.locator(".input-card")).toHaveCount(0);
    await expect(page.getByLabel("1 pending question request")).toHaveCount(0);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("Received by agent")).toBeVisible();
    await page.reload();
    await expect(page.locator(".shell")).toBeVisible();
    await expect(page.locator(".input-card")).toHaveCount(0);
    await page.getByRole("button", { name: "Questions", exact: true }).click();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("Received by agent")).toBeVisible();
    await page.locator(".input-history-card summary").click();
    await expect(page.getByText("Compact spacing", { exact: true })).toBeVisible();
    expect(notifications).toHaveLength(1);
    await expect(page.locator(".boot-splash")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/fez-agent-history-desktop.png" });
  } finally {
    abort.abort();
    connection.disconnect();
    agent.disconnect();
    human.disconnect();
    relay.kill();
  }
});
