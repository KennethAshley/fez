import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("fresh machine lands on onboarding", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByText("Work with a team of AI agents", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /get started/i })).toBeVisible();
});

test("denied keychain access offers retry without reading or replacing the private key", async ({ page }) => {
  const bridge = await installMockBridge(page, {
    get_pubkey: () => { throw "keychain access failed for account default: access denied"; },
  });
  await page.goto("/");
  await expect(page.getByText(/keychain access failed/i)).toBeVisible();
  const checks = bridge.calls.filter((c) => c.cmd === "get_pubkey").length;
  await page.getByRole("button", { name: "try again" }).click();
  await expect.poll(() => bridge.calls.filter((c) => c.cmd === "get_pubkey").length).toBeGreaterThan(checks);
  await expect(page.getByRole("button", { name: /get started/i })).toHaveCount(0);
  expect(bridge.calls.filter((c) => ["get_identity", "set_identity", "ensure_agent_identity"].includes(c.cmd))).toEqual([]);
});
