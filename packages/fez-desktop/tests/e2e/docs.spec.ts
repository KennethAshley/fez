import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("docs keep live agent discussion with a passage and undo a signed edit", async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(7000);
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const agentSecret = generateSecretKey(), agent = getPublicKey(agentSecret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(address.port, { owner });
  const connection = new RelayConnection({ url: relay.url });
  let timestamp = Math.floor(Date.now() / 1000) - 20;
  const publish = async (kind: number, tags: string[][], content: string, key = secret) => {
    const event = finalizeEvent({ kind, tags, content, created_at: timestamp++ }, key);
    await connection.publish(event); return event;
  };
  const original = "# Working agreement\n\nAgents can edit after discussing a change.\n\nKeep the reasoning with the passage.";
  try {
    await connection.connect();
    await publish(47102, [["d", "roster"], ["p", owner, "owner"], ["p", agent, "bot"]], "");
    await publish(47101, [["d", "general"]], JSON.stringify({ name: "general" }));
    await publish(47000, [], JSON.stringify({ name: "quill" }), agentSecret);
    const first = await publish(40100, [["h", "general"], ["d", "working-agreement"], ["title", "Working agreement"]], original);
    await publish(40100, [["h", "general"], ["d", "other-page"], ["title", "Other page"]], "# Other page\n\nSeparate context.");
    await publish(40100, [["h", "general"], ["d", "release-checklist"], ["title", "release-checklist"]], "# Release Process");
    await installMockBridge(page, {
      get_pubkey: () => owner, provider_key_present: () => true, list_personas: () => ["fez", "quill"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await page.goto("/");
    await expect(page.locator(".boot-splash")).toHaveCount(0);
    await page.locator(".home-link").filter({ hasText: "docs" }).click();
    await page.locator(".wiki-list button").filter({ hasText: "Working agreement" }).click();
    await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toBeVisible();
    const passage = page.locator(".doc-line").filter({ hasText: "Agents can edit after discussing a change." });
    await passage.getByRole("button", { name: /Discuss passage/ }).click();
    await passage.locator("p").evaluate(element => {
      const text = element.firstChild!;
      const range = document.createRange(); range.setStart(text, 11); range.setEnd(text, 31);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const rail = page.getByRole("complementary", { name: "Document conversation" });
    await rail.getByRole("combobox", { name: "Lead agent" }).selectOption(agent);
    const input = rail.locator("textarea");
    await input.fill("Does this give agents too much freedom?");
    await rail.getByRole("button", { name: "Send", exact: true }).click();
    await expect(input).toHaveValue("");
    let rootId = "";
    await expect.poll(async () => {
      const roots = await connection.query([{ kinds: [40101], "#d": ["working-agreement"], authors: [owner] }]);
      rootId = roots.find(e => e.content.includes("too much freedom"))?.id ?? "";
      return rootId;
    }).not.toBe("");
    expect((await connection.query([{ ids: [rootId] }]))[0].tags).toContainEqual(["anchor", "edit after discussin"]);
    timestamp = Math.max(timestamp, Math.floor(Date.now() / 1000));
    await publish(40101, [["h", "general"], ["d", "other-page"]], "Unrelated page reply", agentSecret);
    await publish(40101, [["h", "general"], ["d", "working-agreement"], ["e", rootId], ["p", owner]], "Use **explicit edit requests**, and preserve undo.", agentSecret);
    await expect(rail.locator("strong").filter({ hasText: "explicit edit requests" })).toBeVisible();
    await expect(rail).not.toContainText("Unrelated page reply");
    await input.fill("Rewrite this passage with that feedback.");
    await rail.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await connection.query([{ kinds: [40101], authors: [owner], "#e": [rootId] }]))
      .some(e => e.content.includes("Rewrite") && e.tags.some(t => t[0] === "writer" && t[1] === agent))).toBe(true);
    const updated = original.replace("Agents can edit after discussing a change.", "Agents edit when you explicitly ask. Every edit can be reviewed and undone.");
    await page.locator(".wiki-body p").filter({ hasText: "Keep the reasoning with the passage." }).evaluate(element => { element.dataset.retained = "yes"; });
    const agentEdit = await publish(40100, [["h", "general"], ["d", "working-agreement"], ["title", "Working agreement"], ["base", first.id]], updated, agentSecret);
    await expect(page.locator(".wiki-body")).toContainText("Agents edit when you explicitly ask.");
    await expect(page.locator(".wiki-body p").filter({ hasText: "Keep the reasoning with the passage." })).toHaveAttribute("data-retained", "yes");
    await expect(rail).toContainText("Does this give agents too much freedom?");
    await page.screenshot({ path: "/private/tmp/fez-docs-workspace-desktop.png", animations: "disabled" });
    await page.getByRole("tab", { name: /Changes/ }).click();
    await rail.getByRole("button", { name: "Undo change", exact: true }).click();
    await expect(page.locator(".wiki-body")).toContainText("Agents can edit after discussing a change.");
    await page.getByRole("tab", { name: "Conversation", exact: true }).click();
    await input.fill("Keep this draft on this page");
    await page.locator(".wiki-list button").filter({ hasText: "Other page" }).click();
    await expect(input).toHaveValue("");
    await expect(rail).not.toContainText("Does this give agents too much freedom?");
    await page.locator(".wiki-list button").filter({ hasText: "Working agreement" }).click();
    await expect(input).toHaveValue("Keep this draft on this page");

    // A native signing failure must leave the user's message available to retry.
    await page.evaluate(() => {
      const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: { kind?: number }) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      bridge.invoke = (cmd, args) => {
        if (cmd === "sign_event" && args.kind === 40101) { bridge.invoke = invoke; return Promise.reject(new Error("Signing temporarily unavailable")); }
        return invoke(cmd, args);
      };
    });
    await rail.getByRole("button", { name: "Send", exact: true }).click();
    await expect(rail.getByRole("alert")).toContainText("Signing temporarily unavailable");
    await expect(input).toHaveValue("Keep this draft on this page");
    await rail.getByRole("button", { name: "Send", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(rail.getByRole("alert")).toHaveCount(0);

    // Editing pins the version the user saw, even if an agent saves while they type.
    const undoVersion = (await connection.query([{ kinds: [40100], "#d": ["working-agreement"] }])).find(e => e.tags.some(t => t[0] === "base" && t[1] === agentEdit.id))!;
    await page.getByRole("button", { name: "✎ edit", exact: true }).click();
    await page.locator(".doc-textarea").fill("# My unsaved draft");
    timestamp = Math.max(timestamp, undoVersion.created_at + 1);
    await publish(40100, [["h", "general"], ["d", "working-agreement"], ["title", "Working agreement"], ["base", undoVersion.id]], original + "\n\nNew agent context.", agentSecret);
    await page.getByRole("button", { name: "publish new version", exact: true }).click();
    await expect(page.locator(".doc-load-error")).toContainText("version changed");
    await expect(page.locator(".doc-textarea")).toHaveValue("# My unsaved draft");
    expect((await connection.query([{ kinds: [40100], "#d": ["working-agreement"] }])).some(e => e.content === "# My unsaved draft")).toBe(false);
    await page.getByRole("button", { name: "cancel", exact: true }).click();
    await expect(page.locator(".wiki-body")).toContainText("New agent context.");

    await page.getByTitle("new page", { exact: true }).click();
    await page.getByPlaceholder("page title…").fill("A fresh page");
    await page.getByPlaceholder("page title…").press("Enter");
    await expect(page.locator(".doc-textarea")).toHaveValue("# A fresh page\n\n");
    await page.locator(".doc-textarea").fill("# A fresh page\n\nCreated in the document workspace.");
    await page.evaluate(() => {
      const host = window as unknown as { __releaseDocSave?: () => void; __TAURI_INTERNALS__: { invoke: (cmd: string, args: { kind?: number }) => Promise<unknown> } };
      const invoke = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "sign_event" && args.kind === 40100) {
          host.__TAURI_INTERNALS__.invoke = invoke;
          return new Promise(resolve => { host.__releaseDocSave = () => resolve(invoke(cmd, args)); });
        }
        return invoke(cmd, args);
      };
    });
    await page.getByRole("button", { name: "publish", exact: true }).click();
    await expect(page.locator(".doc-textarea")).toBeDisabled();
    await expect(page.locator(".doc-format-bar button").first()).toBeDisabled();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __releaseDocSave?: () => void }).__releaseDocSave)).toBe("function");
    await page.evaluate(() => (window as unknown as { __releaseDocSave: () => void }).__releaseDocSave());
    await expect(page.locator(".wiki-body")).toContainText("Created in the document workspace.");
    await expect(page.locator(".wiki-title")).toContainText("A fresh page");
    await page.locator(".wiki-list button").filter({ hasText: "Working agreement" }).click();
    await expect(page.locator(".wiki-body")).toContainText("Keep the reasoning with the passage.");
    await expect(page.locator(".doc-line").filter({ hasText: "Keep the reasoning with the passage." }).locator(".doc-edit-receipt")).toHaveCount(0);
    await page.locator(".wiki-body p").evaluateAll(paragraphs => {
      const first = paragraphs.find(p => p.textContent?.startsWith("Agents can edit"))!;
      const last = paragraphs.find(p => p.textContent === "Keep the reasoning with the passage.")!;
      const range = document.createRange(); range.setStart(first.firstChild!, 0); range.setEnd(last.firstChild!, last.firstChild!.textContent!.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      first.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(rail.locator("blockquote")).toContainText("Keep the reasoning with the passage.");
    await page.setViewportSize({ width: 850, height: 850 });
    await expect(rail.getByRole("button", { name: "Send", exact: true })).toBeInViewport();
    await page.screenshot({ path: "/private/tmp/fez-docs-workspace-narrow.png", animations: "disabled" });
    await page.locator(".wiki-list button").filter({ hasText: "Release Process" }).click();
    await expect(page.locator(".wiki-body")).toContainText("Release Process");
    await page.getByRole("button", { name: "✎ edit", exact: true }).click();
    await page.locator(".doc-textarea").fill("# Release Process\n\nSaved at the original address.");
    await page.getByRole("button", { name: "publish new version", exact: true }).click();
    await expect(page.locator(".wiki-body")).toContainText("Saved at the original address.");
    expect((await connection.query([{ kinds: [40100], "#d": ["release-checklist"] }])).some(e => e.content.includes("Saved at the original address."))).toBe(true);
    expect(await connection.query([{ kinds: [40100], "#d": ["release-process"] }])).toEqual([]);
  } finally { connection.disconnect(); relay.kill(); }
});
