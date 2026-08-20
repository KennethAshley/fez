/**
 * In-memory model of the workspace this fez is looking at, built purely
 * from relay events fed in via absorb().
 *
 * **A relay IS a workspace.** "Raleigh, NC" is a relay holding #food,
 * #sports and #weather; adding the relay is joining it. There is no
 * community layer — the previous model let one relay hold many
 * communities, which produced three identical "Home"s from one creator
 * and made switching relays look like losing your account.
 *
 * Trust: the workspace's owner is a pubkey the relay advertises in its
 * NIP-11 document. Only that key's 47101 (channel), 47102 (roster) and
 * 30047 (bans) count. The relay is still dumb storage — it merely names
 * who is in charge, and lying about that only gets its own events
 * ignored. Signature validity is nostr-tools' job upstream.
 *
 * Membership is workspace-wide: one roster, and being on it means every
 * channel. That is what "joined by invite and sees all the channels"
 * requires, and it is what Slack has always done.
 */

export type Role = "owner" | "admin" | "member" | "bot";

export interface Channel {
  id: string;
  name: string;
  /** created_at of the winning 47101 — later owner edits rename in place. */
  createdAt: number;
  /**
   * What made this channel, when something other than a person did.
   *
   * A bridge opens a channel per thing it mirrors — a repo, a mailbox,
   * a board — and a rail that lists twelve repos beside #general reads
   * as twelve rooms you are neglecting rather than one integration.
   * Grouping needs the client to know the difference, and only the
   * event that created the channel does.
   *
   * Free-form and owner-signed: the same key that may create a channel
   * says where it came from, so this grants nothing a channel did not
   * already have. Absent for channels people made, which is most.
   */
  source?: string;
}

export interface Workspace {
  /** Relay URL — the workspace's identity, and the only thing that is. */
  relay: string;
  /** Owner pubkey from NIP-11. Undefined = unclaimed: nothing can be valid. */
  owner?: string;
  /** From NIP-11, falling back to the relay host. */
  name: string;
  channels: Map<string, Channel>;
  /** The one roster. On it = every channel in this workspace. */
  members: Map<string, Role>;
  rosterCreatedAt: number;
  rosterEventId?: string;
  banned: Set<string>;
  banListCreatedAt: number;
  banListEventId?: string;
}

/** Where you are. No community — the workspace is the relay you're on. */
export interface Scope {
  channelId: string;
}

/** One entry in the workspace rail. */
export interface KnownWorkspace {
  relay: string;
  name?: string;
}

interface Persisted {
  /** The rail — every workspace you've added. Switching never drops one. */
  workspaces: KnownWorkspace[];
  active?: string;
  /** relay URL -> last channel there, so switching back lands where you were. */
  lastScope?: Record<string, string>;
}

/**
 * Persistence seam — the client core is host-agnostic (Wire philosophy):
 * node hosts install the file-backed impl (state-node.ts), browser hosts
 * (fez-desktop) bring localStorage, tests bring whatever. Default is
 * in-memory: state lives for the process, nothing touches disk.
 */
export interface StatePersistence {
  exists(): boolean;
  read(): string | undefined;
  write(text: string): void;
}

function inMemoryPersistence(): StatePersistence {
  let stored: string | undefined;
  return {
    exists: () => stored !== undefined,
    read: () => stored,
    write: (text) => {
      stored = text;
    },
  };
}

let persistence: StatePersistence = inMemoryPersistence();
export function setStatePersistence(p: StatePersistence): void {
  persistence = p;
}

/** A readable workspace name from a relay URL, when NIP-11 offers none. */
export function nameFromRelay(relay: string): string {
  try {
    const url = new URL(relay.replace(/^ws/, "http"));
    const host = url.hostname;
    if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(host)) return "Local";
    const parts = host.split(".");
    return parts.length >= 2 ? (parts[0] === "relay" ? parts[1] : parts[0]) : host;
  } catch {
    return relay;
  }
}

const KIND_CHANNEL = 47101;
const KIND_MEMBERSHIP = 47102;
const KIND_BAN_LIST = 30047;
const ROSTER_D = "roster";
const BANS_D = "bans";

