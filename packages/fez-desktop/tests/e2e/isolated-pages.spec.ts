import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const code = readFileSync(new URL("../../../fez-kanban/dist/gui.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../../fez-kanban/dist/gui.css", import.meta.url), "utf8");
const content = "```fez:board\ndone: Done\nlimit: In Progress = 1\n```\n\n## Backlog\n\n- [ ] Fix watcher @fez\n  Full details of the watcher fix.\n\n## In Progress\n\n## Review\n\n## Done\n";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ code, styles, content }) => {
    const state = {
      page: { content, versionId: "v1", title: "Test board", channelId: "test-channel", slug: "test-board", editable: true, agents: [["a".repeat(64), "fez"]] },
      config: { reviews: [] as unknown[] }, writes: [] as unknown[], comments: [] as unknown[], details: [] as unknown[], shortcuts: [] as string[], denySave: false, denyDetails: false, revision: 1,
    };
    Object.assign(window, { kanbanProbe: state, __TAURI_INTERNALS__: { invoke: async (command: string, { request: r }: { request: Record<string, unknown> }) => {
      if (command !== "isolated_panel_request") throw Error("native command denied");
      if (r.op === "bootstrap") return { name: "kanban", pageView: "▦ board", code, styles, client: true, agents: [["a".repeat(64), "fez"]] };
      if (r.op === "read_page") return structuredClone(state.page);
      if (r.op === "get_config") return { value: structuredClone(state.config) };
      if (r.op === "set_config") { if (r.extension !== "fez-kanban") throw Error("wrong namespace"); state.config = structuredClone(r.value) as typeof state.config; return null; }
      if (r.op === "host_shortcut") { state.shortcuts.push(String(r.shortcut)); return null; }
      if (r.op === "show_details") { if (state.denyDetails) throw Error("extension requires ui permission"); state.details.push(r); return null; }
      if (r.op === "save_page" || r.op === "comment_page") {
        if (!state.page.editable) throw Error("read-only document");
        if (state.denySave) throw Error("publish permission revoked");
        if (r.version !== state.page.versionId) throw Error("The document changed. Review the latest version and try again.");
        if (r.op === "comment_page") state.comments.push(r);
        else { state.writes.push(r); state.page.content = String(r.content); state.page.versionId = `v${++state.revision}`; }
        return null;
      }
      throw Error(`Unexpected request: ${r.op}`);
    } } });
  }, { code, styles, content });
  await page.goto("/isolated-panel.html");
  await page.evaluate(() => { document.documentElement.dataset.embedded = "true"; });
  await expect(page.getByRole("button", { name: "Fix watcher @fez Full details" })).toBeVisible();
});

test("missing agent access keeps cards readable; discovery refreshes an open schedule", async ({ page }) => {
  await page.evaluate(() => { Reflect.get(window, "kanbanProbe").page.agents = null; window.dispatchEvent(new Event("fez:page-changed")); });
  await expect(page.getByTitle("ask @fez to pick this up", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Fix watcher @fez Full details" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "kanbanProbe").details.length)).toBe(1);
  await page.getByRole("button", { name: "Schedule review", exact: true }).click();
  await page.getByRole("textbox", { name: "Review instructions" }).fill("Preserve my draft");
  await page.evaluate(() => { Reflect.get(window, "kanbanProbe").page.agents = [["a".repeat(64), "fez"], ["b".repeat(64), "new-agent"]]; window.dispatchEvent(new Event("fez:page-changed")); });
  await expect(page.getByTitle("ask @fez to pick this up", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Review instructions" })).toHaveValue("Preserve my draft");
  await expect(page.getByRole("option", { name: "new-agent", exact: false })).toBeAttached();
});

test("shipped board requests host details, assigns, moves a card, and saves its schedule through the broker", async ({ page }) => {
  await page.getByRole("button", { name: "Fix watcher @fez Full details" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "kanbanProbe").details)).toEqual([
    { op: "show_details", title: "Fix watcher @fez", body: "Full details of the watcher fix.", context: "Backlog" },
  ]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "kanbanProbe").shortcuts)).toEqual([]);
  await page.getByTitle("ask @fez to pick this up", { exact: false }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "kanbanProbe").comments.length)).toBe(1);
  const progress = page.locator(".board-column").filter({ has: page.locator(".board-column-name", { hasText: /^In Progress$/ }) });
  await page.locator(".board-card").dragTo(progress);
  await expect(progress.locator(".board-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Schedule review", exact: true }).click();
  await page.getByRole("textbox", { name: "Time zone" }).fill("UTC");
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const state = await page.evaluate(() => Reflect.get(window, "kanbanProbe"));
  expect(state.config.reviews[0]).toMatchObject({ slug: "test-board", channelId: "test-channel", worker: "a".repeat(64), timeZone: "UTC" });
  expect(state.writes[0]).toMatchObject({ op: "save_page", version: "v1" });
  expect(state.comments[0]).toMatchObject({ op: "comment_page", version: "v1", mentions: ["fez"], anchor: "- [ ] Fix watcher @fez" });
  expect(state.writes[0]).not.toHaveProperty("channelId");
});

