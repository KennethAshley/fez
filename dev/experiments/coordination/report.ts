import { readFile } from "node:fs/promises";
import { compareCandidates } from "./benchmark.ts";

try {
  const [input, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error("usage: report.ts <assessment-file.json>");
  const parsed: unknown = JSON.parse(await readFile(input, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("assessment file must contain a comparison array");
  process.stdout.write(JSON.stringify(compareCandidates(parsed), null, 2) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
