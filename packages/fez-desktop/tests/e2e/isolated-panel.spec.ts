import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const code = readFileSync(new URL("../../../fez-elevenlabs/dist/gui.js", import.meta.url), "utf8");

test("the shipped voice panel saves through the narrow broker and shows denied writes", async ({ page }) => {
  await page.addInitScript(({ code }) => {
    const data: Record<string, unknown> = {};
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: { op: string; key: string; value: unknown } }) => {
      if (command !== "isolated_panel_request") throw new Error(`native command denied: ${command}`);
      const { op, key, value } = args.request;
      if (op === "bootstrap") return { name: "elevenlabs", code, styles: "", client: true, agents: [["a".repeat(64), "fez"]] };
      if (op === "get_preference") return key in data ? { value: data[key] } : {};
      if (op === "set_preference") {
        if (data[key]) throw new Error("extension requires ui permission");
        data[key] = value;
        return null;
      }
      throw new Error("unknown operation");
    } } });
  }, { code });
  await page.goto("/isolated-panel.html");
  await expect(page.getByText("@fez", { exact: true })).toBeVisible();
  const select = page.getByRole("combobox");
  await select.selectOption("CwhRBWXzGAHq8TQ4Fs17");
  await expect(select).toHaveValue("CwhRBWXzGAHq8TQ4Fs17");
  await select.selectOption("EXAVITQu4vr4xnSDxMaL");
  await expect(page.getByRole("alert")).toContainText("ui permission");
  await expect(select).toHaveValue("CwhRBWXzGAHq8TQ4Fs17");
  await page.getByRole("button", { name: "Preview Roger" }).click();
  await expect(page.getByRole("alert")).toContainText("preview is unavailable");
});

test("mount callbacks run in the isolated document and dispose when the panel closes", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => ({
      name: "mount-test", styles: "", client: false, agents: null,
      code: `var __fezExt = {default(api) { api.registerSettingsPanel("mount", host => {
        host.textContent = "Mounted inside isolated document";
        return () => { document.body.dataset.disposed = "yes"; };
      }); }};`,
    }) } });
  });
  await page.goto("/isolated-panel.html");
  await expect(page.getByText("Mounted inside isolated document")).toBeVisible();
  await expect(page.getByRole("heading", { name: "mount-test settings" })).toBeVisible();
  await expect(page).toHaveTitle("mount-test settings · Fez");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.locator("body")).toHaveAttribute("data-disposed", "yes");
  await expect(page.getByText("Mounted inside isolated document")).toHaveCount(0);
});

const githubCode = readFileSync(new URL("../../../fez-github/dist/gui.js", import.meta.url), "utf8");

test("GitHub connects through the broker and keeps denied watch and triage changes unsaved", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ code }) => {
    const calls: Record<string, unknown>[] = [];
    const state = { config: { repos: [] as string[], available: [] as { repo: string; private: boolean }[], triage: [] as string[] }, token: false, denySave: false, denyLink: false };
    Object.assign(window, { githubProbe: { calls, state }, __TAURI_INTERNALS__: { invoke: async (command: string, args: { request: Record<string, unknown> }) => {
      if (command !== "isolated_panel_request") throw new Error("native command denied");
      const r = args.request;
      calls.push(r);
      if (r.op === "bootstrap") return { name: "github", code, styles: "", client: true, agents: null };
      if (r.op === "get_config") return { value: state.config };
      if (r.op === "list_channels") return [{ id: "work-id", name: "work" }];
      if (r.op === "set_config") {
        if (state.denySave) throw new Error("extension requires publish permission");
        state.config = structuredClone(r.value) as typeof state.config;
        return null;
      }
      if (r.op === "has_secret") return state.token;
      if (r.op === "set_secret") { if (r.key === "token") state.token = true; return null; }
      if (r.op === "open_url") { if (state.denyLink) throw new Error("network permission revoked"); return null; }
      if (r.op === "http_request") {
        const url = String(r.url);
        let body: unknown;
        if (url === "https://github.com/login/device/code") body = { device_code: "fake-device", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0 };
        else if (url === "https://github.com/login/oauth/access_token") body = { access_token: "test-token", token_type: "bearer", scope: "", refresh_token: "test-refresh", expires_in: 28800, refresh_token_expires_in: 15897600 };
        else if (url === "https://api.github.com/user") body = { login: "fixture-user" };
        else if (url.startsWith("https://api.github.com/user/installations?")) body = { installations: [{ id: 1 }] };
        else if (url.startsWith("https://api.github.com/user/installations/1/repositories?")) body = { repositories: [{ full_name: "fixture/project", private: true }] };
        else throw new Error(`Unexpected HTTP request: ${url}`);
        return { status: 200, headers: [["content-type", "application/json"], ["date", new Date().toUTCString()]], body: JSON.stringify(body), url };
      }
      throw new Error(`unknown operation: ${r.op}`);
    } } });
  }, { code: githubCode });
  await page.goto("/isolated-panel.html");
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page.getByText("connected as fixture-user · read-only")).toBeVisible();
  await expect(page.getByText("fixture/project", { exact: false })).toBeVisible();
  await page.getByRole("combobox", { name: "Channel for fixture/project" }).selectOption("work-id");
  await page.getByRole("button", { name: "watch", exact: true }).click();
  await page.getByRole("button", { name: "triage off", exact: true }).click();
  await expect(page.getByRole("button", { name: "triage on", exact: true })).toBeVisible();
  await page.evaluate(() => { Reflect.get(window, "githubProbe").state.denySave = true; });
  await page.getByRole("button", { name: "triage on", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("publish permission");
  await expect(page.getByRole("button", { name: "triage on", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop watching", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop watching", exact: true })).toBeVisible();
  await page.evaluate(() => { Reflect.get(window, "githubProbe").state.denyLink = true; });
  await page.getByRole("button", { name: "Add or remove repositories on GitHub" }).click();
  await expect(page.getByRole("alert")).toContainText("network permission revoked");
  const probe = await page.evaluate(() => Reflect.get(window, "githubProbe"));
  expect(probe.state.config).toMatchObject({ repos: ["fixture/project"], triage: ["fixture/project"], channelIds: { "fixture/project": "work-id" } });
  expect(probe.calls.filter((r: { op: string }) => r.op === "set_secret").map((r: { key: string }) => r.key)).toEqual(["client_id", "token", "refresh"]);
  expect(probe.calls.some((r: { op: string; url?: string }) => r.op === "open_url" && r.url?.includes("user_code=ABCD-EFGH"))).toBe(true);
  expect(errors).toEqual([]);
});


