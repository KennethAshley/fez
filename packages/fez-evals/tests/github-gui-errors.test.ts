// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("background keychain checks and config refreshes preserve the failed connection's error", async () => {
  vi.useFakeTimers();
  const code = execFileSync(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"), [
    resolve(__dirname, "../../fez-github/src/gui.tsx"), "--bundle", "--format=iife", "--global-name=GitHub", "--jsx-factory=h",
  ], { encoding: "utf8" });
  const activate = new Function(`${code}; return GitHub.default;`)();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let panel: unknown;
  let rejectFetch!: (error: Error) => void;
  const response = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  const has = vi.fn(async () => { throw Error("keychain access failed"); });
  let denyReload = false;
  activate({
    React, secrets: { has }, fetch: () => response,
    client: {
      extensionConfig: async () => { if (denyReload) throw Error("config refresh failed"); return {}; },
      listChannels: async () => [], createChannel: async () => "unused",
    },
    registerSettingsPanel: (_name: string, render: () => unknown) => { panel = render(); },
  });
  try {
    await React.act(async () => root.render(panel));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("keychain access failed");
    await React.act(async () => host.querySelector("button")!.click());
    await React.act(async () => rejectFetch(Error("network permission denied")));
    expect(has.mock.calls.length).toBeGreaterThan(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("network permission denied");
    denyReload = true;
    await React.act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("network permission denied");
    expect(host.querySelector("button")?.disabled).toBe(false);
  } finally {
    await React.act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
