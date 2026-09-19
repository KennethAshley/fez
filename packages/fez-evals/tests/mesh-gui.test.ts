// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import activate from "../../fez-mesh/src/gui.js";
import { MODEL_PROVIDER, parseMeshState, type MeshState } from "../../fez-mesh/src/state.js";
import type { GuiExtensionApi } from "../../fez-extension-api/src/gui.js";
const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react"), { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function panel(permission = true) {
  const state: MeshState = { configured: true, provider: MODEL_PROVIDER, model: "fez-mini-qwen3-4b", label: "Mac mini", machine: "ken@kenmini.local", status: "offline", callersVerified: true, callers: [] };
  let failure = "";
  let render!: () => unknown;
  const run = vi.fn(async (_bin: string, args: string[]) => {
    if (failure) return { code: 1, stdout: "", stderr: failure };
    if (args[0] === "start") state.status = "ready";
    if (args[0] === "stop") state.status = "offline";
    if (args[0] === "connect") state.callers = [{ persona: args[2], pubkey: "a".repeat(64) }];
    if (args[0] === "disconnect") state.callers = [];
    return { code: 0, stdout: JSON.stringify(state), stderr: "" };
  });
  activate({ React, ...(permission ? { processes: { run } } : {}),
    registerSettingsPanel: (name: string, r: typeof render) => { expect(name).toBe("Shared Models"); render = r; },
  } as unknown as GuiExtensionApi);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await React.act(async () => root.render(render()));
  const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;
  return { host, run, state, button,
    fail: (message: string) => { failure = message; },
    click: async (label: string) => { expect(button(label).disabled).toBe(false); await React.act(async () => button(label).click()); },
    close: async () => { await React.act(async () => root.unmount()); host.remove(); },
  };
}

it("uses the configured Mini, prepares access only on Save, and revokes it from settings", async () => {
  const p = await panel();
  try {
    expect(p.host.textContent).toContain("Offline");
    expect(p.host.textContent).toContain("ken@kenmini.local");
    expect(p.run.mock.calls.every(([, args]) => args[0] === "state")).toBe(true);
    await p.click("Start");
    expect(p.host.textContent).toContain("Ready");
    // Access is granted from Agents → model (the CLI's `prepare`); the panel only shows and revokes it.
    p.state.callers = [{ persona: "scout", pubkey: "a".repeat(64) }];
    await p.click("Refresh status");
    expect(p.host.textContent).toContain("@scout");
    await p.click("Revoke access");
    expect(p.run).toHaveBeenCalledWith("fez-mesh", ["disconnect", "--name", "scout"]);
    expect(p.host.textContent).not.toContain("@scout");
    await p.click("Stop");
    expect(p.host.textContent).toContain("Offline");
  } finally { await p.close(); }
});

it("shows command failures and keeps explicit retry available", async () => {
  const p = await panel();
  try {
    p.fail("Mini SSH is unavailable");
    await p.click("Start");
    expect(p.host.querySelector('[role="alert"]')?.textContent).toContain("Mini SSH is unavailable");
    expect(p.button("Start").disabled).toBe(false);
    expect(p.run.mock.calls.filter(([, args]) => args[0] === "start")).toHaveLength(1);
  } finally { await p.close(); }
});

it("explains a missing processes permission", async () => {
  const p = await panel(false);
  try {
    expect(p.host.textContent).toContain("processes permission");
    expect(p.run.mock.calls.some(([, args]) => args[0] !== "state")).toBe(false);
  } finally { await p.close(); }
});

it("sanitizes malformed CLI responses and retains only public data", () => {
  expect(() => parseMeshState('{"token":"secret-token"')).toThrow("invalid status");
  const result = parseMeshState(JSON.stringify({ configured: true, provider: MODEL_PROVIDER, model: "qwen", label: "Mini", machine: "mini", status: "ready", callersVerified: true, token: "private", callers: [{ persona: "scout", pubkey: "a".repeat(64), tokenHash: "private" }] }));
  expect(JSON.stringify(result)).not.toContain("private");
});

it("distinguishes unverified offline access from an empty allowed list", async () => {
  const p = await panel();
  try {
    p.state.callersVerified = false;
    await p.click("Refresh status");
    expect(p.host.textContent).toContain("Access could not be verified");
    expect(p.host.textContent).not.toContain("Save this model on an agent to grant access");
  } finally { await p.close(); }
});

it("names the provider machine from the CLI rather than from hardcoded prose", async () => {
  const p = await panel();
  try {
    p.state.label = "Studio in the loft";
    await p.click("Refresh status");
    // Section rule and the sentence under the status both read the label;
    // neither may say "Mini" for a box that is not one.
    expect(p.host.textContent).toContain("studio in the loft");
    expect(p.host.textContent).toContain("Thinking runs on Studio in the loft.");
    expect(p.host.textContent).not.toContain("the Mini");
  } finally { await p.close(); }
});
