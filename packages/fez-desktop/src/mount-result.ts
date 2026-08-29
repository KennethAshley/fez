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
 *
 * Legacy `() => El` is really `() => ReactNode`, and ReactNode is wider
 * than elements: a string, number, array, or fragment is equally valid
 * content a legacy callback may have always returned. Only a function is
 * a disposer; only null/undefined is "nothing" — everything else in
 * between is content, so it renders rather than silently vanishing.
 */
export function classifyMountResult(result: unknown): { dispose?: Dispose; element?: ReactNode } {
  if (typeof result === "function") return { dispose: result as Dispose };
  if (result === null || result === undefined) return {};
  // Cast: TS can't narrow `unknown` to ReactNode on its own — everything
  // that isn't a function or nullish IS a valid ReactNode by definition
  // (string | number | ReactElement | ReactNode[] | ...), so this is
  // asserting the type ReactNode itself already promises, not guessing.
  return { element: result as ReactNode };
}
