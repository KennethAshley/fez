import type { ReactNode } from "react";

/** What a mount-form callback returns to tear itself down. */
export type Dispose = () => void;

/**
 * A view registration's callback. Legacy form `() => El` still returns an
 * element the host renders. The mount form takes the host node, mounts its
 * own React root into it, and returns a disposer — or nothing.
 */
export type MountRender = (host?: HTMLElement) => ReactNode | Dispose | void;

/**
 * Tell a mount-form disposer apart from legacy element content, so the
 * bridge (MountPoint, Task 5) knows whether to call it later or render it
 * now. A function is always a disposer — nothing legacy ever returned one.
 */
export function classifyMountResult(result: unknown): { dispose?: Dispose; element?: ReactNode } {
  if (typeof result === "function") return { dispose: result as Dispose };
  // Double-cast: TS won't narrow `unknown` straight to ReactNode from an
  // `in` check, so the detour through `unknown` is the honest way to say
  // "checked what I could (has $$typeof), trust the rest."
  if (result && typeof result === "object" && "$$typeof" in result) return { element: result as unknown as ReactNode };
  return {};
}
