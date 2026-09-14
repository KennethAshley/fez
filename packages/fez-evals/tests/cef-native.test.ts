import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Uses the identity-free Tauri example, never the running Fez app/profile.
it.skipIf(!process.env.FEZ_CEF_NATIVE_PROBE)('loads and captures HTTP content in a native Tauri child browser', async () => {
  const dir = await mkdtemp('/private/tmp/fez-cef-native-eval-');
  let requests = 0;
  const http = createServer((_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Native HTTP works</title><h1>Native HTTP works</h1><input aria-label="Draft"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Nothing saved yet</output>');
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP port');
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const debugAddress = reserve.address();
  if (!debugAddress || typeof debugAddress === 'string') throw new Error('No debug port');
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const bootstrap = join(dir, 'bootstrap.json');
  await writeFile(bootstrap, JSON.stringify({ profile: dir, url: `http://127.0.0.1:${address.port}/`, port: debugAddress.port }));
  // Like upstream CEF's test host, keep this disposable fixture off the real
  // Keychain. This does not validate encrypted storage in a signed release.
  const child = spawn(process.env.FEZ_CEF_NATIVE_PROBE!, [bootstrap, '--use-mock-keychain'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(child, 'exit');
  let logs = '';
  child.stderr.on('data', bytes => { logs = (logs + bytes).slice(-8000); });
  let socket: WebSocket | undefined;
  try {
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let n = 0; n < 150; n++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${debugAddress.port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
        target = targets.find((t: { type: string }) => t.type === 'page');
        if (target) logs += `\nCDP targets: ${JSON.stringify(targets)}\n`;
      } catch { /* CEF is starting. */ }
      if (target) break;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CEF exited before startup: ${child.signalCode ?? child.exitCode}`);
      await delay(100);
    }
    expect(target, logs).toBeDefined();
    socket = new WebSocket(target!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 3000);
      socket!.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket!.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    let id = 0;
    const calls = new Map<number, (value: { result?: Record<string, unknown>; error?: unknown }) => void>();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      calls.get(message.id)?.(message);
      calls.delete(message.id);
    });
    const command = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const call = ++id;
      const timer = setTimeout(() => { calls.delete(call); reject(new Error(`Native ${method} timed out`)); }, 3000);
      calls.set(call, value => { clearTimeout(timer); value.error ? reject(value.error) : resolve(value.result ?? {}); });
      socket!.send(JSON.stringify({ id: call, method, params }));
    });
    const evaluate = async (expression: string) => {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true });
      return (response.result as { value?: unknown })?.value;
    };
    let title;
    for (let n = 0; n < 30; n++) {
      title = await evaluate('document.title');
      if (title === 'Native HTTP works') break;
      await delay(100);
    }
    if (title !== 'Native HTTP works') logs += `\nPage state: ${JSON.stringify(await evaluate('({url:location.href,readyState:document.readyState,html:document.documentElement.outerHTML})'))}`;
    expect(title, 'Native HTTP navigation stalled').toBe('Native HTTP works');
    const capture = await command('Page.captureScreenshot', { format: 'png' });
    expect(typeof capture.data).toBe('string');
    const png = Buffer.from(capture.data as string, 'base64');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(1000);
  } catch (error) {
    const cefLog = await readFile(join(dir, 'cef.log'), 'utf8').catch(() => 'No CEF log written');
    throw new Error(`${String(error)}\n${logs}\nFixture HTTP requests received: ${requests}\nCEF log:\n${cefLog}`, { cause: error });
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
