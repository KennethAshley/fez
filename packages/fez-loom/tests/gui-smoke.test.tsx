// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import activate, { type GuiApi } from "../src/gui.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("loom gui migrated to the mount model", () => {
  it("registers a nav view whose mount renders into the host and returns a disposer", () => {
    const registerNavView = vi.fn();
    const api = {
      registerNavView,
      registerArtifactAction: vi.fn(),
      client: {
        pubkey: "user",
        state: {
          workspace: { relay: "wss://workspace", channels: new Map() },
        },
        artifacts: () => [],
        on: () => () => {},
        publishArtifact: vi.fn(),
      },
      openTool: vi.fn(),
    } satisfies GuiApi;

    activate(api);

    expect(registerNavView).toHaveBeenCalled();
    const mount = registerNavView.mock.calls[0][2];
    const host = document.createElement("div");
    let dispose: unknown;
    act(() => {
      dispose = mount(host);
    });
    expect(host.childNodes.length).toBeGreaterThan(0);
    expect(typeof dispose).toBe("function");
    act(() => {
      (dispose as () => void)();
    });
  });
});
