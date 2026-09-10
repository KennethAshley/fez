import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection, CapabilityClient } from "../../../../dist/index.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("native channel workspace retains drafts, navigates threads, and owns panel disposal", async ({ page }) => {
  test.setTimeout(90_000);
  const secret = generateSecretKey(), owner = getPublicKey(secret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(port, { owner });
  const connection = new RelayConnection({ urls: [relay.url] });
  const human = new CapabilityClient({ relay: relay.url, privateKey: Buffer.from(secret).toString("hex") });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await connection.connect();
    await connection.publish(human.signEvent({ kind: 47102, tags: [["d", "roster"], ["p", owner, "owner"]], content: "" }));
    for (const [id, name] of [["room-a", "workshop"], ["room-b", "lounge"]]) {
      await connection.publish(human.signEvent({ kind: 47101, tags: [["d", id]], content: JSON.stringify({ name }) }));
    }
    const root = human.signEvent({ kind: 47103, tags: [["h", "room-a"]], content: "Original workspace thread", created_at: Math.floor(Date.now() / 1000) - 3600 });
    await connection.publish(root);
    // Outside the native latest-50 history: openThread must backfill its root.
    for (let i = 0; i < 55; i++) await connection.publish(human.signEvent({ kind: 47103, tags: [["h", "room-a"]], content: `Other discussion ${i}` }));
    const otherRoot = human.signEvent({ kind: 47103, tags: [["h", "room-b"]], content: "Cross-channel thread" });
    await connection.publish(otherRoot);

    // A generic fixture uses a catalog package's name solely to exercise
    // the real uninstall UI. No package code, processes, or network services.
    const gui = `var __fezExt = { default: function(api) {
      const h = api.React.createElement;
      const count = key => { document.documentElement.dataset[key] = String(Number(document.documentElement.dataset[key] || 0) + 1); };
      const panel = value => host => {
        count('panelMounts');
        const input = document.createElement('input');
        input.setAttribute('aria-label', 'Configuration'); input.value = value; host.appendChild(input);
        return () => { count('panelDisposals'); input.remove(); };
      };
      const manage = value => api.openPanel('Manage record', panel(value));
      api.registerNavView('workspace', { glyph: 'W', label: 'Fixture workspace', channelWorkspace: {
        getChannelId: () => 'room-a',
        summary: ({ openTab }) => { count('summaryMounts'); return h('div', null,
          h('button', { onClick: () => openTab('records') }, 'Browse records'),
          h('button', { onClick: () => manage('new') }, 'New record')); },
        tabs: [
          { id: 'records', label: 'Records', render: () => h('div', null,
            h('input', { 'aria-label': 'Record draft', defaultValue: '' }),
            h('button', { onClick: () => manage('first') }, 'Manage first'),
            h('button', { onClick: () => manage('second') }, 'Manage second'),
            h('button', { onClick: () => api.openThread('room-a', ${JSON.stringify(root.id)}) }, 'Open workspace thread'),
            h('button', { onClick: () => api.openThread('room-b', ${JSON.stringify(otherRoot.id)}) }, 'Open other thread')) },
          { id: 'catalog', label: 'Catalog', render: () => { count('catalogMounts'); return 'Full catalog'; } }
        ]
      } }, () => 'Unbound setup');
      api.registerNavView('dashboard', { glyph: 'D', label: 'Fixture dashboard' }, () => h('div', null,
        h('button', { onClick: () => api.openThread('room-a', ${JSON.stringify(root.id)}) }, 'Open workspace thread'),
        h('button', { onClick: () => api.openChannel('room-a') }, 'Open workspace channel')));
    } };`;
    await installMockBridge(page, {
      "plugin:event|listen": () => 1, "plugin:event|unlisten": () => null,
      get_pubkey: () => owner, provider_key_present: () => true, list_personas: () => ["fez"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
      read_skills: () => "{}", read_extension_versions: () => JSON.stringify({ browser: "0.1.0" }),
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    await page.addInitScript(({ relayUrl, gui }) => {
      localStorage.setItem("fez-relay", relayUrl);
      let installed = true;
      const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const original = bridge.invoke;
      bridge.invoke = (cmd, args) => {
        if (cmd === "list_gui_extensions") return Promise.resolve(installed ? [["browser", gui, ""]] : []);
        if (cmd === "list_local_extensions") return Promise.resolve(installed ? [["browser", ["gui"]]] : []);
        if (cmd === "read_extension_grants") return Promise.resolve(JSON.stringify({ browser: ["ui", "read:channels"] }));
        if (cmd === "remove_extension") { installed = false; return Promise.resolve("removed"); }
        return original(cmd, args);
      };
    }, { relayUrl: relay.url, gui });
    await page.goto("/");
    const rail = page.locator(".rail");
    const workspace = rail.getByRole("button", { name: "W Fixture workspace", exact: true });
    const dashboard = rail.getByRole("button", { name: "D Fixture dashboard", exact: true });
    await workspace.click();
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('input[aria-label="Record draft"]')).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-catalog-mounts");
    await expect(page.locator("html")).toHaveAttribute("data-summary-mounts", "1");
    const composer = page.locator("main .composer-row textarea");
    await composer.fill("Keep this unsent draft");
    await composer.evaluate(el => { el.setAttribute("data-retained-draft", "true"); });
    await page.getByRole("button", { name: "Browse records", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Records", exact: true })).toBeFocused();
    const recordDraft = page.getByRole("textbox", { name: "Record draft", exact: true });
    await recordDraft.fill("Half-completed configuration");
    await expect(composer).toBeHidden();
    await expect(composer).toHaveAttribute("data-retained-draft", "true");
    await page.getByRole("tab", { name: "Records", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Full catalog", { exact: true })).toBeVisible();
    await page.keyboard.press("Home");
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue("Keep this unsent draft");
    await expect(composer).toHaveAttribute("data-retained-draft", "true");

    await page.getByRole("button", { name: "New record", exact: true }).click();
    const configuration = page.getByRole("textbox", { name: "Configuration", exact: true });
    await configuration.fill("Retain launch configuration");
    await page.getByRole("tab", { name: "Records", exact: true }).click();
    await expect(recordDraft).toHaveValue("Half-completed configuration");
    await expect(page.locator("html")).toHaveAttribute("data-catalog-mounts", "1");
    await expect(page.locator("html")).toHaveAttribute("data-summary-mounts", "1");
    await expect(configuration).toHaveValue("Retain launch configuration");
    await page.getByRole("button", { name: "Manage first", exact: true }).click();
    await expect(configuration).toHaveValue("first");
    await page.getByRole("button", { name: "Manage second", exact: true }).click();
    await expect(configuration).toHaveValue("second");
    await expect(page.locator("html")).toHaveAttribute("data-panel-disposals", "2");
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await expect(configuration).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-panel-disposals", "3");

    // Same channel, same root, returning from a custom tab: every request works.
    for (let i = 0; i < 2; i++) {
      await page.getByRole("tab", { name: "Records", exact: true }).click();
      await page.getByRole("button", { name: "Open workspace thread", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("Original workspace thread", { exact: true })).toBeVisible();
      await expect(composer).toHaveAttribute("placeholder", "reply in thread…");
      await expect(composer).toHaveAttribute("data-retained-draft", "true");
      await page.getByRole("button", { name: "← back to channel", exact: true }).click();
    }
    await page.getByRole("tab", { name: "Records", exact: true }).click();
    await page.getByRole("button", { name: "Open other thread", exact: true }).click();
    await expect(page.getByText("Cross-channel thread", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveCount(0);
    await dashboard.click();
    await page.getByRole("button", { name: "Open workspace thread", exact: true }).click();
    await expect(page.getByText("Original workspace thread", { exact: true })).toBeVisible();
    await dashboard.click();
    await page.getByRole("button", { name: "Open workspace channel", exact: true }).click();
    await expect(composer).toHaveAttribute("placeholder", "message #workshop");
    await page.getByRole("tab", { name: "Catalog", exact: true }).click();
    await rail.getByRole("button", { name: /# workshop/ }).click();
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "New record", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("channel-workspace.png"), fullPage: true });

    // Uninstall through the host UI also closes the still-open extension pane.
    await rail.getByTitle("manage extensions", { exact: true }).click();
    await page.locator(".gallery-card").filter({ hasText: "@fezchat/browser" }).getByRole("button", { name: "uninstall", exact: true }).click();
    await expect(configuration).toHaveCount(0);
    await expect(workspace).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-panel-disposals", "4");
    await rail.getByRole("button", { name: /# workshop/ }).click();
    await expect(composer).toHaveValue("Keep this unsent draft");
    await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    connection.disconnect(); human.disconnect(); relay.kill();
  }
});
