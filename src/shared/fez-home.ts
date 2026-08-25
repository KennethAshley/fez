import os from "node:os";
import path from "node:path";

/**
 * The ONE spelling of ~/.fez. Every file, key, persona, extension and
 * harness dir lives under here; building the prefix by hand in each
 * caller is how ".fez" and ".Fez" typos ship. `base` exists for tests
 * that point the tree at a temp dir — production callers omit it.
 */
export function fezHome(...segments: string[]): string {
  return path.join(os.homedir(), ".fez", ...segments);
}

/** fezHome with an overridable root, for callers that support a test base. */
export function fezHomeAt(base: string | undefined, ...segments: string[]): string {
  return path.join(base ?? os.homedir(), ".fez", ...segments);
}
