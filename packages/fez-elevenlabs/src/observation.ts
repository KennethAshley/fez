import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AudioObservation } from "./acceptance.js";

const exec = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// On-device transcription receives only the waveform; no expected text or hints.
const transcribe = String.raw`import Foundation
import Speech
import AVFoundation
import Darwin
alarm(45)
Task {
    do {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")),
              await SpeechTranscriber.installedLocales.contains(locale) else {
            throw NSError(domain: "FezAudioCheck", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Local speech model is not installed"])
        }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcriptionWithAlternatives)
        let collector = Task { () throws -> [[String: Any]] in
            var segments: [[String: Any]] = []
            for try await result in transcriber.results {
                segments.append(["text": String(result.text.characters),
                    "alternatives": result.alternatives.map { String($0.characters) }])
            }
            return segments
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[1]))
        _ = try await analyzer.analyzeSequence(from: file)
        try await analyzer.finalizeAndFinishThroughEndOfInput()
        let segments = try await collector.value
        let data = try JSONSerialization.data(withJSONObject: [
            "engine": "Apple SpeechTranscriber", "locale": "en-US",
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
            "contextualHints": false, "segments": segments
        ], options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data)
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("\(error)\n".utf8))
        exit(1)
    }
}
dispatchMain()
`;

/** Independently observe a bounded WAV, without synthesis or a paid provider.
 * Tool failures remain unavailable evidence; the hash binds these observations
 * to a copy of the exact bytes received before any asynchronous processing. */
export async function observeSpeechAudio(input: Uint8Array): Promise<AudioObservation> {
  const bytes = Buffer.from(input);
  const errors: string[] = [];
  const audio: AudioObservation = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    wav: "unavailable", nonSilent: null, transcript: null, alternatives: [], recognition: null, errors,
  };
  if (bytes.length > 16 * 1024 * 1024) {
    errors.push("Audio exceeds the 16777216-byte observation limit");
    return audio;
  }
  if (bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WAVE") {
    audio.wav = "invalid";
    return audio;
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "fez-speech-observation-"));
    const file = join(directory, "audio.wav");
    await writeFile(file, bytes, { mode: 0o600 });
    try {
      const { stdout } = await exec("ffmpeg", ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe",
        "-f", "wav", "-i", file, "-map", "0:a:0", "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
      { encoding: "buffer", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
      audio.wav = stdout.length ? "decoded" : "invalid";
      audio.nonSilent = stdout.some(byte => byte !== 0);
    } catch (error) {
      // Missing tools, timeouts, and output caps are evaluator failures.
      if (record(error) && typeof error.code === "number" && !error.signal) audio.wav = "invalid";
      errors.push(error instanceof Error ? error.message : "Decoder unavailable");
    }
    if (audio.wav === "decoded" && audio.nonSilent) {
      try {
        if (process.platform !== "darwin") throw new Error("Local transcription requires macOS 26 and an installed English speech model");
        const scriptPath = join(directory, "transcribe.swift");
        await writeFile(scriptPath, transcribe, { mode: 0o600 });
        const { stdout } = await exec("/usr/bin/swift", [scriptPath, file], {
          encoding: "utf8", timeout: 50_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(directory, "module-cache") },
        });
        const recognition: unknown = JSON.parse(stdout);
        audio.recognition = recognition;
        if (!record(recognition) || recognition.contextualHints !== false || !Array.isArray(recognition.segments) ||
            !recognition.segments.every(s => record(s) && typeof s.text === "string" && Array.isArray(s.alternatives) && s.alternatives.every(a => typeof a === "string"))) {
          throw new Error("Malformed transcription output");
        }
        const segments = recognition.segments as { text: string; alternatives: string[] }[];
        audio.transcript = segments.map(s => s.text).join(" ");
        audio.alternatives = segments.flatMap((s, i) => s.alternatives.map(alt => segments.map((v, j) => i === j ? alt : v.text).join(" ")));
      } catch (error) { errors.push(error instanceof Error ? error.message : "Transcription unavailable"); }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : "Audio observation unavailable"); }
  finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(error => {
      errors.push(error instanceof Error ? error.message : "Observation cleanup failed");
    });
  }
  return audio;
}
