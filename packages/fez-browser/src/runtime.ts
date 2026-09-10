import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import runtimeLock from "./camofox-lock.json" with { type: "json" };

export const runtimeRoot = () => path.join(os.homedir(), ".fez", "camofox");
const serverFile = (root: string) => path.join(root, "node_modules/@askjo/camofox-browser/server.js");
const executable = (root: string) => path.join(root, "browser", process.platform === "darwin" ? "Camoufox.app/Contents/MacOS/camoufox" : process.platform === "win32" ? "camoufox.exe" : "camoufox-bin");
export type BrowserStatus = { phase: "missing" | "working" | "ready" | "error"; message: string };
const setupHint = "Open Settings → extensions → Browser and select Set up browser.";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function filesReady(root: string) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "node_modules/@askjo/camofox-browser/package.json"), "utf8"));
    if (pkg.version !== "1.14.0") return false;
    await Promise.all([fs.access(serverFile(root)), fs.access(executable(root), 1), fs.access(path.join(root, "browser/version.json"))]);
    return true;
  } catch { return false; }
}

async function saveStatus(root: string, status: BrowserStatus) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const tmp = path.join(root, `status-${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(status), { mode: 0o600 });
  await fs.rename(tmp, path.join(root, "status.json"));
}

export async function browserStatus(root = runtimeRoot()): Promise<BrowserStatus> {
  let saved: BrowserStatus | undefined;
  try { saved = JSON.parse(await fs.readFile(path.join(root, "status.json"), "utf8")); } catch {}
  if (saved?.phase === "working" || saved?.phase === "error") return saved;
  if (saved?.phase === "ready" && await filesReady(root)) return saved;
  return { phase: "missing", message: "Set up the browser once. Agents will start it automatically when needed." };
}

/** A separate process, port, access key and profile for each MCP connection. */
export async function createManagedBrowser(root = runtimeRoot()) {
  const portFinder = createServer();
  portFinder.listen(0, "127.0.0.1");
  await once(portFinder, "listening");
  const address = portFinder.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local browser port");
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => portFinder.close(error => error ? reject(error) : resolve()));
  const accessKey = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let session: string | undefined;

  async function start() {
    if (stopping) throw new Error("Browser session is closing");
    return starting ??= (async () => {
      if (!await filesReady(root)) throw new Error(setupHint);
      await fs.mkdir(path.join(root, "sessions"), { recursive: true, mode: 0o700 });
      session = await fs.mkdtemp(path.join(root, "sessions", "session-"));
      const log = await fs.open(path.join(session, "server.log"), "w", 0o600);
      // Parent death closes stdin, so even a killed MCP process releases its browser.
      const code = `import{rmSync}from'node:fs';process.once('exit',()=>rmSync(${JSON.stringify(session)},{recursive:true,force:true}));process.stdin.once('end',()=>process.kill(process.pid,'SIGTERM'));process.stdin.resume();await import(${JSON.stringify(pathToFileURL(serverFile(root)).href)});`;
      child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
        cwd: root, stdio: ["pipe", log.fd, log.fd],
        env: {
          PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          TMPDIR: session, NODE_ENV: "production", CAMOUFOX_INSTALL_DIR: path.join(root, "browser"),
          CAMOFOX_BIND_HOST: "127.0.0.1", CAMOFOX_PORT: String(port),
          CAMOFOX_ACCESS_KEY: accessKey, CAMOFOX_API_KEY: randomBytes(32).toString("hex"), CAMOFOX_ADMIN_KEY: randomBytes(32).toString("hex"),
          CAMOFOX_PROFILE_DIR: path.join(session, "profiles"), CAMOFOX_COOKIES_DIR: path.join(session, "cookies"),
          CAMOFOX_UPLOADS_DIR: path.join(session, "uploads"), CAMOFOX_TRACES_DIR: path.join(session, "traces"),
          CAMOFOX_CRASH_REPORT_ENABLED: "false", CAMOFOX_DISABLE_DEFAULT_ADDONS: "1", CAMOFOX_INTERACTIVE: "off",
        },
      });
      exited = once(child, "exit").catch(() => undefined);
      child.stdin?.on("error", () => {});
      await log.close();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`Browser server exited (${child.exitCode}). Use Test browser in Settings → extensions → Browser.`);
        try {
          const response = await fetch(baseUrl + "/health", { headers: { Authorization: `Bearer ${accessKey}` }, signal: AbortSignal.timeout(500), redirect: "error" });
          await response.body?.cancel();
          if (response.ok) return;
        } catch {}
        await delay(100);
      }
      throw new Error("Browser did not start. Use Test browser in Settings → extensions → Browser.");
    })().catch(async error => {
      // A later tool call can retry after GUI setup repairs the runtime.
      await cleanup();
      starting = undefined;
      throw error;
    });
  }

  async function cleanup() {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      child.kill("SIGTERM");
      const force = setTimeout(() => child?.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(force);
    }
    if (session) await fs.rm(session, { recursive: true, force: true });
    child = undefined;
    exited = undefined;
    session = undefined;
  }

  function stop() {
    return stopping ??= (async () => {
      await starting?.catch(() => {});
      await cleanup();
    })();
  }
  return { baseUrl, accessKey, start, stop };
}

export async function testBrowser(root = runtimeRoot()) {
  const browser = await createManagedBrowser(root);
  const userId = randomUUID();
  try {
    await browser.start();
    const request = async (url: string, method: string, body?: unknown) => {
      const response = await fetch(browser.baseUrl + url, {
        method, headers: { Authorization: `Bearer ${browser.accessKey}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(55_000), redirect: "error",
      });
      if (!response.ok) throw new Error(`Browser check failed (HTTP ${response.status}). Retry Test browser.`);
      return response.json();
    };
    const tab = await request("/tabs", "POST", { userId, sessionKey: userId, trace: false });
    if (typeof tab.tabId !== "string") throw new Error("Browser did not create the test page");
    const closed = await request(`/sessions/${userId}`, "DELETE");
    if (closed.ok !== true) throw new Error("Browser did not close the test session");
  } catch (error) {
    await saveStatus(root, { phase: "error", message: message(error) });
    throw error;
  } finally { await browser.stop(); }
  await saveStatus(root, { phase: "ready", message: "Ready. Attached agents start a private browser when needed." });
}

