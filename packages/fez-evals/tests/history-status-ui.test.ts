import { expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "../../fez-desktop/node_modules/react/index.js";
import { createRoot } from "../../fez-desktop/node_modules/react-dom/client.js";
import HistoryStatus from "../../fez-desktop/src/HistoryStatus.js";
import type { HistoryLoadState } from "../../fez-client/src/index.js";

it("shows an accessible failure and Retry, with loading feedback and no warning after recovery", async () => {
  const dom = new JSDOM("<div id='root'></div>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const retry = vi.fn();
  const render = (state: HistoryLoadState) => act(async () => root.render(
    React.createElement(HistoryStatus, { state, onRetry: retry })
  ));
  try {
    await render({ status: "error", operation: "recent", partial: true });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("History is incomplete");
    expect(document.body.textContent).toContain("Messages already loaded are still available");
    await act(async () => document.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledTimes(1);
    await render({ status: "loading", operation: "recent" });
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading history");
    expect(document.querySelector("button")).toBeNull();
    await render({ status: "error", operation: "recent", partial: false });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load history");
    await render({ status: "ready", operation: "recent" });
    expect(document.body.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  }
});
