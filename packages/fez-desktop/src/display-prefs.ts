export interface DisplayPrefs {
  messageSize: 14 | 16 | 18;
  messageSpacing: "comfortable" | "compact";
  reduceMotion: boolean;
}

export const DEFAULT_DISPLAY: DisplayPrefs = { messageSize: 14, messageSpacing: "comfortable", reduceMotion: false };
const STORAGE_KEY = "fez-display-v1";

export function loadDisplayPrefs(): DisplayPrefs {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value && typeof value === "object") {
      const prefs = value as Record<string, unknown>;
      return {
        messageSize: prefs.messageSize === 16 || prefs.messageSize === 18 ? prefs.messageSize : 14,
        messageSpacing: prefs.messageSpacing === "compact" ? "compact" : "comfortable",
        reduceMotion: prefs.reduceMotion === true,
      };
    }
  } catch { /* Unavailable or old storage should not stop the app opening. */ }
  return { ...DEFAULT_DISPLAY };
}

// Attributes survive theme repainting, which replaces the root's inline colors.
export function applyDisplayPrefs(prefs: DisplayPrefs): void {
  const { dataset } = document.documentElement;
  dataset.messageSize = String(prefs.messageSize);
  dataset.messageSpacing = prefs.messageSpacing;
  dataset.reduceMotion = String(prefs.reduceMotion);
}

export function saveDisplayPrefs(prefs: DisplayPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  applyDisplayPrefs(prefs);
}
