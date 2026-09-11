import { expect, it } from "vitest";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assessSpeechWork, type SpeechContract, type SpeechSubmission, type AudioObservation } from "../../../dev/experiments/coordination/speech-validator.js";

const ownerKey = new Uint8Array(32).fill(21), leadKey = new Uint8Array(32).fill(22);
const speakerKey = new Uint8Array(32).fill(23), strangerKey = new Uint8Array(32).fill(24);
const owner = getPublicKey(ownerKey), lead = getPublicKey(leadKey), speaker = getPublicKey(speakerKey);
const hash = "a".repeat(64), url = `https://blossom.example/${hash}`;
const script = "Every agent has a public-key identity. Every message is signed.";
const sign = (key: Uint8Array, kind: number, tags: string[][], content: string) =>
  finalizeEvent({ kind, created_at: 100, tags, content }, key);
const resign = (event: Event, key: Uint8Array, tags = event.tags, content = event.content) =>
  sign(key, event.kind, tags, content);
function fixture(audioHash = hash, spokenScript = script) {
  const url = `https://blossom.example/${audioHash}`;
  const request = sign(ownerKey, 47103, [["h", "demo"]], "Write and narrate a two-sentence welcome.");
  const assignment = sign(leadKey, 47103, [["h", "demo"], ["e", request.id, "", "reply"], ["p", owner], ["task", speaker]], `Narrate exactly:\n${spokenScript}`);
  const result = sign(speakerKey, 47103, [["h", "demo"], ["e", request.id, "", "root"], ["e", assignment.id, "", "reply"],
    ["p", lead], ["result", assignment.id], ["status", "success"], ["capability", "speech"], ["artifact", url]], "Audio is ready.");
  const acceptance = sign(leadKey, 47007, [["h", "demo"], ["p", speaker], ["e", result.id], ["task", assignment.id], ["capability", "speech"]], "Checked the recording.");
  const delivery = sign(leadKey, 47103, [["h", "demo"], ["e", request.id, "", "root"], ["e", result.id, "", "reply"]], `Playable audio: ${url}`);
  const contract: SpeechContract = { request, coordinator: lead, specialist: speaker, script: spokenScript };
  const submission: SpeechSubmission = { assignment, result, acceptance, delivery };
  const audio: AudioObservation = { sha256: hash, wav: "decoded", nonSilent: true,
    transcript: "Every agent has a public key identity. Every message is signed.", alternatives: [] };
  return { contract, submission, audio };
}

it("accepts a signed handoff only with matching independently observed audio", () => {
  const f = fixture();
  expect(assessSpeechWork(f.contract, f.submission, f.audio)).toMatchObject({ decision: "accepted", reason: "verified" });
});

