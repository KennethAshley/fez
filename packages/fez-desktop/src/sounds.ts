/**
 * Notification sounds — the catalog, and playing one.
 *
 * fez ships NO audio. The files are licensed per install (Epidemic Sound
 * and the like are licensed to a person, not to a repository), so the
 * assets are dropped in rather than committed, and this list is the one
 * place that changes when they are.
 *
 * To add a sound:
 *   1. put `<name>.mp3` in packages/fez-desktop/public/sounds/
 *   2. add `<name>` to SOUND_NAMES below
 * The picker offers exactly what is listed here AND present on disk;
 * everything downstream (settings, playback) reads from this.
 */

/**
 * Sounds this build knows about. Empty is a legitimate state and the
 * settings page says so plainly rather than showing a picker of nothing.
 */
export const SOUND_NAMES: readonly string[] = [];

/** Where a sound lives, given its name. Vite serves public/ at the root. */
export function soundUrl(name: string): string {
  return `/sounds/${encodeURIComponent(name)}.mp3`;
}

/**
 * Play one, best-effort.
 *
 * Never throws and never awaits: a notification that fails to make a
 * noise must not take the notification down with it. Autoplay policy,
 * a missing file and a muted output device are all the same non-event
 * here — the banner still arrives.
 */
export function playSound(name: string): void {
  try {
    const audio = new Audio(soundUrl(name));
    audio.volume = 0.5;
    void audio.play().catch(() => {});
  } catch {
    /* no audio device, no autoplay permission — silence is fine */
  }
}
