import { describe, it, expect } from "vitest";
import { DEFAULT_NOTIFY, notifyAllows, readPrefs, soundFor, type NotifyPrefs } from "../../fez-desktop/src/notify-prefs.js";
import { SOUND_NAMES } from "../../fez-desktop/src/sounds.js";

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

/**
 * Sound. The files are supplied separately (licensed assets, not checked
 * in from anywhere), so every rule here has to survive a catalog that is
 * EMPTY, and a saved preference naming a file somebody later deleted.
 */
describe("soundFor", () => {
  const catalog = ["chime", "knock"];
  const withSound = (over: Partial<NotifyPrefs> = {}): NotifyPrefs => ({
    ...DEFAULT_NOTIFY,
    sound: true,
    sounds: { ...DEFAULT_NOTIFY.sounds, dm: "chime", mention: "knock" },
    ...over,
  });

  it("names the file chosen for that category", () => {
    expect(soundFor(withSound(), "dm", catalog)).toBe("chime");
    expect(soundFor(withSound(), "mention", catalog)).toBe("knock");
  });

  it("is silent when the sound master is off", () => {
    expect(soundFor(withSound({ sound: false }), "dm", catalog)).toBeUndefined();
  });

  // Turning a category off should not leave it audible — the row says
  // "off", and a sound still playing would make the page a liar.
  it("is silent for a category whose own toggle is off", () => {
    const p = withSound({ kinds: { ...DEFAULT_NOTIFY.kinds, dm: false } });
    expect(soundFor(p, "dm", catalog)).toBeUndefined();
  });

  it("is silent when no sound was chosen for it", () => {
    expect(soundFor(withSound(), "needs_action", catalog)).toBeUndefined();
  });

  // The saved name outlives the file. Playing a missing asset is a
  // silent 404 that looks exactly like a broken toggle.
  it("is silent when the chosen file is no longer installed", () => {
    expect(soundFor(withSound(), "dm", ["knock"])).toBeUndefined();
    expect(soundFor(withSound(), "dm", [])).toBeUndefined();
  });

  // fez ships built-in voices now, so prefs written before sound existed
  // pick up the defaults rather than staying mute — a shipped sound that
  // nobody hears until they go and switch it on is not a shipped sound.
  it("gives prefs saved before sound existed the default choices", () => {
    const old = readPrefs(JSON.stringify({ enabled: true, kinds: { dm: true } }));
    expect(old.sound).toBe(true);
    expect(old.sounds.dm).toBe(DEFAULT_NOTIFY.sounds.dm);
    expect(soundFor(old, "dm", [DEFAULT_NOTIFY.sounds.dm])).toBe(DEFAULT_NOTIFY.sounds.dm);
  });

  it("every default names a sound that actually exists", () => {
    for (const kind of Object.keys(DEFAULT_NOTIFY.sounds) as (keyof typeof DEFAULT_NOTIFY.sounds)[]) {
      expect(SOUND_NAMES, `default for ${kind}`).toContain(DEFAULT_NOTIFY.sounds[kind]);
    }
  });
});
