import { KIND_CHANNEL, KIND_CHANNEL_MESSAGE } from "./kinds.js";
import type { NostrAccess } from "./extensions.js";

/**
 * Channels, for the things that are not people.
 *
 * A bridge mirrors something into fez — a repo, a mailbox, a board —
 * and needs two verbs: open the channel for this thing if it isn't
 * open, and say something in it, sometimes inside a thread. Before
 * this, an extension wanting those had to build the events itself,
 * which meant copying kind numbers and threading tags out of
 * src/kinds.ts into its own file. fez-github did exactly that, and it
 * was the only package in the repo carrying a comment saying "wire
 * kinds, mirrored from" — the same duplicated-constant shape that cost
 * an afternoon elsewhere in this codebase.
 *
 * The wire lives here now. An extension says what it means; if the
 * threading tag changes, one file changes and every bridge follows.
 *
 * AUTHORITY IS UNCHANGED. Everything published here is signed by the
 * key the caller already had, and creating a channel still requires
 * being the workspace owner — a rule the relay enforces regardless of
 * what this file does. This makes the protocol easier to use
 * correctly; it grants nothing.
 */

/** What a channel's content JSON may carry. */
export interface ChannelSpec {
  /** The name people see, without the #. */
  name: string;
  /**
   * What made this channel, when it wasn't a person: "github", "email".
   *
   * Clients group by it, so twelve mirrored repos read as one
   * integration rather than twelve rooms you are ignoring. Lowercase,
   * hyphenated, short — it becomes a heading.
   */
  source?: string;
  /**
   * Whatever the maker needs to recognise this channel later, such as
   * the full `owner/name` behind a short repo channel. Strings only:
   * this is a UI hint, and nothing should be tempted to put a secret
   * in a public event.
   */
  meta?: Record<string, string>;
  visibility?: "open" | "closed";
}

export interface ChannelRef {
  id: string;
  name: string;
  source?: string;
  meta?: Record<string, string>;
}

export interface ChannelsAccess {
  /** Every channel the owner has signed into being. */
  list(): Promise<ChannelRef[]>;
  /**
   * The channel for this thing, opening it if it isn't open.
   *
   * Matches on NAME, which is what a bridge knows — it cannot remember
   * a UUID it never chose. Undefined when the channel doesn't exist and
   * this key may not create one, which is the normal case for anybody
   * who is not the workspace owner.
   */
  ensure(spec: ChannelSpec): Promise<string | undefined>;
  /** Post to a channel. Returns the message id — the handle a thread hangs off. */
  say(channelId: string, text: string, opts?: { threadRoot?: string }): Promise<string>;
}

/** A heading, not free text: it reaches a UI and must stay small. */
export function cleanSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 24);
  return clean || undefined;
}

function contentFor(spec: ChannelSpec): string {
  const content: Record<string, unknown> = {
    name: spec.name,
    visibility: spec.visibility ?? "open",
  };
  const source = cleanSource(spec.source);
  if (source) content.source = source;
  if (spec.meta && Object.keys(spec.meta).length > 0) content.meta = spec.meta;
  return JSON.stringify(content);
}

export function makeChannels(nostr: NostrAccess, ownerPubkey: string): ChannelsAccess {
  async function list(): Promise<ChannelRef[]> {
    const events = await nostr.query([{ kinds: [KIND_CHANNEL], authors: [ownerPubkey], limit: 500 }]);
    const byId = new Map<string, ChannelRef>();
    // Oldest first, so a later edit (a rename, a source being stamped
    // on) replaces what came before rather than losing to it.
    for (const event of [...events].sort((a, b) => a.created_at - b.created_at)) {
      const id = event.tags.find((t) => t[0] === "d")?.[1];
      if (!id) continue;
      try {
        const parsed = JSON.parse(event.content) as { name?: string; source?: unknown; meta?: unknown };
        if (!parsed.name) continue;
        byId.set(id, {
          id,
          name: parsed.name,
          source: cleanSource(parsed.source),
          meta: parsed.meta && typeof parsed.meta === "object" ? (parsed.meta as Record<string, string>) : undefined,
        });
      } catch { /* a malformed channel is not a channel */ }
    }
    return [...byId.values()];
  }

  return {
    list,

    async ensure(spec: ChannelSpec): Promise<string | undefined> {
      const want = spec.name.toLowerCase();
      const existing = (await list()).find((c) => c.name.toLowerCase() === want);

      if (existing) {
        // A channel opened before it knew what made it looks like a room
        // a person started, and would sit outside its group forever.
        // Re-signing the same `d` is a rename in place — clients already
        // resolve those by created_at — so stamp it once and move on.
        //
        // META COUNTS TOO. Checking only `source` meant a bridge could
        // learn something new about a channel — the branch a repo
        // tracks — and have no way to say so, because the source it had
        // already matched. The comparison is over everything the caller
        // is claiming, not just the part that groups it.
        const wantSource = cleanSource(spec.source);
        const changed =
          (wantSource !== undefined && existing.source !== wantSource) ||
          JSON.stringify(spec.meta ?? {}) !== JSON.stringify(existing.meta ?? {});
        if (changed && nostr.pubkey === ownerPubkey) {
          await nostr.publish({ kind: KIND_CHANNEL, tags: [["d", existing.id]], content: contentFor(spec) });
        }
        return existing.id;
      }

      // Only the workspace owner may sign a channel into being. Saying so
      // here saves every caller from discovering it as a silent no-op.
      if (nostr.pubkey !== ownerPubkey) return undefined;
      const id = crypto.randomUUID();
      await nostr.publish({ kind: KIND_CHANNEL, tags: [["d", id]], content: contentFor(spec) });
      return id;
    },

    async say(channelId: string, text: string, opts?: { threadRoot?: string }): Promise<string> {
      const tags: string[][] = [["h", channelId]];
      // The threading shape fez uses everywhere: a reply carries a root
      // marker, and the root is whatever message opened the thread.
      if (opts?.threadRoot) tags.push(["e", opts.threadRoot, "", "root"]);
      const event = await nostr.publish({ kind: KIND_CHANNEL_MESSAGE, tags, content: text });
      return event.id;
    },
  };
}
