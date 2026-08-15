import { Footer } from "../packages/fez-tui/dist/index.js";

/**
 * Module-level singleton, same pattern as harness.ts's registry — one
 * shared Footer instance that tui.ts drives the lifecycle of (attach/detach)
 * and that extensions.ts exposes to extensions via FezExtensionAPI.ui.
 */
export const footer = new Footer();

export function setStatus(key: string, value: string): void {
  footer.setStatus(key, value);
}
