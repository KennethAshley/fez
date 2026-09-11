import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { observeSpeechAudio } from "../../fez-elevenlabs/src/observation.js";

afterEach(() => vi.unstubAllEnvs());

it("hashes the original bytes and rejects a corrupt recording without running speech tools", async () => {
  const bytes = Buffer.from("not a WAV recording");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const pending = observeSpeechAudio(bytes);
  bytes.fill(0);
  expect(await pending).toMatchObject({ sha256: expectedHash, wav: "invalid", transcript: null, nonSilent: null });
});

it("leaves audio unassessed when the decoder executable is unavailable", async () => {
  vi.stubEnv("PATH", "/nonexistent-fez-speech-tools");
  const audio = await observeSpeechAudio(Buffer.from("RIFF0000WAVE0000"));
  expect(audio).toMatchObject({ wav: "unavailable", nonSilent: null, transcript: null, alternatives: [] });
  expect(audio.errors?.length).toBe(1);
});

it("bounds audio input before decoding rather than claiming oversized audio is corrupt", async () => {
  const audio = await observeSpeechAudio(new Uint8Array(16 * 1024 * 1024 + 1));
  expect(audio).toMatchObject({ wav: "unavailable", nonSilent: null, transcript: null });
  expect(audio.errors?.[0]).toContain("16777216");
});
