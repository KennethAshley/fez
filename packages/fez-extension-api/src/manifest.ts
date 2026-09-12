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
      /** → ~/.fez/packages/<name>: desktop panels, views, commands. */
      gui?: string;
      /** → ~/.fez/relay-extensions: HTTP handlers + NIP-11 advertisements (relay --extensions). */
      relay?: string;
      /** → ~/.fez/workspace-providers: a `repo:` persona's checkout. */
      workspace?: string;
      /** → ~/.fez/miners: SubnetMiner[] descriptors the mining harness loads. */
      miner?: string;
      /** Opt the headless part's scheduled tasks into the always-on sentinel. */
      background?: boolean;
    };
    /** Channel-source settings shortcut, declared without evaluating an isolated GUI bundle. */
    settingsSource?: string;
    /** Requires the separate settings runner; unsupported hosts must not execute this GUI part in main. */
    guiRuntime?: "isolated-settings" | "isolated-page" | "isolated" | "declarative";
    /** Declarative main-window surfaces; the GUI bundle only executes in the isolated page. */
    guiContributions?: IsolatedPageContributions | IsolatedCustomContributions;
    /** What this package asks for — the install dialog shows these. See the permissions reference. */
    permissions?: string[];
    /**
     * Oldest fez this package works on (x.y.z). `fez install` and
     * `fez link` refuse on an older host, naming both versions. Absent
     * means no claim — the package installs anywhere.
     */
    minFezVersion?: string;
  };
}

/** Host shells select a custom view using data; its callbacks execute in the child. */
export interface IsolatedCustomContributions {
  settings?: true;
  nav?: { name: string; glyph: string; label: string; channel?: { source?: string; meta?: Record<string, string> }; tabs?: { id: string; label: string }[]; summary?: true }[];
  threads?: { name: string; label: string; match: CustomContentMatch }[];
  messages?: { label: string; match: CustomContentMatch }[];
  profiles?: { label: string }[];
}

export interface CustomContentMatch {
  contains?: string;
  linePrefix?: string;
  excludeContains?: string[];
  hasReceipts?: true;
  token?: { alphabet: "base58"; prefix?: string; min: number; max: number; excludeFences?: true };
}

export interface IsolatedPageContributions {
  page: { name: string; match: PageDocumentMatch };
  messages?: { linePrefixes: string[]; label: string; summary: string; detailsLabel: string }[];
  blocks?: { language: string; label: string; description?: string; keywords?: string[]; template: string }[];
}

export interface PageDocumentMatch {
  /** An explicit fenced block selects this view by default. */
  fence: string;
  /** Otherwise offer a toggle for at least this many level-two sections containing a task list. */
  checklistSections?: number;
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
  | "sign"
  | "commands"
  | "ui"
  | "background"
  | "system-prompt"
  | "personas"
  | "processes"
  | "notifications"
  | "network:relay"
  | `network:${string}`;
