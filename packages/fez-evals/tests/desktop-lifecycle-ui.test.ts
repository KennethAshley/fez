// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import PersonaEditor from "../../fez-desktop/src/PersonaEditor";
import AiSetupDialog from "../../fez-desktop/src/AiSetupDialog";
import QuitDialog from "../../fez-desktop/src/QuitDialog";

const { native, notice, quitListeners } = vi.hoisted(() => ({
  quitListeners: new Set<() => void>(),
  native: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  notice: vi.fn(),
}));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: native }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/event.js", () => ({
  listen: async (event: string, callback: () => void) => {
    expect(event).toBe("fez-quit-requested");
    quitListeners.add(callback);
    return () => quitListeners.delete(callback);
  },
}));
vi.mock("../../fez-desktop/src/toast", () => ({ flash: notice, toast: { error: notice } }));
vi.mock("../../fez-desktop/src/SkillPicker", () => ({ default: () => null }));
vi.mock("../../fez-desktop/src/Avatar", () => ({ default: () => null }));
vi.mock("../../fez-desktop/src/ModelPicker", () => ({
  ModelPicker: ({ onChange }: { onChange: (brain: object) => void }) => React.createElement("button", {
    onClick: () => onChange({ harness: "pi", provider: "chutes", model: "new-model" }),
  }, "choose model"),
}));
vi.mock("../../fez-desktop/src/Onboarding", () => ({
  ConnectAiStep: ({ setBrain, onNext }: { setBrain: (brain: object) => void; onNext: () => void }) => React.createElement("div", {},
    React.createElement("button", { onClick: () => setBrain({ harness: "pi", provider: "chutes", model: "new-model" }) }, "choose model"),
    React.createElement("button", { onClick: onNext }, "connect")),
}));

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  native.mockImplementation(async (command) => {
    switch (command) {
      case "read_persona": return "---\nharness: pi\n---\n\nKeep this prompt.\n";
      case "list_personas": return ["scout"];
      case "agent_alive": return true;
      case "update_persona": case "kill_agent": return;
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
});
afterEach(() => { vi.restoreAllMocks(); native.mockReset(); notice.mockReset(); });

async function mount(component: unknown) {
  const div = document.createElement("div"); document.body.append(div);
  const root = createRoot(div);
  await React.act(async () => root.render(component));
  return {
    div,
    click: async (text: string) => {
      const button = [...div.querySelectorAll("button")].find(b => b.textContent === text);
      expect(button).toBeDefined();
      await React.act(async () => button!.click());
    },
    close: async () => { await React.act(async () => root.unmount()); div.remove(); },
  };
}

it("saving launch configuration preserves active work and tells the user to restart", async () => {
  const done = vi.fn();
  const p = await mount(React.createElement(PersonaEditor, { name: "scout", onDone: done }));
  try {
    await p.click("choose model");
    await p.click("save");
    expect(native).toHaveBeenCalledWith("update_persona", { name: "scout", content: expect.stringContaining("model: new-model") });
    expect(native.mock.calls.some(([command]) => command === "kill_agent" || command === "spawn_agent")).toBe(false);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/restart.*apply/i));
    expect(done).toHaveBeenCalledWith(true);
  } finally { await p.close(); }
});

it("connecting an AI updates team personas without stopping running agents", async () => {
  const connected = vi.fn();
  const p = await mount(React.createElement(AiSetupDialog, { onConnected: connected, onClose: vi.fn() }));
  try {
    await p.click("choose model");
    await p.click("connect");
    expect(native).toHaveBeenCalledWith("update_persona", { name: "fez", content: expect.stringContaining("model: new-model") });
    expect(native.mock.calls.some(([command]) => command === "kill_agent" || command === "spawn_agent")).toBe(false);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/restart.*apply/i));
    expect(connected).toHaveBeenCalledOnce();
  } finally { await p.close(); }
});

async function requestQuit() {
  await React.act(async () => { for (const callback of quitListeners) callback(); });
}

it("shows one native quit confirmation, supports cancellation, and explicitly stops work", async () => {
  const p = await mount(React.createElement(QuitDialog));
  try {
    expect(p.div.querySelector("dialog")).toBeNull();
    await requestQuit();
    await requestQuit();
    expect(p.div.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(p.div.querySelector("dialog")?.getAttribute("aria-labelledby")).toBe("desktop-quit-title");
    expect(p.div.textContent).toContain("Quit Fez?");
    expect(p.div.textContent).toMatch(/local agents and integrations/i);
    expect(p.div.textContent).toMatch(/active work.*stop/i);
    await p.click("Keep running");
    expect(p.div.querySelector("dialog")).toBeNull();
    expect(native).not.toHaveBeenCalled();
    await requestQuit();
    await React.act(async () => p.div.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(p.div.querySelector("dialog")).toBeNull();
    expect(native).not.toHaveBeenCalled();
    await requestQuit();
    native.mockResolvedValue(undefined);
    await p.click("Quit and stop local work");
    expect(native).toHaveBeenCalledOnce();
    expect(native).toHaveBeenCalledWith("confirm_desktop_quit");
    expect(p.div.textContent).toContain("Stopping local work");
    expect([...p.div.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
  } finally { await p.close(); }
  expect(quitListeners.size).toBe(0);
});

it("keeps a failed quit visible and retryable", async () => {
  const p = await mount(React.createElement(QuitDialog));
  try {
    await requestQuit();
    native.mockRejectedValueOnce(new Error("Couldn't stop the background worker"));
    await p.click("Quit and stop local work");
    expect(p.div.querySelector('[role="alert"]')?.textContent).toContain("Couldn't stop the background worker");
    expect([...p.div.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
    native.mockResolvedValue(undefined);
    await p.click("Quit and stop local work");
    expect(native).toHaveBeenCalledTimes(2);
  } finally { await p.close(); }
});