test("live updates preserve the open form and adding a card keeps another agent's edit", async ({ page }) => {
  await page.getByRole("button", { name: "Schedule review", exact: true }).click();
  await page.getByRole("textbox", { name: "Review instructions" }).fill("Keep this unfinished draft");
  await page.getByTitle("add a card to Backlog", { exact: true }).click();
  await page.getByPlaceholder("card… @agent to give it to someone").fill("My new card");
  await page.evaluate(() => {
    const state = Reflect.get(window, "kanbanProbe");
    state.page.content = state.page.content.replace("## Review", "## Review\n\n- [ ] Another agent's card");
    state.page.versionId = `v${++state.revision}`;
    window.dispatchEvent(new Event("fez:page-changed"));
  });
  await expect(page.getByRole("button", { name: "Another agent's card" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Review instructions" })).toHaveValue("Keep this unfinished draft");
  await expect(page.getByPlaceholder("card… @agent to give it to someone")).toHaveValue("My new card");
  await page.getByPlaceholder("card… @agent to give it to someone").press("Enter");
  await expect(page.getByRole("button", { name: "My new card" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Another agent's card" })).toBeVisible();
  await page.setViewportSize({ width: 650, height: 500 });
  expect(await page.locator(".board-columns").evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, "kanbanProbe").writes[0].version)).toBe("v2");
});

test("stale and revoked writes surface errors; read-only boards still open details", async ({ page }) => {
  await page.getByTitle("add a card to Backlog", { exact: true }).click();
  await page.getByPlaceholder("card… @agent to give it to someone").fill("Stale edit");
  await page.evaluate(() => {
    const state = Reflect.get(window, "kanbanProbe");
    state.page.versionId = `v${++state.revision}`;
    state.page.content += "\n- [x] Remote fix\n";
  });
  await page.getByPlaceholder("card… @agent to give it to someone").press("Enter");
  await expect(page.locator(".board-error")).toContainText("document changed");
  await expect(page.getByRole("button", { name: "Remote fix" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stale edit" })).toHaveCount(0);
  await page.evaluate(() => { Reflect.get(window, "kanbanProbe").denySave = true; });
  await page.getByTitle("ask @fez to pick this up", { exact: false }).click();
  await expect(page.locator(".board-error")).toContainText("publish permission revoked");
  await page.evaluate(() => { Reflect.get(window, "kanbanProbe").page.editable = false; window.dispatchEvent(new Event("fez:page-changed")); });
  await expect(page.getByTitle("add a card to Backlog", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Fix watcher @fez Full details" }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "kanbanProbe").details.length)).toBe(1);
  await page.evaluate(() => { Reflect.get(window, "kanbanProbe").denyDetails = true; });
  await page.getByRole("button", { name: "Fix watcher @fez Full details" }).click();
  await expect(page.getByRole("alert")).toContainText("ui permission");
  expect(await page.evaluate(() => Reflect.get(window, "kanbanProbe").writes)).toEqual([]);
});