test("GitHub reports keychain and network denials instead of leaving login pending", async ({ page }) => {
  await page.addInitScript(({ code }) => {
    Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (_command: string, args: { request: { op: string } }) => {
      const { op } = args.request;
      if (op === "bootstrap") return { name: "github", code, styles: "", client: true, agents: null };
      if (op === "get_config") return {};
      if (op === "list_channels") return [];
      if (op === "has_secret") throw new Error("keychain access failed");
      if (op === "http_request") throw new Error("extension requires network:github.com permission");
      throw new Error(`Unexpected operation: ${op}`);
    } } });
  }, { code: githubCode });
  await page.goto("/isolated-panel.html");
  await expect(page.getByRole("alert")).toContainText("keychain access failed");
  await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("network:github.com permission");
  await expect(page.getByRole("button", { name: "Connect GitHub", exact: true })).toBeEnabled();
});


test("GitHub creates an ordinary channel and retries a denied watch without creating twice", async ({ page }) => {
  await page.addInitScript(({ code }) => {
    const state = {
      config: { repos: [], available: [{ repo: "fixture/project", private: false }] },
      channels: [] as { id: string; name: string }[], creates: [] as Record<string, unknown>[], denyCreate: true, denySave: true,
    };
    Object.assign(window, { githubDestinationProbe: state, __TAURI_INTERNALS__: { invoke: async (_command: string, args: { request: Record<string, unknown> }) => {
      const r = args.request;
      if (r.op === "bootstrap") return { name: "github", code, styles: "", client: true, agents: null };
      if (r.op === "has_secret") return true;
      if (r.op === "get_config") return { value: state.config };
      if (r.op === "list_channels") return state.channels;
      if (r.op === "create_channel") {
        if (state.denyCreate) throw new Error("only the workspace owner can add channels");
        state.creates.push(r);
        state.channels.push({ id: "created-id", name: String(r.name) });
        return "created-id";
      }
      if (r.op === "set_config") {
        if (state.denySave) throw new Error("relay write failed");
        state.config = structuredClone(r.value) as typeof state.config;
        return null;
      }
      throw new Error(`Unexpected operation: ${r.op}`);
    } } });
  }, { code: githubCode });
  await page.goto("/isolated-panel.html");
  const select = page.getByRole("combobox", { name: "Channel for fixture/project" });
  await select.selectOption("__new__");
  await page.getByRole("textbox", { name: "New channel name for fixture/project" }).fill("Engineering");
  await page.getByRole("button", { name: "watch", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("only the workspace owner");
  await page.evaluate(() => { Reflect.get(window, "githubDestinationProbe").denyCreate = false; });
  await page.getByRole("button", { name: "watch", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("relay write failed");
  await expect(select).toHaveValue("created-id");
  await expect(page.getByRole("button", { name: "Stop watching", exact: true })).toHaveCount(0);
  await page.evaluate(() => { Reflect.get(window, "githubDestinationProbe").denySave = false; });
  await page.getByRole("button", { name: "watch", exact: true }).click();
  await expect(page.getByText("Posting to #Engineering")).toBeVisible();
  const state = await page.evaluate(() => Reflect.get(window, "githubDestinationProbe"));
  expect(state.creates).toEqual([{ op: "create_channel", name: "Engineering" }]);
  expect(state.config.channelIds).toEqual({ "fixture/project": "created-id" });
});
