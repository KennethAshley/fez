/**
 * The `fez` block of a package's package.json — how a package declares
 * WHICH surfaces it extends and WHAT it may do. `fez install` /
 * `fez link` place each part; the host loads the parts it recognizes
 * and injects the matching API.
 */
export interface FezManifest {
  /** npm's own bin map — executables copied to ~/.fez/bin (credential helpers, CLIs). */
  bin?: Record<string, string>;
  fez: {
    type: "extension" | "integration" | "agent" | "persona-pack";
    /** External binaries this package shells out to (`["gh"]`) — reported, never installed. */
    requires?: string[];
    parts?: {
      /** MCP server definition merged into the machine catalog. */
      skill?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
      /** → ~/.fez/extensions: slash commands + scheduled tasks (TUI/sentinel). */
      headless?: string;
      /** → ~/.fez/gui-extensions: desktop panels, views, commands. */
      gui?: string;
      /** → ~/.fez/relay-extensions: HTTP handlers + NIP-11 advertisements (relay --extensions). */
      relay?: string;
      /** → ~/.fez/workspace-providers: a `repo:` persona's checkout. */
      workspace?: string;
      /** Opt the headless part's scheduled tasks into the always-on sentinel. */
      background?: boolean;
    };
    /** What this package asks for — the install dialog shows these. See the permissions reference. */
    permissions?: string[];
  };
}

/**
 * The permission vocabulary. `network:relay` resolves to the workspace's
 * own relay host at call time; `network:<host>` is a fixed host.
 */
export type FezPermission =
  | "read:channels"
  | "read:dms"
  | "read:agents"
  | "publish"
  | "commands"
  | "ui"
  | "background"
  | "system-prompt"
  | "personas"
  | "network:relay"
  | `network:${string}`;
