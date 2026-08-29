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
    const { dispose, element } = classifyMountResult(render(host.current));
    if (element) setPortal(createPortal(element, host.current));
    return () => {
      dispose?.();
      setPortal(null);
    };
  }, [render]);
  return <div ref={host} style={{ display: "contents" }}>{portal}</div>;
}
