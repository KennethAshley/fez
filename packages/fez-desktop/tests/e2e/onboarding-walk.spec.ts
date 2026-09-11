import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("full happy path: welcome → connect AI → personal workspace → profile → team", async ({ page }) => {
  const bridge = await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();

  await expect(page.getByText("Connect your AI")).toBeVisible();
  await page.getByRole("button", { name: /Fez’s built-in agent/ }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("chutes");
  await page.getByPlaceholder(/api key/i).fill("test-key-123");
  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByLabel("Model", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /continue with mock\/model-a/i }).click();

  await page.getByRole("button", { name: /start a workspace for me/i }).click();

  await expect(page.getByText("Build your profile")).toBeVisible();
  await page.getByPlaceholder("your name").fill("Doug");
  await page.getByRole("button", { name: /^continue$/i }).click();

  // Naming a profile fires a best-effort kind-0 publish over a real
  // WebSocket to the (mocked-invoke, but real-socket) local relay URL —
  // it waits out BrowserWire's connect timeout before falling back, so
  // this transition is slower than the others.
  await expect(page.getByText("Meet your starter team")).toBeVisible({ timeout: 15_000 });
  // Assert the figures by accessible name, not by bare text: the step was
  // redesigned to put the job inside the same <figcaption> as the name
  // ("names alone made you guess what each one is for"), so a figcaption
  // now reads "FEZyour guide" and no element has the exact text "FEZ".
  // Naming the pair is also the stronger assertion — a member whose job
  // label went missing used to pass.
  for (const [id, job] of [["FEZ", "your guide"], ["DRIFT", "research"], ["QUILL", "writing"]]) {
    await expect(page.getByRole("figure", { name: `${id} ${job}`, exact: true })).toBeVisible();
  }
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
  await page.getByRole("button", { name: /explore first/i }).click();
  await page.getByRole("button", { name: /^back$/i }).click();
  await expect(page.getByText("Connect your AI")).toBeVisible();
  await page.getByRole("button", { name: /explore first/i }).click();
  await page.getByRole("button", { name: /start a workspace for me/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click(); // profile skipped
  await expect(page.getByText("Meet your starter team")).toBeVisible();
});
