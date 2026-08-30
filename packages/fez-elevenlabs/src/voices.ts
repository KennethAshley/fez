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
export const PINNED: PinnedVoice[] = [
  { id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3" },
  { id: "N2lVS1w4EtoT3dr4eOWO", name: "Callum", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3" },
  { id: "SAz9YHcvj6GT2YYXdXww", name: "River", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/SAz9YHcvj6GT2YYXdXww/e6c95f0b-2227-491a-b3d7-2249240decb7.mp3" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3" },
  { id: "bIHbv24MWmeRgasZH58o", name: "Will", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/bIHbv24MWmeRgasZH58o/8caf8f3d-ad29-4980-af41-53f20c72d7a4.mp3" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Jessica", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3" },
  { id: "cjVigY5qzO86Huf0OWal", name: "Eric", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/cjVigY5qzO86Huf0OWal/d098fda0-6456-4030-b3d8-63aa048c9070.mp3" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", previewUrl: "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3" },
];

/** Stable small hash — no crypto needed, spread is all that matters. */
function hash(pk: string): number {
  let h = 0;
  for (let i = 0; i < pk.length; i++) h = (h * 31 + pk.charCodeAt(i)) >>> 0;
  return h;
}

export function voiceFor(
  pk: string,
  overrides?: Record<string, string>,
  personaName?: string
): PinnedVoice {
  const wanted = personaName ? overrides?.[personaName] : undefined;
  const pinned = wanted && PINNED.find((v) => v.id === wanted);
  if (pinned) return pinned;
  return PINNED[hash(pk) % PINNED.length];
}