it.skipIf(!process.env.FEZ_SPEECH_VALIDATOR_EVIDENCE)("checks the saved real recording and rejects actual bad files through the compiled CLI", async () => {
  const source = process.env.FEZ_SPEECH_VALIDATOR_EVIDENCE!;
  const directory = await mkdtemp(join(tmpdir(), "fez-speech-validator-controls-"));
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const exec = promisify(execFile), cli = join(directory, "validator.mjs");
  await exec(join(repo, "node_modules/.bin/esbuild"), [join(repo, "dev/experiments/coordination/run-speech-validator.ts"),
    "--bundle", "--platform=node", "--format=esm", "--target=node24", `--outfile=${cli}`]);
  const request: Event = JSON.parse(await readFile(join(source, "request.json"), "utf8"));
  const events: Event[] = JSON.parse(await readFile(join(source, "events.json"), "utf8"));
  const saved = JSON.parse(await readFile(join(source, "verification.json"), "utf8"));
  const expected = (await readFile(join(source, "transcript.txt"), "utf8")).trim();
  const actualContract: SpeechContract = { request, coordinator: saved.coordinator, specialist: saved.specialist, script: expected };
  const find = (id: string) => events.find(e => e.id === id) ?? null;
  const actualSubmission: SpeechSubmission = { assignment: find(saved.handoffId), result: find(saved.resultId),
    acceptance: find(saved.acceptanceId), delivery: find(saved.deliveryId) };
  const original = join(source, "fez-introduction.wav");
  const wrong = join(directory, "wrong-speech.wav"), silent = join(directory, "silent.wav"), corrupt = join(directory, "corrupt.wav");
  await exec("ffmpeg", ["-v", "error", "-i", original, "-t", "3", wrong]);
  await exec("ffmpeg", ["-v", "error", "-i", original, "-af", "volume=0", silent]);
  await writeFile(corrupt, "not a WAV recording");
  const summary: unknown[] = [];
  async function check(name: string, contract: SpeechContract, submission: SpeechSubmission, file: string, decision: string, reason: string) {
    const inputs = join(directory, name); await mkdir(inputs);
    await writeFile(join(inputs, "contract.json"), JSON.stringify(contract));
    await writeFile(join(inputs, "submission.json"), JSON.stringify(submission));
    let exitCode = 0;
    try {
      await exec(process.execPath, [cli, join(inputs, "contract.json"), join(inputs, "submission.json"), file, join(inputs, "output")], { timeout: 70_000 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number") throw error;
      exitCode = error.code;
    }
    const report = JSON.parse(await readFile(join(inputs, "output/assessment.json"), "utf8"));
    summary.push({ name, decision: report.decision, reason: report.reason, exitCode, file: join(inputs, "output/assessment.json") });
    await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    expect(report, name).toMatchObject({ decision, reason, rewardEligible: false, modelCostUsd: null });
    expect(exitCode, name).toBe(decision === "accepted" ? 0 : decision === "rejected" ? 2 : 3);
  }
  await check("original", actualContract, actualSubmission, original, "accepted", "verified");
  for (const [name, file, reason] of [["wrong-speech", wrong, "speech-mismatch"], ["silent", silent, "silent-audio"], ["corrupt", corrupt, "invalid-wav"]]) {
    const sha = createHash("sha256").update(await readFile(file)).digest("hex");
    const f = fixture(sha, expected);
    await check(name, f.contract, f.submission, file, "rejected", reason);
  }
  const sha = createHash("sha256").update(await readFile(original)).digest("hex");
  const badSigner = fixture(sha, expected); badSigner.submission.result = resign(badSigner.submission.result!, strangerKey);
  await check("wrong-signer", badSigner.contract, badSigner.submission, original, "rejected", "wrong-specialist");
  const badChit = fixture(sha, expected);
  badChit.submission.acceptance = resign(badChit.submission.acceptance!, leadKey,
    badChit.submission.acceptance!.tags.map(t => t[0] === "e" ? ["e", "b".repeat(64)] : t));
  await check("wrong-acceptance", badChit.contract, badChit.submission, original, "rejected", "wrong-acceptance");
  await check("missing-evidence", actualContract, { ...actualSubmission, result: null }, original, "unassessed", "missing-records");
  console.log(`Speech validator controls: ${join(directory, "summary.json")}`);
}, 180_000);

it("rejects unassigned signers, mismatched acceptance, and forged cached signatures", () => {
  const cases: [string, (s: SpeechSubmission) => void][] = [
    ["wrong-specialist", s => { s.result = resign(s.result!, strangerKey); }],
    ["wrong-acceptance", s => { s.acceptance = resign(s.acceptance!, leadKey, s.acceptance!.tags.map(t => t[0] === "e" ? ["e", "b".repeat(64)] : t)); }],
    ["invalid-signature", s => { s.result!.content = "Tampered after finalizeEvent cached a successful verification"; }],
    ["wrong-delivery", s => { s.delivery = resign(s.delivery!, leadKey, s.delivery!.tags, `${url}000`); }],
    ["wrong-assignment", s => { s.assignment = resign(s.assignment!, leadKey, s.assignment!.tags, "Narrate an unrelated script."); }],
  ];
  for (const [reason, change] of cases) {
    const f = fixture(); change(f.submission);
    expect(assessSpeechWork(f.contract, f.submission, f.audio), reason).toMatchObject({ decision: "rejected", reason });
  }
});

it("rejects wrong speech, silence, corrupt audio, and mismatched artifact bytes", () => {
  const cases: [string, Partial<AudioObservation>][] = [
    ["speech-mismatch", { transcript: "Every message is not signed." }],
    ["silent-audio", { nonSilent: false }],
    ["invalid-wav", { wav: "invalid" }],
    ["artifact-mismatch", { sha256: "b".repeat(64) }],
  ];
  for (const [reason, observation] of cases) {
    const f = fixture();
    expect(assessSpeechWork(f.contract, f.submission, { ...f.audio, ...observation }), reason).toMatchObject({ decision: "rejected", reason });
  }
});

it("leaves missing evidence, unavailable tools, and ambiguous recognition unassessed", () => {
  const f = fixture();
  expect(assessSpeechWork(f.contract, { ...f.submission, result: null }, f.audio)).toMatchObject({ decision: "unassessed", reason: "missing-records" });
  expect(assessSpeechWork(f.contract, f.submission, null)).toMatchObject({ decision: "unassessed", reason: "missing-audio" });
  expect(assessSpeechWork(f.contract, f.submission, { ...f.audio, wav: "unavailable" })).toMatchObject({ decision: "unassessed", reason: "decoder-unavailable" });
  expect(assessSpeechWork(f.contract, f.submission, { ...f.audio, transcript: null })).toMatchObject({ decision: "unassessed", reason: "transcription-unavailable" });
  expect(assessSpeechWork(f.contract, f.submission, { ...f.audio, transcript: "Every message assigned.", alternatives: [script] })).toMatchObject({ decision: "unassessed", reason: "ambiguous-transcription" });
  // Missing audio cannot erase an established signature violation.
  f.submission.result!.sig = "0".repeat(128);
  expect(assessSpeechWork(f.contract, f.submission, null)).toMatchObject({ decision: "rejected", reason: "invalid-signature" });
});
