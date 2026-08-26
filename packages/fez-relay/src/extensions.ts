import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RelayPolicy } from "./policies.js";
import type { StoredEvent } from "./relay.js";

/**
 * The relay's extension API — the host that did not have one.
 *
 * fez's parts are PLACES: `headless` lands in ~/.fez/extensions and the
 * TUI and sentinel read it, `gui` lands in ~/.fez/gui-extensions and the
 * desktop reads it. The relay was the one host with no directory of its
 * own, so anything it needed to do had to be written INTO it — which is
 * how git nearly ended up as a field on RelayOptions and a file inside
 * this package.
 *
 * It has one now. `parts.relay` lands in ~/.fez/relay-extensions and
 * this reads it, so serving git, exposing metrics, or enforcing a house
 * policy are all things you install rather than things somebody forks
 * the relay to add.
 *
 * TRUST. This is code inside the process holding everyone's events, so
 * loading is OPT-IN (`--extensions`) and the directory is the operator's
 * own machine — the same bar as the `--config` module that already
 * exists, not the bar for a GUI extension a user clicks install on. A
 * relay that never passes the flag behaves exactly as it always did.
 */

export interface RelayExtensionAPI {
  /**
   * Answer HTTP requests on the relay's port. First handler to claim a
   * request owns it; anything unclaimed falls through to NIP-11.
   */
  registerHttpHandler(handler: {
    handle(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>;
  }): void;
  /** Enforce something at ingest — the same seam --config policies use. */
  registerPolicy(policy: RelayPolicy): void;
  /**
   * Describe what you added, in the relay's NIP-11 document.
   *
   * An extension serving something over HTTP has to say where it is, or
   * every client derives the URL from the websocket address — which is
   * silently wrong the moment a proxy puts that surface on another host.
   * Buzz makes the same call: its repo announcements carry an explicit
   * `clone` tag rather than letting clients reconstruct one.
   *
   * Namespace the key by package (`fez_git`, not `git`) so two
   * extensions cannot collide. The relay's own fields always win, so
   * this cannot be used to restate who owns the workspace.
   */
  advertise(key: string, value: unknown): void;
  /**
   * Read what the relay has stored.
   *
   * This is how an extension authorizes against facts the workspace
   * already signed — the roster (47102) and the ban list (30047) —
   * rather than inventing a second, weaker permission model beside them.
   */
  query(filter: Record<string, unknown>): StoredEvent[];
  /** Where an extension may keep bytes (bare repos, caches). */
  dataDir(name: string): string;
  /**
   * Public origins this relay answers to, for anything signing URLs.
   * Behind a proxy the relay cannot know this — the operator says.
   */
  origins: readonly string[];
  /**
   * The workspace owner's pubkey, from NIP-11.
   *
   * Anything authorizing against the roster needs it: 47102 only counts
   * when the owner signed it, and the owner is implicitly a member of
   * their own workspace. Undefined means unclaimed — and an extension
   * that gates on membership should then allow nobody, because on an
   * unclaimed relay no roster can be valid.
   */
  owner?: string;
  log(line: string): void;
  /** Observe every accepted event (stored + ephemeral), after fan-out. */
  onEvent(cb: (event: StoredEvent) => void): void;
  /**
   * Feed an event through the relay's normal ingest pipeline — dedupe,
   * signature verification, policies, store, fan-out — exactly as if it
   * arrived over the wire. The relay stays the validator; injection
   * grants no authority a signed event doesn't already carry.
   */
  inject(event: StoredEvent): { accepted: boolean; reason?: string };
}

export interface LoadedRelayExtensions {
  httpHandlers: { handle(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean> }[];
  policies: RelayPolicy[];
}

export interface LoadOptions {
  /** Defaults to ~/.fez/relay-extensions. */
  dir?: string;
  /** Where extensions may store bytes. Defaults to ~/.fez/relay-data. */
  dataRoot?: string;
  origins?: readonly string[];
  owner?: string;
  query(filter: Record<string, unknown>): StoredEvent[];
  /** Where an advertised NIP-11 field lands — RelayHandle.advertise. */
  advertise?: (key: string, value: unknown) => void;
  log?: (line: string) => void;
  /** RelayHandle.onEvent, threaded through so an extension can observe traffic. */
  onEvent(cb: (event: StoredEvent) => void): void;
  /** RelayHandle.inject, threaded through so an extension can feed the pipeline. */
  inject(event: StoredEvent): { accepted: boolean; reason?: string };
}

/**
 * Load every extension in the directory, in name order.
 *
 * One broken extension is skipped with a line saying so rather than
 * taking the relay down: a relay that will not start because somebody's
 * metrics module has a syntax error is a worse failure than a relay
 * missing its metrics.
 */
export async function loadRelayExtensions(opts: LoadOptions): Promise<LoadedRelayExtensions> {
  const dir = opts.dir ?? path.join(os.homedir(), ".fez", "relay-extensions");
  const dataRoot = opts.dataRoot ?? path.join(os.homedir(), ".fez", "relay-data");
  const log = opts.log ?? (() => {});
  const loaded: LoadedRelayExtensions = { httpHandlers: [], policies: [] };

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort();
  } catch {
    return loaded; // no directory is the normal case
  }

  for (const entry of entries) {
    const name = entry.replace(/\.m?js$/, "");
    const api: RelayExtensionAPI = {
      registerHttpHandler: (handler) => loaded.httpHandlers.push(handler),
      registerPolicy: (policy) => loaded.policies.push(policy),
      advertise: (key, value) => opts.advertise?.(key, value),
      query: opts.query,
      dataDir: (who) => {
        const target = path.join(dataRoot, who);
        fs.mkdirSync(target, { recursive: true });
        return target;
      },
      origins: opts.origins ?? [],
      owner: opts.owner,
      log: (line) => log(`${name}: ${line}`),
      onEvent: opts.onEvent,
      inject: opts.inject,
    };
    try {
      const module = (await import(pathToFileURL(path.join(dir, entry)).href)) as {
        default?: (api: RelayExtensionAPI) => void | Promise<void>;
        activate?: (api: RelayExtensionAPI) => void | Promise<void>;
      };
      const activate = module.default ?? module.activate;
      if (typeof activate !== "function") {
        log(`⚠️  relay extension ${name} exports no default function — skipped`);
        continue;
      }
      await activate(api);
      log(`   ⇄ relay extension ${name}`);
    } catch (err) {
      log(`⚠️  relay extension ${name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return loaded;
}
