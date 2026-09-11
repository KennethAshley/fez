import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let directory: string, instrument: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "fez-sentry-reporting-"));
  instrument = join(directory, "instrument.mjs");
  execFileSync(createRequire(import.meta.url).resolve("esbuild/bin/esbuild"), [
    resolve(__dirname, "../../fez-sentry/src/instrument.ts"), "--bundle", "--platform=node", "--format=esm",
    "--banner:js=import{createRequire as ___fezRequire}from'node:module';const require=___fezRequire(import.meta.url);",
    `--outfile=${instrument}`,
  ], { stdio: "pipe" });
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function run(code: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", instrument, "--input-type=module", "-e", code], {
      env: { ...process.env, NODE_OPTIONS: "", FEZ_SENTRY_DSN: "", SENTRY_DSN: "", FEZ_SENTRY_ENVIRONMENT: "test", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(Error("Sentry child did not exit")); }, 8000);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

it("stays inactive without Fez opt-in even when another app has SENTRY_DSN set", async () => {
  const result = await run('console.log(process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection"))', { SENTRY_DSN: "https://public@example.com/1" });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("0 0");
  expect(result.stderr).toBe("");
});

it.each([
  'setTimeout(() => { throw new Error("Fez Sentry connection test"); }, 0)',
  'Promise.reject(new Error("Fez Sentry connection test"))',
])("reports an actual fatal Node error and preserves failure exit: %s", async code => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => { bodies.push(body); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing test port");
    const result = await run(code, { FEZ_SENTRY_DSN: `http://public@127.0.0.1:${address.port}/123` });
    expect(result.code, result.stderr).toBe(1);
    expect(bodies, result.stderr).toHaveLength(1);
    const event = JSON.parse(bodies[0].trim().split("\n").at(-1)!);
    expect(event.exception.values[0].value).toBe("Fez Sentry connection test");
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(event.environment).toBe("test");
    expect(event.tags.component).toBe("fez-node");
    expect(event.user).toBeUndefined(); expect(event.request).toBeUndefined(); expect(event.server_name).toBeUndefined();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("drops contextual payloads and scrubs credentials and local paths from diagnostics", async () => {
  const source = `import { scrubEvent } from ${JSON.stringify(pathToFileURL(instrument).href)};
    console.log(JSON.stringify(scrubEvent({event_id:"test",user:{email:"private@example.com"},request:{data:"private prompt"},extra:{key:"private"},breadcrumbs:[{message:"private chat"}],contexts:{runtime:{name:"node"}},server_name:"private-host",exception:{values:[{type:"Error",value:"failed test-secret-value ${"a".repeat(64)} https://user:pass@example.com/?token=secret",stacktrace:{frames:[{filename:"/Users/private/work/app.ts",function:"run",lineno:12,context_line:"private source",vars:{key:"private"}}]}}]}})));`;
  const result = await run(source, { FEZ_API_TOKEN: "test-secret-value" });
  expect(result.code, result.stderr).toBe(0);
  const event = JSON.parse(result.stdout);
  expect(result.stdout).not.toContain("private");
  expect(result.stdout).not.toContain("test-secret-value");
  expect(result.stdout).not.toContain("a".repeat(64));
  expect(result.stdout).not.toContain("user:pass");
  expect(event.exception.values[0].stacktrace.frames[0]).toMatchObject({ filename: "app.ts", function: "run", lineno: 12 });
});

it("checks Sentry's HTTP acknowledgement instead of treating a drained queue as acceptance", async () => {
  let status = 200;
  const server = createServer((req, res) => { req.resume(); req.on("end", () => { res.statusCode = status; res.end("{}"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing test port");
    const env = { FEZ_SENTRY_DSN: `http://public@127.0.0.1:${address.port}/123` };
    const code = `import { verifyConnection } from ${JSON.stringify(pathToFileURL(instrument).href)};
      try { console.log(await verifyConnection()); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
    expect((await run(code, env)).code).toBe(0);
    status = 403;
    const rejected = await run(code, env);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("HTTP 403");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
