/**
 * Notification sounds — the catalog, and playing one.
 *
 * fez SHIPS its sounds, and ships them as synthesis rather than files:
 * see sound-voices.ts for why (a sample carries a licence, an oscillator
 * carries none). Anything you would rather supply yourself still works —
 * drop `<name>.mp3` into public/sounds/ and add the name to FILE_SOUNDS,
 * and it joins the same picker. Files win over built-ins on a name clash,
 * so a supplied `blip.mp3` replaces the generated one.
 */
import { VOICES, BUILT_IN_SOUNDS } from "./sound-voices";

/**
 * Sounds supplied as audio files rather than generated. Empty by design:
 * fez commits no audio (public/sounds/ gitignores *.mp3 — sound libraries
 * licence to a person, not to a repository). Add a name here after
 * dropping the matching .mp3 in.
 */
export const FILE_SOUNDS: readonly string[] = [];

/** Everything the picker may offer, files first so they shadow built-ins. */
export const SOUND_NAMES: readonly string[] = [
  ...FILE_SOUNDS,
  ...BUILT_IN_SOUNDS.filter((name) => !FILE_SOUNDS.includes(name)),
];

/** Where a supplied sound lives. Vite serves public/ at the root. */
export function soundUrl(name: string): string {
  return `/sounds/${encodeURIComponent(name)}.mp3`;
}

let ctx: AudioContext | undefined;
function audio(): AudioContext | undefined {
  try {
    // Built lazily and kept: constructing one per notification leaks
    // contexts, and browsers cap how many a page may hold.
    ctx ??= new AudioContext();
    // A context created before the first click starts suspended. Every
    // path that plays follows a click somewhere, so asking it to resume
    // is enough — and failing is a non-event.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return undefined;
  }
}

/**
 * Play one, best-effort.
 *
 * Never throws and never awaits: a notification that fails to make a
 * noise must not take the notification down with it. No audio device, a
 * suspended context, a missing file — all the same non-event, and the
 * banner still arrives.
 */
export function playSound(name: string): void {
  try {
    if (FILE_SOUNDS.includes(name)) {
      const el = new Audio(soundUrl(name));
      el.volume = 0.5;
      void el.play().catch(() => {});
      return;
    }
    const parts = VOICES[name];
    const context = parts?.length ? audio() : undefined;
    if (!context || !parts) return;
    const now = context.currentTime;
    for (const part of parts) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = part.type;
      const start = now + part.at / 1000;
      const end = start + part.ms / 1000;
      osc.frequency.setValueAtTime(part.freq, start);
      // A glide, when the voice asks for one.
      if (part.to !== undefined) osc.frequency.linearRampToValueAtTime(part.to, end);
      // Attack then exponential decay. The 4ms attack is what keeps a
      // square-edged start from clicking; the ramp never reaches zero
      // because exponentialRamp cannot, so it stops just above it.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(part.gain, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(context.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    /* no output device, no permission — silence is fine */
  }
}
