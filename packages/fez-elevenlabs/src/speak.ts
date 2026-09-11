import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const TEXT_CAP = 2500;

/** Returns an error string, or undefined when the text is speakable. */
export function checkText(text: string): string | undefined {
  if (!text.trim()) return "nothing to speak — text is empty.";
  if (text.length > TEXT_CAP)
    return `text is ${text.length} chars; the cap is ${TEXT_CAP}. Shorten it and call again — do not expect truncation.`;
  return undefined;
}

/** NIP-92 imeta tag, byte-shaped like the composer's (upload.ts imetaTag). */
export function imetaFor(url: string, size: number, mime = "audio/mpeg"): string[] {
  return ["imeta", `url ${url}`, `m ${mime}`, `size ${size}`];
}

/** Explicit local backend: native PCM WAV needs neither an API key nor an encoder dependency. */
export async function speakLocally(text: string): Promise<Uint8Array> {
  const bad = checkText(text);
  if (bad) throw new Error(bad);
  if (process.platform !== "darwin") throw new Error("the macos speech engine requires macOS");
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fez-speech-"));
  try {
    const input = path.join(dir, "text.txt");
    const output = path.join(dir, "speech.wav");
    await fs.promises.writeFile(input, text.trim(), { mode: 0o600 });
    await promisify(execFile)("/usr/bin/say", [
      "-v", "Samantha", "-r", "165", "-f", input, "-o", output,
      "--file-format=WAVE", "--data-format=LEI16@22050",
    ], { timeout: 60_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin" } });
    return await fs.promises.readFile(output);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

interface ChannelEvent {
  tags: string[][];
  content: string;
}

/**
 * Pure half of channel resolution (id or name → id). Split out from the
 * relay query so "the relay failed" and "the relay answered, no match"
 * stay distinguishable — a query failure must surface as its own error,
 * not fold into this returning undefined.
 */
export function matchChannel(channels: ChannelEvent[], raw: string): string | undefined {
  if (channels.find((e) => e.tags.find((t) => t[0] === "d")?.[1] === raw)) return raw;
  const nameOf = (e: ChannelEvent) => {
    const tag = e.tags.find((t) => t[0] === "name")?.[1];
    if (tag) return tag;
    try {
      return (JSON.parse(e.content) as { name?: string }).name;
    } catch {
      return undefined;
    }
  };
  return channels
    .find((e) => nameOf(e)?.toLowerCase() === raw.toLowerCase().replace(/^#/, ""))
    ?.tags.find((t) => t[0] === "d")?.[1];
}

function loadVoices(file: string): Record<string, string> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      prefs?: { voices?: Record<string, string> };
    };
    const voices = raw.prefs?.voices;
    return voices && Object.keys(voices).length > 0 ? voices : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Voice overrides written by the gui panel via the prefs seam land in
 * this extension's state file. Headless side reads the same file.
 * Shape: { prefs: { voices: { [personaName]: voiceId } } }
 *
 * The gui writes under the INSTALL DIRECTORY name, which differs by
 * install path: `fez link` keys it "fez-elevenlabs", but a production
 * `fez install npm:@fezchat/elevenlabs` de-scopes it to "elevenlabs" —
 * fez-wallet hit this exact trap (see storage-mirror.ts). Try the
 * de-scoped npm name first, fall back to the link name.
 */
export function readVoicePrefs(
  dir = process.env.FEZ_EXTENSION_DATA_DIR ?? path.join(os.homedir(), ".fez", "extension-data")
): Record<string, string> {
  return (
    loadVoices(path.join(dir, "elevenlabs.json")) ??
    loadVoices(path.join(dir, "fez-elevenlabs.json")) ??
    {}
  );
}
