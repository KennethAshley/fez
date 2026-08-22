/**
 * Extension permissions — pure, eval-pinned.
 *
 * An extension is arbitrary code from a stranger. Today it gets the whole
 * API: every channel it can read, publishing as you, unrestricted network,
 * and (since the background seam) unattended execution in the always-on
 * process that holds your key. That's fine for extensions you wrote and
 * indefensible for a store.
 *
 * The model, deliberately boring and borrowed from every store that has
 * survived contact with users (browser extensions, VS Code, Obsidian):
 * a package DECLARES what it needs, the user sees that list before
 * anything runs, the grant is recorded, and the host hands the extension
 * an API narrowed to the grant. Undeclared capability is absent, not
 * merely discouraged.
 *
 * What this is NOT: a sandbox. A headless extension is a Node module and
 * can require() its way around anything we do here; the GUI half is
 * better (we control the scope it evaluates in) but not airtight. The
 * value is informed consent and accident-resistance, and the honest
 * framing at install time is "this is what it says it needs", not "this
 * is all it can do".
 */

export type PermissionId =
  | "read:channels"
  | "read:dms"
  | "read:agents"
  | "publish"
  | "commands"
  | "ui"
  | "background"
  | `network:${string}`;

export interface PermissionInfo {
  id: string;
  /** Shown at install time. Written for someone deciding, not for a spec. */
  description: string;
  /** Permissions a reasonable person would want to think twice about. */
  sensitive: boolean;
}

const KNOWN: Record<string, Omit<PermissionInfo, "id">> = {
  "read:channels": { description: "Read messages in your channels", sensitive: false },
  "read:dms": { description: "Read your private direct messages", sensitive: true },
  "read:agents": { description: "See your agent roster and their activity", sensitive: false },
  publish: { description: "Post messages, reactions, and docs AS YOU", sensitive: true },
  commands: { description: "Add slash commands", sensitive: false },
  ui: { description: "Add panels, themes, and message cards", sensitive: false },
  background: { description: "Run on a schedule while you're away", sensitive: true },
  // Sensitive: standing instructions reach every agent this host starts,
  // on every turn, ahead of anything a person says to them. An extension
  // with this can change what your agents will and won't do.
  "system-prompt": { description: "Add standing instructions to all your agents", sensitive: true },
  personas: { description: "Read and edit your agent personas (their instructions and settings)", sensitive: true },
};

export interface ParsedPermissions {
  granted: string[];
  /** Hosts from network:<host> declarations, lowercased. "*" means any. */
  networkHosts: string[];
  unknown: string[];
}

export function parsePermissions(declared: readonly string[] | undefined): ParsedPermissions {
  const granted: string[] = [];
  const networkHosts: string[] = [];
  const unknown: string[] = [];
  for (const raw of declared ?? []) {
    const id = String(raw).trim().toLowerCase();
    if (!id) continue;
    if (id.startsWith("network:")) {
      const host = id.slice("network:".length).trim();
      if (host) {
        networkHosts.push(host);
        granted.push(`network:${host}`);
      }
      continue;
    }
    if (id in KNOWN) granted.push(id);
    else unknown.push(id);
  }
  return { granted: [...new Set(granted)], networkHosts: [...new Set(networkHosts)], unknown };
}

export function describePermission(id: string): PermissionInfo {
  if (id === "network:relay") {
    return { id, description: "Reach your relay's HTTP endpoints (git, media) — the server already trusted with your messages", sensitive: false };
  }
  if (id.startsWith("network:")) {
    const host = id.slice("network:".length);
    return {
      id,
      description: host === "*" ? "Connect to ANY server on the internet" : `Connect to ${host}`,
      sensitive: host === "*",
    };
  }
  const known = KNOWN[id];
  return known ? { id, ...known } : { id, description: `Unrecognized permission "${id}"`, sensitive: true };
}

/** Install-time consent block. Sensitive lines are marked so they can be highlighted. */
export function consentLines(declared: readonly string[] | undefined): PermissionInfo[] {
  const { granted, unknown } = parsePermissions(declared);
  return [...granted, ...unknown].map(describePermission);
}

export function has(granted: readonly string[] | undefined, permission: string): boolean {
  return (granted ?? []).includes(permission);
}

/**
 * Is `url` reachable under this grant? Exact host match, or a leading-dot
 * suffix match (network:.example.com covers api.example.com). "*" allows
 * everything and is flagged sensitive at install. A malformed URL is
 * refused — the caller can't have meant it.
 */
export function networkAllowed(hosts: readonly string[] | undefined, url: string, relayHosts: readonly string[] = []): boolean {
  const list = (hosts ?? []).flatMap((entry) =>
    // "relay" is not a hostname — it names WHATEVER relay this
    // workspace uses, resolved by the host at call time. An extension
    // serving relay HTTP surfaces (git, media) cannot know the host at
    // publish time, and "network:*" would be claiming far more than
    // "the server you already trust with every message".
    entry === "relay" ? relayHosts.map((h) => h.toLowerCase()) : [entry]
  );
  if (list.length === 0) return false;
  // Parse BEFORE consulting the grant: a url we can't resolve to a host
  // is refused even under "*", because "allow any host" is not the same
  // claim as "allow a request whose host I could not determine".
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (list.includes("*")) return true;
  return list.some((entry) => (entry.startsWith(".") ? host === entry.slice(1) || host.endsWith(entry) : host === entry));
}

/**
 * What an extension's declaration IMPLIES it will do, for packages that
 * predate permissions: a package with parts but no declaration gets the
 * legacy grant (everything except the sensitive ones) so existing
 * installs keep working, and the UI can flag it as undeclared.
 */
export const LEGACY_GRANT: string[] = ["read:channels", "read:agents", "commands", "ui"];
