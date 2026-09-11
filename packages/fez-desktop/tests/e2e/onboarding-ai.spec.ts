import { test, expect } from "@playwright/test";
import { installMockBridge } from "./helpers/bridge";

test("local choices are detection results, with no named installation suggestions", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByText("No compatible agents detected on this machine.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Fez’s built-in agent/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Claude Code|Codex/, hidden: true })).toHaveCount(0);
  await expect(page.getByText("Install a local agent")).toHaveCount(0);
});

test("installed agents appear under Found on this machine", async ({ page }) => {
  const installed = () => JSON.stringify({ installed: true, authed: true, adapterReady: true });
  await installMockBridge(page, { claude_brain_status: installed, codex_brain_status: installed });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  const detected = page.getByRole("group", { name: "Found on this machine" });
  await expect(detected.getByRole("button", { name: /^Claude Code/ })).toBeVisible();
  await expect(detected.getByRole("button", { name: /^Codex/ })).toBeVisible();
  await expect(detected.getByRole("button", { name: /built-in/ })).toHaveCount(0);
});

test("Codex uses its own setup and persists that choice for the whole team", async ({ page }) => {
  const bridge = await installMockBridge(page, {
    codex_brain_status: () => JSON.stringify({ installed: true, authed: true, adapterReady: true }),
  });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await expect(page.getByRole("heading", { name: "Connect your AI" })).toBeVisible();
  await page.getByRole("button", { name: /^Codex/ }).click();
  await expect(page.getByLabel("Provider", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/existing sign-in and model/i)).toBeVisible();
  await page.screenshot({ path: "/tmp/fez-onboarding-codex.png", fullPage: true });
  await page.getByRole("button", { name: "Continue with Codex" }).click();
  await page.getByRole("button", { name: /Start a workspace for me/i }).click();
  await page.getByRole("button", { name: /skip for now/i }).click();
  await page.getByRole("button", { name: /take me to fez/i }).click();
  await expect.poll(() => bridge.calls.filter(c => c.cmd === "write_persona").length).toBe(3);
  for (const c of bridge.calls.filter(c => c.cmd === "write_persona")) {
    const content = (c.args as { content: string }).content;
    expect(content).toContain("harness: codex");
    expect(content).not.toContain("provider:");
    expect(content).not.toContain("model:");
  }
});

test("Codex setup failures stay actionable and cannot be saved as connected", async ({ page }) => {
  const bridge = await installMockBridge(page, {
    codex_brain_status: () => JSON.stringify({ installed: true, authed: true, adapterReady: false }),
    ensure_codex_adapter: () => { throw "Download unavailable — try again"; },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /^Codex/ }).click();
  await page.getByRole("button", { name: "Connect Codex to Fez" }).click();
  await expect(page.getByRole("alert")).toContainText("Download unavailable");
  await expect(page.getByRole("button", { name: "Continue with Codex" })).toBeDisabled();
  expect(bridge.calls.filter(c => c.cmd === "write_persona")).toHaveLength(0);
});

test("changing providers clears verification and old API-key input", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: /get started/i }).click();
  await page.getByRole("button", { name: /Fez’s built-in agent/ }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByLabel("API key", { exact: true }).fill("test-openai-key");
  await page.getByLabel("Provider", { exact: true }).selectOption("chutes");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: /verify/i }).click();
  await page.screenshot({ path: "/tmp/fez-onboarding-builtin.png", fullPage: true });
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
});
