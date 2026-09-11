import { test, expect } from "@playwright/test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "@noble/hashes/utils.js";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";
import { BrowserWire } from "../../src/wire";

test.describe.configure({ mode: "serial" });
for (const connected of [false, true]) {
  test(`first task ${connected ? "fills a draft without sending it" : "offers AI connection after skipping setup"}`, async ({ page }) => {
    const owner = generateSecretKey();
    const pk = getPublicKey(owner);
    const relay = await spawnRelay(7796, { owner: pk });
    const wire = new BrowserWire([relay.url], bytesToHex(owner));
    try {
      const bridge = await installMockBridge(page, {
        get_pubkey: () => pk,
        list_personas: () => ["fez", "drift", "quill"],
        read_persona: () => connected ? "---\nharness: codex\n---\n" : "---\nharness: pi\nskills: [git]\n---\n\nKeep my instructions.\n",
        update_persona: () => "",
        agent_alive: () => false,
        codex_brain_status: () => JSON.stringify({ installed: true, authed: true, adapterReady: true }),
      }, { identities: { default: bytesToHex(owner) } });
      await page.addInitScript(() => {
        const native = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
        const original = native.invoke;
        const saved = new Map<string, string>();
        native.invoke = async (cmd, args) => {
          const result = await original(cmd, args);
          if (cmd === "update_persona") saved.set(String(args?.name), String(args?.content));
          return cmd === "read_persona" ? saved.get(String(args?.name)) ?? result : result;
        };
      });
      await page.goto("/");
      await page.evaluate((url) => localStorage.setItem("fez-relay", url), relay.url);
      await page.reload();
      if (connected) {
        await page.getByRole("button", { name: "Turn an idea into a plan" }).click();
        await expect(page.getByPlaceholder("message #welcome")).toHaveValue(/^@fez help me turn an idea into a plan/);
        const sent = await wire.query([{ kinds: [47103], authors: [pk], "#h": ["bootstrap-welcome"] }]);
        expect(sent).toHaveLength(0);
      } else {
        await page.getByRole("button", { name: "Connect AI", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Connect your AI" })).toBeVisible();
        await expect(page.getByRole("button", { name: /Fez’s built-in agent/ })).toBeVisible();
        await expect(page.getByRole("button", { name: "Turn an idea into a plan" })).toHaveCount(0);
        expect(bridge.calls.filter(c => c.cmd === "start_managed_agent")).toHaveLength(0);
        await page.getByRole("button", { name: /^Codex/ }).click();
        await page.getByRole("button", { name: "Continue with Codex" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Turn an idea into a plan" })).toBeVisible();
        const updates = bridge.calls.filter(c => c.cmd === "update_persona");
        expect(updates).toHaveLength(3);
        for (const update of updates) {
          expect((update.args as { content: string }).content).toContain("harness: codex\nskills: [git]");
          expect((update.args as { content: string }).content).toContain("Keep my instructions.");
        }
      }
      await page.screenshot({ path: `/tmp/fez-first-task-${connected ? "draft" : "connect"}.png`, fullPage: true });
    } finally {
      wire.close();
      relay.kill();
    }
  });
}
