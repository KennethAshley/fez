import { isPermissionGranted, requestPermission, sendNotification, onAction } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Native (OS) notifications, coalesced, click-to-open.
 *
 *  - Only fire when the app is UNFOCUSED — a ping for what you're looking
 *    at is noise.
 *  - A burst sharing a `key` inside a short window collapses into one
 *    "N new in <label>" ping — a chatty channel or a retrying agent
 *    shouldn't machine-gun your notification center.
 *  - Clicking the notification focuses the app and jumps to its source.
 *    macOS is finicky about which click callback fires, so we wire BOTH
 *    the plugin's onAction AND a window-focus fallback (focus returning
 *    within a few seconds of a ping is almost always the click), and a
 *    one-shot guard stops them navigating twice.
 */
export type NotifTarget =
  | { kind: "channel"; id: string }
  | { kind: "dm"; convoKey: string }
  | { kind: "agent"; name: string }
  | { kind: "proposals" };

let lastTarget: NotifTarget | undefined;
let lastFiredAt = 0;
let navigate: ((t: NotifTarget) => void) | undefined;

function navigateOnce(): void {
  const t = lastTarget;
  lastTarget = undefined;
  if (t && navigate) navigate(t);
}

let wired = false;
/** Register once: on a notification click, focus the window and jump to its source. */
export function installNotificationClick(handler: (t: NotifTarget) => void): void {
  navigate = handler; // always freshen the target router
  if (wired) return; // but attach the OS listeners only once
  wired = true;
  void onAction(() => {
    void getCurrentWindow().setFocus().catch(() => {});
    navigateOnce();
  }).catch(() => {});
  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      // Focus returning right after a ping ≈ the user clicked it.
      if (focused && Date.now() - lastFiredAt < 8000) navigateOnce();
    })
    .catch(() => {});
}

async function ensureGranted(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  } catch {
    return false;
  }
}

async function fire(title: string, body: string, target?: NotifTarget): Promise<void> {
  if (!(await ensureGranted())) return;
  lastTarget = target;
  lastFiredAt = Date.now();
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
  target?: NotifTarget;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const WINDOW_MS = 1400;

export function notifyEvent(opts: { key: string; title: string; body: string; label: string; target?: NotifTarget }): void {
  if (typeof document !== "undefined" && document.hasFocus()) return;
  const prev = pending.get(opts.key);
  if (prev) clearTimeout(prev.timer);
  const count = (prev?.count ?? 0) + 1;
  const timer = setTimeout(() => {
    const p = pending.get(opts.key);
    pending.delete(opts.key);
    if (!p) return;
    if (p.count === 1) void fire(p.title, p.body, p.target);
    else void fire(`${p.count} new in ${p.label}`, p.body, p.target);
  }, WINDOW_MS);
  pending.set(opts.key, { count, title: opts.title, body: opts.body, label: opts.label, target: opts.target, timer });
}
