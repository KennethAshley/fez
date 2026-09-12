// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseFrontmatter } from "../../../src/identity/personas.js";
import { reflectionConfig } from "../../fez-client/src/reflection.js";
import PersonaEditor from "../../fez-desktop/src/PersonaEditor";

const { native, notice } = vi.hoisted(() => ({
  native: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  notice: vi.fn(),
}));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: native }));
vi.mock("../../fez-desktop/src/toast", () => ({ flash: notice }));
vi.mock("../../fez-desktop/src/SkillPicker", () => ({ default: () => null }));
vi.mock("../../fez-desktop/src/Avatar", () => ({ default: () => null }));
vi.mock("../../fez-desktop/src/ModelPicker", () => ({ ModelPicker: () => null }));

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let persona: string;
beforeEach(() => {
  persona = "---\nharness: pi\nmodel: keep-model\nrespondTo: owner\ncustomExtension: keep-me\n---\n\nKeep these instructions.\n";
  native.mockImplementation(async (command, args) => {
    switch (command) {
      case "read_persona": return persona;
      case "list_personas": return ["scout"];
      case "agent_alive": return true;
      case "update_persona": persona = String(args!.content); return;
      default: throw new Error(`Unexpected native command: ${command}`);
    }
  });
});
afterEach(() => { native.mockReset(); notice.mockReset(); });

async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(PersonaEditor, { name: "scout", onDone: () => {} })));
  const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
  const control = (label: string) => {
    const forId = [...host.querySelectorAll("label")].find(l => l.textContent === label)?.htmlFor;
    const element = forId ? host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${forId}`) : null;
    expect(element, `control labelled ${label}`).toBeTruthy();
    return element!;
  };
  return {
    host, button, control,
    toggle: async () => {
      const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Periodic reflection"]');
      expect(toggle, "reflection switch").not.toBeNull();
      await React.act(async () => toggle!.click());
    },
    change: async (label: string, value: string) => {
      const element = control(label);
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      await React.act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    save: async () => { await React.act(async () => button("save").click()); },
    close: async () => { await React.act(async () => root.unmount()); host.remove(); },
  };
}

it("enables reflection from the editor and saves a runtime-readable configuration without stopping work", async () => {
  const p = await mount();
  try {
    expect(p.host.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(p.button("save").disabled).toBe(true);
    await p.toggle();
    await p.change("Check every", "2h");
    await p.change("Reflection instructions", "Check docs.\nrespondTo: anyone");
    await p.save();
    const parsed = parseFrontmatter(persona);
    expect(reflectionConfig(parsed.extra, {})).toEqual({ everyMs: 7_200_000, prompt: "Check docs. respondTo: anyone" });
    expect(parsed.extra.respondTo).toBe("owner");
    expect(parsed.extra.model).toBe("keep-model");
    expect(parsed.extra.customExtension).toBe("keep-me");
    expect(persona).toContain("Keep these instructions.");
    expect(native.mock.calls.some(([command]) => command === "kill_agent" || command === "spawn_agent")).toBe(false);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/restart.*apply/i));
  } finally { await p.close(); }
});

it("loads custom intervals, retains the draft when toggled, and disables reflection without deleting its instructions", async () => {
  persona = persona.replace("model: keep-model", "model: keep-model\nreflectionEvery: 90s\nreflectionPrompt: Check docs.");
  const p = await mount();
  try {
    expect(p.control("Check every").value).toBe("90s");
    expect(p.control("Reflection instructions").value).toBe("Check docs.");
    expect(p.button("save").disabled).toBe(true);
    await p.toggle();
    await p.toggle();
    expect(p.control("Check every").value).toBe("90s");
    expect(p.button("save").disabled).toBe(true);
    await p.toggle();
    await p.save();
    const parsed = parseFrontmatter(persona);
    expect(reflectionConfig(parsed.extra, {})).toBeUndefined();
    expect(parsed.extra.reflectionPrompt).toBe("Check docs.");
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/restart.*apply/i));
  } finally { await p.close(); }
});

it("blocks unsafe intervals before saving and accepts a corrected interval with the default prompt", async () => {
  const original = persona;
  const p = await mount();
  try {
    await p.toggle();
    for (const invalid of ["", "59s", "30d", "often"]) {
      await p.change("Check every", invalid);
      expect(p.button("save").disabled).toBe(true);
      expect(p.control("Check every").getAttribute("aria-invalid")).toBe("true");
      expect(p.host.querySelector('[role="alert"]')?.textContent).toMatch(/interval|duration/i);
      await p.save();
      expect(persona).toBe(original);
    }
    await p.change("Check every", "1m");
    expect(p.button("save").disabled).toBe(false);
    await p.save();
    const parsed = parseFrontmatter(persona);
    expect(parsed.extra.reflectionPrompt).toBeUndefined();
    expect(reflectionConfig(parsed.extra, {})?.everyMs).toBe(60_000);
    expect(reflectionConfig(parsed.extra, {})?.prompt).toMatch(/standing responsibilities/);
  } finally { await p.close(); }
});

it("does not offer the standing-agent timer for the router runtime", async () => {
  persona = persona.replace("harness: pi", "harness: router");
  const p = await mount();
  try { expect(p.host.querySelector('[role="switch"][aria-label="Periodic reflection"]')).toBeNull(); }
  finally { await p.close(); }
});

it("clears an explicitly blank prompt so the runtime can use its default", async () => {
  persona = persona.replace("model: keep-model", "model: keep-model\nreflectionEvery: off\nreflectionPrompt: ");
  const p = await mount();
  try {
    await p.toggle();
    await p.save();
    const parsed = parseFrontmatter(persona);
    expect(parsed.extra.reflectionPrompt).toBeUndefined();
    expect(reflectionConfig(parsed.extra, {})?.prompt).toMatch(/standing responsibilities/);
  } finally { await p.close(); }
});

it("reads the effective duplicate values and removes stale values when disabling reflection", async () => {
  persona = persona.replace("model: keep-model", "model: keep-model\nreflectionEvery: 2h\nreflectionEvery: 90s\nreflectionPrompt: Old instructions.\nreflectionPrompt: Current instructions.");
  const p = await mount();
  try {
    expect(p.control("Check every").value).toBe("90s");
    expect(p.control("Reflection instructions").value).toBe("Current instructions.");
    await p.change("Reflection instructions", "");
    await p.toggle();
    await p.save();
    const parsed = parseFrontmatter(persona);
    expect(parsed.extra.reflectionPrompt).toBeUndefined();
    expect(reflectionConfig(parsed.extra, {})).toBeUndefined();
    expect(persona.match(/^reflectionEvery:/gm)).toHaveLength(1);
  } finally { await p.close(); }
});
