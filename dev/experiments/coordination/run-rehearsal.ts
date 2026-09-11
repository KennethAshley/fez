import { resolve } from "node:path";
import { runRehearsal, type RehearsalMode } from "./rehearsal.js";

setTimeout(() => {
  process.stderr.write("Rehearsal exceeded its 30-second process limit. Partial output is not a completed episode.\n");
  process.exit(1);
}, 30_000).unref();

try {
  const [directory, mode, ...extra] = process.argv.slice(2);
  if (!directory || !mode || extra.length || !["direct", "delegated", "missing-delivery"].includes(mode)) {
    throw new Error("usage (from repository root): run-rehearsal <new-output-directory> <direct|delegated|missing-delivery>");
  }
  const episode = await runRehearsal(directory, mode as RehearsalMode, resolve("dev/experiments/coordination"));
  process.stdout.write(`Scripted transport rehearsal: ${episode.delivery.reason}. Quality ungraded.\n${resolve(directory, "episode.json")}\n`);
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
