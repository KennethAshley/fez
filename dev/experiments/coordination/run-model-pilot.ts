import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { previewPilot, runModelPilot } from "./model-pilot.js";

try {
  const [configPath, candidatePath, directory, ...flags] = process.argv.slice(2);
  const run = flags[0] === "--run";
  if (run) flags.shift();
  if (!configPath || !candidatePath || !directory || (flags.length && (flags.length !== 2 || flags[0] !== "--repositories"))) {
    throw new Error("usage (from repository root): run-model-pilot <config.json> <candidate.md> <new-output-directory> [--run] [--repositories <checkouts.json>]");
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const candidate = await readFile(candidatePath);
  const packDirectory = resolve("dev/experiments/coordination");
  const checkouts = flags.length ? JSON.parse(await readFile(flags[1], "utf8")) : undefined;
  const preview = await previewPilot(config, candidate, packDirectory, checkouts);
  if (!run) {
    await mkdir(resolve(directory));
    await writeFile(join(resolve(directory), "preview.json"), JSON.stringify(preview, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(`Preview only; no provider contact. Maximum ${preview.allowance.maximumCalls} requests and ${preview.allowance.maximumRequestedOutputTokens} requested output tokens across three attempts.\n${resolve(directory, "preview.json")}\n`);
  } else {
    // An unref'd cap also catches leaked transports after the bounded task waits finish.
    setTimeout(() => { process.stderr.write("Pilot process limit reached; inspect partial output.\n"); process.exit(1); },
      3 * preview.conditions.config.limits.maxSeconds * 1000 + 60_000).unref();
    const report = await runModelPilot(directory, config, candidate, packDirectory, checkouts);
    for (const arm of report.arms) process.stdout.write(`${arm.name}: ${arm.status}; ${arm.calls.length} model requests; quality ungraded\n`);
    process.stdout.write(`${resolve(directory, "report.json")}\n`);
    if (report.arms.some(arm => arm.status === "failed")) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
