import { validateEvent, verifyEvent, type Event } from "nostr-tools/pure";
import { acceptWork, workResult } from "../../fez-client/src/work-completion.js";
import { parseThreadRef } from "../../fez-client/src/thread-ref.js";

export interface SpeechContract { request: Event; coordinator: string; specialist: string; script: string }
export interface SpeechSubmission { assignment: Event | null; result: Event | null; acceptance: Event | null; delivery: Event | null }
export interface AudioObservation {
  readonly sha256: string; wav: "decoded" | "invalid" | "unavailable"; nonSilent: boolean | null;
  transcript: string | null; alternatives: string[];
  /** Audio-only recognition metadata and local evaluator errors, when collected. */
  recognition?: unknown; errors?: string[];
}

const tag = (e: Event, name: string) => {
  const values = e.tags.filter(t => t[0] === name);
  return values.length === 1 ? values[0]?.[1] : undefined;
};
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
function signed(event: Event): boolean {
  if (!event || !validateEvent(event) || typeof event.id !== "string" || typeof event.sig !== "string") return false;
  // Re-verify bytes even if an in-process caller passed nostr-tools' cached symbol.
  return verifyEvent({ id: event.id, pubkey: event.pubkey, kind: event.kind, created_at: event.created_at,
    content: event.content, tags: event.tags, sig: event.sig });
}

/** Contract and audio observations belong to the validator, never the submitter.
 * Acceptance covers this frozen script and saved handoff, not live availability,
 * a coordinator's claimed tool actions, general writing quality, or subnet rewards. */
export function assessSpeechWork(contract: SpeechContract, submission: SpeechSubmission, audio: AudioObservation | null) {
  const verdict = (decision: "accepted" | "rejected" | "unassessed", reason: string) => ({ decision, reason });
  const reject = (reason: string) => verdict("rejected", reason);
  const unknown = (reason: string) => verdict("unassessed", reason);
  if (!contract || !signed(contract.request) || contract.request.kind !== 47103 || !tag(contract.request, "h") ||
      !/^[a-f0-9]{64}$/.test(contract.coordinator) || !/^[a-f0-9]{64}$/.test(contract.specialist) ||
      contract.coordinator === contract.specialist || typeof contract.script !== "string" || !words(contract.script) || contract.script.length > 2500) {
    throw new Error("Invalid validator-owned speech contract");
  }
  if (!submission || typeof submission !== "object") return reject("invalid-submission");
  const { assignment, result, acceptance, delivery } = submission;
  if ([assignment, result, acceptance, delivery].some(e => e != null && !signed(e))) return reject("invalid-signature");
  if (!assignment || !result || !acceptance || !delivery) return unknown("missing-records");
  const channel = tag(contract.request, "h"), root = contract.request.id;
  if (assignment.kind !== 47103 || assignment.pubkey !== contract.coordinator || tag(assignment, "h") !== channel ||
      parseThreadRef(assignment.tags).rootId !== root || parseThreadRef(assignment.tags).parentId !== root ||
      tag(assignment, "task") !== contract.specialist || !assignment.content.includes(contract.script)) return reject("wrong-assignment");
  if (result.pubkey !== contract.specialist) return reject("wrong-specialist");
  if (result.kind !== 47103 || workResult(result, assignment) !== "success" || tag(result, "capability") !== "speech") return reject("invalid-result");
  const artifact = tag(result, "artifact");
  let artifactHash: string;
  try {
    const url = new URL(artifact!);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return reject("invalid-artifact-url");
    artifactHash = url.pathname.slice(1);
  } catch { return reject("invalid-artifact-url"); }
  try {
    const expected = acceptWork(result, assignment, contract.coordinator, acceptance.content);
    if (acceptance.kind !== expected.kind || acceptance.pubkey !== contract.coordinator ||
        !expected.tags.every(t => t[0] !== undefined && tag(acceptance, t[0]) === t[1])) return reject("wrong-acceptance");
  } catch { return reject("wrong-acceptance"); }
  const deliveredUrls: string[] = delivery.content.match(/https:\/\/[^\s<>"`]+/g) ?? [];
  if (delivery.kind !== 47103 || delivery.pubkey !== contract.coordinator || tag(delivery, "h") !== channel ||
      parseThreadRef(delivery.tags).rootId !== root || parseThreadRef(delivery.tags).parentId !== result.id ||
      !deliveredUrls.includes(artifact!)) return reject("wrong-delivery");
  if (!audio) return unknown("missing-audio");
  if (audio.sha256 !== artifactHash) return reject("artifact-mismatch");
  if (audio.wav === "invalid") return reject("invalid-wav");
  if (audio.wav !== "decoded") return unknown("decoder-unavailable");
  if (audio.nonSilent === false) return reject("silent-audio");
  if (audio.nonSilent !== true) return unknown("signal-unassessed");
  if (typeof audio.transcript !== "string" || !words(audio.transcript)) return unknown("transcription-unavailable");
  if (words(audio.transcript) !== words(contract.script)) {
    if (audio.alternatives.some(t => words(t) === words(contract.script))) return unknown("ambiguous-transcription");
    return reject("speech-mismatch");
  }
  return verdict("accepted", "verified");
}
