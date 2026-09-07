import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

const CLAUDE_READY = { claude_brain_status: () => JSON.stringify({ installed: true, authed: true, adapterReady: true }) };

test("claude READY shows on the harness page and unlocks the harness dropdown", async ({ page }) => {
  await installMockBridge(page, CLAUDE_READY);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByText("signed in — uses your Claude subscription")).toBeVisible();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.locator("select").first().selectOption("claude-code");
  await expect(page.getByText("uses your Claude subscription")).toBeVisible();
});

test("claude SIGN IN state renders the login hint", async ({ page }) => {
  await installMockBridge(page, { claude_brain_status: () => JSON.stringify({ installed: true, authed: false, adapterReady: false }) });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByText(/claude \/login/i)).toBeVisible();
});

test("a bad provider key fails inline and does not advance", async ({ page }) => {
  await installMockBridge(page, { wire_provider_pi: () => { throw "OpenAI wired, but couldn't list models: 401"; } });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.locator("select").first().selectOption("pi");
  await page.locator("select").nth(1).selectOption("openai");
  await page.getByPlaceholder(/api key/i).fill("sk-garbage");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByText(/couldn't list models/i)).toBeVisible();
  await expect(page.getByText("Configure your defaults")).toBeVisible(); // still here
});

test("a bad provider key is taken back OUT of the keychain", async ({ page }) => {
  // Store-then-verify is forced by wire_provider_pi reading the keychain;
  // the failed verify must delete what it stored, or provider_key_present
  // later reads the typo'd key as "authed" and the welcome spawns a
  // starter team that can never complete a turn.
  const bridge = await installMockBridge(page, { wire_provider_pi: () => { throw "OpenAI wired, but couldn't list models: 401"; } });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.locator("select").first().selectOption("pi");
  await page.locator("select").nth(1).selectOption("openai");
  await page.getByPlaceholder(/api key/i).fill("sk-garbage");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByText(/couldn't list models/i)).toBeVisible();
  const stored = bridge.calls.find((c) => c.cmd === "set_skill_secret");
  const deleted = bridge.calls.find((c) => c.cmd === "delete_skill_secret");
  expect(stored).toBeTruthy();
  expect(deleted).toBeTruthy();
});

test("a verify that reuses an already-stored key does NOT delete it on failure", async ({ page }) => {
  // Empty key field + stored key from before: a network blip must not
  // discard a key that was never this attempt's to manage.
  const bridge = await installMockBridge(page, { wire_provider_pi: () => { throw "relay unreachable"; } });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.locator("select").first().selectOption("pi");
  await page.locator("select").nth(1).selectOption("openai");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByText(/relay unreachable/i)).toBeVisible();
  expect(bridge.calls.find((c) => c.cmd === "set_skill_secret")).toBeFalsy();
  expect(bridge.calls.find((c) => c.cmd === "delete_skill_secret")).toBeFalsy();
});
