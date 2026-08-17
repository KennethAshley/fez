
/**
 * In-memory model of every community/channel/membership this fez knows
 * about, built purely from relay events the extension feeds in via
 * absorb(). Enforces the client-side trust rules from src/kinds.ts:
 * only the community creator's 47101/47102 events count, and among a
 * channel's memberships the highest created_at wins.
 *
 * Persistence is deliberately tiny — which communities the user joined and
 * where they last were. Everything else re-syncs from the relay.
 */

export type Role = "owner" | "admin" | "member" | "bot";

export interface Channel {
  id: string;
  name: string;
  members: Map<string, Role>; // pubkey -> role
  membershipCreatedAt: number; // created_at of the winning 47102
  membershipEventId?: string; // id of the winning 47102 — same-second tie-break
}

export interface Community {
  id: string;
  creator: string; // pubkey — root of trust
  name: string;
  channels: Map<string, Channel>;
  /** Creator-signed ban list (kind 30047, latest wins). Banned = non-member everywhere. */
  banned: Set<string>;
  banListCreatedAt: number;
  banListEventId?: string;
}

export interface Scope {
  communityId: string;
  channelId: string;
}

interface Persisted {
  joined: string[]; // community ids
  lastScope?: Scope;
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

export class CommunityState {
  communities = new Map<string, Community>();
  joined = new Set<string>();
  scope: Scope | null = null;

  /** Whether any state was ever persisted — the first-run bootstrap check. */
  persistedFileExists(): boolean {
    return persistence.exists();
  }

  /** Which community a channel belongs to (undefined if unknown). */
  communityOfChannel(channelId: string): string | undefined {
    for (const community of this.communities.values()) {
      if (community.channels.has(channelId)) return community.id;
    }
    return undefined;
  }

  load(): void {
    try {
      const raw: Persisted = JSON.parse(persistence.read() ?? "");
      for (const id of raw.joined ?? []) this.joined.add(id);
      this.scope = raw.lastScope ?? null;
    } catch {
      // first run — nothing persisted yet
    }
  }

  save(): void {
    const data: Persisted = {
      joined: [...this.joined],
      lastScope: this.scope ?? undefined,
    };
    try {
      persistence.write(JSON.stringify(data, null, 2));
    } catch { /* persistence is best-effort; in-memory state is authoritative this session */ }
  }

