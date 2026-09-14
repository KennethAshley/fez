import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBrowserUseServer } from '../../fez-browser-use/src/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolContext } from '../../fez-acp/src/tool-context.js';

// External CDP bootstraps trusted owner controls and reads assertions only.
// All tested agent input/capture uses the real MCP -> Unix socket -> native CEF path.
it.skipIf(!process.env.FEZ_TAURI_CEF_PROBE)('connects the browser extension to native MCP input with owner-only handoff and teardown', async () => {
  const profile = await mkdtemp('/private/tmp/fez-tauri-cef-eval-');
  const fixture = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Fez browser fixture</title><style>body{padding:32px;font:20px system-ui}input,button{font:inherit}</style><h1>Native browser</h1><input aria-label="Draft"><button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Save</button><p><output>Nothing saved yet</output></p>`);
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const addr = fixture.address();
  if (!addr || typeof addr === 'string') throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${addr.port}/`;
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const debug = reserve.address();
  if (!debug || typeof debug === 'string') throw new Error('Missing debug port');
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.env.FEZ_TAURI_CEF_PROBE!, [], {
    env: { ...process.env, FEZ_UPSTREAM_PROFILE: profile, FEZ_UPSTREAM_DEBUG_PORT: String(debug.port), CEF_EXAMPLE_SECRET_STORAGE: 'mock', CEF_EXAMPLE_SANDBOX: 'required' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = Promise.race([
    once(child, 'exit'),
    once(child, 'error').then(([error]) => { throw error; }),
  ]);
  // Observe rejection immediately; a bad executable must not strand the server.
  void exited.catch(() => {});
  let logs = '';
  child.stderr.on('data', b => { logs = (logs + b).slice(-8000); });
  const sockets: WebSocket[] = [];
  const agents: { context: ToolContext; client: Client; server: ReturnType<typeof createBrowserUseServer> }[] = [];
  const server = createBrowserUseServer({ sessionFile: `${profile}/session.json` });
  const client = new Client({ name: 'native-browser-eval', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const tool = (action: Record<string, unknown>) => client.callTool({ name: 'browser_use', arguments: action });
  type Target = { type: string; url: string; webSocketDebuggerUrl: string };
  const targets = async (): Promise<Target[]> => (await fetch(`http://127.0.0.1:${debug.port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
  try {
    async function connect(matches: (target: Target) => boolean) {
      let target: Target | undefined;
      for (let n = 0; n < 150; n++) {
        try { target = (await targets()).find(matches); } catch { /* Native startup. */ }
        if (target) break;
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error(`Native startup failed: ${logs}`);
        await delay(100);
      }
      expect(target, logs).toBeDefined();
      const socket = new WebSocket(target!.webSocketDebuggerUrl);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 3000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    let id = 1_000_000;
    const pending = new Map<number, (message: { result: unknown; error?: unknown }) => void>();
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    socket.addEventListener('close', () => {
      for (const reply of pending.values()) reply({ result: undefined, error: 'native host closed' });
      pending.clear();
    });
    const call = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
      const callId = ++id;
      const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`${method} timed out`)); }, 8000);
      pending.set(callId, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result as T); });
      socket!.send(JSON.stringify({ id: callId, method, params }));
    });
    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await call<{ result: { value: T }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
      return { evaluate, call, target: target! };
    }
    const main = await connect(t => t.type === 'page' && t.url === 'http://tauri.localhost/');
    let descriptor: { id: string; agentToken: string; endpoint: string } | undefined;
    await expect.poll(async () => {
      try { descriptor = JSON.parse(await readFile(`${profile}/session.json`, 'utf8')); return true; } catch { return false; }
    }, { timeout: 10000 }).toBe(true);
    const firstId = descriptor!.id;
    // Browser input intentionally pauses when the owner window is hidden or
    // occluded. A native regression needs a foreground window, including after
    // testing minimize/restore; launching its binary does not guarantee that.
    const focusWindow = async () => {
      await main.evaluate("window.__TAURI__.core.invoke('plugin:window|set_focus',{label:'main'})");
      await expect.poll(() => main.evaluate('document.visibilityState')).toBe('visible');
    };
    await focusWindow();
    const owner = await connect(t => t.url === 'http://tauri.localhost/owner.html');
    await expect.poll(() => owner.evaluate("document.querySelector('#control')?.disabled"), { timeout: 5000 }).toBe(false);
    expect(await main.evaluate("!!document.querySelector('[data-new-browser]')")).toBe(true);
    const control = <T>(action: string) => owner.evaluate<T>(`window.__TAURI__.core.invoke('native_surface_owner',{action:${JSON.stringify(action)}})`);
    // The lab has no Fez runtime until this test creates disposable contexts.
    expect(await control('state')).toMatchObject({ queued: false, waiting: [] });
    const action = <T>(action: object, id = firstId) => main.evaluate<T>(`window.__TAURI__.core.invoke('native_surface_action',{id:${JSON.stringify(id)},action:${JSON.stringify(action)}})`);
    const pointer = async () => (await action<{ pointer: { x: number; y: number; label: string; phase: string; palette: { background: number[]; foreground: number[] } } | null }>({ op: 'snapshot' })).pointer;
    expect((await stat(profile)).mode & 0o777).toBe(0o700);
    expect((await stat(`${profile}/session.json`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${profile}/control.sock`)).mode & 0o777).toBe(0o600);
    expect(await main.evaluate("document.querySelectorAll('.cef-page,img').length")).toBe(0);
    await main.evaluate(`document.querySelector('.cef-address input').value=${JSON.stringify(url)};document.querySelector('.cef-address').requestSubmit()`);
    const browser = await connect(t => t.url === url);
    const page = browser.evaluate;
    await expect.poll(() => page('document.title')).toBe('Fez browser fixture');
    await expect.poll(() => main.evaluate("document.querySelector('.cef-address input').value")).toBe(url);
    expect((await tool({ type: 'observe' })).isError).toBe(true);
    // Shared extension JS cannot grant, invoke raw CDP, or open a privileged view.
    await expect(main.evaluate("window.__TAURI__.core.invoke('native_surface_owner',{action:'grant'})")).rejects.toThrow('owner control required');
    await expect(action({ op: 'native', method: 'Target.getTargets', params: {} })).rejects.toThrow();
    expect(await page(`window.__TAURI_INTERNALS__.invoke('native_surface_owner',{action:'grant'}).then(()=> 'ESCAPED', e=>String(e))`)).toMatch(/not allowed|denied|required/);
    expect(await page(`window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url',{url:'https://example.com'}).then(()=> 'ESCAPED', e=>String(e))`)).toMatch(/not allowed|denied/);
    const geometry = await page<{ x: number; y: number }[]>(`['input','button'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})`);
    await control('grant');
    expect((await tool({ type: 'click', x: 10, y: 10 })).isError).toBe(true);
    async function observe() {
      const observed = await tool({ type: 'observe' });
      expect(observed.isError, JSON.stringify(observed)).not.toBe(true);
      const content = observed.content as { type: string; text?: string; data?: string }[];
      expect(Buffer.from(content.find(c => c.type === 'image')!.data!, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
      return { ...JSON.parse(content.find(c => c.type === 'text')!.text!).screenshot as { width: number; height: number }, image: content.find(c => c.type === 'image')!.data! };
    }
    const screenshot = await observe();
    const viewport = await page<{ width: number; height: number }>('({width:innerWidth,height:innerHeight})');
    const click = async (point: { x: number; y: number }) => {
      const result = await tool({ type: 'click', x: point.x * screenshot.width / viewport.width, y: point.y * screenshot.height / viewport.height });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    };
    await click({ x: viewport.width - 20, y: viewport.height - 20 });
    expect((await observe()).image === screenshot.image, 'The native cursor must not enter agent screenshots').toBe(true);
    // Theme-only changes repaint the native tag without taking away control.
    // Mixed CSS formats exercise the browser's color resolution at the bridge.
    await main.evaluate("document.documentElement.style.setProperty('--bg0','#fbf1c7');document.documentElement.style.setProperty('--fg','rgb(60, 56, 54)')");
    await expect.poll(async () => (await pointer())?.palette).toEqual({ background: [251,241,199], foreground: [60,56,54] });
    expect((await control<{ mode: string }>('state')).mode).toBe('agent');
    await main.evaluate("document.documentElement.style.setProperty('--bg0','rgb(24, 36, 48)');document.documentElement.style.setProperty('--fg','#abc')");
    await expect.poll(async () => (await pointer())?.palette).toEqual({ background: [24,36,48], foreground: [170,187,204] });
    await expect(action({ op: 'palette', palette: { background: [256,0,0], foreground: [1,2,3] } })).rejects.toThrow();
    await expect(action({ op: 'palette', palette: { background: [0,0,0], foreground: [1,2] } })).rejects.toThrow();
    expect((await observe()).image).toBe(screenshot.image);
    await click(geometry[0]);
    const cursor = await pointer();
    expect(cursor).toMatchObject({ label: 'Agent', phase: 'pressed' });
    expect(cursor!.x).toBeCloseTo(geometry[0].x, 1);
    expect(cursor!.y).toBeCloseTo(geometry[0].y, 1);
    expect((await tool({ type: 'type', text: 'Fez native browser works' })).isError).not.toBe(true);
    await click(geometry[1]);
    expect(await page("document.querySelector('output').textContent")).toBe('Fez native browser works');
    // Ownership can change while the visible pointer approaches its target.
    // The animation must not leave a queued click behind after takeover.
    await page("document.querySelector('output').textContent='Not clicked'; document.querySelector('input').value='Unexpected click'");
    const pendingClick = tool({ type: 'click', x: geometry[1].x * screenshot.width / viewport.width, y: geometry[1].y * screenshot.height / viewport.height });
    await expect.poll(async () => (await pointer())?.phase, { interval: 10 }).toBe('moving');
    await control('take');
    expect((await pendingClick).isError).toBe(true);
    await expect.poll(pointer).toBeNull();
    expect(await page("document.querySelector('output').textContent")).toBe('Not clicked');
    await control('grant');
    await observe();
    await click({ x: viewport.width - 20, y: viewport.height - 20 });
    expect((await pointer())?.palette).toEqual({ background: [24,36,48], foreground: [170,187,204] });
    // Same-URL replacement retains permission but invalidates old image coordinates.
    await browser.call('Page.reload');
    await expect.poll(() => page("document.querySelector('output')?.textContent")).toBe('Nothing saved yet');
    expect((await tool({ type: 'key', key: 'Tab' })).isError).toBe(true);
    expect((await control<{ mode: string }>('state')).mode).toBe('agent');
    await observe();
    // Takeover and regrant both invalidate the old frame, including queued input.
    await control('take');
    expect((await tool({ type: 'type', text: 'blocked' })).isError).toBe(true);
    await control('grant');
    expect((await tool({ type: 'type', text: 'still blocked' })).isError).toBe(true);
    await observe();
    // No MCP requests while hidden: restoring must not restore the old grant.
    const windowCommand = (command: string) => main.evaluate(`window.__TAURI__.core.invoke('plugin:window|${command}',{label:'main'})`);
    await windowCommand('minimize');
    await expect.poll(() => windowCommand('is_minimized')).toBe(true);
    await windowCommand('unminimize');
    await expect.poll(() => windowCommand('is_minimized')).toBe(false);
    await focusWindow();
    // The native child follows the DOM visibility update after the window restores.
    await expect.poll(async () => (await action<{ visible: boolean }>({ op: 'snapshot' })).visible).toBe(true);
    expect((await tool({ type: 'key', key: 'Tab' })).isError).toBe(true);
    expect((await tool({ type: 'observe' })).isError).toBe(true);
    await control('grant');
    await observe();
    const bounds = { x: 16, y: 88, width: 620, height: 390 };
    await action({ op: 'bounds', bounds, visible: true });
    expect((await tool({ type: 'key', key: 'Tab' })).isError).toBe(true);
    type Snapshot = { visible: boolean; parentMatches: boolean; bounds: { size: { Logical: { width: number; height: number } } } };
    const resized = await action<Snapshot>({ op: 'snapshot' });
    expect(resized.parentMatches).toBe(true);
    expect(resized.bounds.size.Logical).toEqual({ width: 620, height: 352 });
    await action({ op: 'bounds', bounds, visible: false });
    expect((await action<Snapshot>({ op: 'snapshot' })).visible).toBe(false);
    await expect(control('grant')).rejects.toThrow('browser is not visible');
    await action({ op: 'bounds', bounds, visible: true });
    expect((await action<Snapshot>({ op: 'snapshot' })).visible).toBe(true);
    // Real shared queue: Drift requests first, but the message names Quill first.
    // Context completion (including a failed turn) releases the native lease.
    await action({ op: 'navigate', url });
    await expect.poll(() => page("document.querySelector('output')?.textContent")).toBe('Nothing saved yet');
    const message = 'e'.repeat(64);
    const order = ['quill', 'drift'];
    const queuedAgent = async (name: string) => {
      const context = new ToolContext(profile, name, ['browser-use']);
      const server = createBrowserUseServer({ sessionFile: `${profile}/${name}.json` });
      const client = new Client({ name, version: '1' });
      agents.push({ context, server, client });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
      let finish!: () => void;
      const running = context.run({ id: message, order }, () => new Promise<void>(resolve => { finish = resolve; }));
      const call = (args: Record<string, unknown>) => client.callTool({ name: 'browser_use', arguments: args });
      await expect.poll(async () => { try { await stat(`${profile}/${name}.json`); return true; } catch { return false; } }).toBe(true);
      return { context, call, finish: async () => { finish(); await running; } };
    };
    await mkdir(`${profile}/.fez/personas`, { recursive: true });
    await writeFile(`${profile}/.fez/personas/quill.md`, '---\nmcpServers: [browser-use]\n---\n');
    const drift = await queuedAgent('drift');
    await control('resume');
    let driftObserved = false;
    const laterObservation = drift.call({ type: 'observe' }).then(result => { driftObserved = true; return result; });
    void laterObservation.catch(() => {});
    await expect.poll(() => control('state')).toMatchObject({ mode: 'human', waiting: ['quill', 'drift'], paused: false });
    const quill = await queuedAgent('quill');
    const quillFrame = await quill.call({ type: 'observe' });
    expect(quillFrame.isError).not.toBe(true);
    await expect.poll(() => control('state')).toMatchObject({ agentName: 'quill', waiting: ['drift'] });
    const frameContent = quillFrame.content as { type: string; text?: string; data?: string }[];
    const frameSize = JSON.parse(frameContent.find(item => item.type === 'text')!.text!).screenshot;
    const queueViewport = await page<{ width: number; height: number }>('({width:innerWidth,height:innerHeight})');
    const queueGeometry = await page<{ x: number; y: number }[]>(`['input','button'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.right-10,y:r.y+r.height/2}})`);
    const queueClick = async (agent: typeof quill, point: { x: number; y: number }) => {
      const result = await agent.call({ type: 'click', x: point.x * frameSize.width / queueViewport.width, y: point.y * frameSize.height / queueViewport.height });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result;
    };
    expect((await queueClick(quill, queueGeometry[0])).isError).not.toBe(true);
    expect((await pointer())?.label).toBe('@quill');
    expect((await quill.call({ type: 'type', text: 'Quill' })).isError).not.toBe(true);
    expect((await queueClick(quill, queueGeometry[1])).isError).not.toBe(true);
    expect(await page("document.querySelector('output').textContent")).toBe('Quill');
    await control('take');
    await quill.finish();
    await delay(650);
    expect(driftObserved).toBe(false);
    expect(await control('state')).toMatchObject({ mode: 'human', paused: true, waiting: ['drift'] });
    expect((await quill.call({ type: 'type', text: 'forbidden' })).isError).toBe(true);
    await control('resume');
    const driftFrame = await laterObservation;
    expect(driftFrame.isError).not.toBe(true);
    expect((driftFrame.content as { type: string; data?: string }[]).find(c => c.type === 'image')!.data).not.toBe(frameContent.find(c => c.type === 'image')!.data);
    expect((await queueClick(drift, queueGeometry[0])).isError).not.toBe(true);
    expect((await pointer())?.label).toBe('@drift');
    expect((await drift.call({ type: 'type', text: ' + Drift' })).isError).not.toBe(true);
    expect((await queueClick(drift, queueGeometry[1])).isError).not.toBe(true);
    expect(await page("document.querySelector('output').textContent")).toBe('Quill + Drift');
    await drift.finish();
    await expect.poll(() => control('state')).toMatchObject({ mode: 'human', waiting: [] });
    // Two visible browsers run independent drivers even when their original
    // message addresses both agents. Each persona chooses its target once.
    expect(await main.evaluate("!!document.querySelector('[data-new-browser]')")).toBe(true);
    await main.evaluate("document.querySelector('[data-new-browser]').click()");
    let secondId = '';
    await expect.poll(async () => {
      const ids = await main.evaluate<string[]>("[...document.querySelectorAll('[data-surface-id]')].map(e=>e.dataset.surfaceId).filter(Boolean)");
      secondId = ids.find(id => id !== firstId) ?? '';
      return ids.length;
    }).toBe(2);
    const owner2 = await connect(t => t.url === 'http://tauri.localhost/owner.html' && t.webSocketDebuggerUrl !== owner.target.webSocketDebuggerUrl);
    const control2 = <T>(action: string) => owner2.evaluate<T>(`window.__TAURI__.core.invoke('native_surface_owner',{action:${JSON.stringify(action)}})`);
    await action({ op: 'navigate', url });
    await action({ op: 'navigate', url: `${url}?second` }, secondId);
    const browser2 = await connect(t => t.url === `${url}?second`);
    await expect.poll(() => browser2.evaluate('document.title')).toBe('Fez browser fixture');
    const begin = (agent: typeof quill, id: string, participants = order) => {
      let finish!: () => void;
      const running = agent.context.run({ id, order: participants }, () => new Promise<void>(resolve => { finish = resolve; }));
      return async () => { finish(); await running; };
    };
    const finishQuill = begin(quill, 'f'.repeat(64));
    const finishDrift = begin(drift, 'f'.repeat(64));
    await control('resume'); await control2('resume');
    const parallelFrames = await Promise.all([
      quill.call({ type: 'observe', target: firstId }),
      drift.call({ type: 'observe', target: secondId }),
    ]);
    for (const frame of parallelFrames) expect(frame.isError, JSON.stringify(frame)).not.toBe(true);
    expect(await control('state')).toMatchObject({ agentName: 'quill', waiting: [] });
    expect(await control2('state')).toMatchObject({ agentName: 'drift', waiting: [] });
    const clickIn = async (agent: typeof quill, view: typeof browser, frame: typeof quillFrame, selector: string) => {
      const content = frame.content as { type: string; text?: string }[];
      const size = JSON.parse(content.find(item => item.type === 'text')!.text!).screenshot;
      const point = await view.evaluate<{ x: number; y: number; w: number; h: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+10,y:r.top+r.height/2,w:innerWidth,h:innerHeight}})()`);
      return agent.call({ type: 'click', x: point.x * size.width / point.w, y: point.y * size.height / point.h });
    };
    const parallelClicks = await Promise.all([
      clickIn(quill, browser, parallelFrames[0], 'input'),
      clickIn(drift, browser2, parallelFrames[1], 'input'),
    ]);
    for (const clicked of parallelClicks) expect(clicked.isError).not.toBe(true);
    expect((await pointer())?.label).toBe('@quill');
    expect((await action<{ pointer: { label: string } }>({ op: 'snapshot' }, secondId)).pointer.label).toBe('@drift');
    expect((await quill.call({ type: 'type', text: 'Parallel Quill' })).isError).not.toBe(true);
    expect((await drift.call({ type: 'type', text: 'Parallel Drift' })).isError).not.toBe(true);
    await clickIn(quill, browser, parallelFrames[0], 'button');
    await clickIn(drift, browser2, parallelFrames[1], 'button');
    expect(await page("document.querySelector('output').textContent")).toBe('Parallel Quill');
    expect(await browser2.evaluate("document.querySelector('output').textContent")).toBe('Parallel Drift');
    await control2('take');
    expect(await control('state')).toMatchObject({ agentName: 'quill' });
    expect((await drift.call({ type: 'type', text: 'blocked' })).isError).toBe(true);
    await finishDrift();
    const cancelMessage = 'c'.repeat(64);
    const finishCancelled = begin(drift, cancelMessage, ['drift']);
    const cancelled = drift.call({ type: 'observe', target: firstId });
    void cancelled.catch(() => {});
    await expect.poll(() => control('state')).toMatchObject({ agentName: 'quill', waiting: ['drift'] });
    await owner.evaluate(`window.__TAURI__.core.invoke('native_surface_owner',{action:'cancel',request:${JSON.stringify(cancelMessage)},persona:'drift'})`);
    expect((await cancelled).isError).toBe(true);
    expect((await drift.call({ type: 'observe', target: firstId })).isError).toBe(true);
    expect(await control('state')).toMatchObject({ agentName: 'quill', waiting: [] });
    await finishCancelled(); await finishQuill();
    await expect.poll(() => control('state')).toMatchObject({ mode: 'human', waiting: [] });
    // A rejected first choice must not bind the turn or cancel its place elsewhere.
    const retryMessage = 'd'.repeat(64);
    const finishRetryQuill = begin(quill, retryMessage);
    const finishRetryDrift = begin(drift, retryMessage);
    expect((await quill.call({ type: 'observe', target: firstId })).isError).not.toBe(true);
    await expect.poll(() => control('state')).toMatchObject({ agentName: 'quill', waiting: ['drift'] });
    await owner.evaluate(`window.__TAURI__.core.invoke('native_surface_owner',{action:'cancel',request:${JSON.stringify(retryMessage)},persona:'drift'})`);
    expect((await drift.call({ type: 'observe', target: firstId })).isError).toBe(true);
    await control2('resume');
    const retried = await drift.call({ type: 'observe', target: secondId });
    expect(retried.isError, JSON.stringify(retried)).not.toBe(true);
    expect(await control2('state')).toMatchObject({ agentName: 'drift' });
    await control2('stop').catch(() => {});
    expect(await control('state')).toMatchObject({ agentName: 'quill' });
    expect((await quill.call({ type: 'key', key: 'Tab' })).isError).not.toBe(true);
    await finishRetryDrift(); await finishRetryQuill();
    await expect.poll(() => control('state')).toMatchObject({ mode: 'human', waiting: [] });
    // The bundled owner HTML is still powerless when loaded in the browser child.
    await action({ op: 'navigate', url: 'http://tauri.localhost/owner.html' });
    await expect.poll(() => page('document.title')).toBe('Fez · Browser control');
    expect(await page(`window.__TAURI_INTERNALS__.invoke('native_surface_owner',{action:'grant'}).then(()=> 'ESCAPED', e=>String(e))`)).toBe('owner control required');
    expect(await page(`window.__TAURI_INTERNALS__.invoke('native_surface_action',{id:${JSON.stringify(firstId)},action:{op:'close'}}).then(()=> 'ESCAPED', e=>String(e))`)).toBe('native command denied for this webview');
    await expect(action({ op: 'navigate', url: 'file:///etc/passwd' })).rejects.toThrow();
    await control('stop').catch(() => {});
    await expect.poll(async () => (await targets()).filter(t => t.type === 'page').length).toBe(1);
    await expect(readFile(`${profile}/session.json`, 'utf8')).rejects.toThrow();
    expect((await tool({ type: 'observe' })).isError).toBe(true);
    expect(child.exitCode).toBeNull();
    await main.evaluate("document.querySelector('#open').click()");
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(`${profile}/session.json`, 'utf8')).id; } catch { return firstId; }
    }).not.toBe(firstId);
    await expect(action({ op: 'close' })).rejects.toThrow('browser is closed');
    // Reloading the extension owner closes the old views and rotates the session.
    const beforeReload = JSON.parse(await readFile(`${profile}/session.json`, 'utf8')).id;
    await main.call('Page.reload');
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(`${profile}/session.json`, 'utf8')).id; } catch { return beforeReload; }
    }, { timeout: 10000 }).not.toBe(beforeReload);
    await expect.poll(async () => (await targets()).filter(t => t.type === 'page').length).toBe(3);
    expect((await tool({ type: 'type', text: 'old session' })).isError).toBe(true);
    await main.evaluate("document.querySelector('#close').click()");
    await expect.poll(async () => (await targets()).filter(t => t.type === 'page').length).toBe(1);
    expect(await main.evaluate('!!window.__TAURI__?.core')).toBe(true);
    await main.evaluate("document.querySelector('#open').click()");
    await expect.poll(async () => { try { await readFile(`${profile}/session.json`); return true; } catch { return false; } }).toBe(true);
    const initialUrl = `${url}?initial`;
    const openAt = <T>(initialUrl: string) => main.evaluate<T>(`window.__TAURI__.core.invoke('native_surface_open',{bounds:{x:20,y:180,width:600,height:400},initialUrl:${JSON.stringify(initialUrl)}})`);
    await expect(openAt('file:///etc/passwd')).rejects.toThrow();
    await expect(openAt('https://user:password@example.com/')).rejects.toThrow();
    const initial = await openAt<{ id: string }>(initialUrl);
    const initialPage = await connect(t => t.url === initialUrl);
    await expect.poll(() => initialPage.evaluate('document.title')).toBe('Fez browser fixture');
    // CEF's delayed initial-load recovery must use the requested URL too.
    await delay(1200);
    const initialHistory = await initialPage.call<{ entries: { url: string }[] }>('Page.getNavigationHistory');
    expect(initialHistory.entries.map(entry => entry.url).filter(entry => /^https?:/.test(entry))).toEqual([initialUrl]);
    await main.evaluate(`window.__TAURI__.core.invoke('native_surface_action',{id:${JSON.stringify(initial.id)},action:{op:'close'}})`);
    await windowCommand('close').catch(() => {});
    await expect.poll(async () => { try { await stat(`${profile}/session.json`); return false; } catch { return true; } }).toBe(true);
    expect((await tool({ type: 'observe' })).isError).toBe(true);
    // Closing with a live native monitor must release CEF's NSView and let
    // BrowserClosed drain; checking only the removed descriptor misses a hang.
    await expect.poll(() => child.exitCode, { timeout: 10000 }).toBe(0);
  } catch (error) {
    throw new Error(`${error}\n${logs}\n${await readFile(`${profile}/cef.log`, 'utf8').catch(() => '')}`, { cause: error });
  } finally {
    for (const agent of agents) { agent.context.close(); await agent.client.close(); await agent.server.close(); }
    for (const socket of sockets) socket.close();
    await client.close(); await server.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true, () => true), delay(2000).then(() => false)]);
      if (!stopped) {
        child.kill('SIGKILL');
        await Promise.race([exited.catch(() => {}), delay(2000)]);
      }
    }
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
}, 75000);
