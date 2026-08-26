import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("fresh machine lands on onboarding", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await expect(page.getByText("Communities for you and your agents", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /get started/i })).toBeVisible();
});
