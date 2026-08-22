import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Native (OS) notifications, coalesced. Two rules matter:
 *
 *  - Only fire when the app is UNFOCUSED — a ping for something you're
 *    already looking at is noise.
 *  - A burst sharing a `key` inside a short window collapses into one
 *    "N new in <label>" instead of N separate pings — a chatty channel
 *    or a retrying agent shouldn't machine-gun your notification center.
 *
 * Click-to-open (focus the app + jump to the source) is intentionally
 * NOT wired here: Tauri v2's notification-click handling is unreliable on
 * macOS, and a half-working jump is worse than none. Left as a follow-up.
 */
async function ensureGranted(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  } catch {
    return false;
  }
}

async function fire(title: string, body: string): Promise<void> {
  if (!(await ensureGranted())) return;
  try {
    sendNotification({ title, body: body.replace(/\s+/g, " ").trim().slice(0, 180) });
  } catch {
    /* dev server / permission denied — silent */
  }
}

interface Pending {
  count: number;
  title: string;
  body: string;
  label: string;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const WINDOW_MS = 1400;

export function notifyEvent(opts: { key: string; title: string; body: string; label: string }): void {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  const prev = pending.get(opts.key);
  if (prev) clearTimeout(prev.timer);
  const count = (prev?.count ?? 0) + 1;
  const timer = setTimeout(() => {
    const p = pending.get(opts.key);
    pending.delete(opts.key);
    if (!p) return;
    if (p.count === 1) void fire(p.title, p.body);
    else void fire(`${p.count} new in ${p.label}`, p.body);
  }, WINDOW_MS);
  pending.set(opts.key, { count, title: opts.title, body: opts.body, label: opts.label, timer });
}
