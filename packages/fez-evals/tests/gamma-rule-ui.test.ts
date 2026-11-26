// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseFrontmatter } from "../../../src/identity/personas.js";
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
  persona = "---\nharness: pi\nmodel: keep-model\nspendCapUsd: 5\n---\n\nKeep these instructions.\n";
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

// The owner sets a daily dollar limit in the persona editor; the wallet reads
// it back through the core parser as `gammaDailyUsd` on every purchase.
it("saves the owner's daily gamma limit where the wallet reads it, and nothing else changes", async () => {
  const p = await mount();
  try {
    const input = p.control("Gamma daily limit") as HTMLInputElement;
    expect([input.type, input.min, input.value]).toEqual(["number", "0", ""]);
    await p.change("Gamma daily limit", "2.5");
    await p.save();
    const saved = parseFrontmatter(persona);
    expect(saved.extra).toMatchObject({ gammaDailyUsd: "2.5", spendCapUsd: "5", model: "keep-model" });
    expect(Number(saved.extra.gammaDailyUsd)).toBe(2.5);
    expect(saved.body).toBe("Keep these instructions.");
  } finally { await p.close(); }
});

it("shows an existing limit and removes it when cleared", async () => {
  persona = persona.replace("spendCapUsd: 5", "spendCapUsd: 5\ngammaDailyUsd: 1");
  const p = await mount();
  try {
    expect(p.control("Gamma daily limit").value).toBe("1");
    await p.change("Gamma daily limit", "");
    await p.save();
    expect(parseFrontmatter(persona).extra.gammaDailyUsd).toBeUndefined();
  } finally { await p.close(); }
});
