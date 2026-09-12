// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "../../fez-desktop/node_modules/react/index.js";
import { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire, type WireEvent } from "../../fez-client/src/index.js";
import { customChannelId, matchCustomContent, parseCustomGuiContributions, type CustomSurface } from "../../../src/extensions/gui-custom-contributions.js";
import { createCustomHost, customSnapshot, type CustomSnapshot } from "../../fez-desktop/src/isolated-custom-host";
import { createCustomRuntime } from "../../fez-desktop/src/isolated-custom";
import type { IsolatedPanelApi } from "../../fez-desktop/src/isolated-panel";

vi.mock("../../fez-desktop/src/notify", () => ({ notifyEvent: vi.fn() }));
vi.mock("../../fez-desktop/src/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() } }));
vi.mock("../../fez-desktop/src/invite-persona", () => ({ invitePersona: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const owner = "a".repeat(64), agent = "b".repeat(64);
const surface: CustomSurface = { kind: "message", index: 0, channelId: "channel", msgId: "message", content: "forged main context", authorName: "forged" };

function fixture() {
  const client = new FezClient({ pubkey: owner } as Wire);
  client.state.workspace.owner = owner;
  client.state.workspace.channels.set("channel", { id: "channel", name: "work", createdAt: 1 });
  vi.spyOn(client, "messages").mockImplementation(channel => channel === "channel" ? [{ id: "message", content: "signed channel text", authorPk: agent, authorName: "miner", ts: 100, mentionPks: [] }] : []);
  vi.spyOn(client, "knownNames").mockReturnValue(new Map([[agent, "miner"], [owner, "owner"]]));
  vi.spyOn(client, "pkByName").mockImplementation(name => name === "miner" ? agent : name === "owner" ? owner : undefined);
  vi.spyOn(client, "agents").mockReturnValue(new Map([[agent, "miner"]]));
  vi.spyOn(client, "displayName").mockImplementation(pk => pk === agent ? "miner" : "owner");
  return client;
}

it("uses bounded declarations for Mining bindings and Wallet launchers, rejecting executable and unknown rules", () => {
  const mining = JSON.parse(readFileSync(resolve(__dirname, "../../fez-mining/package.json"), "utf8")).fez;
  const wallet = JSON.parse(readFileSync(resolve(__dirname, "../../fez-wallet/package.json"), "utf8")).fez;
  const mine = parseCustomGuiContributions(mining.guiContributions), pay = parseCustomGuiContributions(wallet.guiContributions);
  expect(mining.guiRuntime).toBe("isolated"); expect(wallet.guiRuntime).toBe("isolated");
  expect(customChannelId([{ id: "old", source: "mining" }, { id: "linked", source: "other", meta: { miningWorkspace: "true" } }], mine.nav[0].channel!)).toBe("linked");
  expect(matchCustomContent("a warning\n💸 **miner** wants to send **1 TAO**\nto `destination`\nreact ✅", pay.messages[0].match)).toBe(true);
  const address = "5" + "B".repeat(47);
  expect(matchCustomContent(`Pay ${address}`, pay.messages[3].match)).toBe(true);
  expect(matchCustomContent(`\`\`\`\n${address}\n\`\`\``, pay.messages[3].match)).toBe(false);
  expect(matchCustomContent("5" + "a".repeat(63), pay.messages[3].match)).toBe(false);
  for (const value of [{ nav: [{ name: "evil", glyph: "x", label: "x", render: "alert(1)" }] },
    { messages: [{ label: "evil", match: { regex: "(x+)+" } }] }, { messages: [{ label: "all", match: {} }] },
    { messages: [{ label: "large", match: { token: { alphabet: "base58", min: 1, max: 1_000_000 } } }] }]) {
    expect(() => parseCustomGuiContributions(value)).toThrow();
  }
});

it("snapshots only its bound channel message, preserving source, receipt bytes and owner reaction timestamps", () => {
  const client = fixture();
  const raw: WireEvent = { id: "receipt", pubkey: agent, kind: 47040, content: "receipt body", created_at: 101, sig: "signature", tags: [["e", "message"], ["h", "channel"]] };
  vi.spyOn(client, "paymentReceiptsFor").mockReturnValue([raw]);
  vi.spyOn(client, "myReactionTimeTo").mockImplementation((id, emoji) => id === "message" && emoji === "✅" ? 110 : undefined);
  const dmRead = vi.spyOn(client, "dmConversations");
  const globalMessageRead = vi.spyOn(client, "msgById");
  const value = customSnapshot(client, surface, ["ui", "read:channels"]);
  expect(value.surface).toMatchObject({ content: "signed channel text", authorName: "miner" });
  expect(value.message).toEqual({ id: "message", content: "signed channel text", authorPk: agent, ts: 100 });
  expect(value.receipts).toEqual([raw]); expect(value.reactions).toEqual([["✅", 110]]);
  expect(value.pubkeysByName).toContainEqual(["miner", agent]); expect(value.agents).toBeNull();
  expect(dmRead).not.toHaveBeenCalled(); expect(globalMessageRead).not.toHaveBeenCalled();
  expect(() => customSnapshot(client, { ...surface, msgId: "a-private-dm" }, ["ui", "read:channels", "read:dms"])).toThrow(/no longer available/);
  expect(() => customSnapshot(client, surface, ["ui"])).toThrow(/read:channels/);
});

it("binds reactions to the opened message and refuses unscoped processes, unknown actions and revoked views", async () => {
  const client = fixture(), react = vi.spyOn(client, "toggleReaction").mockResolvedValue();
  const invoke = vi.fn(async () => 123);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  let current: CustomSurface | undefined = surface;
  const handler = createCustomHost(client, () => current, { openChannel: vi.fn(), openThread: vi.fn(), openGuestDm: vi.fn() });
  const run = (action: string, args: unknown, grants = ["ui", "read:channels", "publish", "processes"]) => handler({ op: "custom", name: "wallet", action, args, grants });
  await expect(run("toggle_reaction", { channelId: "channel", targetId: "another", emoji: "✅" })).rejects.toThrow(/another message/);
  await expect(run("toggle_reaction", { channelId: "channel", targetId: "message", emoji: "✅" }, ["ui", "read:channels"])).rejects.toThrow(/publish/);
  await run("toggle_reaction", { channelId: "channel", targetId: "message", emoji: "✅" });
  expect(react).toHaveBeenCalledTimes(1); expect(react).toHaveBeenCalledWith("channel", "message", "✅");
  await expect(run("agent_stop", { name: "miner" })).rejects.toThrow();
  await expect(run("process_run", { bin: "fez-wallet", args: [], extension: "mining" })).rejects.toThrow();
  await run("process_run", { bin: "fez-wallet", args: ["status", "--json"] });
  expect(invoke).toHaveBeenCalledWith("run_extension_bin", { extension: "wallet", bin: "fez-wallet", args: ["status", "--json"] }, undefined);
  await expect(run("get_identity", {})).rejects.toThrow(/Unsupported/);
  current = undefined;
  await expect(run("process_run", { bin: "fez-wallet", args: [] })).rejects.toThrow(/closed/);
  expect(invoke).toHaveBeenCalledTimes(1);
});

const baseApi = (): IsolatedPanelApi => ({
  React, prefs: { get: async () => undefined, set: async () => {} }, secrets: { has: async () => false, set: async () => {} },
  fetch: globalThis.fetch, openUrl: async () => {}, showDetails: async () => {}, confirm: async () => false, registerSettingsPanel: () => {},
});

it("routes custom external links through the URL broker and removes the handler on disposal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opening: CustomSurface = { kind: "nav", name: "board" };
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async () => customSnapshot(fixture(), opening, ["ui"]) });
  const openUrl = vi.fn(async (url: string) => { if (url.includes("denied.example")) throw Error("network grant denied"); });
  const runtime = await createCustomRuntime({ ...baseApi(), openUrl }, opening);
  runtime.api.registerNavView("board", { glyph: "x", label: "Board" }, () => <>
    <a href="https://bazaar.fez.chat/board" target="_blank"><span>Board</span></a>
    <a href="https://denied.example/">Denied</a>
    <a href="javascript:alert(1)">Script</a>
    <a href="#section">Section</a>
  </>);
  document.body.innerHTML = "<div id='test-root'></div>";
  const root = createRoot(document.getElementById("test-root")!);
  const click = (selector: string) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.querySelector(selector)!.dispatchEvent(event);
    return event;
  };
  // Observe cancellation without asking jsdom to navigate the test document.
  let intercepted = false;
  const preventNavigation = (event: Event) => { intercepted = event.defaultPrevented; event.preventDefault(); };
  document.addEventListener("click", preventNavigation);
  try {
    await act(async () => root.render(<runtime.View />));
    await act(async () => { click("a span"); });
    expect(intercepted).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://bazaar.fez.chat/board");
    await act(async () => { click('a[href*="denied"]'); });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("network grant denied");
    await act(async () => { click('a[href^="javascript:"]'); });
    expect(intercepted).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(2);
    click('a[href^="#"]'); expect(intercepted).toBe(false);
    runtime.dispose();
    click("a span"); expect(intercepted).toBe(false);
    expect(openUrl).toHaveBeenCalledTimes(2);
  } finally { document.removeEventListener("click", preventNavigation); await act(async () => root.unmount()); runtime.dispose(); }
});

