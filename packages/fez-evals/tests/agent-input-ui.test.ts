import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import AgentInput, { InputCard, QuestionRow, conversationQuestions } from "../../fez-desktop/src/AgentInput.js";
import HomeView from "../../fez-desktop/src/HomeView.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";
import { notifyEvent } from "../../fez-desktop/src/notify.js";
import type { FezClient, PendingInput, InputHistoryEntry } from "../../fez-client/src/index.js";
import { inputForm } from "../../fez-client/src/agent-input.js";

vi.mock("../../fez-desktop/src/notify.js", () => ({ notifyEvent: vi.fn() }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: async () => "" }));
afterEach(() => vi.unstubAllGlobals());

it.each(["channel", "dm", "legacy"] as const)("opens an unanswered %s question from Inbox and clears attention after sending", async kind => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://fez.test" });
  for (const key of ["window", "document", "FormData", "HTMLElement", "localStorage", "CustomEvent"] as const) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const request: PendingInput = {
    id: "agent:inbox", requestId: "inbox", agentPk: "agent", expiresAt: Date.now() + 60_000,
    origin: kind === "channel" ? { kind, channelId: "general", rootId: "root" }
      : kind === "dm" ? { kind, participants: ["agent", "owner"] } : undefined,
    form: inputForm({ mode: "form", message: "Pick a layout", requestedSchema: {
      properties: { layout: { type: "string", title: "Layout", enum: ["List", "Grid"] } }, required: ["layout"],
    } }),
  };
  let entry: InputHistoryEntry = { ...request, requestedAt: Date.now(), status: "pending" };
  const client = {
    pubkey: "owner", pendingInputs: () => [request], waitingInputs: () => entry.status === "pending" ? [request] : [],
    inputHistory: () => [entry], loadInputHistory: async () => {}, displayName: () => "quill",
    state: { workspace: { name: "test", channels: new Map([["general", { id: "general", name: "general" }]]) } },
    channelRef: () => ({ name: "general" }), dmConversations: () => new Map(), workflowRuns: () => new Map(), workingAgents: () => new Map(),
    on: () => () => {},
    answerInput: vi.fn<FezClient["answerInput"]>(async (_id, response) => { entry = { ...entry, status: "sent", response, answeredAt: Date.now() }; }),
  } as unknown as FezClient;
  const wire = { query: async () => [] } as unknown as BrowserWire;
  const onOpenQuestion = vi.fn((question: PendingInput) => {
    if (!question.origin) window.dispatchEvent(new CustomEvent("fez-show-questions", { detail: question.id }));
  });
  const inbox = () => React.createElement(React.Fragment, {},
    React.createElement(AgentInput, { client, onOpen: onOpenQuestion }),
    React.createElement(HomeView, { client, wire, onOpenChannel: vi.fn(), onOpenDm: vi.fn(), onOpenQuestion }));
  try {
    await act(async () => root.render(inbox()));
    expect(document.querySelector("main .loops-count")?.textContent).toBe("1");
    const answer = [...document.querySelectorAll("main button")].find(button => button.textContent === "Answer question →");
    expect(answer).toBeDefined();
    await act(async () => (answer as HTMLButtonElement).click());
    expect(onOpenQuestion).toHaveBeenCalledWith(request);
    if (kind === "legacy") expect(document.querySelector(".agent-input")?.hasAttribute("hidden")).toBe(false);
    else await act(async () => root.render(React.createElement(QuestionRow, { client, entry })));
    await act(async () => (document.querySelector('input[value="Grid"]') as HTMLInputElement).click());
    await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(client.answerInput).toHaveBeenCalledWith(request.id, { action: "accept", content: { layout: "Grid" } });
    await act(async () => root.render(inbox()));
    expect(client.pendingInputs()).toHaveLength(1); // delivery receipt is still outstanding
    expect(document.querySelector("main .loop.blocked")).toBeNull();
    const history = [...document.querySelectorAll("main button")].find(button => button.textContent === "Question history");
    expect(history).toBeDefined();
    await act(async () => (history as HTMLButtonElement).click());
    expect(document.querySelector(".agent-input")?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelector(".input-history")?.textContent).toContain("Grid");
    expect(document.querySelector(".input-history")?.textContent).toContain("Sent · awaiting receipt");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

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
    await act(async () => root.render(React.createElement(InputCard, { ownerPk: "owner", request: { id: "agent:request", requestId: "request", agentPk: "agent", expiresAt: Date.now() + 60_000, form }, name: "quill", onAnswer })));
    expect(document.querySelectorAll("fieldset.input-question")).toHaveLength(3);
    await act(async () => { for (const input of document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')) input.click(); });
    (document.querySelector('textarea[name="custom"]') as HTMLTextAreaElement).value = "compact";
    const submit = async () => {
      for (let i = 0; i < form.fields.length; i++) {
        const last = document.querySelector('button[type="submit"]')?.textContent !== "Next";
        await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
        if (last) break;
      }
    };
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Relay unavailable");
    expect(document.querySelector("button[type=submit]")?.hasAttribute("disabled")).toBe(false);
    await submit();
    expect(onAnswer).toHaveBeenLastCalledWith({ action: "accept", content: { layout: "grid", features: ["search", "filters"], custom: "compact" } });
    expect(document.body.textContent).toContain("Waiting for agent");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

it("removes the Questions navigation, notifies once without private text, and opens legacy requests on demand", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  for (const key of ["window", "document", "FormData", "HTMLElement", "Event"] as const) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const listeners = new Set<() => void>();
  const requests: PendingInput[] = [];
  const client = {
    pendingInputs: () => requests, inputHistory: () => [], loadInputHistory: async () => {}, displayName: () => "quill", answerInput: async () => {},
    on: (_event: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as FezClient;
  vi.mocked(notifyEvent).mockClear();
  try {
    await act(async () => root.render(React.createElement(AgentInput, { client })));
    expect(document.querySelector('[aria-label="Questions"]')).toBeNull();
    requests.push({ id: "agent:request", requestId: "request", agentPk: "agent", expiresAt: Date.now() + 60000,
      form: inputForm({ mode: "form", message: "Private deployment details", requestedSchema: { properties: { pick: { type: "string", enum: ["secret A", "secret B"] } } } }) });
    await act(async () => { for (const listener of listeners) listener(); });
    expect(document.querySelector(".agent-input")?.hasAttribute("hidden")).toBe(true);
    expect(notifyEvent).toHaveBeenCalledTimes(1);
    expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "needs_action", target: { kind: "questions", id: "agent:request" } }));
    expect(JSON.stringify(vi.mocked(notifyEvent).mock.calls)).not.toContain("Private deployment details");
    await act(async () => { for (const listener of listeners) listener(); });
    expect(notifyEvent).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new dom.window.CustomEvent("fez-show-questions", { detail: "agent:request" })));
    expect(document.querySelector(".agent-input")?.hasAttribute("hidden")).toBe(false);
    await act(async () => (document.querySelector('[aria-label="Close questions"]') as HTMLButtonElement).click());
    expect(document.querySelector(".agent-input")?.hasAttribute("hidden")).toBe(true);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

it("shows readable private answers and distinguishes a receipt from an unconfirmed send", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  for (const key of ["window", "document", "FormData", "HTMLElement"] as const) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const form = inputForm({ mode: "form", message: "Layout preference", requestedSchema: { properties: {
    layout: { type: "string", title: "Layout", oneOf: [{ const: "grid", title: "Card grid" }] },
  } } });
  const record = { id: "agent:one", requestId: "one", agentPk: "agent", expiresAt: Date.now(), requestedAt: Date.now(),
    form, status: "sent", response: { action: "accept", content: { layout: "grid" } } };
  const listeners = new Set<() => void>();
  const client = { pendingInputs: () => [], inputHistory: () => [record], loadInputHistory: async () => {}, displayName: () => "quill",
    on: (_event: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as FezClient;
  try {
    await act(async () => root.render(React.createElement(AgentInput, { client })));
    await act(async () => window.dispatchEvent(new dom.window.CustomEvent("fez-show-questions", { detail: { view: "history" } })));
    expect(document.body.textContent).toContain("Sent · awaiting receipt");
    expect(document.body.textContent).toContain("Card grid");
    record.status = "received";
    await act(async () => { for (const listener of listeners) listener(); });
    expect(document.body.textContent).toContain("Received by agent");
    expect(document.body.textContent).not.toContain("Sent · awaiting receipt");
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

it("keeps scoped forms and sent answers in their exact conversation", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  for (const key of ["window", "document", "FormData", "HTMLElement"] as const) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const listeners = new Set<() => void>();
  const requests: PendingInput[] = [];
  const client = { pubkey: "owner", pendingInputs: () => requests, inputHistory: () => [], loadInputHistory: async () => {}, displayName: () => "quill",
    on: (_event: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  } as unknown as FezClient;
  const onOpen = vi.fn();
  vi.mocked(notifyEvent).mockClear();
  try {
    await act(async () => root.render(React.createElement(AgentInput, { client, onOpen })));
    requests.push({ id: "agent:scoped", requestId: "scoped", agentPk: "agent", expiresAt: Date.now() + 60000,
      origin: { kind: "channel", channelId: "general", rootId: "root", messageId: "trigger" },
      form: inputForm({ mode: "form", message: "Private choices", requestedSchema: { properties: { pick: { type: "string", enum: ["A", "B"] } } } }) });
    await act(async () => { for (const listener of listeners) listener(); });
    expect(document.querySelector(".agent-input")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("form")).toBeNull();
    expect(notifyEvent).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "questions", id: "agent:scoped" } }));
    await act(async () => window.dispatchEvent(new dom.window.Event("fez-show-questions")));
    await act(async () => (document.querySelector('.input-thread-link') as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith(requests[0]);
    const scope = { kind: "channel" as const, channelId: "general", rootId: "root" };
    const [entry] = conversationQuestions(client, scope);
    expect(entry.id).toBe("agent:scoped");
    expect(conversationQuestions(client, { ...scope, rootId: "other" })).toEqual([]);
    expect(conversationQuestions(client, { ...scope, channelId: "other" })).toEqual([]);
    await act(async () => root.render(React.createElement(QuestionRow, { client, entry })));
    expect(document.querySelector("form")).not.toBeNull();
    expect(document.body.textContent).toContain("Waiting for your answer");
    await act(async () => root.render(React.createElement(QuestionRow, { client, entry: {
      ...entry, status: "sent", answeredAt: Date.now(), response: { action: "accept", content: { pick: "B" } },
    } })));
    expect(document.body.textContent).not.toContain("Waiting for your answer");
    expect(document.body.textContent).toContain("Waiting for agent to acknowledge");
    expect((document.querySelector('input[value="B"]') as HTMLInputElement).checked).toBe(true);
    requests[0].origin = { kind: "dm", participants: ["owner", "agent", "peer"], messageId: "trigger" };
    expect(conversationQuestions(client, { kind: "dm", convoKey: "agent+peer" })).toHaveLength(1);
    expect(conversationQuestions(client, { kind: "dm", convoKey: "agent" })).toHaveLength(0);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
