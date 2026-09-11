// @vitest-environment jsdom
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react"), { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("offers write-only Slack token slots and explicit source and destination settings; mounting never connects", async () => {
  const code = execFileSync(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"), [resolve(__dirname, "../../fez-slack/src/gui.tsx"), "--bundle", "--format=iife", "--global-name=Slack", "--jsx-factory=h"], { encoding: "utf8" });
  const activate = new Function(`${code}; return Slack.default;`)();
  let panel: unknown;
  const set = vi.fn(async () => {}), save = vi.fn(async () => {});
  activate({ React, client: { agents: () => new Map([["a".repeat(64), "worker"]]), listChannels: async () => [{ id: "work", name: "work" }], extensionConfig: async () => undefined, saveExtensionConfig: save }, secrets: { set, has: async () => false }, registerSettingsPanel: (_name: string, render: () => unknown) => { panel = render(); } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await React.act(async () => root.render(panel));
    expect(host.textContent).toContain("Slack workspace ID");
    expect(host.textContent).toContain("Allowed Slack user IDs");
    expect(host.textContent).toContain("Fez agent");
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(2);
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect(set).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  } finally { await React.act(async () => root.unmount()); host.remove(); }
});
