// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { SaltSection } from "../../fez-desktop/src/AgentReputation.js";
import { deriveSalt, type SaltEvidence } from "../../fez-client/src/salt.js";
import { registerWalletReputation } from "../../fez-wallet/src/gui-reputation.js";
import type { GuiExtensionApi } from "../../fez-extension-api/src/gui.js";

vi.mock("../../fez-desktop/src/gui-extensions.js", () => ({ extensionAgentProfileSections: () => [] }));
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

async function render(element: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root, close: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("shows endorsers separately from accepted work, including people outside the viewer's circle", async () => {
  const evidence: SaltEvidence[] = [
    { signer: "alice", kind: "vouch", note: "Careful researcher", at: 100, moneyBacked: false },
    { signer: "bob", kind: "vouch", note: "Good at code review", at: 110, moneyBacked: false },
    { signer: "me", kind: "chit", workId: "work-123", note: "Accepted the report", at: 120, moneyBacked: true },
    { signer: "owner", kind: "vouch", note: "Household praise", at: 130, moneyBacked: false },
  ];
  const panel = deriveSalt({ agent: "agent", viewer: "me", evidence, attestations: [{ owner: "owner", agent: "agent" }],
    isViewerAgent: () => false, inViewerCircle: (pk) => pk === "alice" });
  const view = await render(React.createElement(SaltSection, { panel, viewer: "me", displayName: (pk) => pk }));
  try {
    const vouches = view.host.querySelector('[aria-label="Vouched by"]')!;
    expect(vouches.textContent).toContain("alice");
    expect(vouches.textContent).toContain("In your circle");
    expect(vouches.textContent).toContain("bob");
    expect(vouches.textContent).toContain("Outside your circle");
    expect(vouches.textContent).not.toContain("Accepted the report");
    expect(view.host.querySelector('[aria-label="Chits"]')?.textContent).toContain("payment receipt (unverified)");
    expect(view.host.textContent).not.toContain("Household praise");
    expect(view.host.textContent).toContain("1 household entry excluded");
  } finally { await view.close(); }
});

it("does not turn a failed reputation lookup into a claim of no endorsements", async () => {
  const view = await render(React.createElement(SaltSection, { panel: "error" }));
  try {
    expect(view.host.textContent).toContain("Reputation unavailable");
    expect(view.host.textContent).not.toContain("No active vouches");
  } finally { await view.close(); }
});

function wallet(run: NonNullable<GuiExtensionApi["processes"]>["run"]) {
  let section!: Parameters<GuiExtensionApi["registerAgentProfileSection"]>[1];
  registerWalletReputation({ React, processes: { run }, registerAgentProfileSection: (_label, render) => { section = render; } });
  return (persona?: string) => section({ pubkey: "agent", persona }) as React.ReactNode;
}
const status = { persona: "researcher", address: "5" + "A".repeat(47), network: "test", netuid: 1, uid: 7, free: "100", staked: "2.5" };
const output = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });

it("reports a missing profile seam on older desktops without breaking wallet activation", () => {
  const toast = vi.fn();
  expect(() => registerWalletReputation({ React, toast })).not.toThrow();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("updated Fez desktop"), "warn");
});

it("shows self stake with test units, provenance and freshness; refresh failures remove the old balance", async () => {
  const run = vi.fn().mockResolvedValue(output(status));
  const section = wallet(run);
  const view = await render(section("researcher"));
  try {
    expect(run).toHaveBeenCalledWith("fez-wallet", ["status", "researcher", "--json"]);
    expect(view.host.textContent).toContain("2.5 tα self stake");
    expect(view.host.textContent).toContain("Testnet · test funds");
    expect(view.host.textContent).toContain("Other accounts' stake is not included");
    expect(view.host.querySelector("time")?.dateTime).toBeTruthy();
    run.mockRejectedValueOnce(new Error("Chain offline"));
    await act(async () => view.host.querySelector("button")!.click());
    expect(view.host.textContent).toContain("Stake unavailable: Chain offline");
    expect(view.host.textContent).not.toContain("2.5 tα");
  } finally { await view.close(); }
});

it.each([undefined, "0"])("keeps unknown stake distinct from a measured zero (%s)", async (staked) => {
  const view = await render(wallet(async () => output({ ...status, staked }))("researcher"));
  try { expect(view.host.textContent).toContain(staked === undefined ? "Self stake unknown" : "0 tα self stake"); }
  finally { await view.close(); }
});

it("does not map a foreign display name to a local wallet or display malformed money", async () => {
  const run = vi.fn().mockResolvedValue(output({ ...status, staked: -1 }));
  const section = wallet(run);
  const view = await render(section());
  try {
    expect(run).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("No local wallet account is linked");
    await act(async () => view.root.render(section("researcher")));
    expect(view.host.textContent).toContain("invalid stake status");
    expect(view.host.textContent).not.toContain("-1 tα");
  } finally { await view.close(); }
});
