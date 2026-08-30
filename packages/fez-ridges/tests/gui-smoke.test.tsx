// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { activate, type GuiApi } from "../src/view.tsx";
import type { RidgesJob } from "../src/store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function job(overrides: Partial<RidgesJob>): RidgesJob {
  return {
    id: "id",
    ts: new Date().toISOString(),
    persona: "scout",
    issueUrl: "https://github.com/fez/fez/issues/212",
    repo: "fez/fez",
    issueNumber: 212,
    status: "working",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function apiWith(jobs: RidgesJob[], network?: string, opts?: { withClient?: boolean }): GuiApi {
  const registerNavView = vi.fn();
  const storageValues: Record<string, unknown> = { jobs, network };
  const api: GuiApi = {
    registerNavView,
    storage: {
      get: async <T,>(key: string) => storageValues[key] as T | undefined,
    },
    openUrl: vi.fn(async () => {}),
    client:
      opts?.withClient === false
        ? undefined
        : {
            pkByName: () => undefined,
            sendChannelMessage: vi.fn(async () => ({})),
          },
  };
  return api;
}

async function mountPane(api: GuiApi): Promise<{ host: HTMLDivElement; dispose: () => void }> {
  activate(api);
  const registerNavView = api.registerNavView as unknown as ReturnType<typeof vi.fn>;
  expect(registerNavView).toHaveBeenCalledWith("ridges", { glyph: "⛏", label: "ridges" }, expect.any(Function));
  const mount = registerNavView.mock.calls[0][2];
  const host = document.createElement("div");
  let dispose!: () => void;
  await act(async () => {
    dispose = mount(host);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, dispose };
}

describe("ridges gui pane — mount model", () => {
  it("renders a live row's status text and the merged/done rows, then unmounts cleanly", async () => {
    const jobs: RidgesJob[] = [
      job({ id: "1", status: "working", ts: "2020-01-01T00:00:00.000Z" }),
      job({ id: "2", status: "merged", usd: 0.75, updatedAt: "2020-01-01T00:00:00.000Z" }),
    ];
    const api = apiWith(jobs, "base-sepolia · test USDC");
    const { host, dispose } = await mountPane(api);

    expect(host.textContent).toContain("working — the subnet has your issue");
    expect(host.textContent).toContain("✓ merged");
    expect(host.textContent).toContain("base-sepolia · test USDC");
    expect(host.textContent).not.toContain("Your first job goes here.");

    act(() => dispose());
    expect(host.childNodes.length).toBe(0);
  });

  it("renders a refused row from its issue URL and status alone", async () => {
    const jobs: RidgesJob[] = [
      job({ id: "3", status: "refused", repo: "", issueNumber: 0, issueUrl: "not a url at all", usd: undefined }),
    ];
    const api = apiWith(jobs);
    const { host } = await mountPane(api);
    expect(host.textContent).toContain("refused");
    expect(host.textContent).toContain("not a url at all");
  });

  it("hides the dispatch input when api.client is absent, without crashing", async () => {
    const api = apiWith([], undefined, { withClient: false });
    const { host } = await mountPane(api);
    // Clicking "+ dispatch an issue" would normally reveal the input row;
    // with no client to send through, that row must never appear.
    const button = host.querySelector("button");
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector("input")).toBeNull();
  });

  it("shows the empty-state lines verbatim when the mirror has no jobs", async () => {
    const api = apiWith([]);
    const { host } = await mountPane(api);
    expect(host.textContent).toContain("Your first job goes here.");
    expect(host.textContent).toContain("Install the Ridgeline app on the repo first");
  });
});
