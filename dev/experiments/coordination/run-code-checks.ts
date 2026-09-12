import { resolve } from "node:path";
import { verifyPilotCode } from "./code-checks.js";
import { verifyRepositoryPilot } from "./repository-acceptance.js";

try {
  const [report, directory, baseline, ...extra] = process.argv.slice(2);
  if (!report || !directory || extra.length) throw new Error("usage (from repository root): run-code-checks <pilot/report.json> <new-output-directory> [R01-baseline-checkout]");
  if (baseline) {
    const result = await verifyRepositoryPilot(report, baseline, directory, resolve("dev/experiments/coordination"));
    for (const arm of result.arms) process.stdout.write(`${arm.name}: ${arm.status}; code checks ${arm.codeChecksPassed}; full acceptance pending review\n`);
    if (result.arms.some(arm => arm.codeChecksPassed !== true)) process.exitCode = 2;
  } else {
    const result = await verifyPilotCode(report, directory, resolve("dev/experiments/coordination"));
    for (const arm of result.arms) {
      process.stdout.write(`${arm.name}: code tests ${arm.acceptance?.verdict ?? "not delivered"}; regression demonstrated ${arm.regressionDemonstrated}; full acceptance ungraded\n`);
    }
    if (result.arms.some(a => a.acceptance?.verdict !== "passed" || a.regressionDemonstrated !== true)) process.exitCode = 2;
  }
  process.stdout.write(resolve(directory, "verification.json") + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "code verification failed") + "\n");
  process.exitCode = 1;
}
