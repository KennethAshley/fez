import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activateModelProfile } from "../../fez-acp/src/model-profile.js";

const installed = join(homedir(), ".fez/bin");
const available = ["pi", "pi-acp"].every(bin => existsSync(join(installed, bin)));
const homes: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

async function fixture(invalid: boolean) {
  const home = await mkdtemp(join(tmpdir(), "fez-pi-pin-")); homes.push(home);
  const provider = "ext-test-mini", model = "local/selected", persona = "test-agent";
  const directory = join(home, ".fez/model-profiles", provider, persona);
  await mkdir(directory, { recursive: true });
  for (const [file, value] of Object.entries({
    "profile.json": { provider, model, persona },
    "settings.json": { defaultProvider: provider, defaultModel: model, quietStartup: true, retry: { enabled: false } },
    "models.json": { providers: { [provider]: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "synthetic-local-key",
      models: [{ id: model, contextWindow: invalid ? "bad" : 8192, maxTokens: 32 }] } } },
  })) await writeFile(join(directory, file), JSON.stringify(value));
  const bin = join(home, ".fez/bin"), record = join(home, "rpc.jsonl");
  await mkdir(bin, { recursive: true });
  await symlink(join(installed, "pi-acp"), join(bin, "pi-acp"));
  // Real pi loads the malformed profile and selects its fallback. Intercept only
  // inference so a failing regression can never send the test prompt to a cloud.
  await writeFile(join(bin, "pi"), `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("test-wrapper"); process.exit(0); }
const child = spawn(${JSON.stringify(join(installed, "pi"))}, [...process.argv.slice(2), "--offline"], { stdio: ["pipe", "pipe", "inherit"] });
createInterface({ input: child.stdout }).on("line", line => {
  const value = JSON.parse(line);
  if (value.command === "get_state") appendFileSync(${JSON.stringify(record)}, JSON.stringify({ state: value.data?.model }) + "\\n");
  process.stdout.write(line + "\\n");
});
createInterface({ input: process.stdin }).on("line", line => {
  const value = JSON.parse(line);
  if (value.type === "prompt") {
    appendFileSync(${JSON.stringify(record)}, JSON.stringify({ prompt: true }) + "\\n");
    process.stdout.write(JSON.stringify({ id: value.id, type: "response", command: "prompt", success: false, error: "test blocked inference" }) + "\\n");
  } else child.stdin.write(line + "\\n");
}).on("close", () => child.kill());
process.on("SIGTERM", () => child.kill());
child.once("exit", () => process.exit(0));
`, { mode: 0o755 });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", `${dirname(process.execPath)}:/usr/bin:/bin`);
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-cloud-key");
  for (const name of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "FEZ_PI_REQUIRED_MODEL"]) vi.stubEnv(name, "");
  activateModelProfile({ id: persona, harness: "pi", extra: { provider, model, modelProfile: provider } }, home, process.env);
  vi.resetModules();
  const { registerBuiltinHarnesses, findHarness } = await import("../../../src/agent/harness.js");
  registerBuiltinHarnesses();
  const records = async () => (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { state?: { provider: string; id: string }; prompt?: boolean });
  return { home, harness: findHarness("pi")!, records };
}

it.skipIf(!available).each(["invoke", "openSession"] as const)("%s refuses an invalid private model before pi can infer with inherited cloud credentials", async method => {
  const f = await fixture(true);
  let error: unknown;
  try {
    if (method === "invoke") await f.harness.invoke("Never send this to the cloud", f.home);
    else { const session = await f.harness.openSession!(f.home); await session.close(); }
  } catch (caught) { error = caught; }
  const records = await f.records();
  expect(records.some(row => row.state?.provider === "anthropic")).toBe(true);
  expect(records.some(row => row.prompt)).toBe(false);
  expect(String(error)).toMatch(/required model|model.*not found|unknown model/i);
}, 20000);

it.skipIf(!available)("opens the exact valid private model while keeping other credentials available", async () => {
  const f = await fixture(false);
  const session = await f.harness.openSession!(f.home);
  try {
    expect((await f.records()).at(-1)?.state).toMatchObject({ provider: "ext-test-mini", id: "local/selected" });
    expect(process.env.ANTHROPIC_API_KEY).toBe("synthetic-cloud-key");
  } finally { await session.close(); }
}, 20000);
