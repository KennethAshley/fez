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

// Premade ElevenLabs voices (ids are stable public catalog ids).
// Verified against GET /v1/voices at implementation time — if any id is
// gone, replace it here rather than filtering at runtime.
export const PINNED: PinnedVoice[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
  { id: "29vD33N1CtxCmqQRPOHJ", name: "Drew" },
  { id: "2EiwWnXFnvU5JabPnv8n", name: "Clyde" },
  { id: "5Q0t7uMcjvnagumLfvZi", name: "Paul" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
  { id: "CYw3kZ02Hs0563khs1Fj", name: "Dave" },
  { id: "D38z5RcWu1voky8WS1ja", name: "Fin" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },
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