/** Setup runs from the owner's GUI action, never from an agent's browser call. */
export async function setupBrowser(root = runtimeRoot()) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, "setup.lock");
  try {
    const old = JSON.parse(await fs.readFile(lockPath, "utf8"));
    let alive = false;
    try { process.kill(old.pid, 0); alive = old.at > Date.now() - os.uptime() * 1000; } catch {}
    if (alive) throw new Error("Browser setup is already running");
    await fs.unlink(lockPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = await fs.open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
  await lock.close();
  try {
    if (!await filesReady(root)) {
      await saveStatus(root, { phase: "working", message: "Installing browser tools…" });
      const npm = path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
      await fs.access(npm).catch(() => { throw new Error("The Fez Node runtime is missing npm. Repair the runtime in Fez settings and retry setup."); });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "@askjo/camofox-browser": "1.14.0" } }));
      await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(runtimeLock));
      await fs.mkdir(path.join(root, "tmp"), { recursive: true });
      const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: path.join(root, "tmp"), CAMOUFOX_INSTALL_DIR: path.join(root, "browser"), npm_config_cache: path.join(root, "npm-cache"), npm_config_userconfig: path.join(root, "npmrc") };
      await fs.writeFile(env.npm_config_userconfig, "");
      async function run(args: string[]) {
        const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
        const [code] = await once(child, "exit");
        if (code !== 0) throw new Error("Browser download failed. Check the connection and retry Set up browser.");
      }
      await run([npm, "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"]);
      await saveStatus(root, { phase: "working", message: "Downloading the browser (about 313 MB)…" });
      const pkgman = pathToFileURL(path.join(root, "node_modules/camoufox-js/dist/pkgman.js")).href;
      await run(["--input-type=module", "--eval", `const {CamoufoxFetcher}=await import(${JSON.stringify(pkgman)});await new CamoufoxFetcher().install();`]);
    }
    const configFile = path.join(root, "node_modules/@askjo/camofox-browser/camofox.config.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    config.interactive = { mode: "off" };
    config.plugins = { ...config.plugins, persistence: { enabled: false }, youtube: { enabled: false }, vnc: { enabled: false } };
    await fs.writeFile(configFile, JSON.stringify(config, null, 2));
    await saveStatus(root, { phase: "working", message: "Testing the browser…" });
    await testBrowser(root);
    await saveStatus(root, { phase: "ready", message: "Ready. Attached agents start a private browser when needed." });
  } catch (error) {
    await saveStatus(root, { phase: "error", message: message(error) });
    throw error;
  } finally { await fs.unlink(lockPath); }
}
