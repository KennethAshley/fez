import { describe, it, expect } from "vitest";
import { DEFAULT_NOTIFY, notifyAllows, readPrefs, type NotifyPrefs } from "../../fez-desktop/src/notify-prefs.js";

/**
 * The gate in front of every native notification. Its failure mode is
 * silence — an alert you asked for that never arrives, with nothing on
 * screen to say it was suppressed — so each rule is pinned rather than
 * inferred from the shape of the object.
 */
const prefs = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({ ...DEFAULT_NOTIFY, ...over });

describe("notifyAllows", () => {
  it("lets a live category through by default", () => {
    expect(notifyAllows(prefs(), "dm", false)).toBe(true);
    expect(notifyAllows(prefs(), "mention", false)).toBe(true);
    expect(notifyAllows(prefs(), "needs_action", false)).toBe(true);
    expect(notifyAllows(prefs(), "agent_error", false)).toBe(true);
  });

  it("master off silences everything, whatever the categories say", () => {
    const all = prefs({ enabled: false });
    expect(notifyAllows(all, "dm", false)).toBe(false);
    expect(notifyAllows(all, "mention", false)).toBe(false);
  });

  it("stays quiet while you are looking at the app", () => {
    expect(notifyAllows(prefs(), "dm", true)).toBe(false);
  });

  it("…unless you asked to be told anyway", () => {
    expect(notifyAllows(prefs({ whileFocused: true }), "dm", true)).toBe(true);
  });

  it("silences one category without touching its neighbours", () => {
    const p = prefs({ kinds: { ...DEFAULT_NOTIFY.kinds, agent_error: false } });
    expect(notifyAllows(p, "agent_error", false)).toBe(false);
    expect(notifyAllows(p, "dm", false)).toBe(true);
  });
});

describe("readPrefs", () => {
  it("gives the defaults when nothing has been saved", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_NOTIFY);
  });

  it("gives the defaults rather than throwing on unreadable json", () => {
    expect(readPrefs("{ not json")).toEqual(DEFAULT_NOTIFY);
  });

  // A saved file predates any category added later. Dropping to "off"
  // for the new one would silence an alert nobody chose to silence.
  it("defaults a category the saved prefs never heard of to ON", () => {
    const old = JSON.stringify({ enabled: true, whileFocused: false, kinds: { dm: false } });
    const got = readPrefs(old);
    expect(got.kinds.dm).toBe(false);
    expect(got.kinds.agent_error).toBe(true);
  });

  it("keeps a saved master switch", () => {
    expect(readPrefs(JSON.stringify({ enabled: false })).enabled).toBe(false);
  });
});
