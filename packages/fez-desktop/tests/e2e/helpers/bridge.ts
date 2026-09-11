import type { Page } from "@playwright/test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

export type Handlers = Record<string, (args: Record<string, unknown>) => unknown>;

/** Account keys stay in the Node-side native mock. The page receives only
 * pubkeys/signatures unless a test explicitly uses the export command. */
export interface DynamicOptions {
  identities?: Record<string, string>;
  denyIdentityExport?: boolean;
}

/**
 * A fresh machine: no fez identity in the keychain yet. App.tsx's boot
 * calls `get_pubkey` first (never `get_identity` directly — that's the
 * explicit-reveal command used by settings/backup, not the boot path);
 * `get_pubkey` propagates `get_identity`'s error verbatim when the
 * keychain item is absent. The frontend routes to onboarding on a
 * case-insensitive match of "no fez identity" in the error message
 * (see App.tsx's boot .catch), so this string must contain exactly
 * that phrase — mirrored from src-tauri/src/lib.rs's
 * `no fez identity in the keychain for account "{account}"`.
 */
const NO_IDENTITY = `no fez identity in the keychain for account "default"`;

const FRESH_MACHINE: Handlers = {
  get_pubkey: () => { throw NO_IDENTITY; }, // no identity yet → App.tsx routes to onboarding
  get_identity: () => { throw NO_IDENTITY; }, // explicit-reveal path (settings/backup), not boot — mocked for completeness
  set_identity: () => null,
  detect_harnesses: () => JSON.stringify({ "claude-code": false, pi: true }),
  claude_brain_status: () => JSON.stringify({ installed: false, authed: false, adapterReady: false }),
  ensure_claude_adapter: () => "",
  codex_brain_status: () => JSON.stringify({ installed: false, authed: false, adapterReady: false }),
  ensure_codex_adapter: () => "",
  set_skill_secret: () => null,
  has_skill_secret: () => false,
  provider_key_present: () => false,
  wire_provider_pi: () => JSON.stringify({ provider: "local-56105ece7a", models: ["mock/model-a", "mock/model-b"] }),
  wire_chutes_pi: () => JSON.stringify({ provider: "local-56105ece7a", models: ["mock/model-a"] }),
  ensure_local_relay: () => "ws://127.0.0.1:7791",
  write_persona: () => "",
  read_persona: () => { throw "no persona"; },
  start_managed_agent: () => null,
  stop_managed_agents: () => null,
  managed_agent_status: () => JSON.stringify({}),
  runner_status: () => true,
  ensure_agent_runner: () => null,
  plugin_notification_is_permission_granted: () => true,
};

/**
 * Installs `window.__TAURI_INTERNALS__` before the app's own scripts run
 * (Playwright's addInitScript runs on every subsequent navigation/reload
 * in this page, ahead of the page's own scripts). Command results are
 * computed up front and passed across the page boundary as plain data —
 * `overrides` functions run here, in Node, and their return value (or
 * thrown value) is what the mocked `invoke` resolves/rejects with in the
 * browser; the functions themselves never cross the boundary.
 *
 * `exposeFunction` is awaited BEFORE `addInitScript` so the recorder is
 * already registered on window before the init script's invoke wrapper
 * can reference it.
 */
export async function installMockBridge(page: Page, overrides: Handlers = {}, dynamic: DynamicOptions = {}) {
  const calls: { cmd: string; args: unknown }[] = [];
  await page.exposeFunction("__fezBridgeRecord", (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
  });

  const identities = dynamic.identities ? { ...dynamic.identities } : undefined;
  // Registered BEFORE addInitScript so the window-side invoke wrapper
  // can already reference it once the page's own scripts start running.
  if (identities) {
    await page.exposeFunction("__fezBridgeIdentity", (cmd: string, args?: { account?: string; name?: string }) => {
      if (cmd === "get_identity" && dynamic.denyIdentityExport) throw new Error("identity export forbidden in this test");
      const account = cmd === "ensure_agent_identity" ? `agent:${args?.name}` : args?.account ?? "default";
      if (cmd === "ensure_agent_identity" && !identities[account]) {
        identities[account] = Array.from(generateSecretKey(), (b) => b.toString(16).padStart(2, "0")).join("");
      }
      const hex = identities[account];
      if (!hex) throw new Error(`no fez identity in the keychain for account "${account}"`);
      return cmd === "get_identity" ? hex : getPublicKey(Uint8Array.from(hex.match(/.{2}/g)!, (b) => parseInt(b, 16)));
    });
    await page.exposeFunction(
      "__fezBridgeSign",
      (tmpl: { kind: number; content: string; tags: string[][]; createdAt?: number; account?: string }) => {
        const account = tmpl.account ?? "default";
        const hex = identities[account];
        if (!hex) throw new Error(`no fez identity in the keychain for account "${account}"`);
        const secret = Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
        const event = finalizeEvent(
          {
            kind: tmpl.kind,
            content: tmpl.content,
            tags: tmpl.tags,
            created_at: tmpl.createdAt ?? Math.floor(Date.now() / 1000),
          },
          secret
        );
        return JSON.stringify(event);
      }
    );
  }

  // Handlers can't cross the page boundary as functions — serialize the
  // override RESULTS instead: each override becomes {value} or {error}.
  const table: Record<string, { value?: unknown; error?: string; isError?: boolean }> = {};
  for (const [cmd, fn] of Object.entries({ ...FRESH_MACHINE, ...overrides })) {
    try {
      table[cmd] = { value: fn({}) };
    } catch (e) {
      table[cmd] = { error: String(e), isError: true };
    }
  }
  await page.addInitScript(
    ({ table, hasIdentities }) => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: unknown) => {
          (window as unknown as { __fezBridgeRecord?: (cmd: string, args: unknown) => void }).__fezBridgeRecord?.(
            cmd,
            args
          );
          if (hasIdentities && ["get_identity", "get_pubkey", "ensure_agent_identity"].includes(cmd)) {
            return (window as unknown as { __fezBridgeIdentity: (cmd: string, args: unknown) => Promise<string> }).__fezBridgeIdentity(cmd, args);
          }
          if (hasIdentities && cmd === "sign_event") {
            return (window as unknown as { __fezBridgeSign?: (args: unknown) => Promise<string> }).__fezBridgeSign!(
              args
            );
          }
          const entry = (table as Record<string, { value?: unknown; error?: string; isError?: boolean }>)[cmd];
          if (!entry) return Promise.reject(`mock bridge: unhandled command ${cmd}`);
          return entry.isError ? Promise.reject(entry.error) : Promise.resolve(entry.value);
        },
        transformCallback: (cb: unknown) => cb,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      };
    },
    { table, hasIdentities: !!identities }
  );
  return { calls };
}
