// @vitest-environment jsdom
import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ObserverEntry } from "../../fez-client/src/index.js";
import ActivityFeed from "../../fez-desktop/src/ActivityFeed";

const require = createRequire(resolve(__dirname, "../../fez-desktop/package.json"));
const React = require("react"), { createRoot } = require("react-dom/client");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Seen live: dubois retried three times on a Chutes 402 and the activity
// feed showed only "turn retrying" — the reason existed in the agent's
// process but never reached the screen. The retrying frame now carries it.
const reason = 'transient: harness returned an empty reply (stderr: …HTTP 402 {"detail":{"message":"Quota exceeded and account balance is $-0.059"}})';

async function render(entries: ObserverEntry[]) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(ActivityFeed, { entries })));
  return { host, close: async () => { await React.act(async () => root.unmount()); host.remove(); } };
}

it("shows why a turn is retrying, in the row and in its tooltip", async () => {
  const r = await render([
    { type: "turn", status: "started", ts: 1_000 },
    { type: "turn", status: "retrying", ts: 4_000, reason } as ObserverEntry,
  ]);
  try {
    const status = r.host.querySelector(".turn-status.retrying") as HTMLElement | null;
    expect(status).not.toBeNull();
    expect(status!.title).toContain("Quota exceeded");
    expect(r.host.textContent).toContain("Quota exceeded");
  } finally { await r.close(); }
});

it("says nothing extra when a retry carries no reason", async () => {
  const r = await render([
    { type: "turn", status: "started", ts: 1_000 },
    { type: "turn", status: "retrying", ts: 4_000 },
  ]);
  try {
    const status = r.host.querySelector(".turn-status.retrying") as HTMLElement | null;
    expect(status).not.toBeNull();
    expect(status!.title).toBe("");
    expect(r.host.querySelector(".turn-reason")).toBeNull();
  } finally { await r.close(); }
});
