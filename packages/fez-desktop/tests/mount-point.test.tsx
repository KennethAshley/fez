// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MountPoint } from "../src/MountPoint";

// Tell React this is an act() environment so effects/cleanups flush the way
// the app runs them (post-commit), not synchronously mid-render.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Silence React 19's "not wrapped in act" console noise from the nested
// foreign root; every mutation below is already inside our own act().
let container: HTMLDivElement;
let hostRoot: ReturnType<typeof createRoot>;
afterEach(() => {
  // A test may already have unmounted (to assert it doesn't throw); a
  // second unmount is a no-op, so swallow it and just clean the DOM.
  try { act(() => hostRoot.unmount()); } catch { /* already unmounted */ }
  container.remove();
});

/** Mount a MountPoint whose extension spins up its OWN React root into the
 * node it's handed — the mount model `fez pack` produces (ridges, loom). */
function mountExtension(render: Parameters<typeof MountPoint>[0]["render"]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  hostRoot = createRoot(container);
  act(() => hostRoot.render(<MountPoint render={render} />));
}

describe("MountPoint — the mount-model bridge", () => {
  it("hands the extension a dedicated child node, not the host's own div", () => {
    let given: HTMLElement | undefined;
    mountExtension((host) => {
      given = host;
      return () => {};
    });
    // The node the extension renders into must be isolated from the div the
    // host's React reconciles — a child of it, never the node itself. This
    // is what keeps two React roots off the same DOM node (the NotFoundError
    // race on teardown).
    expect(given).toBeDefined();
    expect(given!.parentElement).toBeTruthy();
    expect(given!.parentElement).not.toBe(given);
    expect(container.contains(given!)).toBe(true);
  });

  it("a foreign createRoot mounts and tears down without throwing", async () => {
    let disposed = false;
    let mountNode: HTMLElement | undefined;
    mountExtension((host) => {
      mountNode = host;
      const root = createRoot(host!);
      // flushSync so the foreign commit lands before the assert — the app
      // commits async, but the test needs deterministic timing.
      flushSync(() => root.render(<span data-testid="ext">hello from the extension</span>));
      return () => {
        disposed = true;
        root.unmount();
      };
    });
    expect(mountNode!.textContent).toContain("hello from the extension");
    // Tearing the host down disposes the extension AND removes its node —
    // the whole point: no orphaned foreign nodes, no removeChild race.
    // Teardown is deferred to a microtask, so flush it before asserting.
    expect(() => act(() => hostRoot.unmount())).not.toThrow();
    await Promise.resolve();
    expect(disposed).toBe(true);
    expect(mountNode!.isConnected).toBe(false);
  });
});