export function emptyWorkspace(relay: string, name?: string): Workspace {
  return {
    relay,
    name: name ?? nameFromRelay(relay),
    channels: new Map(),
    members: new Map(),
    rosterCreatedAt: 0,
    banned: new Set(),
    banListCreatedAt: 0,
  };
}

export class WorkspaceState {
  /** The workspace currently open. One at a time — switching reconnects. */
  workspace: Workspace = emptyWorkspace("");
  /** The rail: every workspace added, whether or not it is active. */
  known: KnownWorkspace[] = [];
  scope: Scope | null = null;
  private lastScope: Record<string, string> = {};

  /** Whether any state was ever persisted — the first-run bootstrap check. */
  persistedFileExists(): boolean {
    return persistence.exists();
  }

  /**
   * Point at a workspace. Remembers it in the rail and restores where you
   * were — switching workspaces must never behave like losing one.
   */
  open(relay: string, name?: string): void {
    this.workspace = emptyWorkspace(relay, name);
    if (!this.known.some((w) => w.relay === relay)) this.known.push({ relay, name });
    const remembered = this.lastScope[relay];
    this.scope = remembered ? { channelId: remembered } : null;
    this.save();
  }

  /** Drop a workspace from the rail. Purely local; the workspace is untouched. */
  forget(relay: string): void {
    this.known = this.known.filter((w) => w.relay !== relay);
    delete this.lastScope[relay];
    this.save();
  }

  /** What the relay says about itself (NIP-11), including who owns it. */
  describe(info: { name?: string; owner?: string }): void {
    if (info.name) {
      this.workspace.name = info.name;
      const entry = this.known.find((w) => w.relay === this.workspace.relay);
      if (entry) entry.name = info.name;
    }
    this.workspace.owner = info.owner;
    this.save();
  }

  load(): void {
    try {
      const raw: Persisted = JSON.parse(persistence.read() ?? "");
      this.known = raw.workspaces ?? [];
      this.lastScope = raw.lastScope ?? {};
      if (raw.active) {
        const entry = this.known.find((w) => w.relay === raw.active);
        this.workspace = emptyWorkspace(raw.active, entry?.name);
        const remembered = this.lastScope[raw.active];
        this.scope = remembered ? { channelId: remembered } : null;
      }
    } catch {
      // first run — nothing persisted yet
    }
  }

  save(): void {
    if (this.scope && this.workspace.relay) this.lastScope[this.workspace.relay] = this.scope.channelId;
    const data: Persisted = {
      workspaces: this.known,
      active: this.workspace.relay || undefined,
      lastScope: this.lastScope,
    };
    try {
      persistence.write(JSON.stringify(data, null, 2));
    } catch { /* persistence is best-effort; in-memory state is authoritative this session */ }
  }

  /**
   * Fold one relay event into the model. Returns true if anything changed
   * (callers re-render the sidebar on true).
   *
   * Every governed kind is checked against the owner. An unclaimed
   * workspace (no owner) absorbs nothing — failing closed here is what
   * stops the first passer-by seizing a relay that hasn't said who runs
   * it.
   */
  absorb(event: {
    id: string;
    kind: number;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  }): boolean {
    const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
    const ws = this.workspace;
    if (!ws.owner || event.pubkey !== ws.owner) return false;

    if (event.kind === KIND_CHANNEL) {
      const channelId = tag("d");
      if (!channelId) return false;
      let name = channelId;
      let source: string | undefined;
      try {
        const content = JSON.parse(event.content) as { name?: unknown; source?: unknown };
        if (typeof content.name === "string" && content.name) name = content.name;
        // Constrained before it reaches a UI: this becomes a section
        // heading in the rail, and a "source" of a thousand newlines
        // would be a channel deciding how the sidebar looks.
        if (typeof content.source === "string") {
          const clean = content.source.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24);
          if (clean) source = clean;
        }
      } catch { /* keep fallback */ }
      const existing = ws.channels.get(channelId);
      // A later owner event renames; an older one replayed must not undo it.
      if (existing && event.created_at < existing.createdAt) return false;
      ws.channels.set(channelId, { id: channelId, name, createdAt: event.created_at, source });
      return true;
    }

