// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import type { FezClient } from "../../fez-client/src/index.js";
import HoverCard from "../../fez-desktop/src/HoverCard.js";
import UserCard from "../../fez-desktop/src/UserCard.js";
import ProfilePane from "../../fez-desktop/src/ProfilePane.js";
import { deriveSalt } from "../../fez-client/src/salt.js";

const { native, fetchSaltPanel, contribution } = vi.hoisted(() => ({ native: vi.fn(), fetchSaltPanel: vi.fn(), contribution: vi.fn(() => null) }));
vi.mock("../../fez-desktop/node_modules/@tauri-apps/api/core.js", () => ({ invoke: native }));
vi.mock("../../fez-desktop/src/PersonaEditor.js", () => ({ default: () => null }));
vi.mock("../../fez-desktop/src/relay.js", () => ({ relaySet: () => ["wss://workspace.test"] }));
vi.mock("../../fez-desktop/src/salt-record.js", async (original) => ({ ...await original<object>(), fetchSaltPanel }));
vi.mock("../../fez-desktop/src/gui-extensions.js", () => ({ extensionAgentProfileSections: () => [{ source: "wallet", label: "Stake", render: contribution }] }));

const viewer = "a".repeat(64), agent = "b".repeat(64), stranger = "c".repeat(64);
const client = {
  pubkey: viewer, displayName: () => "steph", knownNames: () => new Map([[agent, "steph"]]),
  agents: () => new Map([[agent, "steph"], [stranger, "steph"]]), agentInfo: () => ({ about: "Shoots baskets", skills: ["web"] }),
  isOnline: () => true, statusOf: () => undefined, isMutedByMe: () => false,
  state: { roleOf: (pk: string) => pk === viewer ? "owner" : "bot", isOwner: (pk: string) => pk === viewer,
    isMember: () => true, workspace: { members: new Map([[agent, "bot"], [stranger, "bot"]]) } },
} as unknown as FezClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.mockImplementation(async (cmd: string) => cmd === "list_personas" ? ["steph"] : agent);
  fetchSaltPanel.mockResolvedValue(deriveSalt({ agent, viewer, attestations: [], isViewerAgent: () => false, inViewerCircle: () => false,
    evidence: [{ signer: viewer, kind: "vouch", note: "A careful teammate", at: 100, moneyBacked: false }] }));
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function render(element: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("opens a hover card's profile by keyboard without activating its DM trigger", async () => {
  const onProfile = vi.fn(), onDm = vi.fn();
  const view = await render(React.createElement(HoverCard, { client, pk: agent, onProfile,
    children: React.createElement("button", { onClick: onDm }, "DM steph") }));
  try {
    const trigger = view.host.querySelector("button")!;
    await act(async () => trigger.focus());
    const card = view.host.querySelector<HTMLButtonElement>("button.hovercard");
    expect(card?.getAttribute("aria-label")).toBe("View steph's profile");
    await act(async () => {
      card!.focus();
      card!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(document.activeElement).toBe(card);
    await act(async () => card!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);
    expect(view.host.querySelector(".hovercard")).toBeNull();
    await act(async () => { trigger.blur(); trigger.focus(); });
    await act(async () => view.host.querySelector<HTMLButtonElement>("button.hovercard")!.click());
    expect(onProfile).toHaveBeenCalledOnce();
    expect(onDm).not.toHaveBeenCalled();
    expect(view.host.querySelector(".hovercard")).toBeNull();
  } finally { await view.close(); }
});

it("opens the channel popover's profile and preserves its independent copy action", async () => {
  const onProfile = vi.fn(), onClose = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = await render(React.createElement(UserCard, { client, pk: agent, at: { x: 10, y: 10 }, onProfile, onClose }));
  try {
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="Copy npub"]')!.click());
    expect(writeText).toHaveBeenCalledOnce();
    expect(onProfile).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const links = view.host.querySelectorAll<HTMLButtonElement>("button[aria-label=\"View steph's profile\"]");
    expect(links).toHaveLength(2);
    for (const link of links) await act(async () => link.click());
    expect(onProfile).toHaveBeenCalledWith(agent);
    expect(onClose).toHaveBeenCalledTimes(2);
  } finally { await view.close(); }
});

it("loads reputation in the common profile and links stake only to the matching local key", async () => {
  const props = { client, working: new Map(), onDm: vi.fn(), onWatch: vi.fn(), onSettings: vi.fn(), onClose: vi.fn() };
  const view = await render(React.createElement(ProfilePane, { ...props, pk: agent }));
  try {
    expect(view.host.querySelector('[aria-label="Vouched by"]')?.textContent).toContain("A careful teammate");
    expect(view.host.querySelector('[aria-label="Chits"]')).not.toBeNull();
    expect(view.host.querySelector('[aria-label="Stake"]')).not.toBeNull();
    expect(contribution).toHaveBeenLastCalledWith({ pubkey: agent, persona: "steph" }, expect.any(HTMLElement));
    expect(native).toHaveBeenCalledWith("get_pubkey", { account: "agent:steph" });
    contribution.mockClear();
    fetchSaltPanel.mockResolvedValue("error");
    await act(async () => view.root.render(React.createElement(ProfilePane, { ...props, pk: stranger })));
    expect(view.host.textContent).toContain("Reputation unavailable");
    expect(view.host.textContent).not.toContain("A careful teammate");
    expect(view.host.textContent).not.toContain("edit persona");
    expect(contribution).toHaveBeenCalled();
    for (const [context] of contribution.mock.calls) expect(context).toEqual({ pubkey: stranger, persona: undefined });
  } finally { await view.close(); }
});
