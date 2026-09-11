import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { assessSpeechWork, type SpeechContract, type SpeechSubmission, type AudioObservation } from "./speech-validator.js";
import { observeSpeechAudio } from "../../../packages/fez-elevenlabs/src/observation.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function boundedFile(path: string, limit: number) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error(`Input must be a regular file no larger than ${limit} bytes: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error("Input grew beyond its size limit");
  return bytes;
}

try {
  const [contractPath, submissionPath, audioPath, outputPath, ...extra] = process.argv.slice(2);
  if (!contractPath || !submissionPath || !audioPath || !outputPath || extra.length) {
    throw new Error("usage: run-speech-validator <validator-contract.json> <submission.json> <audio.wav|-> <new-output-directory>");
  }
  const contractBytes = await boundedFile(contractPath, 1024 * 1024);
  const submissionBytes = await boundedFile(submissionPath, 1024 * 1024);
  const contract: SpeechContract = JSON.parse(contractBytes.toString());
  const submission: SpeechSubmission = JSON.parse(submissionBytes.toString());
  const preliminary = assessSpeechWork(contract, submission, null);
  const directory = resolve(outputPath);
  await mkdir(directory); // Refuse to overwrite earlier evidence.
  await writeFile(join(directory, "contract.json"), contractBytes);
  await writeFile(join(directory, "submission.json"), submissionBytes);
  const errors: string[] = [];
  let audio: AudioObservation | null = null;
  let recognition: unknown = null;
  // Known event failures and incomplete chains need no audio processing.
  if (preliminary.reason === "missing-audio" && audioPath !== "-") {
    let bytes: Buffer | null = null;
    try { bytes = await boundedFile(audioPath, 16 * 1024 * 1024); }
    catch (error) { errors.push(error instanceof Error ? error.message : "Audio unavailable"); }
    if (bytes) {
      const file = join(directory, "audio.wav");
      await writeFile(file, bytes);
      const { recognition: observedRecognition, errors: observationErrors, ...observedAudio } = await observeSpeechAudio(bytes);
      audio = observedAudio;
      recognition = observedRecognition ?? null;
      errors.push(...observationErrors ?? []);
    }
  }
  const assessment = assessSpeechWork(contract, submission, audio);
  const report = {
    version: "fez-saved-speech-check-v1", scope: "frozen-script-and-saved-handoff", ...assessment,
    contractSha256: hash(contractBytes), submissionSha256: hash(submissionBytes),
    requestId: contract.request.id, audio, recognition, errors,
    liveUrlChecked: false, coordinatorToolActionsVerified: false, modelCostUsd: null, rewardEligible: false,
  };
  await writeFile(join(directory, "assessment.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`${assessment.decision}: ${assessment.reason}\n${join(directory, "assessment.json")}\n`);
  process.exitCode = assessment.decision === "accepted" ? 0 : assessment.decision === "rejected" ? 2 : 3;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "Speech check failed") + "\n");
  process.exitCode = 1;
}
