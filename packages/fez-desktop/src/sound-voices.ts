/**
 * The built-in notification sounds, as SPECIFICATIONS rather than files.
 *
 * fez generates its creatures from a pubkey rather than shipping art, and
 * this is the same move for audio: a notification blip is a couple of
 * sine waves and an envelope, so describing it costs a few bytes where a
 * sample costs tens of kilobytes and — the part that actually decided it
 * — a license. Sound libraries license to a PERSON, not to a repository,
 * and fez has to redistribute whatever it ships. Synthesis has no owner.
 *
 * Kept deliberately plain: short, quiet, two partials at most. This plays
 * while you are looking at something else, so the bar is "did I notice",
 * not "was that pleasant on the twentieth repeat".
 */

export interface Partial_ {
  /** Start frequency in Hz. */
  freq: number;
  /** Glide to this by the end, for the rising/falling ones. */
  to?: number;
  type: OscillatorType;
  /** Milliseconds from the voice's start. */
  at: number;
  ms: number;
  /** Peak gain before the decay. Kept low — this is a notification. */
  gain: number;
}

/**
 * Every built-in sound. The names are the vocabulary the settings picker
 * offers, so they describe the SOUND rather than the event: one sound may
 * end up on any category, and "dm" as a sound name would be a lie the
 * moment you put it on agent errors.
 */
export const VOICES: Record<string, Partial_[]> = {
  // A single soft blip. The default for anything that just needs a nudge.
  blip: [{ freq: 880, type: "sine", at: 0, ms: 90, gain: 0.18 }],

  // Two notes up — an octave. Reads as "something arrived".
  chirp: [
    { freq: 660, type: "sine", at: 0, ms: 70, gain: 0.16 },
    { freq: 990, type: "sine", at: 60, ms: 110, gain: 0.16 },
  ],

  // Two notes down. Reads as "something ended", which is why it suits
  // an agent error better than a rising pair does.
  fall: [
    { freq: 700, type: "triangle", at: 0, ms: 80, gain: 0.17 },
    { freq: 440, type: "triangle", at: 70, ms: 140, gain: 0.17 },
  ],

  // Woody and low, no pitch movement — the least attention-seeking one.
  knock: [{ freq: 180, type: "triangle", at: 0, ms: 120, gain: 0.3 }],

  // A fifth, struck together. Fuller than a blip without being a tune.
  chord: [
    { freq: 587.33, type: "sine", at: 0, ms: 220, gain: 0.12 },
    { freq: 880, type: "sine", at: 0, ms: 220, gain: 0.1 },
  ],

  // A glide rather than two steps — the softest of the attention ones.
  swell: [{ freq: 420, to: 720, type: "sine", at: 0, ms: 200, gain: 0.14 }],
};

export const BUILT_IN_SOUNDS: readonly string[] = Object.keys(VOICES);

/** How long a sound runs, for tests and for anything that needs to wait. */
export function voiceDurationMs(name: string): number {
  const parts = VOICES[name];
  if (!parts?.length) return 0;
  return Math.max(...parts.map((p) => p.at + p.ms));
}
