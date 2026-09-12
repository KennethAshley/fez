import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

let dir: string, entry: string;
const children = new Set<ChildProcess>();
const orphanGroups = new Set<number>();

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "fez-agent-lifetime-"));
  const out = path.join(dir, "lifetime.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../../fez-acp/src/lifetime.ts", import.meta.url))], outfile: out, format: "esm", platform: "node", bundle: true });
  entry = pathToFileURL(out).href;
});
afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const pid of orphanGroups) { try { process.kill(-pid, "SIGKILL"); } catch { /* The fixture process may already have exited. */ } }
  if (dir) await rm(dir, { recursive: true, force: true });
});

function fixture(marker: string) {
  return `import { bindAgentLifetime } from ${JSON.stringify(entry)};
    import { appendFileSync } from 'node:fs';
    const timer = setInterval(() => {}, 1000);
    bindAgentLifetime(async () => {
      appendFileSync(${JSON.stringify(marker)}, 'closing\\n');
      await new Promise(r => setTimeout(r, 80));
      appendFileSync(${JSON.stringify(marker)}, 'closed\\n');
      clearInterval(timer);
    });
    console.log('ready');`;
}

async function start(code: string, parentPid = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, FEZ_DESKTOP_PARENT_PID: parentPid }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const exited = once(child, "exit");
  let text = "";
  child.stdout!.on("data", chunk => { text += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { cleanup(); reject(new Error("lifetime fixture did not become ready")); }, 3000);
    const check = () => { if (text.includes("ready")) { cleanup(); resolve(); } };
    const failed = () => { cleanup(); reject(new Error("lifetime fixture exited before ready")); };
    function cleanup() { clearTimeout(deadline); child.stdout!.off("data", check); child.off("exit", failed); }
    child.stdout!.on("data", check); child.once("exit", failed); check();
  });
  return { child, exited, output: () => text };
}

it("finishes cleanup exactly once before exiting on repeated SIGTERM", async () => {
  const marker = path.join(dir, "term");
  const { child, exited } = await start(fixture(marker));
  child.kill("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 20));
  child.kill("SIGTERM");
  expect(await exited).toEqual([0, null]);
  children.delete(child);
  expect(await readFile(marker, "utf8")).toBe("closing\nclosed\n");
});

it("cleans up after the desktop parent dies without a shutdown signal", async () => {
  const marker = path.join(dir, "parent");
  const childCode = fixture(marker);
  const parentCode = `import { spawn } from 'node:child_process';
    spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childCode)}], {
      env: {...process.env, FEZ_DESKTOP_PARENT_PID: String(process.pid)}, stdio: ['ignore', 'inherit', 'inherit']
    });
    setInterval(() => {}, 1000);`;
  const { child, exited } = await start(parentCode);
  child.kill("SIGKILL");
  await exited;
  children.delete(child);
  await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 4000 }).toBe("closing\nclosed\n");
});

it("keeps headless agents alive without a desktop parent and still handles SIGINT", async () => {
  const marker = path.join(dir, "headless");
  const { child, exited } = await start(fixture(marker));
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(child.exitCode).toBeNull();
  child.kill("SIGINT");
  expect(await exited).toEqual([0, null]);
  children.delete(child);
  expect(await readFile(marker, "utf8")).toBe("closing\nclosed\n");
});

it("reaps an adapter that ignores TERM when its desktop and native reaper disappear", async () => {
  const marker = path.join(dir, "group");
  const code = `import { bindAgentLifetime } from ${JSON.stringify(entry)};
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { appendFileSync } from 'node:fs';
    bindAgentLifetime(async () => { appendFileSync(${JSON.stringify(marker)}, 'closed'); });
    const adapter = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('adapter-ready'); setInterval(() => {}, 1000)"], {stdio: ['ignore', 'pipe', 'inherit']});
    await once(adapter.stdout, 'data');
    console.log('GROUP=' + process.pid + ' ADAPTER=' + adapter.pid + ' ready');
    setInterval(() => {}, 1000);`;
  const parent = `import { spawn } from 'node:child_process';
    spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(code)}], {
      detached: true, env: {...process.env, FEZ_DESKTOP_PARENT_PID: String(process.pid)}, stdio: ['ignore', 'inherit', 'inherit']
    }); setInterval(() => {}, 1000);`;
  const { child, exited, output } = await start(parent);
  const group = Number(output().match(/GROUP=(\d+)/)?.[1]);
  const adapter = Number(output().match(/ADAPTER=(\d+)/)?.[1]);
  expect(group).toBeGreaterThan(1); expect(adapter).toBeGreaterThan(1);
  orphanGroups.add(group);
  child.kill("SIGKILL"); await exited; children.delete(child);
  await expect.poll(() => {
    try { process.kill(adapter, 0); return true; } catch { return false; }
  }, { timeout: 5000 }).toBe(false);
  expect(await readFile(marker, "utf8")).toBe("closed");
  await expect.poll(output).toContain(`FEZ_AGENT_STOPPED=${group}\n`);
  orphanGroups.delete(group);
}, 10_000);
