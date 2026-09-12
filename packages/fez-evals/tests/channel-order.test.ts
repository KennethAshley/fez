// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import { moveChannel, orderChannels, useChannelOrder } from "../../fez-desktop/src/channel-order.js";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("orders known channels, appends newcomers, and preserves hidden channels when moving", () => {
  const channels = ["a", "hidden", "b", "c"].map(id => ({ id }));
  const saved = moveChannel(["a", "hidden", "b"], "b", "a", false);
  expect(orderChannels(channels, saved).map(c => c.id)).toEqual(["b", "a", "hidden", "c"]);
  expect(orderChannels(channels.filter(c => c.id !== "hidden"), saved).map(c => c.id)).toEqual(["b", "a", "c"]);
  expect(moveChannel(saved, "b", "a", true)).toEqual(["a", "b", "hidden"]);
  expect(moveChannel(saved, "b", "b", false)).toBe(saved);
  expect(moveChannel(saved, "missing", "b", false)).toBe(saved);
  expect(moveChannel(saved, "b", "missing", false)).toBe(saved);
  expect(orderChannels(channels, ["gone", "b"]).map(c => c.id)).toEqual(["b", "a", "hidden", "c"]);
});

it("persists personal order per identity and workspace, handles damaged storage, and exposes save failures", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let result: ReturnType<typeof useChannelOrder>;
  function Harness({ user, relay }: { user: string; relay: string }) {
    result = useChannelOrder(user, relay);
    return React.createElement("div", null, result[0].join(","));
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (user = "alice", relay = "wss://one") => act(async () => root.render(React.createElement(Harness, { user, relay })));
  try {
    await render();
    await act(async () => result[1](["b", "a"]));
    expect(host.textContent).toBe("b,a");
    const key = localStorage.key(0)!;
    await render("bob");
    expect(host.textContent).toBe("");
    await render("alice", "wss://two");
    expect(host.textContent).toBe("");
    await render();
    expect(host.textContent).toBe("b,a");
    await act(async () => root.render(null));
    await render();
    expect(host.textContent).toBe("b,a");
    const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("storage full"); });
    expect(() => result[1](["a", "b"])).toThrow("storage full");
    expect(host.textContent).toBe("b,a");
    fail.mockRestore();
    for (const [raw, expected] of [["{broken", ""], ['{"a":1}', ""], ['["b",null,7,"b","a"]', "b,a"]]) {
      localStorage.setItem(key, raw);
      await render("bob");
      await render();
      expect(host.textContent).toBe(expected);
    }
  } finally { await act(async () => root.unmount()); }
});