  /**
   * Fold one relay event into the model. Returns true if anything changed
   * (callers re-render the sidebar on true). Trust rules enforced here;
   * signature validity is nostr-tools' job upstream.
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

    if (event.kind === 47100) {
      const id = tag("d");
      if (!id) return false;
      const existing = this.communities.get(id);
      // First 47100 seen for an id wins as root of trust; later events for
      // the same id only count from that same creator (metadata updates).
      if (existing && existing.creator !== event.pubkey) return false;
      let name = id;
      try {
        name = JSON.parse(event.content).name ?? id;
      } catch { /* keep fallback */ }
      this.communities.set(id, {
        id,
        creator: event.pubkey,
        name,
        channels: existing?.channels ?? new Map(),
        banned: existing?.banned ?? new Set(),
        banListCreatedAt: existing?.banListCreatedAt ?? 0,
        banListEventId: existing?.banListEventId,
      });
      return true;
    }

    if (event.kind === 30047) {
      // Ban list: creator-signed only, latest wins (id tie-break), same
      // trust chain as the roster. p tags = banned pubkeys.
      const communityId = tag("d");
      if (!communityId) return false;
      const community = this.communities.get(communityId);
      if (!community || community.creator !== event.pubkey) return false;
      if (event.created_at < community.banListCreatedAt) return false;
      if (
        event.created_at === community.banListCreatedAt &&
        community.banListEventId !== undefined &&
        event.id >= community.banListEventId
      ) {
        return false;
      }
      community.banned = new Set(event.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
      community.banListCreatedAt = event.created_at;
      community.banListEventId = event.id;
      return true;
    }

    if (event.kind === 47101) {
      const channelId = tag("d");
      const communityId = tag("c");
      if (!channelId || !communityId) return false;
      const community = this.communities.get(communityId);
      if (!community || community.creator !== event.pubkey) return false;
      let name = channelId;
      try {
        name = JSON.parse(event.content).name ?? channelId;
      } catch { /* keep fallback */ }
      const existing = community.channels.get(channelId);
      community.channels.set(channelId, {
        id: channelId,
        name,
        members: existing?.members ?? new Map(),
        membershipCreatedAt: existing?.membershipCreatedAt ?? 0,
      });
      return true;
    }

    if (event.kind === 47102) {
      const channelId = tag("d");
      const communityId = tag("c");
      if (!channelId || !communityId) return false;
      const community = this.communities.get(communityId);
      if (!community || community.creator !== event.pubkey) return false;
      const channel = community.channels.get(channelId);
      if (!channel || event.created_at < channel.membershipCreatedAt) return false;
      // Same-second tie: deterministic winner (lowest id), so every
      // client converges regardless of arrival order. Buzz avoids the
      // tie by bumping timestamps; fez does both (see invite/kick).
      if (
        event.created_at === channel.membershipCreatedAt &&
        channel.membershipEventId !== undefined &&
        event.id >= channel.membershipEventId
      ) {
        return false;
      }
      const members = new Map<string, Role>();
      for (const t of event.tags) {
        if (t[0] === "p" && t[1]) members.set(t[1], (t[2] as Role) ?? "member");
      }
      channel.members = members;
      channel.membershipCreatedAt = event.created_at;
      channel.membershipEventId = event.id;
      return true;
    }

    return false;
  }

  community(id: string): Community | undefined {
    return this.communities.get(id);
  }

  currentChannel(): { community: Community; channel: Channel } | undefined {
    if (!this.scope) return undefined;
    const community = this.communities.get(this.scope.communityId);
    const channel = community?.channels.get(this.scope.channelId);
    return community && channel ? { community, channel } : undefined;
  }

  /** Is `author` allowed to speak in this channel per the winning membership? */
  isMember(communityId: string, channelId: string, pubkey: string): boolean {
    const community = this.communities.get(communityId);
    if (!community || community.banned.has(pubkey)) return false; // banned = non-member EVERYWHERE
    return community.channels.get(channelId)?.members.has(pubkey) ?? false;
  }

  isBanned(communityId: string, pubkey: string): boolean {
    return this.communities.get(communityId)?.banned.has(pubkey) ?? false;
  }

  findChannelByName(communityId: string, name: string): Channel | undefined {
    const community = this.communities.get(communityId);
    if (!community) return undefined;
    const wanted = name.replace(/^#/, "").toLowerCase();
    return [...community.channels.values()].find((c) => c.name.toLowerCase() === wanted);
  }

  /**
   * Sidebar text: every joined community as a tree, current channel
   * highlighted. Raw ANSI (bold/dim/cyan) instead of a chalk import keeps
   * the bundled extension lean — this is the only place it styles text.
   */
  sidebarText(unreads?: Map<string, number>): string {
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const active = (s: string) => `\x1b[1;36m${s}\x1b[39m\x1b[22m`; // bold cyan (fg/weight resets only — a full \x1b[0m kills the pane background)
    const lines: string[] = [];
    for (const id of this.joined) {
      const community = this.communities.get(id);
      if (!community) continue;
      if (lines.length > 0) lines.push("");
      lines.push(bold(community.name));
      const channels = [...community.channels.values()];
      channels.forEach((channel, i) => {
        const glyph = i === channels.length - 1 ? "└─" : "├─";
        const current =
          this.scope?.communityId === id && this.scope?.channelId === channel.id;
        const label = `#${channel.name}`;
        const count = dim(` ${channel.members.size}`);
        // Unread badge — bold, after the member count: the reason to
        // glance at the sidebar at all.
        const unread = unreads?.get(channel.id) ?? 0;
        const badge = unread > 0 && !current ? ` ${bold(`(${unread > 99 ? "99+" : unread})`)}` : "";
        lines.push(current ? `${dim(glyph)} ${active("▸ " + label)}${count}` : `${dim(glyph)} ${label}${count}${badge}`);
      });
    }
    return lines.length > 0 ? lines.join("\n") : dim("no communities\n/community create <name>");
  }
}
