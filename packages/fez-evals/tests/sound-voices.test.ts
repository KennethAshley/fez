import { describe, it, expect } from "vitest";
import { VOICES, BUILT_IN_SOUNDS, voiceDurationMs } from "../../fez-desktop/src/sound-voices.js";

/**
 * The voices are data, so they can be checked. What actually goes wrong
 * with a synthesized notification is not "wrong note" — it is a sound
 * long enough to become an interruption, loud enough to startle, or
 * silent because a partial was mis-specified.
 */
describe("built-in voices", () => {
  it("offers more than one, so a picker is worth having", () => {
    expect(BUILT_IN_SOUNDS.length).toBeGreaterThan(2);
  });

  it("names describe the sound, never the event it might be put on", () => {
    // A sound can land on any category, so "dm" as a NAME would be a lie
    // the moment someone puts it on agent errors.
    for (const name of BUILT_IN_SOUNDS) {
      expect(name).not.toMatch(/^(dm|mention|needs_action|agent_error|thread_reply)$/);
    }
  });

  it("stays under a third of a second — past that it is an interruption", () => {
    for (const name of BUILT_IN_SOUNDS) {
      expect(voiceDurationMs(name), name).toBeGreaterThan(0);
      expect(voiceDurationMs(name), name).toBeLessThanOrEqual(300);
    }
  });

  it("stays quiet — this fires while you are looking elsewhere", () => {
    for (const [name, parts] of Object.entries(VOICES)) {
      for (const p of parts) {
        expect(p.gain, name).toBeGreaterThan(0);
        expect(p.gain, name).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it("keeps every partial audible and every voice sounding", () => {
    for (const [name, parts] of Object.entries(VOICES)) {
      expect(parts.length, name).toBeGreaterThan(0);
      for (const p of parts) {
        // Roughly the band a small speaker reproduces and an ear notices.
        expect(p.freq, name).toBeGreaterThanOrEqual(100);
        expect(p.freq, name).toBeLessThanOrEqual(4000);
        if (p.to !== undefined) {
          expect(p.to, name).toBeGreaterThanOrEqual(100);
          expect(p.to, name).toBeLessThanOrEqual(4000);
        }
        expect(p.ms, name).toBeGreaterThan(0);
        expect(p.at, name).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reports 0 for a name it does not have, rather than throwing", () => {
    expect(voiceDurationMs("nope")).toBe(0);
  });
});
