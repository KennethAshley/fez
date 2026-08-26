import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("full happy path: welcome → harness → defaults → community(create) → profile → team", async ({ page }) => {
  const bridge = await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();

  await expect(page.getByText("Your agent harnesses")).toBeVisible();
  await expect(page.getByText("READY")).toBeVisible(); // the Fez card
  await page.getByRole("button", { name: /^continue$/i }).click();

  await expect(page.getByText("Configure your defaults")).toBeVisible();
  await page.locator("select").first().selectOption("pi");
  await page.locator("select").nth(1).selectOption("chutes");
  await page.getByPlaceholder(/api key/i).fill("test-key-123");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.locator("select")).toHaveCount(4); // harness, provider, model, effort
  await page.getByRole("button", { name: /continue with mock\/model-a/i }).click();

  await page.getByRole("button", { name: /create a community/i }).click();

  await expect(page.getByText("Build your profile")).toBeVisible();
  await page.getByPlaceholder("your name").fill("Doug");
  await page.getByRole("button", { name: /^continue$/i }).click();

  // Naming a profile fires a best-effort kind-0 publish over a real
  // WebSocket to the (mocked-invoke, but real-socket) local relay URL —
  // it waits out BrowserWire's connect timeout before falling back, so
  // this transition is slower than the others.
  await expect(page.getByText("Meet your starter team")).toBeVisible({ timeout: 15_000 });
  // exact: true — getByText's default match is case-insensitive substring,
  // and "fez" (lowercase) also appears in the lede copy and the "take me
  // to fez" button; the team figcaptions are the literal uppercase ids.
  for (const n of ["FEZ", "DRIFT", "QUILL"]) await expect(page.getByText(n, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /take me to fez/i }).click();

  // The wizard's contract with the backend, asserted through the bridge:
  const personas = bridge.calls.filter((c) => c.cmd === "write_persona").map((c) => (c.args as any).name);
  expect(personas).toEqual(expect.arrayContaining(["fez", "drift", "quill"]));
  const fezMd = (bridge.calls.find((c) => c.cmd === "write_persona" && (c.args as any).name === "fez")!.args as any).content as string;
  expect(fezMd).toContain("harness: pi");
  expect(fezMd).toContain("model: mock/model-a");
  expect(fezMd).toContain("effort: medium");
});

test("back retraces from every step; skips never dead-end", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^continue$/i }).click(); // → defaults
  await page.getByRole("button", { name: /^back$/i }).click(); // → harness
  await expect(page.getByText("Your agent harnesses")).toBeVisible();
  await page.getByRole("button", { name: /^continue$/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click(); // defaults skipped
  await page.getByRole("button", { name: /create a community/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click(); // profile skipped
  await expect(page.getByText("Meet your starter team")).toBeVisible();
});
