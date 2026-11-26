// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { SaltSection } from "../../fez-desktop/src/AgentReputation.js";
import { deriveSalt, type SaltEvidence } from "../../fez-client/src/salt.js";

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