it("refreshes consent reads without resetting a mounted custom component's input state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let value: CustomSnapshot = customSnapshot(fixture(), surface, ["ui", "read:channels", "read:agents"]);
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke: async () => value });
  const runtime = await createCustomRuntime(baseApi(), surface);
  function Form() {
    const [draft, setDraft] = React.useState("keep me");
    return <><input value={draft} onChange={event => setDraft(event.target.value)} /><output>{runtime.api.client?.myReactionTimeTo("message", "✅") ?? "pending"}</output></>;
  }
  runtime.api.registerMessageDecorator(() => true, () => <Form />);
  document.body.innerHTML = "<div id='test-root'></div>";
  const root = createRoot(document.getElementById("test-root")!);
  try {
    await act(async () => root.render(<runtime.View />));
    const input = document.querySelector("input")!;
    expect(document.querySelector("output")?.textContent).toBe("pending");
    value = { ...value, reactions: [["✅", 120]] };
    await act(async () => runtime.refresh());
    expect(document.querySelector("output")?.textContent).toBe("120");
    expect(document.querySelector("input")).toBe(input);
    expect(input.value).toBe("keep me");
  } finally { await act(async () => root.unmount()); runtime.dispose(); }
});

it("renders the shipped Mining fleet summary and routes its tabs through the bounded broker", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opening: CustomSurface = { kind: "navSummary", name: "mining" };
  const value = customSnapshot(fixture(), opening, ["ui", "read:channels", "processes"]);
  const invoke = vi.fn(async (_command: string, { request }: { request: { action: string } }) => {
    if (request.action === "snapshot") return value;
    if (request.action === "process_run") return { code: 0, stdout: JSON.stringify([{ alive: true }, { desired: "running", alive: false }]), stderr: "" };
    return null;
  });
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  const runtime = await createCustomRuntime(baseApi(), opening);
  const bundle = readFileSync(resolve(__dirname, "../../fez-mining/dist/gui.js"), "utf8");
  const extension = new Function(`${bundle}\n;return __fezExt;`)() as { default(api: typeof runtime.api): void };
  extension.default(runtime.api);
  document.body.innerHTML = "<div id='test-root'></div>";
  const root = createRoot(document.getElementById("test-root")!);
  try {
    await act(async () => root.render(<runtime.View />));
    expect(document.body.textContent).toContain("2 active · 2 total miners · 1 need attention");
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "New miner")!.click());
    expect(invoke).toHaveBeenCalledWith("isolated_panel_request", { request: { op: "custom", action: "open_tab", args: { id: "subnets" } } }, undefined);
  } finally { await act(async () => root.unmount()); runtime.dispose(); }
});
