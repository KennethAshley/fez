/** Live acceptance check; requires the configured Mini provider. Makes one agent invocation. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const directory = await mkdtemp(join(tmpdir(), "fez-mesh-acceptance-"));
const input = join(directory, "requests.jsonl"), output = join(directory, "summary.json");
const rows = [
  { request: "r1", status: 200, durationMs: 840, outputTokens: 32 },
  { request: "r2", status: 403, durationMs: 18, outputTokens: 0 },
  { request: "r3", status: 200, durationMs: 1260, outputTokens: 48 },
  { request: "r4", status: 401, durationMs: 12, outputTokens: 0 },
  { request: "r5", status: 429, durationMs: 9, outputTokens: 0 },
  { request: "r6", status: 200, durationMs: 900, outputTokens: 40 },
];
await writeFile(input, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
const task = join(directory, "task.txt");
await writeFile(task, `Write and execute a Node.js program to summarize a synthetic request log. Follow these steps:
1. Read ${input} to inspect its JSONL format.
2. Write a program to ${join(directory, "summarize.cjs")}. It must read the input file and calculate these numeric fields from the parsed rows: totalRequests, successfulRequests (HTTP 200), deniedRequests (HTTP 401 or 403), busyRequests (HTTP 429), successfulOutputTokens (sum for successful requests), meanSuccessfulDurationMs (arithmetic mean of durationMs for successful requests only). Have the program write those fields as JSON to ${output}. Calculate values in code, never hardcode the answers.
3. Execute your program with node using the bash tool.
4. Read ${output} and check that the category counts sum to totalRequests.
Do not send messages or contact external services. Finish with the output path and a one-sentence interpretation.`, { mode: 0o600 });
console.log(`Acceptance artifacts: ${directory}`);
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("dist/cli.mjs", import.meta.url)), "ask", "--file", task], { stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Agent exited ${code}; artifacts retained at ${directory}`)));
});
assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
  totalRequests: 6, successfulRequests: 3, deniedRequests: 2, busyRequests: 1,
  successfulOutputTokens: 120, meanSuccessfulDurationMs: 1000,
});
console.log(`PASS: independently verified all six fields in ${output}`);
