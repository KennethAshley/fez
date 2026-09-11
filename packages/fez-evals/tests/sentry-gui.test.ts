// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const code = execFileSync(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"), [resolve(__dirname, "../../fez-sentry/src/gui.ts"), "--bundle", "--format=iife", "--global-name=Sentry"], { encoding: "utf8" });
const activate = new Function(`${code}; return Sentry.default;`)();
const worker = "b".repeat(64);
const config = { enabled: true, autoInvestigate: false, origin: "https://sentry.io", organization: "acme", project: "web", repo: "acme/web", channelId: "bugs", worker };

async function mount(overrides: Record<string, unknown> = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); let panel: unknown;
  const save = vi.fn(async () => undefined), set = vi.fn(async () => undefined);
  const api = {
    React, secrets: { has: async () => true, set },
    fetch: vi.fn(async (input: string | URL) => new Response(JSON.stringify(String(input).includes("/projects/") ? { id: "42", slug: "web", organization: { slug: "acme" } } : []))),
    client: { extensionConfig: async () => config, listChannels: async () => [{ id: "bugs", name: "bugs" }, { id: "closed", name: "closed", archived: true }], agents: () => new Map([[worker, "fixer"]]), saveExtensionConfig: save },
    registerSettingsPanel: (_name: string, render: () => unknown) => { panel = render(); }, ...overrides,
  };
  activate(api); await React.act(async () => root.render(panel));
  return { host, api, save, set, close: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}
async function input(element: HTMLInputElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("offers actual agents/channels and saves explicit investigation opt-in without storing secrets in config", async () => {
  const h = await mount();
  try {
    expect([...h.host.querySelectorAll("option")].map(option => option.textContent)).toContain("fixer");
    expect(h.host.textContent).not.toContain("#closed");
    await React.act(async () => (h.host.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).click());
    await React.act(async () => h.host.querySelector("button")!.click());
    expect(h.save).toHaveBeenCalledWith("fez-sentry", expect.objectContaining({ worker, autoInvestigate: true, revision: expect.any(String) }));
    expect(JSON.stringify(h.save.mock.calls)).not.toContain("token");
    expect(h.host.querySelector('[role="status"]')?.textContent).toContain("baseline");
  } finally { await h.close(); }
});

it("validates a pasted token before write-only keychain storage and clears it after saving", async () => {
  const h = await mount();
  try {
    const password = h.host.querySelector('input[type="password"]') as HTMLInputElement;
    await input(password, "test-private-token");
    await React.act(async () => h.host.querySelector("button")!.click());
    expect(h.api.fetch).toHaveBeenCalledTimes(2);
    expect(h.set).toHaveBeenCalledWith("token", "test-private-token");
    expect(password.value).toBe("");
    expect(h.host.textContent).not.toContain("test-private-token");
  } finally { await h.close(); }
});

it("keeps token failures actionable without echoing server response bodies", async () => {
  const h = await mount({ fetch: async () => new Response("test-private-token", { status: 403 }) });
  try {
    await input(h.host.querySelector('input[type="password"]') as HTMLInputElement, "test-private-token");
    await React.act(async () => h.host.querySelector("button")!.click());
    expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("HTTP 403");
    expect(h.host.textContent).not.toContain("test-private-token");
    expect(h.set).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it("reports relay save failure and can retry without reading the stored token", async () => {
  const h = await mount();
  try {
    h.save.mockRejectedValueOnce(Error("relay is unavailable"));
    await React.act(async () => h.host.querySelector("button")!.click());
    expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
    expect(h.host.querySelector("button")!.disabled).toBe(false);
    await React.act(async () => h.host.querySelector("button")!.click());
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
  } finally { await h.close(); }
});
