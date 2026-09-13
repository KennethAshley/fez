// Throwaway CEF feasibility probe. No user profile, credentials, or Fez keys.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exe = process.env.FEZ_CEF_EXECUTABLE;
if (!exe) throw new Error('Set FEZ_CEF_EXECUTABLE to the bundled cefsimple executable.');
const profile = await mkdtemp(join(tmpdir(), 'fez-cef-prototype-'));
const uiToken = randomBytes(24).toString('hex');
const agentToken = randomBytes(24).toString('hex');
let mode = 'human';
let stopped = false;
let socket;
let child;
let id = 0;
const pending = new Map();
const sessionPath = new URL('./session.json', import.meta.url);

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function cdp(method, params = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser disconnected'));
  const callId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`${method} timed out`)); }, 5000);
    pending.set(callId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: callId, method, params }));
  });
}
async function stop() {
  if (stopped) return;
  stopped = true;
  mode = 'stopped';
  try { await cdp('Browser.close'); } catch {}
  socket?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  await rm(profile, { recursive: true, force: true });
}
const fixture = '<!doctype html><html><body style="font:24px system-ui;padding:40px"><h1>Fez shared browser test</h1><label>Draft <input id="draft" aria-label="Draft"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><p><output>Nothing saved yet</output></p></body></html>';

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.url === '/fixture') {
    res.setHeader('Content-Type', 'text/html'); res.end(fixture); return;
  }
  // Loopback is not authentication. A random bearer token protects every control route.
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const actor = token === uiToken ? 'human' : token === agentToken ? 'agent' : null;
  const origin = req.headers.origin;
  if (origin && ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (!actor || req.method !== 'POST' || req.url !== '/control') { res.writeHead(403).end(); return; }
  res.setHeader('Content-Type', 'application/json');
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request too large'); }
    const action = JSON.parse(body);
    let result;
    if (action.type === 'stop' && actor === 'human') await stop();
    else if (stopped) throw new Error('Session stopped');
    else if (action.type === 'resize' && actor === 'human') {
      const { width, height } = action;
      if (![width, height].every(n => Number.isInteger(n) && n >= 200 && n <= 4096)) throw new Error('Invalid viewport size');
      const current = (await cdp('Page.getLayoutMetrics')).cssLayoutViewport;
      if (current.clientWidth !== width || current.clientHeight !== height) {
        mode = 'human'; // A model's previous screenshot no longer matches after a layout change.
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false });
      }
    }
    else if (action.type === 'mode' && actor === 'human') {
      if (!['human', 'agent'].includes(action.value)) throw new Error('Invalid mode');
      mode = action.value;
      await cdp('Page.stopLoading');
    } else if (action.type === 'observe') {
      if (actor === 'agent' && mode !== 'agent') throw new Error('Owner has not granted agent control');
      const viewport = (await cdp('Page.getLayoutMetrics')).cssLayoutViewport;
      const snapshot = await cdp('Runtime.evaluate', { expression: '({ text: document.body?.innerText.slice(0, 12000) ?? "", dpr: devicePixelRatio, url: location.href, title: document.title })', returnByValue: true });
      // ponytail: cap agent images at 1024px to avoid model-side resizing; add crops for tiny targets later.
      const clip = actor === 'agent' ? {
        x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight,
        scale: Math.min(1, 1024 / Math.max(viewport.clientWidth, viewport.clientHeight)) / snapshot.result.value.dpr,
      } : undefined;
      result = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 65, ...(clip ? { clip } : {}) });
      result.text = snapshot.result.value.text;
      result.viewport = viewport;
      result.url = snapshot.result.value.url;
      result.title = snapshot.result.value.title;
      if (actor === 'human') {
        const history = await cdp('Page.getNavigationHistory');
        result.navigation = { canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
      }
    } else {
      if (mode !== actor) throw new Error(`Control belongs to ${mode}`);
      switch (action.type) {
        case 'navigate': {
          const url = new URL(action.url);
          if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP(S) navigation is supported');
          result = await cdp('Page.navigate', { url: url.href }); break;
        }
        case 'reload': await cdp('Page.reload'); break;
        case 'history': {
          if (![-1, 1].includes(action.delta)) throw new Error('Invalid history direction');
          const history = await cdp('Page.getNavigationHistory');
          const entry = history.entries[history.currentIndex + action.delta];
          if (entry) await cdp('Page.navigateToHistoryEntry', { entryId: entry.id });
          break;
        }
        case 'wheel': {
          const { x, y, deltaX, deltaY } = action;
          if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 4096) || ![deltaX, deltaY].every(n => Number.isFinite(n) && Math.abs(n) <= 4096)) throw new Error('Invalid scroll');
          await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }); break;
        }
        case 'click': {
          const { x, y } = action;
          if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 4096)) throw new Error('Invalid coordinates');
          await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); break;
        }
        case 'type':
          if (typeof action.text !== 'string' || action.text.length > 4096) throw new Error('Invalid text');
          await cdp('Input.insertText', { text: action.text }); break;
        case 'key': {
          const keys = { Enter: 13, Tab: 9, Backspace: 8, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
          if (!Object.hasOwn(keys, action.key)) throw new Error('Unsupported key');
          await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, windowsVirtualKeyCode: keys[action.key], ...(action.key === 'Enter' ? { text: '\r' } : {}) });
          await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, windowsVirtualKeyCode: keys[action.key] }); break;
        }
        default: throw new Error('Unsupported action');
      }
    }
    if (actor === 'agent' && mode !== 'agent') throw new Error('Owner revoked agent control');
    res.end(JSON.stringify({ mode, ...result }));
  } catch (error) { res.writeHead(400).end(JSON.stringify({ error: error.message, mode })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const port = await unusedPort();
child = spawn(exe, ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--url=${endpoint}/fixture`], { stdio: 'ignore' });
child.on('error', error => console.error(error.message));
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch {}
    if (target) break;
    if (child.exitCode !== null) throw new Error(`CEF exited: ${child.exitCode}`);
    await delay(200);
  }
  if (!target) throw new Error('CEF did not expose a page over CDP');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  });
  await cdp('Page.enable');
  await writeFile(sessionPath, JSON.stringify({ endpoint, uiToken, agentToken, profile, pid: process.pid }), { mode: 0o600 });
  console.log(`CEF ready. Private session file: ${sessionPath.pathname}`);
} catch (error) { await stop(); server.close(); throw error; }
async function shutdown() { await stop(); await rm(sessionPath, { force: true }); server.close(); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
