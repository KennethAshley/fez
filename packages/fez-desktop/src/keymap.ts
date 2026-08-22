/**
 * Keymap — the pure half, deliberately free of React and Tauri so it can
 * be reasoned about and tested on its own.
 *
 * A keymap binds an ACTION (a named app operation — "search", "go-home")
 * to a key chord ("mod+k"). Defaults live here; the user's
 * ~/.fez/keymap.json overrides or unbinds them. `mod` is ⌘ on macOS and
 * Ctrl elsewhere, so one binding reads correctly on both.
 *
 * The GUI's Keyboard panel and hand-editing the file are two doors onto
 * the same map: the file is the source of truth, this module the rules.
 */
export type ActionId = string;

/** Ships in code; a user file layers on top. Keep to GLOBAL actions — context keys (Enter, Esc, up-to-edit) stay in their local handlers. */
export const DEFAULT_KEYMAP: Record<ActionId, string> = {
  search: "mod+k",
  settings: "mod+,",
  "next-unread": "alt+down",
  "prev-unread": "alt+up",
  "go-home": "mod+shift+h",
};

/** Human labels for the Keyboard panel — every DEFAULT_KEYMAP id needs one. */
export const ACTION_LABELS: Record<ActionId, string> = {
  search: "Search messages & docs",
  settings: "Open settings",
  "next-unread": "Next unread channel",
  "prev-unread": "Previous unread channel",
  "go-home": "Go to your mentions",
};

export interface Chord {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** The subset of a DOM KeyboardEvent we match on — kept local so this file needs no DOM lib. */
export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MOD_ALIASES = new Set(["mod", "cmd", "command", "ctrl", "control", "meta", "super"]);
const ALT_ALIASES = new Set(["alt", "option", "opt"]);

/** "mod+shift+k" → a chord. Order-insensitive; the last non-modifier token is the key. Undefined if no key. */
export function parseBinding(binding: string): Chord | undefined {
  const chord: Chord = { mod: false, alt: false, shift: false, key: "" };
  for (const raw of binding.toLowerCase().split("+")) {
    const token = raw.trim();
    if (!token) continue;
    if (MOD_ALIASES.has(token)) chord.mod = true;
    else if (ALT_ALIASES.has(token)) chord.alt = true;
    else if (token === "shift") chord.shift = true;
    else chord.key = normalizeKey(token);
  }
  return chord.key ? chord : undefined;
}

/** DOM key names vary; fold them to the tokens bindings are written in. */
export function normalizeKey(key: string): string {
  const low = key.toLowerCase();
  const map: Record<string, string> = {
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    escape: "esc",
    " ": "space",
    spacebar: "space",
  };
  return map[low] ?? low;
}

/**
 * Layer the user's file over the defaults. A string rebinds; an empty
 * string or null UNBINDS (so a user can turn a default off). Non-string
 * values and unknown shapes are ignored — a broken file never throws.
 */
export function mergeKeymap(user: unknown): Record<ActionId, string> {
  const merged: Record<ActionId, string> = { ...DEFAULT_KEYMAP };
  if (user && typeof user === "object" && !Array.isArray(user)) {
    for (const [action, binding] of Object.entries(user as Record<string, unknown>)) {
      if (typeof binding === "string" && binding.trim()) merged[action] = binding.trim();
      else if (binding === "" || binding === null) delete merged[action];
      // anything else: ignore, keep the default
    }
  }
  return merged;
}

/** Parse a keymap.json string into merged bindings, never throwing on bad JSON. */
export function loadKeymap(json: string | undefined): Record<ActionId, string> {
  if (!json) return { ...DEFAULT_KEYMAP };
  try {
    return mergeKeymap(JSON.parse(json));
  } catch {
    return { ...DEFAULT_KEYMAP };
  }
}

/** The action a key event triggers, or undefined. `mac` decides whether `mod` means ⌘ or Ctrl. */
export function matchAction(event: KeyEventLike, keymap: Record<ActionId, string>, mac: boolean): ActionId | undefined {
  const modActive = mac ? event.metaKey : event.ctrlKey;
  const key = normalizeKey(event.key);
  for (const [action, binding] of Object.entries(keymap)) {
    const chord = parseBinding(binding);
    if (!chord) continue;
    if (chord.mod !== modActive) continue;
    if (chord.alt !== event.altKey) continue;
    if (chord.shift !== event.shiftKey) continue;
    if (chord.key !== key) continue;
    return action;
  }
  return undefined;
}

/**
 * The channel to jump to for next/prev-unread: walk `order` from just past
 * the current channel, wrapping once, and return the first with unread > 0.
 * Pure — `order` is the sidebar's channel-id order, `unreads` the count map.
 * Undefined when nothing else is unread (nowhere to go).
 */
export function nextUnreadChannel(
  order: readonly string[],
  unreads: ReadonlyMap<string, number>,
  currentId: string | undefined,
  dir: 1 | -1
): string | undefined {
  if (order.length === 0) return undefined;
  const start = currentId ? order.indexOf(currentId) : -1;
  for (let step = 1; step <= order.length; step++) {
    // from `start`, move `dir`, wrapping; when there is no current, start at an end
    const idx = (((start === -1 ? (dir === 1 ? -1 : 0) : start) + dir * step) % order.length + order.length) % order.length;
    const id = order[idx];
    if (id !== currentId && (unreads.get(id) ?? 0) > 0) return id;
  }
  return undefined;
}

/** Render a KeyboardEvent as a binding string the file would use — for the panel's "press to record". */
export function eventToBinding(event: KeyEventLike, mac: boolean): string | undefined {
  const key = normalizeKey(event.key);
  // a bare modifier isn't a binding on its own
  if (["shift", "alt", "control", "meta", "option", "command"].includes(key)) return undefined;
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}
