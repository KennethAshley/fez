import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { classifyMountResult, type MountRender } from "./mount-result";

/**
 * The bridge from a stored extension `render` callback to a real DOM node.
 * Owns a `<div>`, hands it to `render` once mounted, and dispatches on what
 * comes back: an element goes into the node via a host-React portal (so it
 * still lives in the extension's own component tree, not a foreign root);
 * a disposer is kept and called on unmount instead.
 *
 * `display: contents` so the wrapper adds no box of its own — the div only
 * exists to give the callback a host node, never to lay anything out.
 *
 * React's StrictMode dev double-invoke calls this effect, its cleanup, then
 * the effect again — the cleanup below always runs first and always clears
 * both the disposer and the portal, so the second invoke starts clean
 * rather than stacking a second mount on top of the first.
 */
export function MountPoint({ render }: { render: MountRender }) {
  const host = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<ReactNode>(null);
  useEffect(() => {
    if (!host.current) return;
    // The mount form runs the extension's OWN React root (fez pack bundles
    // React per-extension). Give that root a dedicated child node instead
    // of host.current itself: the host's React renders {portal} into
    // host.current, so a foreign root mutating the SAME node races the
    // host on teardown — the intermittent "object can not be found here"
    // (removeChild NotFoundError) on fast view cycling. An isolated child
    // the host never reconciles keeps the two roots off each other's DOM,
    // and a fresh node per effect run also sidesteps StrictMode's
    // "createRoot on an already-used container".
    const mountNode = document.createElement("div");
    mountNode.style.display = "contents";
    host.current.appendChild(mountNode);
    const { dispose, element } = classifyMountResult(render(mountNode));
    // Legacy/api.React content still portals into the host's own tree.
    if (element) setPortal(createPortal(element, host.current));
    return () => {
      setPortal(null);
      // Defer the foreign root's unmount out of the host's commit phase —
      // unmounting one React root synchronously while another is mid-render
      // is the race React warns about ("may lead to a race condition") and
      // the source of the intermittent teardown crash. The fresh mountNode
      // per effect means this deferred cleanup only ever touches its own
      // node, never the next mount's — so it stays StrictMode-safe.
      queueMicrotask(() => {
        dispose?.();
        mountNode.remove();
      });
    };
  }, [render]);
  return <div ref={host} style={{ display: "contents" }}>{portal}</div>;
}
