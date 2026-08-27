/**
 * Which native notifications you want, and the gate that decides.
 *
 * Deliberately free of Tauri and DOM imports so the rules are testable:
 * this gate's failure mode is SILENCE — an alert you asked for that never
 * arrives, with nothing on screen to say it was suppressed — which is the
 * kind of bug that survives a long time unnoticed.
 *
 * Per machine, not per identity: which alerts you want on the laptop you
 * left at the office is not a fact about who you are on the relay. Same
 * reasoning (and the same storage) as the mute list.
 */

/** The events fez can actually alert on. */
export type NotifyKind = "dm" | "mention" | "needs_action" | "agent_error" | "thread_reply";

export interface NotifyPrefs {
  /** Master switch — off means nothing fires at all. */
  enabled: boolean;
  /** Alert even when the window has focus. Off is fez's long-standing
   *  behavior: a ping for what you are already looking at is noise. */
  whileFocused: boolean;
  kinds: Record<NotifyKind, boolean>;
  /** Master for sound. Independent of `enabled`: some people want the
   *  banner without the noise, and some want only the noise. */
  sound: boolean;
  /** Which file each category plays. "" means that category is silent
   *  even when sound is on — the default, since fez ships no sounds. */
  sounds: Record<NotifyKind, string>;
}

export const NOTIFY_KINDS: NotifyKind[] = ["dm", "mention", "needs_action", "agent_error", "thread_reply"];

export const DEFAULT_NOTIFY: NotifyPrefs = {
  enabled: true,
  whileFocused: false,
  kinds: { dm: true, mention: true, needs_action: true, agent_error: true, thread_reply: true },
  sound: true,
  sounds: { dm: "", mention: "", needs_action: "", agent_error: "", thread_reply: "" },
};

/** Should this notification fire? */
export function notifyAllows(prefs: NotifyPrefs, kind: NotifyKind, focused: boolean): boolean {
  if (!prefs.enabled) return false;
  if (focused && !prefs.whileFocused) return false;
  return prefs.kinds[kind] !== false;
}

/**
 * Parse what was saved, tolerating anything. An unknown category — one
 * added after these prefs were written — defaults to ON: dropping it to
 * off would silence an alert nobody ever chose to silence, and the user
 * would have no way to know a new one existed.
 */
export function readPrefs(raw: string | null | undefined): NotifyPrefs {
  if (!raw) return DEFAULT_NOTIFY;
  try {
    const saved = JSON.parse(raw) as Partial<NotifyPrefs>;
    const kinds = { ...DEFAULT_NOTIFY.kinds };
    for (const kind of NOTIFY_KINDS) {
      const value = (saved.kinds as Record<string, unknown> | undefined)?.[kind];
      if (typeof value === "boolean") kinds[kind] = value;
    }
    const sounds = { ...DEFAULT_NOTIFY.sounds };
    for (const kind of NOTIFY_KINDS) {
      const value = (saved.sounds as Record<string, unknown> | undefined)?.[kind];
      if (typeof value === "string") sounds[kind] = value;
    }
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_NOTIFY.enabled,
      whileFocused: typeof saved.whileFocused === "boolean" ? saved.whileFocused : DEFAULT_NOTIFY.whileFocused,
      kinds,
      sound: typeof saved.sound === "boolean" ? saved.sound : DEFAULT_NOTIFY.sound,
      sounds,
    };
  } catch {
    return DEFAULT_NOTIFY;
  }
}

/** Labels and one-liners, shared by the settings page. */
export const NOTIFY_LABELS: Record<NotifyKind, { label: string; desc: string }> = {
  dm: { label: "direct messages", desc: "When someone messages you directly." },
  mention: { label: "mentions", desc: "When someone tags you by name in a channel you have not muted." },
  needs_action: { label: "needs action", desc: "When a reminder comes due, or a proposal is waiting on your approval." },
  agent_error: { label: "agent errors", desc: "When one of your agents fails mid-turn." },
  thread_reply: { label: "thread replies", desc: "When someone replies in a thread you posted in." },
};

/**
 * Categories fez does not emit yet. The control still renders, disabled
 * and labelled — Buzz's rule for its stubbed agent-job slots, and the
 * honest one: hiding it implies the alert works, and a live toggle in
 * front of no emitter is worse still.
 */
export const NOTIFY_UNBUILT: ReadonlySet<NotifyKind> = new Set<NotifyKind>(["thread_reply"]);

/**
 * Which sound file this category should play, or undefined for silence.
 *
 * `installed` is the catalog of files actually present. A saved choice
 * outlives the file it names — assets are supplied per install rather
 * than shipped — and playing a missing one is a silent 404 that looks
 * exactly like a broken toggle, so an uninstalled name resolves to
 * silence rather than to an attempt.
 */
export function soundFor(prefs: NotifyPrefs, kind: NotifyKind, installed: readonly string[]): string | undefined {
  if (!prefs.sound) return undefined;
  // A category switched off is off in every sense — leaving it audible
  // would make the settings row a liar.
  if (prefs.kinds[kind] === false) return undefined;
  const name = prefs.sounds[kind];
  if (!name || !installed.includes(name)) return undefined;
  return name;
}
