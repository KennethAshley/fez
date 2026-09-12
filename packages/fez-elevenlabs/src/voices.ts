import gui from "./gui.json" with { type: "json" };
import { stableChoice } from "../../../src/shared/stable-choice.js";

/**
 * The sprite trick, for sound: the agent's pk hashes into a pinned list
 * of ElevenLabs stock voices, so @quill sounds like @quill on every
 * machine with zero configuration. The list is PINNED ids, not a live
 * API listing — deterministic defaults must not drift when ElevenLabs
 * reshuffles their catalog. previewUrl is optional; the gui hides the
 * play button when it is absent.
 */
export interface PinnedVoice {
  id: string;
  name: string;
  previewUrl?: string;
}

// Current-generation ElevenLabs premade voices, verified against
// GET /v1/voices on 2026-08-30 (the first pinned list was legacy
// premades most newer accounts don't carry). If an id is gone, replace
// it here rather than filtering at runtime. Preview urls are the
// durable storage.googleapis ones; voices whose previews are tokenized
// API urls would expire, so those voices weren't pinned.
export const PINNED: PinnedVoice[] = gui.settings[0].options;

export function voiceFor(
  pk: string,
  overrides?: Record<string, string>,
  personaName?: string
): PinnedVoice {
  const wanted = personaName ? overrides?.[personaName] : undefined;
  const pinned = wanted && PINNED.find((v) => v.id === wanted);
  if (pinned) return pinned;
  return stableChoice(pk, PINNED);
}
