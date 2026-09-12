// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { DeclarativeSettings, type SettingsHost } from "../../fez-desktop/src/DeclarativeSettings.js";
import { parseDeclarativeGui } from "../../fez-desktop/src/declarative-gui.js";

const sections = parseDeclarativeGui(readFileSync(resolve(__dirname, "../../fez-browser/src/gui.json"), "utf8")).settings!;
let root: ReturnType<typeof createRoot>;
let host: SettingsHost;
beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.getElementById("root")!);
  host = { permissions: ["ui", "processes"],
    run: vi.fn(async () => ({ code: 0, stdout: '{"phase":"missing","message":"Set up first"}', stderr: "" })),
    spawn: vi.fn(async () => { throw Error("Download unavailable"); }), isRunning: vi.fn(async () => false),
    agents: () => [], readPreference: async () => undefined, writePreference: async () => {}, allowPreview: () => {},
  };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = () => act(async () => root.render(React.createElement(DeclarativeSettings, { sections, host })));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === label)!;

describe("Browser declarative settings", () => {
  it("explains a missing process grant without offering unusable actions or polling", async () => {
    host.permissions = ["ui"];
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("processes");
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(host.run).not.toHaveBeenCalled();
  });
  it("uses the package-owned setup job and displays spawn failures", async () => {
    await render();
    await act(async () => button("Set up browser").click());
    expect(host.spawn).toHaveBeenCalledWith("fez-browser", "fez-browser-setup", { FEZ_BROWSER_ACTION: "setup" });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Download unavailable");
  });
  it("detects stopped setup jobs, permits retry, and stops polling when the panel closes", async () => {
    vi.useFakeTimers();
    host.run = vi.fn(async () => ({ code: 0, stdout: '{"phase":"working","message":"Downloading"}', stderr: "" }));
    await render();
    expect(document.body.textContent).toContain("Setup stopped before finishing");
    expect(button("Set up browser").disabled).toBe(false);
    expect(button("Test browser").disabled).toBe(false);
    expect(host.isRunning).toHaveBeenCalledWith("fez-browser", "fez-browser-setup");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(host.run).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(host.run).toHaveBeenCalledTimes(2);
  });
  it("shows ready state, sends the test action, and reports both failure and success", async () => {
    host.run = vi.fn(async (_bin, args) => ({ code: args[0] === "test" ? 1 : 0, stdout: '{"phase":"ready","message":"Ready to browse"}', stderr: "Browser unavailable" }));
    await render();
    expect(button("Set up browser")).toBeUndefined();
    await act(async () => button("Test browser").click());
    expect(host.run).toHaveBeenCalledWith("fez-browser", ["test"]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Browser unavailable");
    vi.mocked(host.run).mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await act(async () => button("Test browser").click());
    expect(document.body.textContent).toContain("Browser test passed. You can ask an attached agent to browse.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it("rejects malformed status output and disables duplicate setup while starting", async () => {
    host.run = vi.fn(async () => ({ code: 0, stdout: '{"phase":"<script>","message":"oops"}', stderr: "" }));
    let complete!: () => void;
    host.spawn = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Unexpected process status");
    await act(async () => { button("Set up browser").click(); button("Set up browser").click(); });
    expect(host.spawn).toHaveBeenCalledTimes(1);
    expect(button("Set up browser").disabled).toBe(true);
    await act(async () => complete());
    expect(document.body.textContent).toContain("Starting browser setup…");
  });
});
