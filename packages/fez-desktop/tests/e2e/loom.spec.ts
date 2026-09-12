import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { RelayConnection } from "../../../../src/protocol/relay";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("Loom saves, reopens, updates and shares artifacts from any agent under desktop CSP", async ({ page }) => {
  await page.context().grantPermissions(["local-network-access"], { origin: "http://127.0.0.1:4173" });
  page.on("pageerror", error => console.error(error.message));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const ownerKey = generateSecretKey(), agentKey = generateSecretKey();
  const owner = getPublicKey(ownerKey), agent = getPublicKey(agentKey);
  const relay = await spawnRelay(address.port, { owner });
  const connection = new RelayConnection({ url: relay.url });
  await connection.connect();
  const now = Math.floor(Date.now() / 1000);
  const publish = async (kind: number, tags: string[][], content: string, key = ownerKey, ts = now - 20) => {
    const event = finalizeEvent({ kind, tags, content, created_at: ts }, key);
    await connection.publish(event);
    return event;
  };
  const body = (version: string) => `<div id="status">loading</div><script>window.fez.query('open tasks').then(rows => document.getElementById('status').textContent = '${version}: ' + rows.length + ' tasks');</script>`;
  try {
    await publish(47102, [["d", "roster"], ["p", owner, "owner"], ["p", agent, "bot"]], "");
    await publish(47101, [["d", "general"]], JSON.stringify({ name: "general" }));
    await publish(47000, [], JSON.stringify({ name: "helper" }), agentKey);
    const root = await publish(47103, [["h", "general"]], "Build a task board");
    const artifact = await publish(40300, [["h", "general"], ["e", root.id, "", "root"]],
      JSON.stringify({ type: "live", title: "Task board", content: body("original") }), agentKey);
    const legacy = JSON.stringify([{ id: artifact.id, title: "Task board", content: body("original"), type: "live", ts: now },
      { id: "unrelated-workspace", content: "private older save", type: "live", ts: now }]);
    const gui = readFileSync(new URL("../../../fez-loom/dist/gui.js", import.meta.url), "utf8");
    const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    const csp = Object.entries(config.app.security.csp).map(([key, value]) => `${key} ${value}`).join("; ");
    await page.route("http://127.0.0.1:4173/", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
    });
    const staged = new Map<number, string>();
    let id = 0;
    await page.exposeFunction("stageArtifact", (html: string) => { staged.set(++id, html); return id; });
    await page.exposeFunction("releaseArtifact", (id: number) => { staged.delete(id); });
    await page.route("http://artifact.localhost/**", route => route.fulfill({
      contentType: "text/html", body: staged.get(Number(new URL(route.request().url()).pathname.slice(1))) ?? "missing artifact",
    }));
    await installMockBridge(page, {
      provider_key_present: () => true, list_personas: () => ["fez"],
      ensure_local_relay: () => relay.url, list_installed_skills: () => "[]", read_keymap: () => "{}",
      read_media_server: () => "", latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
      "plugin:event|listen": () => 1, "plugin:event|unlisten": () => null, read_skills: () => "{}",
      list_gui_extensions: () => [["loom", gui, ""]],
      read_extension_grants: () => JSON.stringify({ loom: ["ui", "read:channels", "publish", "personas"] }),
    }, { identities: { default: Buffer.from(ownerKey).toString("hex") } });
    await page.addInitScript(({ url, legacy }) => {
      if (window.top !== window) return;
      localStorage.setItem("fez-relay", url);
      if (!localStorage.getItem("fez-tools")) localStorage.setItem("fez-tools", legacy);
      const w = window as unknown as {
        stageArtifact: (html: string) => Promise<number>; releaseArtifact: (id: number) => Promise<void>;
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: { html?: string; id?: number }) => Promise<unknown>; convertFileSrc: (path: string, protocol: string) => string };
      };
      const invoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.convertFileSrc = (path, protocol) => `http://${protocol}.localhost/${path}`;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        if (cmd === "stage_artifact") return w.stageArtifact(args.html!);
        if (cmd === "release_artifact") return w.releaseArtifact(args.id!);
        return invoke(cmd, args);
      };
    }, { url: relay.url, legacy });
    await page.goto("/");
    await expect(page.locator(".shell")).toBeVisible({ timeout: 10_000 });
    const library = page.locator(".rail").getByRole("button", { name: "▣ artifacts", exact: true });
    await library.click();
    await page.getByRole("button", { name: "Import 1 older save from this workspace", exact: true }).click();
    const cards = page.locator(".tools-grid .tool-card");
    await expect(cards).toHaveCount(1);
    await expect(cards.locator("iframe")).toHaveCount(0);
    await expect(page.getByTitle("export as a publishable fez extension")).toHaveCount(0);
    await cards.getByTitle("open artifact", { exact: true }).click();
    const status = page.frameLocator(".tool-pane iframe").locator("#status");
    await expect(status).toHaveText("original: 0 tasks");
    await page.getByTitle("remove from saved artifacts", { exact: true }).click();
    await expect(cards).toHaveCount(0);
    await page.getByTitle("save artifact", { exact: true }).click();
    await expect(cards).toHaveCount(1);
    await page.reload();
    await library.click();
    await expect(cards).toHaveCount(1);
    await cards.getByTitle("open artifact", { exact: true }).click();
    await expect(status).toHaveText("original: 0 tasks");
    await publish(40300, [["h", "general"], ["e", root.id, "", "root"]],
      JSON.stringify({ type: "live", title: "Task board", content: body("revised") }), agentKey, Math.floor(Date.now() / 1000));
    await expect(status).toHaveText("revised: 0 tasks");
    await expect(cards).toHaveCount(1);
    await page.locator(".tool-pane .pane-actions > button").click();
    await cards.getByTitle("open artifact", { exact: true }).click();
    await expect(status).toHaveText("revised: 0 tasks");
    page.once("dialog", dialog => dialog.accept());
    await cards.getByTitle("share into its channel", { exact: true }).click();
    await expect.poll(async () => (await connection.query([{ kinds: [40300], authors: [owner] }])).length).toBe(1);
    const [shared] = await connection.query([{ kinds: [40300], authors: [owner] }]);
    expect(JSON.parse(shared.content).content).toBe(body("revised"));
    expect(shared.tags).toContainEqual(["h", "general"]);
    expect(await page.evaluate(() => localStorage.getItem("fez-tools"))).toBe(legacy);
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith("fez-tools:v2:")) throw Error("storage full");
        return set.call(this, key, value);
      };
    });
    await cards.getByTitle("remove saved artifact", { exact: true }).click();
    await expect(page.getByText("Could not save artifacts: storage full", { exact: true })).toBeVisible();
    await expect(cards).toHaveCount(1);
  } finally { connection.disconnect(); relay.kill(); }
});
