import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import AgentInput, { QuestionRow } from "../../fez-desktop/src/AgentInput.js";
import type { FezClient, InputHistoryEntry } from "../../fez-client/src/index.js";
import { inputForm } from "../../fez-client/src/agent-input.js";

vi.mock("../../fez-desktop/src/notify.js", () => ({ notifyEvent: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fez.test" });
  for (const key of ["window", "document", "FormData", "HTMLElement", "localStorage"] as const) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const entry: InputHistoryEntry = {
    id: "agent:question", requestId: "question", agentPk: "agent", requestedAt: Date.now(), expiresAt: Date.now() + 60_000, status: "pending",
    form: inputForm({ mode: "form", message: "Preferences", requestedSchema: { properties: {
      layout: { type: "string", title: "Layout", enum: ["Grid", "List"] },
      features: { type: "array", title: "Features", items: { enum: ["Search", "Filters"] } },
      custom: { type: "string", title: "Details", minLength: 10 },
      enabled: { type: "boolean", title: "Enabled" },
      count: { type: "integer", title: "Count" },
      email: { type: "string", title: "Email", format: "email" },
    }, required: ["layout", "custom"] } }),
  };
  const answerInput = vi.fn().mockResolvedValue(undefined);
  const listeners = new Set<() => void>();
  const client = {
    pubkey: "owner", displayName: () => "quill", answerInput,
    pendingInputs: () => entry.status === "pending" || entry.status === "sent" ? [entry] : [],
    inputHistory: () => [entry], loadInputHistory: async () => {}, on: (event: string, listener: () => void) => {
      if (event === "inputsChanged") listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as FezClient;
  const mount = () => act(async () => root.render(React.createElement(QuestionRow, { client, entry })));
  const leave = () => act(async () => root.render(null));
  const input = (selector: string) => document.querySelector(selector) as HTMLInputElement;
  const edit = async (selector: string, value: string) => act(async () => {
    input(selector).value = value;
    input(selector).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const submit = () => act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  const send = async () => {
    for (let i = 0; i < entry.form.fields.length && document.querySelector('button[type="submit"]')?.textContent === "Next"; i++) await submit();
    await submit();
  };
  const dispose = async () => { await act(async () => root.unmount()); dom.window.close(); };
  return { root, entry, client, answerInput, mount, leave, input, edit, submit, send, dispose, listeners };
}

it("restores partial choices and text after remount, without submitting, and keeps drafts after a failed send", async () => {
  const t = setup();
  try {
    await t.mount();
    await act(async () => { t.input('[value="Grid"]').click(); t.input('[value="Search"]').click(); t.input('[value="Filters"]').click(); });
    await t.edit('[name="custom"]', "short"); // Invalid until finished; still worth saving.
    await t.edit('[name="enabled"]', "false");
    await t.edit('[name="count"]', "0");
    await t.edit('[name="email"]', "unfinished@");
    await t.leave(); await t.mount();
    expect(t.input('[value="Grid"]').checked).toBe(true);
    expect(t.input('[value="Search"]').checked).toBe(true);
    expect(t.input('[value="Filters"]').checked).toBe(true);
    expect(t.input('[name="custom"]').value).toBe("short");
    expect(t.input('[name="enabled"]').value).toBe("false");
    expect(t.input('[name="count"]').value).toBe("0");
    expect(t.input('[name="email"]').value).toBe("unfinished@");
    expect(t.answerInput).not.toHaveBeenCalled();
    await t.edit('[name="custom"]', "Compact spacing");
    await t.edit('[name="email"]', "");
    t.answerInput.mockRejectedValueOnce(new Error("Relay unavailable"));
    await t.send();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Relay unavailable");
    await t.leave(); await t.mount();
    expect(t.input('[name="custom"]').value).toBe("Compact spacing");
    expect(t.answerInput).toHaveBeenCalledTimes(1);
    await t.send();
    expect(t.answerInput).toHaveBeenLastCalledWith("agent:question", { action: "accept", content: {
      layout: "Grid", features: ["Search", "Filters"], custom: "Compact spacing", enabled: false, count: 0,
    } });
    expect(localStorage.length).toBe(0);
  } finally { await t.dispose(); }
});

it("isolates drafts by recipient and request and removes an emptied draft", async () => {
  const t = setup();
  try {
    await t.mount(); await t.edit('[name="custom"]', "My private draft"); await t.leave();
    const firstOwner = t.client.pubkey;
    Object.defineProperty(t.client, "pubkey", { value: "another-owner", configurable: true });
    await t.mount(); expect(t.input('[name="custom"]').value).toBe(""); await t.leave();
    Object.defineProperty(t.client, "pubkey", { value: firstOwner });
    t.entry.id = "agent:another-question";
    await t.mount(); expect(t.input('[name="custom"]').value).toBe(""); await t.leave();
    t.entry.id = "agent:question";
    await t.mount(); expect(t.input('[name="custom"]').value).toBe("My private draft");
    await t.edit('[name="custom"]', "");
    expect(localStorage.length).toBe(0);
  } finally { await t.dispose(); }
});

it.each(["sent", "received", "closed", "expired"] as const)("clears drafts when a question becomes %s while its conversation is closed", async status => {
  const t = setup();
  try {
    await t.mount(); await t.edit('[name="custom"]', "Unfinished reply"); await t.leave();
    expect(localStorage.length).toBe(1);
    t.entry.status = status;
    await act(async () => t.root.render(React.createElement(AgentInput, { client: t.client })));
    expect(localStorage.length).toBe(0);
  } finally { await t.dispose(); }
});

it("clears drafts after Skip and does not restore expired or changed forms", async () => {
  const t = setup();
  try {
    await t.mount(); await t.edit('[name="custom"]', "Unfinished reply");
    expect(localStorage.length).toBe(1);
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Skip")!.click());
    expect(t.answerInput).toHaveBeenCalledWith("agent:question", { action: "decline" });
    expect(localStorage.length).toBe(0);
    await t.leave(); await t.mount(); await t.edit('[name="custom"]', "Another draft"); await t.leave();
    const expiry = t.entry.expiresAt;
    vi.spyOn(Date, "now").mockReturnValue(expiry + 1);
    await t.mount(); expect(t.input('[name="custom"]').value).toBe("");
    vi.restoreAllMocks();
    await t.leave(); await t.mount(); await t.edit('[name="custom"]', "A new draft"); await t.leave();
    t.entry.form.message = "A different question";
    await t.mount(); expect(t.input('[name="custom"]').value).toBe("");
  } finally { vi.restoreAllMocks(); await t.dispose(); }
});

it("keeps the form usable when saved data is corrupt or storage fails", async () => {
  const t = setup();
  try {
    await t.mount(); await t.edit('[name="custom"]', "Private draft"); await t.leave();
    expect(localStorage.length).toBe(1);
    localStorage.setItem(localStorage.key(0)!, "{broken");
    await t.mount(); expect(t.input('[name="custom"]').value).toBe("");
    vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    await t.edit('[name="custom"]', "Still editable");
    expect(document.body.textContent).toContain("Draft could not be saved");
    expect(t.input('[name="custom"]').value).toBe("Still editable");
    await act(async () => t.input('[value="Grid"]').click());
    await t.send();
    expect(t.answerInput).toHaveBeenCalledWith("agent:question", { action: "accept", content: { layout: "Grid", custom: "Still editable" } });
  } finally { vi.restoreAllMocks(); await t.dispose(); }
});

it("clears a remotely closed request outside the bounded history window", async () => {
  const t = setup();
  try {
    await t.mount(); await t.edit('[name="custom"]', "Old pending draft"); await t.leave();
    t.client.inputHistory = () => [];
    await act(async () => t.root.render(React.createElement(AgentInput, { client: t.client })));
    expect(localStorage.length).toBe(1);
    t.entry.status = "closed";
    await act(async () => { for (const listener of t.listeners) listener(); });
    expect(localStorage.length).toBe(0);
  } finally { await t.dispose(); }
});

it("shows one question at a time, validates Next, and restores the current step and earlier answers", async () => {
  const t = setup();
  try {
    t.entry.form.fields = t.entry.form.fields.slice(0, 3);
    t.entry.form.fields[0].options![0].label = "Grid (Recommended)";
    await t.mount();
    expect(document.querySelectorAll('.input-question:not([hidden])')).toHaveLength(1);
    expect(document.body.textContent).toContain("Question 1 of 3");
    expect(document.querySelector('.input-recommended')?.textContent).toBe("Recommended");
    await t.submit();
    expect(document.body.textContent).toContain("Layout: an answer is required");
    expect(t.answerInput).not.toHaveBeenCalled();
    await act(async () => t.input('[value="Grid"]').click());
    await t.submit();
    expect(document.body.textContent).toContain("Question 2 of 3");
    expect(document.activeElement?.textContent).toContain("Features");
    await act(async () => t.input('[value="Search"]').click());
    await t.leave(); await t.mount();
    expect(document.body.textContent).toContain("Question 2 of 3");
    const back = [...document.querySelectorAll("button")].find(button => button.textContent === "Back")!;
    await act(async () => back.click());
    expect(t.input('[value="Grid"]').checked).toBe(true);
    await t.submit(); await t.submit();
    await t.edit('[name="custom"]', "short");
    await t.submit();
    expect(document.body.textContent).toContain("Details: invalid answer");
    expect(t.answerInput).not.toHaveBeenCalled();
    await t.edit('[name="custom"]', "Compact spacing");
    await t.submit();
    expect(t.answerInput).toHaveBeenCalledWith("agent:question", { action: "accept", content: { layout: "Grid", features: ["Search"], custom: "Compact spacing" } });
  } finally { await t.dispose(); }
});
