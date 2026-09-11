import { expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { FezClient, type Wire, type WireEvent, type WireFilter } from "../../fez-client/src/index.js";
import type { BrowserWire } from "../../fez-desktop/src/wire.js";
import MemoryView from "../../fez-desktop/src/MemoryView.js";
import { matchFilter } from "nostr-tools";

const event = (id: string, kind: number, pubkey: string, content: string, tags: string[][], created_at = 100): WireEvent =>
  ({ id, kind, pubkey, content, tags, created_at, sig: "signature-verified-by-wire" });

it("the pane filters untrusted facts, applies live corrections and bans, and reports outages with retry", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  let failed = false;
  let receive: ((event: WireEvent) => void) | undefined;
  const events = [
    event("channel", 47101, "owner", JSON.stringify({ name: "general" }), [["d", "general-id"]]),
    event("roster", 47102, "owner", "", [["d", "roster"], ["p", "agent", "bot"]]),
    event("fact", 47210, "agent", "Friday deployments", [["h", "general-id"]]),
    event("forged", 47210, "stranger", "Untrusted fact", [["h", "general-id"]]),
  ];
  const query = async (filters: WireFilter[]) => failed ? [] : events.filter(e => filters.some(f => matchFilter(f, e)));
  const wire = {
    pubkey: "owner", query,
    queryWithStatus: async (filters: WireFilter[]) => ({ events: await query(filters), failures: failed ? [{ url: "relay", reason: "timeout" }] : [] }),
    subscribe: (_filters: WireFilter[], handler: (event: WireEvent) => void) => { receive = handler; return () => { receive = undefined; }; },
  };
  const client = new FezClient(wire as Wire);
  client.state.workspace.owner = "owner";
  for (const e of events) client.state.absorb(e);
  try {
    await act(async () => root.render(React.createElement(MemoryView, {
      client, wire: wire as BrowserWire, channelId: "general-id", channelName: "general", onClose() {},
    })));
    expect(document.body.textContent).toContain("Friday deployments");
    expect(document.body.textContent).not.toContain("Untrusted fact");
    const correction = event("correction", 47211, "agent", "Monday deployments", [["h", "general-id"], ["e", "fact"]], 101);
    events.push(correction);
    await act(async () => receive!(correction));
    expect(document.body.textContent).toContain("Monday deployments");
    expect(document.body.textContent).not.toContain("Friday deployments");
    const ban = event("ban", 30047, "owner", "", [["d", "bans"], ["p", "agent"]], 102);
    events.push(ban);
    await act(async () => receive!(ban));
    expect(document.body.textContent).not.toContain("Monday deployments");
    failed = true;
    await act(async () => receive!(ban));
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/incomplete|could not|unavailable/i);
    expect(document.body.textContent).not.toContain("nothing remembered yet");
    failed = false;
    await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "Retry")!.click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  }
});
