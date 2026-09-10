import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { InputCard } from "../../fez-desktop/src/AgentInput.js";
import { inputForm } from "../../fez-client/src/agent-input.js";

afterEach(() => vi.unstubAllGlobals());

it("renders every question, submits choices and custom text together, and keeps failed submissions editable", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  for (const key of ["window", "document", "FormData", "HTMLElement"] as const) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const form = inputForm({ mode: "form", message: "Build preferences", requestedSchema: { properties: {
    layout: { type: "string", title: "Layout", oneOf: [{ const: "grid", title: "Grid" }] },
    features: { type: "array", title: "Features", items: { anyOf: [{ const: "search", title: "Search" }, { const: "filters", title: "Filters" }] } },
    custom: { type: "string", title: "Other" },
  } } });
  const onAnswer = vi.fn().mockRejectedValueOnce(new Error("Relay unavailable")).mockResolvedValue(undefined);
  try {
    await act(async () => root.render(React.createElement(InputCard, { request: { id: "agent:request", requestId: "request", agentPk: "agent", expiresAt: Date.now() + 60_000, form }, name: "quill", onAnswer })));
    expect(document.querySelectorAll("fieldset.input-question")).toHaveLength(3);
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')) input.click();
    (document.querySelector('textarea[name="custom"]') as HTMLTextAreaElement).value = "compact";
    const submit = () => document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await act(async () => { submit(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Relay unavailable");
    expect(document.querySelector("button[type=submit]")?.hasAttribute("disabled")).toBe(false);
    await act(async () => { submit(); });
    expect(onAnswer).toHaveBeenLastCalledWith({ action: "accept", content: { layout: "grid", features: ["search", "filters"], custom: "compact" } });
    expect(document.body.textContent).toContain("Waiting for agent");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
