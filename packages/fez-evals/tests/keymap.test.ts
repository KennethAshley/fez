import { describe, expect, it } from "vitest";
// The desktop's pure keymap logic — no React/Tauri, so it imports clean here.
import {
  DEFAULT_KEYMAP,
  ACTION_LABELS,
  parseBinding,
  mergeKeymap,
  loadKeymap,
  matchAction,
  eventToBinding,
  nextUnreadChannel,
  type KeyEventLike,
} from "../../fez-desktop/src/keymap.js";

/**
 * The keymap is a user-facing config file — people hand-edit it and the
 * Keyboard panel writes it. Its rules must be exactly what both doors
 * expect: `mod` is ⌘ on mac and Ctrl elsewhere, an empty binding UNBINDS
 * a default, and a broken file falls back to defaults rather than leaving
 * the app with no shortcuts.
 */
const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("keymap parsing", () => {
  it("parses modifiers order-insensitively; last token is the key", () => {
    expect(parseBinding("mod+shift+k")).toEqual({ mod: true, alt: false, shift: true, key: "k" });
    expect(parseBinding("shift+mod+k")).toEqual({ mod: true, alt: false, shift: true, key: "k" });
    expect(parseBinding("alt+down")).toEqual({ mod: false, alt: true, shift: false, key: "down" });
  });
  it("treats cmd/ctrl/meta and option as aliases of mod/alt", () => {
    expect(parseBinding("cmd+k")?.mod).toBe(true);
    expect(parseBinding("ctrl+k")?.mod).toBe(true);
    expect(parseBinding("option+p")?.alt).toBe(true);
  });
  it("returns undefined for a chord with no actual key", () => {
    expect(parseBinding("mod+shift")).toBeUndefined();
    expect(parseBinding("")).toBeUndefined();
  });
  it("every default has a human label", () => {
    for (const id of Object.keys(DEFAULT_KEYMAP)) expect(ACTION_LABELS[id]).toBeTruthy();
  });
});

describe("merge & load — the user file layers over defaults", () => {
  it("keeps defaults when the file is absent or empty", () => {
    expect(loadKeymap(undefined)).toEqual(DEFAULT_KEYMAP);
    expect(loadKeymap("{}")).toEqual(DEFAULT_KEYMAP);
  });
  it("rebinds a default and adds a new action", () => {
    const km = mergeKeymap({ search: "mod+p", "toggle-mute": "mod+m" });
    expect(km.search).toBe("mod+p");
    expect(km["toggle-mute"]).toBe("mod+m");
    expect(km.settings).toBe(DEFAULT_KEYMAP.settings); // untouched
  });
  it("an empty string or null UNBINDS a default", () => {
    expect(mergeKeymap({ search: "" }).search).toBeUndefined();
    expect(mergeKeymap({ search: null }).search).toBeUndefined();
  });
  it("never throws on a broken file — falls back to defaults", () => {
    expect(loadKeymap("{ not json")).toEqual(DEFAULT_KEYMAP);
    expect(mergeKeymap(42)).toEqual(DEFAULT_KEYMAP);
    expect(mergeKeymap(["x"])).toEqual(DEFAULT_KEYMAP);
  });
  it("ignores non-string bindings, keeping the default", () => {
    expect(mergeKeymap({ search: 5 }).search).toBe(DEFAULT_KEYMAP.search);
  });
});

describe("matching events to actions", () => {
  const km = { search: "mod+k", "next-unread": "alt+down", "go-home": "mod+shift+h" };
  it("on mac, mod means ⌘ (metaKey); Ctrl does NOT fire it", () => {
    expect(matchAction(ev({ key: "k", metaKey: true }), km, true)).toBe("search");
    expect(matchAction(ev({ key: "k", ctrlKey: true }), km, true)).toBeUndefined();
  });
  it("off mac, mod means Ctrl", () => {
    expect(matchAction(ev({ key: "k", ctrlKey: true }), km, false)).toBe("search");
    expect(matchAction(ev({ key: "k", metaKey: true }), km, false)).toBeUndefined();
  });
  it("normalizes ArrowDown → down and matches an alt chord", () => {
    expect(matchAction(ev({ key: "ArrowDown", altKey: true }), km, true)).toBe("next-unread");
  });
  it("requires the shift flag to match exactly (uppercase H with shift)", () => {
    expect(matchAction(ev({ key: "H", metaKey: true, shiftKey: true }), km, true)).toBe("go-home");
    expect(matchAction(ev({ key: "h", metaKey: true }), km, true)).toBeUndefined(); // no shift → no match
  });
  it("a bare key with no modifiers matches nothing global", () => {
    expect(matchAction(ev({ key: "k" }), km, true)).toBeUndefined();
  });
});

describe("recording a binding from an event (the panel's capture)", () => {
  it("builds the same string the file uses", () => {
    expect(eventToBinding(ev({ key: "k", metaKey: true }), true)).toBe("mod+k");
    expect(eventToBinding(ev({ key: "ArrowUp", altKey: true }), true)).toBe("alt+up");
    expect(eventToBinding(ev({ key: "H", metaKey: true, shiftKey: true }), true)).toBe("mod+shift+h");
  });
  it("refuses a bare modifier press", () => {
    expect(eventToBinding(ev({ key: "Shift", shiftKey: true }), true)).toBeUndefined();
    expect(eventToBinding(ev({ key: "Meta", metaKey: true }), true)).toBeUndefined();
  });
});

describe("next/prev unread navigation", () => {
  const order = ["a", "b", "c", "d"];
  it("finds the next unread after the current, forward", () => {
    const unreads = new Map([["c", 3]]);
    expect(nextUnreadChannel(order, unreads, "a", 1)).toBe("c");
  });
  it("wraps around forward", () => {
    const unreads = new Map([["a", 1]]);
    expect(nextUnreadChannel(order, unreads, "c", 1)).toBe("a");
  });
  it("goes backward (prev)", () => {
    const unreads = new Map([["a", 1]]);
    expect(nextUnreadChannel(order, unreads, "c", -1)).toBe("a");
  });
  it("skips the current channel even if it's unread", () => {
    const unreads = new Map([["b", 5]]);
    expect(nextUnreadChannel(order, unreads, "b", 1)).toBeUndefined();
  });
  it("returns undefined when nothing is unread", () => {
    expect(nextUnreadChannel(order, new Map(), "a", 1)).toBeUndefined();
  });
  it("with no current channel, forward starts from the first", () => {
    const unreads = new Map([["b", 1]]);
    expect(nextUnreadChannel(order, unreads, undefined, 1)).toBe("b");
  });
});
