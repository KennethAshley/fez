import { test, expect, type Page } from "@playwright/test";

async function loadDetails(page: Page, confirmation = false) {
  await page.addInitScript(confirmation => {
    const requests: Record<string, unknown>[] = [];
    Object.assign(window, { detailsProbe: requests, __TAURI_INTERNALS__: { invoke: async (command: string, { request }: { request: Record<string, unknown> }) => {
      if (command !== "isolated_panel_request") throw Error("native command denied");
      requests.push(request);
      if (request.op === "bootstrap") return {
        name: "kanban", client: false, agents: null,
        // An overlay must never evaluate a bundle or install its stylesheet.
        code: 'document.body.dataset.extensionExecuted = "yes"; throw Error("extension ran");',
        styles: 'body { display: none !important; }',
        details: { title: '<img src=x onerror="alert(1)">', body: 'Full card details.\n'.repeat(600), context: "Backlog", confirmation },
      };
      if (request.op === "close_details" || request.op === "resolve_details") return null;
      throw Error(`unexpected request: ${request.op}`);
    } } });
  }, confirmation);
  await page.goto("/isolated-panel.html");
  // Native may mark embedded surfaces; details must still own their keys.
  await page.evaluate(() => { document.documentElement.dataset.embedded = "true"; });
}

for (const action of ["Confirm", "Cancel", "Escape", "backdrop"] as const) {
  test(`confirmation ${action} resolves only the selected native decision`, async ({ page }) => {
    await loadDetails(page, true);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("kanban · Confirmation", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveAttribute("data-extension-executed");
    await page.keyboard.press("Meta+k");
    if (action === "Escape") await page.keyboard.press("Escape");
    else if (action === "backdrop") await page.mouse.click(2, 2);
    else await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "detailsProbe"))).toEqual([
      { op: "bootstrap" }, action === "Escape" || action === "backdrop" ? { op: "close_details" } : { op: "resolve_details", accepted: action === "Confirm" },
    ]);
  });
}

for (const accepted of [false, true]) {
  test(`api.confirm awaits and returns native ${accepted} with explicit null fields`, async ({ page }) => {
    await page.addInitScript(accepted => {
      const requests: Record<string, unknown>[] = [];
      Object.assign(window, { detailsRequests: requests, __TAURI_INTERNALS__: { invoke: async (_command: string, { request }: { request: Record<string, unknown> }) => {
        if (request.op === "bootstrap") return {
          name: "confirm-test", styles: "", client: false, agents: null,
          code: `var __fezExt = {default(api) { api.registerSettingsPanel("confirm", () => api.React.createElement("button", {onClick: async () => { document.body.dataset.decision = "waiting"; document.body.dataset.decision = String(await api.confirm({title: "Continue?"})); }}, "Ask")); }};`,
        };
        if (request.op === "confirm") {
          requests.push(request);
          return new Promise(resolve => { Object.assign(window, { resolveConfirmation: () => resolve(accepted) }); });
        }
        throw Error(`unexpected request: ${request.op}`);
      } } });
    }, accepted);
    await page.goto("/isolated-panel.html");
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-decision", "waiting");
    expect(await page.evaluate(() => Reflect.get(window, "detailsRequests"))).toEqual([
      { op: "confirm", title: "Continue?", body: null, context: null },
    ]);
    await page.evaluate(() => Reflect.get(window, "resolveConfirmation")());
    await expect(page.locator("body")).toHaveAttribute("data-decision", String(accepted));
  });
}

test("host details keep untrusted text inert and bounded over a transparent app overlay", async ({ page }) => {
  await loadDetails(page);
  const dialog = page.getByRole("dialog", { name: '<img src=x onerror="alert(1)">' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("kanban · Details", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Backlog", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveAttribute("data-extension-executed");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 500, height: 400 });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(500);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  expect(await dialog.locator(".host-details-body").evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await page.evaluate(() => [document.documentElement, document.body, document.getElementById("root")!].map(el => ({
    background: getComputedStyle(el).backgroundColor, height: el.getBoundingClientRect().height,
  })))).toEqual(Array.from({ length: 3 }, () => ({ background: "rgba(0, 0, 0, 0)", height: 400 })));
});

for (const dismissal of ["Close", "Escape", "backdrop"] as const) {
  test(`${dismissal} closes the native details overlay without forwarding host shortcuts`, async ({ page }) => {
    await loadDetails(page);
    const close = page.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeVisible();
    await page.keyboard.press("Meta+k");
    await page.keyboard.press("Meta+,");
    await page.keyboard.press("Tab");
    if (dismissal === "Close") await close.click();
    else if (dismissal === "Escape") await page.keyboard.press("Escape");
    else await page.mouse.click(2, 2);
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "detailsProbe"))).toEqual([
      { op: "bootstrap" }, { op: "close_details" },
    ]);
  });
}

test("showDetails sends explicit nulls for omitted text through the broker", async ({ page }) => {
  await page.addInitScript(() => {
    const requests: Record<string, unknown>[] = [];
    Object.assign(window, { detailsRequests: requests, __TAURI_INTERNALS__: { invoke: async (_command: string, { request }: { request: Record<string, unknown> }) => {
      if (request.op === "bootstrap") return {
        name: "details-test", styles: "", client: false, agents: null,
        code: `var __fezExt = {default(api) { api.registerSettingsPanel("details", () => api.React.createElement("button", {onClick: () => api.showDetails({title: "Short note"})}, "Show details")); }};`,
      };
      if (request.op === "show_details") { requests.push(request); return null; }
      throw Error(`unexpected request: ${request.op}`);
    } } });
  });
  await page.goto("/isolated-panel.html");
  await page.getByRole("button", { name: "Show details" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "detailsRequests"))).toEqual([
    { op: "show_details", title: "Short note", body: null, context: null },
  ]);
});

test("a revoked bootstrap still lets the user close the native overlay", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.surface = "details"; }, { once: true });
    const requests: Record<string, unknown>[] = [];
    Object.assign(window, { detailsRequests: requests, __TAURI_INTERNALS__: { invoke: async (_command: string, { request }: { request: Record<string, unknown> }) => {
      requests.push(request);
      if (request.op === "bootstrap") throw Error("extension requires ui permission");
      if (request.op === "close_details") return null;
      throw Error(`unexpected request: ${request.op}`);
    } } });
  });
  await page.goto("/isolated-panel.html");
  await expect(page.getByRole("alert")).toContainText("ui permission");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "detailsRequests"))).toEqual([
    { op: "bootstrap" }, { op: "close_details" },
  ]);
});
