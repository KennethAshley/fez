/**
 * @fez/extension-api — the contract you build a fez extension against.
 *
 * A fez package extends one or more SURFACES, each with its own host
 * and API:
 *
 *   headless   → the TUI + sentinel (slash commands, scheduled tasks)
 *   gui        → the desktop webview (panels, views, decorators)
 *   relay      → the relay process (HTTP handlers, NIP-11 ads)
 *   workspace  → the agent runtime (repo checkouts)
 *
 * Import the surface(s) you extend. These are TYPES ONLY — they erase at
 * bundle time, so your shipped part carries no dependency on fez. The
 * host injects the real API at load time; you type against this.
 *
 *   import type { FezExtensionAPI } from "@fez/extension-api/headless";
 *   import type { GuiExtensionApi } from "@fez/extension-api/gui";
 */
export type * from "./headless.js";
export type * from "./gui.js";
export type * from "./relay.js";
export type * from "./workspace.js";
export type * from "./manifest.js";
export type * from "./nostr.js";
