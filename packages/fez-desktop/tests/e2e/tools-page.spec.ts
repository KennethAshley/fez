import { test, expect } from "@playwright/test";
import { createServer } from "node:net";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { installMockBridge } from "./helpers/bridge";
import { spawnRelay } from "./helpers/relay";

test("tools show agent access, keep sharing in details, and offer discovery on an empty relay", async ({ page }) => {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const secret = generateSecretKey();
  const relay = await spawnRelay(port, { owner: getPublicKey(secret) });
  try {
    await installMockBridge(page, {
      provider_key_present: () => true,
      list_personas: () => ["fez", "quill"],
      read_persona: () => "---\nmcpServers: [web-search]\nskills: [review]\n---\nResearch carefully.\n",
      read_skills: () => JSON.stringify({
        "web-search": { command: "npx", args: ["-y", "@example/search"], description: "Search public pages and bring sources back to the conversation.", env: { API_KEY: "" } },
        "team-docs": { type: "http", url: "https://tools.example/mcp", description: "Read the documents your team has shared with this server." },
      }),
      list_installed_skills: () => JSON.stringify([{ pkg: "review-pack", id: "review", name: "Code review", description: "Instructions for reviewing a change before it ships." }]),
      ensure_local_relay: () => relay.url,
      read_keymap: () => "{}", read_media_server: () => "",
      latest_version: () => "0.1.0", package_info: () => "{}", spawned_agents: () => [],
      has_skill_secret: () => false,
    }, { identities: { default: Buffer.from(secret).toString("hex") } });
    await page.addInitScript(url => localStorage.setItem("fez-relay", url), relay.url);
    await page.route("https://fez.chat/api/counts", route => route.fulfill({ json: {} }));
    await page.setViewportSize({ width: 1280, height: 920 });
    await page.goto("/");
    await page.locator(".self-wrap > button").click();
    await page.locator(".self-menu").getByRole("button", { name: /extensions/ }).click();
    await expect(page.locator(".gallery-card").first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("extensions-reference.png"), fullPage: true, animations: "disabled" });
    await page.locator(".self-wrap > button").click();
    await page.locator(".self-menu").getByRole("button", { name: /tools/ }).click();
    const row = page.locator(".tool-item").filter({ hasText: "web-search" });
    await expect(row.getByText("Assigned to @fez, @quill")).toBeVisible();
    await expect(row.getByText("Needs setup", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Assign to agent" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Share tool setup" })).toBeHidden();
    await page.screenshot({ path: test.info().outputPath("your-tools.png"), fullPage: true, animations: "disabled" });
    await row.locator("summary").click();
    await expect(row.getByRole("button", { name: "Share tool setup" })).toBeVisible();
    await page.getByRole("button", { name: "Add tools", exact: true }).click();
    await expect(page.getByText(/No tools shared here yet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Search packages" })).toBeVisible();
    await page.getByRole("textbox", { name: "Tool name", exact: true }).fill("new-tool");
    await page.getByRole("textbox", { name: "Package or server URL", exact: true }).fill("https://tools.example/mcp");
    await expect(page.getByRole("button", { name: "Review setup" })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("add-tools.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Review setup" }).click();
    await expect(page.getByRole("dialog", { name: "Add new-tool" })).toContainText("Assigned agents will connect to this server");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.setViewportSize({ width: 760, height: 900 });
    await page.screenshot({ path: test.info().outputPath("add-tools-narrow.png"), fullPage: true, animations: "disabled" });
    expect(await page.locator(".tools-page").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 920 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
    await page.screenshot({ path: test.info().outputPath("add-tools-dark.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: /^Your tools/ }).click();
    await expect(row.getByRole("button", { name: "Assign to agent" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("your-tools-dark.png"), fullPage: true, animations: "disabled" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-scheme", "light");
  } finally { relay.kill(); }
});