    if (event.kind === KIND_MEMBERSHIP) {
      if (tag("d") !== ROSTER_D) return false; // per-channel rosters are the old model
      if (event.created_at < ws.rosterCreatedAt) return false;
      // Same-second tie: deterministic winner (lowest id), so every client
      // converges regardless of arrival order. fez also bumps created_at on
      // publish (see nextRosterCreatedAt) — belt and braces, as Buzz does.
      if (
        event.created_at === ws.rosterCreatedAt &&
        ws.rosterEventId !== undefined &&
        event.id >= ws.rosterEventId
      ) {
        return false;
      }
      const members = new Map<string, Role>();
      for (const t of event.tags) {
        if (t[0] === "p" && t[1]) members.set(t[1], (t[2] as Role) ?? "member");
      }
      ws.members = members;
      ws.rosterCreatedAt = event.created_at;
      ws.rosterEventId = event.id;
      return true;
    }

    if (event.kind === KIND_BAN_LIST) {
      if (tag("d") !== BANS_D) return false;
      if (event.created_at < ws.banListCreatedAt) return false;
      if (
        event.created_at === ws.banListCreatedAt &&
        ws.banListEventId !== undefined &&
        event.id >= ws.banListEventId
      ) {
        return false;
      }
      ws.banned = new Set(event.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
      ws.banListCreatedAt = event.created_at;
      ws.banListEventId = event.id;
      return true;
    }

    return false;
  }

  currentChannel(): Channel | undefined {
    return this.scope ? this.workspace.channels.get(this.scope.channelId) : undefined;
  }

  /**
   * Is `pubkey` in this workspace? One question for the whole place —
   * every channel, every doc, every reaction. A ban is a non-member
   * everywhere, without touching the roster.
   */
  isMember(pubkey: string): boolean {
    if (this.workspace.banned.has(pubkey)) return false;
    return this.workspace.members.has(pubkey) || this.workspace.owner === pubkey;
  }

  isBanned(pubkey: string): boolean {
    return this.workspace.banned.has(pubkey);
  }

  /** Am I the one who can create channels and edit the roster? */
  isOwner(pubkey: string): boolean {
    return !!this.workspace.owner && this.workspace.owner === pubkey;
  }

  roleOf(pubkey: string): Role | undefined {
    if (this.workspace.owner === pubkey) return "owner";
    return this.workspace.members.get(pubkey);
  }

  findChannelByName(name: string): Channel | undefined {
    const wanted = name.replace(/^#/, "").toLowerCase();
    return [...this.workspace.channels.values()].find((c) => c.name.toLowerCase() === wanted);
  }

  /**
   * Sidebar text: the workspace name and its channels, current one
   * highlighted. Raw ANSI (bold/dim/cyan) instead of a chalk import keeps
   * the bundled extension lean — this is the only place it styles text.
   */
  sidebarText(unreads?: Map<string, number>): string {
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const active = (s: string) => `\x1b[1;36m${s}\x1b[39m\x1b[22m`; // bold cyan (fg/weight resets only — a full \x1b[0m kills the pane background)
    const ws = this.workspace;
    if (!ws.relay) return dim("no workspace\n/workspace add <relay>");
    const lines: string[] = [bold(ws.name)];
    if (!ws.owner) lines.push(dim("  unclaimed — no owner"));
    const channels = [...ws.channels.values()];
    channels.forEach((channel, i) => {
      const glyph = i === channels.length - 1 ? "└─" : "├─";
      const current = this.scope?.channelId === channel.id;
      const label = `#${channel.name}`;
      const count = dim(` ${ws.members.size}`);
      const unread = unreads?.get(channel.id) ?? 0;
      const badge = unread > 0 && !current ? ` ${bold(`(${unread > 99 ? "99+" : unread})`)}` : "";
      lines.push(current ? `${dim(glyph)} ${active("▸ " + label)}${count}` : `${dim(glyph)} ${label}${count}${badge}`);
    });
    if (channels.length === 0) lines.push(dim("  no channels yet"));
    return lines.join("\n");
  }
}
