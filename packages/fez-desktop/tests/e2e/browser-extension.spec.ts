import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";
import { installedRuntime } from "../../../fez-evals/tests/helpers/browser-runtime";
import { browserStatus, setupBrowser, testBrowser } from "../../../fez-browser/src/runtime";

test("install Browser, finish GUI setup, give it to Quill, and test again after reload", async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  page.on("console", msg => { if (["error", "warning"].includes(msg.type())) console.log("webview:", msg.text()); });
  page.on("pageerror", error => console.log("webview:", error.message));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fez-browser-gui-"));
  await installedRuntime(root);
  const secret = generateSecretKey();
  const owner = getPublicKey(secret);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const relay = await spawnRelay(port, { owner });
  let installed = false;
  let running = false;
  let setup: Promise<void> | undefined;
  const initialPersona = "---\nharness: pi\nprovider: local\nmodel: test\nmcpServers: [wallet, mining]\n---\nQuill writes clearly.\n";
  let persona = initialPersona;
  const gui = await fs.readFile(new URL("../../../fez-browser/dist/gui.js", import.meta.url), "utf8");
  const grants = ["network:*", "ui", "processes"];
  const commands = ["install_package", "read_skills", "list_local_extensions", "read_extension_versions", "read_extension_grants", "list_gui_extensions", "run_extension_bin", "spawn_extension_agent", "agent_alive", "read_persona", "update_persona"];
  try {
    await installMockBridge(page, {
      get_pubkey: () => owner, provider_key_present: () => true,
      list_personas: () => ["fez", "quill"],
      ensure_local_relay: () => relay.url,
      list_installed_skills: () => "[]", read_keymap: () => "{}", read_media_server: () => "",
      latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    // Native operations are the boundary: setup/status/test run the real
    // extension against the same subprocess fixture used by the eval gate.
    await page.exposeFunction("browserNative", async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "install_package") { expect(args.name).toBe("@fezchat/browser"); installed = true; return "installed"; }
      if (cmd === "read_skills") return JSON.stringify(installed ? { browser: { command: "node", args: ["/fixture/dist/mcp.js"], package: "@fezchat/browser", description: "Browser" } } : {});
      if (cmd === "list_local_extensions") return installed ? [["browser", ["gui"]]] : [];
      if (cmd === "read_extension_versions") return JSON.stringify(installed ? { browser: "0.1.0" } : {});
      if (cmd === "read_extension_grants") return JSON.stringify(installed ? { browser: grants } : {});
      if (cmd === "list_gui_extensions") return installed ? [["browser", gui, ""]] : [];
      if (cmd === "agent_alive") return args.bin === "fez-browser" && running;
      if (cmd === "read_persona") return persona;
      if (cmd === "update_persona") { expect(args.name).toBe("quill"); persona = String(args.content); return null; }
      if (cmd === "spawn_extension_agent") {
        expect(args.extension).toBe("browser"); expect(args.bin).toBe("fez-browser");
        running = true;
        setup = setupBrowser(root).finally(() => { running = false; });
        return process.pid;
      }
      if (cmd === "run_extension_bin") {
        expect(args.extension).toBe("browser"); expect(args.bin).toBe("fez-browser");
        if ((args.args as string[])[0] === "test") await testBrowser(root);
        return { code: 0, stdout: JSON.stringify(await browserStatus(root)), stderr: "" };
      }
      throw new Error(`Unexpected native command: ${cmd}`);
    });
    await page.addInitScript(({ commands, relayUrl }) => {
      localStorage.setItem("fez-relay", relayUrl);
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }; browserNative: (cmd: string, args: unknown) => Promise<unknown> };
      const original = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) => commands.includes(cmd) ? w.browserNative(cmd, args ?? {}) : original(cmd, args);
    }, { commands, relayUrl: relay.url });
    await page.goto("/");
    await page.locator(".self-wrap > button").click();
    await page.locator(".self-menu").getByRole("button", { name: /extensions/ }).click();
    const card = page.locator(".gallery-card").filter({ hasText: "Let agents open websites" });
    await card.getByRole("button", { name: /install/i }).click();
    await page.getByRole("button", { name: "install & grant", exact: true }).click();
    await expect.poll(() => installed).toBe(true);
    await page.locator(".self-wrap > button").click();
    await page.locator(".self-menu").getByRole("button", { name: /settings/ }).click();
    await page.getByRole("button", { name: "browser", exact: true }).click();
    await page.getByRole("button", { name: "Set up browser", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Ready" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Test browser", exact: true }).click();
    await expect(page.getByText("Browser test passed.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "← back", exact: true }).click();
    await page.getByRole("button", { name: "installed1", exact: true }).click();
    const row = page.locator(".skill-row").filter({ hasText: "Browser" });
    await row.getByRole("button", { name: "give to…", exact: true }).click();
    await row.getByRole("button", { name: "@quill", exact: true }).click();
    await expect.poll(() => persona).toContain("mcpServers: [wallet, mining, browser]");
    expect(persona.replace("mcpServers: [wallet, mining, browser]", "mcpServers: [wallet, mining]")).toBe(initialPersona);
    await page.reload();
    await page.locator(".self-wrap > button").click();
    await page.locator(".self-menu").getByRole("button", { name: /settings/ }).click();
    await page.getByRole("button", { name: "browser", exact: true }).click();
    await expect(page.getByRole("button", { name: "Test browser", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Test browser", exact: true }).click();
    await expect(page.getByText("Browser test passed.", { exact: false })).toBeVisible();
    await page.screenshot({ path: "/private/tmp/fez-browser-settings.png", fullPage: true });
  } finally {
    await setup;
    relay.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});
