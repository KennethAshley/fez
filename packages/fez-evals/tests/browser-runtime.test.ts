import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedBrowser, browserStatus, setupBrowser } from "../../fez-browser/src/runtime.js";

import { installedRuntime } from "./helpers/browser-runtime.js";

let root: string;
let browsers: Awaited<ReturnType<typeof createManagedBrowser>>[];
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "fez-browser-runtime-")); browsers = []; });
afterEach(async () => { for (const browser of browsers) await browser.stop(); await fs.rm(root, { recursive: true, force: true }); });


describe("managed browser lifecycle", () => {
  it("offers GUI setup instead of trying to download from an agent call", async () => {
    expect((await browserStatus(root)).phase).toBe("missing");
    const browser = await createManagedBrowser(root);
    browsers.push(browser);
    await expect(browser.start()).rejects.toThrow(/Set up browser/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("starts a private authenticated subprocess lazily, and stops it on close", async () => {
    await installedRuntime(root);
    process.env.FEZ_BROWSER_TEST_SECRET = "do-not-inherit";
    const browser = await createManagedBrowser(root);
    browsers.push(browser);
    try {
      await expect(fetch(browser.baseUrl)).rejects.toThrow();
      await Promise.all([browser.start(), browser.start()]);
      const response = await fetch(browser.baseUrl + "/environment", { headers: { Authorization: `Bearer ${browser.accessKey}` } });
      expect(await response.json()).toMatchObject({ inheritedSecret: false, host: "127.0.0.1", apiKeySeparate: true });
      expect((await fetch(browser.baseUrl + "/health")).status).toBe(401);
      await browser.stop();
      await expect(fetch(browser.baseUrl)).rejects.toThrow();
    } finally { delete process.env.FEZ_BROWSER_TEST_SECRET; }
  });

  it("recovers on the same connection after setup or a failed startup is repaired", async () => {
    const browser = await createManagedBrowser(root);
    browsers.push(browser);
    await expect(browser.start()).rejects.toThrow(/Set up browser/);
    await installedRuntime(root);
    await fs.writeFile(path.join(root, "node_modules/@askjo/camofox-browser/server.js"), "process.exit(7)");
    await expect(browser.start()).rejects.toThrow(/exited/);
    expect(await fs.readdir(path.join(root, "sessions"))).toEqual([]);
    await installedRuntime(root);
    await Promise.all([browser.start(), browser.start()]);
    expect((await fetch(browser.baseUrl + "/health", { headers: { Authorization: `Bearer ${browser.accessKey}` } })).status).toBe(200);
    expect(await fs.readdir(path.join(root, "sessions"))).toHaveLength(1);
  });

  it("reuses installed browser files and verifies a real launch before reporting ready", async () => {
    await installedRuntime(root);
    await setupBrowser(root);
    expect(await browserStatus(root)).toMatchObject({ phase: "ready" });
    await fs.unlink(path.join(root, "node_modules/@askjo/camofox-browser/server.js"));
    expect((await browserStatus(root)).phase).toBe("missing");
  });

  it("keeps a startup failure visible and allows a new attempt after it is fixed", async () => {
    await installedRuntime(root);
    const server = path.join(root, "node_modules/@askjo/camofox-browser/server.js");
    await fs.writeFile(server, "process.exit(7)");
    await expect(setupBrowser(root)).rejects.toThrow(/exited|start/i);
    expect(await browserStatus(root)).toMatchObject({ phase: "error" });
    await installedRuntime(root);
    await setupBrowser(root);
    expect((await browserStatus(root)).phase).toBe("ready");
  });

  it("releases the browser and its temporary profile even if the owning process is killed", async () => {
    await installedRuntime(root);
    const module = new URL("../../fez-browser/src/runtime.ts", import.meta.url).href;
    const parent = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval",
      `import{createManagedBrowser}from${JSON.stringify(module)};const b=await createManagedBrowser(${JSON.stringify(root)});await b.start();console.log(b.baseUrl);setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(parent, "exit");
    try {
      const [output] = await once(parent.stdout!, "data");
      const url = String(output).trim();
      expect((await fetch(url + "/health")).status).toBe(401);
      parent.kill("SIGKILL");
      await exit;
      let stopped = false;
      let remaining: string[] = [];
      for (let i = 0; i < 40; i++) {
        try { await fetch(url + "/health"); } catch { stopped = true; }
        // The socket can close before the subprocess's exit hook removes its profile.
        remaining = await fs.readdir(path.join(root, "sessions"));
        if (stopped && remaining.length === 0) break;
        await delay(50);
      }
      expect(stopped).toBe(true);
      expect(remaining).toEqual([]);
    } finally { parent.kill("SIGKILL"); await exit; }
  });
});
