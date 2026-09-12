export type CustomSurface =
  | { kind: "settings" }
  | { kind: "nav"; name: string }
  | { kind: "navTab"; name: string; tab: string }
  | { kind: "navSummary"; name: string }
  | { kind: "thread"; name: string; channelId: string; rootId: string; rootContent: string }
  | { kind: "message"; index: number; channelId: string; msgId: string; content: string; authorName: string }
  | { kind: "profile"; index: number; pubkey: string; persona?: string };

export interface CustomMatch {
  contains?: string;
  linePrefix?: string;
  excludeContains?: string[];
  hasReceipts?: true;
  token?: { alphabet: "base58"; prefix?: string; min: number; max: number; excludeFences?: true };
}
export interface CustomChannelBinding { source?: string; meta?: Record<string, string> }
export interface CustomGuiContributions {
  settings?: true;
  nav: { name: string; glyph: string; label: string; channel?: CustomChannelBinding; tabs: { id: string; label: string }[]; summary?: true }[];
  threads: { name: string; label: string; match: CustomMatch }[];
  messages: { label: string; match: CustomMatch }[];
  profiles: { label: string }[];
}

const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid custom GUI contribution fields");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 160): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw Error("Invalid custom GUI contribution text");
  return value;
};
const list = (value: unknown, max = 8): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw Error("Invalid custom GUI contribution list");
  return value;
};
const enabled = (value: unknown): true | undefined => {
  if (value !== undefined && value !== true) throw Error("Invalid custom GUI contribution flag");
  return value;
};
function match(value: unknown): CustomMatch {
  const data = object(value, ["contains", "linePrefix", "excludeContains", "hasReceipts", "token"]);
  if (data.contains === undefined && data.linePrefix === undefined && data.hasReceipts === undefined && data.token === undefined) throw Error("Custom GUI matching needs a bounded criterion");
  const result: CustomMatch = {
    ...(data.contains === undefined ? {} : { contains: text(data.contains) }),
    ...(data.linePrefix === undefined ? {} : { linePrefix: text(data.linePrefix) }),
    ...(data.excludeContains === undefined ? {} : { excludeContains: list(data.excludeContains).map(value => text(value)) }),
    ...(data.hasReceipts === undefined ? {} : { hasReceipts: enabled(data.hasReceipts) }),
  };
  if (data.token !== undefined) {
    const token = object(data.token, ["alphabet", "prefix", "min", "max", "excludeFences"]);
    if (token.alphabet !== "base58" || !Number.isInteger(token.min) || !Number.isInteger(token.max)
      || Number(token.min) < 1 || Number(token.max) > 128 || Number(token.min) > Number(token.max)) throw Error("Invalid custom GUI token match");
    result.token = { alphabet: "base58", min: Number(token.min), max: Number(token.max),
      ...(token.prefix === undefined ? {} : { prefix: text(token.prefix, 16) }),
      ...(token.excludeFences === undefined ? {} : { excludeFences: enabled(token.excludeFences) }),
    };
  }
  return result;
}

/** Native shells select surfaces from data; extension match callbacks run only in their child. */
export function parseCustomGuiContributions(value: unknown): CustomGuiContributions {
  if (JSON.stringify(value)?.length > 32_768) throw Error("Custom GUI contributions exceed 32 KiB");
  const data = object(value, ["settings", "nav", "threads", "messages", "profiles"]);
  const result: CustomGuiContributions = {
    ...(data.settings === undefined ? {} : { settings: enabled(data.settings) }),
    nav: list(data.nav).map(value => {
      const nav = object(value, ["name", "glyph", "label", "channel", "tabs", "summary"]);
      let channel: CustomChannelBinding | undefined;
      if (nav.channel !== undefined) {
        const binding = object(nav.channel, ["source", "meta"]);
        const meta = binding.meta;
        if (meta !== undefined && (!meta || typeof meta !== "object" || Array.isArray(meta) || Object.keys(meta).length > 8)) throw Error("Invalid channel metadata match");
        channel = { ...(binding.source === undefined ? {} : { source: text(binding.source, 80) }),
          ...(meta === undefined ? {} : { meta: Object.fromEntries(Object.entries(meta).map(([key, value]) => [text(key, 80), text(value)])) }),
        };
        if (!channel.source && !Object.keys(channel.meta ?? {}).length) throw Error("Channel binding needs source or metadata");
      }
      const tabs = list(nav.tabs).map(value => { const tab = object(value, ["id", "label"]); return { id: text(tab.id, 80), label: text(tab.label) }; });
      if (new Set(tabs.map(tab => tab.id)).size !== tabs.length) throw Error("Duplicate custom tab id");
      if (!channel && (tabs.length || nav.summary)) throw Error("Custom channel tabs need a channel binding");
      return { name: text(nav.name, 80), glyph: text(nav.glyph, 8), label: text(nav.label), channel, tabs, summary: enabled(nav.summary) };
    }),
    threads: list(data.threads).map(value => { const thread = object(value, ["name", "label", "match"]); return { name: text(thread.name, 80), label: text(thread.label), match: match(thread.match) }; }),
    messages: list(data.messages).map(value => { const message = object(value, ["label", "match"]); return { label: text(message.label), match: match(message.match) }; }),
    profiles: list(data.profiles).map(value => { const profile = object(value, ["label"]); return { label: text(profile.label) }; }),
  };
  for (const items of [result.nav, result.threads]) if (new Set(items.map(item => item.name)).size !== items.length) throw Error("Duplicate custom view name");
  if (!result.settings && !result.nav.length && !result.threads.length && !result.messages.length && !result.profiles.length) throw Error("No custom GUI surfaces declared");
  return result;
}

export function matchCustomContent(content: string, match: CustomMatch): boolean {
  // Receipts are checked with the message ID by the host's rendered launcher.
  if (content.length > 1_048_576) return false;
  const lower = content.toLowerCase();
  if (match.contains && !lower.includes(match.contains.toLowerCase())) return false;
  if (match.excludeContains?.some(value => lower.includes(value.toLowerCase()))) return false;
  if (match.linePrefix && !content.split("\n").some(line => line.startsWith(match.linePrefix!))) return false;
  if (match.token) {
    const token = match.token;
    const prose = token.excludeFences ? content.replace(/```[\s\S]*?```/g, " ") : content;
    return [...prose.matchAll(/[1-9A-HJ-NP-Za-km-z]+/g)].some(([value]) => value.length >= token.min && value.length <= token.max && (!token.prefix || value.startsWith(token.prefix)));
  }
  return true;
}

export function customChannelId(channels: readonly { id: string; source?: string; archived?: boolean; meta?: Record<string, string> }[], binding: CustomChannelBinding): string | undefined {
  return channels.find(channel => !channel.archived && (!binding.source || channel.source === binding.source)
    && Object.entries(binding.meta ?? {}).every(([key, value]) => channel.meta?.[key] === value))?.id;
}
