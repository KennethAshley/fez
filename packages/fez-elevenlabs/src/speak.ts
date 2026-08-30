import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEXT_CAP = 2500;

/** Returns an error string, or undefined when the text is speakable. */
export function checkText(text: string): string | undefined {
  if (!text.trim()) return "nothing to speak — text is empty.";
  if (text.length > TEXT_CAP)
    return `text is ${text.length} chars; the cap is ${TEXT_CAP} (it is a paid API). Shorten it and call again — do not expect truncation.`;
  return undefined;
}

/** NIP-92 imeta tag, byte-shaped like the composer's (upload.ts imetaTag). */
export function imetaFor(url: string, size: number): string[] {
  return ["imeta", `url ${url}`, "m audio/mpeg", `size ${size}`];
}

/**
 * Voice overrides written by the gui panel via the prefs seam land in
 * this extension's state file. Headless side reads the same file.
 * Shape: { prefs: { voices: { [personaName]: voiceId } } }
 */
export function readVoicePrefs(
  file = path.join(os.homedir(), ".fez", "extension-data", "fez-elevenlabs.json")
): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      prefs?: { voices?: Record<string, string> };
    };
    return raw.prefs?.voices ?? {};
  } catch {
    return {};
  }
}
