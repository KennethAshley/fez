// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { ModelPicker } from "../../fez-desktop/src/ModelPicker";
import { listModelProviders, registerModelProvider, snapshotModelProviders } from "../../fez-desktop/src/model-providers";

const { native } = vi.hoisted(() => ({ native: vi.fn<(command: string) => Promise<unknown>>() }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: native }));

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react");
const { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const restore = snapshotModelProviders();
afterEach(() => { restore(); native.mockReset(); });

async function mount(value: object, onChange = vi.fn()) {
  native.mockImplementation(async (command) => {
    if (command === "detect_harnesses") return JSON.stringify({ "claude-code": true });
    if (command === "wire_provider_pi") throw Error("No provider key yet");
    throw Error(`Unexpected native call ${command}`);
  });
  const div = document.createElement("div"); document.body.append(div);
  const root = createRoot(div);
  await React.act(async () => root.render(React.createElement(ModelPicker, { value, onChange })));
  return { div, onChange, render: async (next: object) => { await React.act(async () => root.render(React.createElement(ModelPicker, { value: next, onChange }))); }, close: async () => { await React.act(async () => root.unmount()); div.remove(); } };
}

it("offers a contributed model and records its provider profile without preparing on selection", async () => {
  const prepare = vi.fn();
  registerModelProvider("mesh", { id: "ext-mesh-mini", label: "Mini", listModels: async () => [{ id: "local/llama", label: "Llama", status: "ready", detail: "Tools run on this Mac" }], prepare });
  const p = await mount({ harness: "pi", provider: "", model: "" });
  try {
    const option = [...p.div.querySelectorAll("option")].find(o => o.textContent?.includes("Llama"));
    expect(option).toBeDefined();
    await React.act(async () => { const select = p.div.querySelector("select")!; select.value = option!.value; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(p.onChange).toHaveBeenCalledWith({ harness: "pi", provider: "ext-mesh-mini", model: "local/llama", modelProfile: "ext-mesh-mini" });
    expect(prepare).not.toHaveBeenCalled();
    await p.render({ harness: "pi", provider: "ext-mesh-mini", model: "local/llama", modelProfile: "ext-mesh-mini" });
    expect(p.div.textContent).toContain("Mini");
    expect(p.div.textContent).toContain("Tools run on this Mac");
  } finally { await p.close(); }
});

it("keeps an offline selected model and clears its profile when choosing a built-in", async () => {
  registerModelProvider("mesh", { id: "ext-mesh-mini", label: "Mini", listModels: async () => [{ id: "local/llama", label: "Llama", status: "offline", detail: "Mini is sleeping" }], prepare: async () => {} });
  const p = await mount({ harness: "pi", provider: "ext-mesh-mini", model: "local/llama", modelProfile: "ext-mesh-mini" });
  try {
    expect(p.div.querySelector("select")?.selectedOptions[0].textContent).toMatch(/Llama.*offline/i);
    expect(p.div.textContent).toContain("Mini is sleeping");
    const select = p.div.querySelector("select")!;
    await React.act(async () => { select.value = "claude-code"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(p.onChange).toHaveBeenCalledWith({ harness: "claude-code", provider: "", model: "", modelProfile: "" });
  } finally { await p.close(); }
});

it("shows an unavailable saved provider without clearing its selection", async () => {
  const p = await mount({ harness: "pi", provider: "ext-mesh-mini", model: "local/llama", modelProfile: "ext-mesh-mini" });
  try {
    expect(p.div.querySelector("select")?.selectedOptions[0].textContent).toMatch(/local\/llama.*unavailable/i);
    expect(p.onChange).not.toHaveBeenCalled();
  } finally { await p.close(); }
});

it("keeps provider failure visible alongside another provider's models", async () => {
  registerModelProvider("mesh", { id: "ext-mesh-mini", label: "Mini", listModels: async () => { throw Error("Mini unavailable"); }, prepare: async () => {} });
  registerModelProvider("other", { id: "ext-other-local", label: "Other", listModels: async () => [{ id: "other/model", label: "Other model", status: "ready" }], prepare: async () => {} });
  const items = await listModelProviders();
  expect(items[0].error).toContain("Mini unavailable");
  expect(items[1].models).toEqual([{ id: "other/model", label: "Other model", status: "ready" }]);
  const p = await mount({ harness: "pi", provider: "ext-mesh-mini", model: "local/llama", modelProfile: "ext-mesh-mini" });
  try {
    expect(p.div.textContent).toContain("Mini unavailable");
    expect(p.div.querySelector("select")?.selectedOptions[0].textContent).toMatch(/local\/llama.*unavailable/i);
  } finally { await p.close(); }
});

it("rejects duplicate registrations and invalid model metadata", async () => {
  const provider = { id: "ext-mesh-mini", label: "Mini", listModels: async () => [{ id: "local/llama", label: "Llama", status: "ready" as const }], prepare: async () => {} };
  registerModelProvider("mesh", provider);
  expect(() => registerModelProvider("mesh", provider)).toThrow(/already registered/);
  expect(() => registerModelProvider("other", { ...provider, id: "ext-fezchat-mesh-other" })).toThrow(/Invalid model provider/);
  expect(await listModelProviders()).toHaveLength(1);
});
