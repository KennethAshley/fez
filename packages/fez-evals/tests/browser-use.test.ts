import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createUnixServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBrowserUseServer } from '../../fez-browser-use/src/index.js';

let dir: string, sessionFile: string, endpoint: string;
let http: Server, client: Client, close: () => Promise<void>;
let behavior: 'ok' | 'revoked' | 'redirect' | 'malformed' | 'waiting';
let requests: Record<string, unknown>[];
let native: ReturnType<typeof createUnixServer> | undefined;
let nativeRequests: { id: string; token: string; action: Record<string, unknown> }[];
let nativeReplies: Map<string, object | string>;
const agentToken = 'a'.repeat(48);
// Minimal SOF header for the boundary's 1000 × 500 screenshot; real CEF test uses a full JPEG.
const jpeg = Buffer.from([255, 216, 255, 192, 0, 17, 8, 1, 244, 3, 232, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]).toString('base64');

async function descriptor(overrides: Record<string, unknown> = {}) {
  await writeFile(sessionFile, JSON.stringify({ version: 1, id: 'test-browser', kind: 'browser', label: 'Test browser', endpoint, agentToken, ...overrides }), { mode: 0o600 });
}

async function catalog(targets: object[]) {
  await writeFile(sessionFile, JSON.stringify({ version: 2, targets }), { mode: 0o600 });
}

async function nativeCatalog() {
  const socketPath = join(dir, 'control.sock');
  const targets = ['first', 'second'].map((id, index) => ({ version: 1, id, kind: 'browser', label: `Browser ${index + 1}`,
    endpoint: `unix://${socketPath}`, agentToken: (index ? 'b' : 'a').repeat(48) }));
  native = createUnixServer(socket => {
    let body = '';
    socket.on('data', bytes => {
      body += bytes;
      if (!body.endsWith('\n')) return;
      const request = JSON.parse(body);
      nativeRequests.push(request);
      const response = nativeReplies.get(request.id) ?? { mode: 'agent', epoch: 7, ...(request.action.type === 'observe' ? {
        data: jpeg, viewport: request.id === 'first' ? { clientWidth: 2000, clientHeight: 1000 } : { clientWidth: 1000, clientHeight: 500 },
      } : {}) };
      socket.end((typeof response === 'string' ? response : JSON.stringify(response)) + '\n');
    });
  });
  native.listen(socketPath);
  await once(native, 'listening');
  await catalog(targets);
  return targets;
}

beforeEach(async () => {
  requests = [];
  nativeRequests = [];
  nativeReplies = new Map();
  behavior = 'ok';
  dir = await mkdtemp(join(tmpdir(), 'fez-browser-use-eval-'));
  sessionFile = join(dir, 'agent-session.json');
  http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${agentToken}`) { res.writeHead(403).end('{}'); return; }
    let body = '';
    for await (const bytes of req) body += bytes;
    requests.push(JSON.parse(body));
    if (behavior === 'redirect') { res.writeHead(307, { Location: `${endpoint}/redirected` }).end(); return; }
    if (behavior === 'revoked') { res.writeHead(403).end('{"error":"Control belongs to human"}'); return; }
    if (behavior === 'malformed') { res.end('{"mode":"agent","data":"invalid"}'); return; }
    if (behavior === 'waiting') { res.end('{"mode":"waiting","paused":true,"driver":null,"waiting":["drift"]}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ mode: 'agent', epoch: 7, ...(JSON.parse(body).type === 'observe' ? {
      data: jpeg, viewport: { clientWidth: 2000, clientHeight: 1000 },
    } : {}) }));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  endpoint = `http://127.0.0.1:${address.port}`;
  await descriptor();
  const instance = createBrowserUseServer({ sessionFile });
  close = () => instance.close();
  client = new Client({ name: 'computer-use-eval', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverTransport);
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client?.close();
  await close?.();
  if (native) await new Promise<void>(resolve => native!.close(() => resolve()));
  native = undefined;
  http?.closeAllConnections();
  if (http) await new Promise<void>(resolve => http.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const tool = (action: Record<string, unknown>) => client.callTool({ name: 'browser_use', arguments: action });

it('lists only granted target names and requires selection before observing a catalog', async () => {
  await nativeCatalog();
  expect(await tool({ type: 'list' })).toMatchObject({ content: [{ type: 'text', text: JSON.stringify({ targets: [
    { id: 'first', kind: 'browser', label: 'Browser 1' }, { id: 'second', kind: 'browser', label: 'Browser 2' },
  ] }) }] });
  expect((await tool({ type: 'observe' })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(0);
  await catalog([]);
  expect(await tool({ type: 'list' })).toMatchObject({ content: [{ type: 'text', text: '{"targets":[]}' }] });
});

it('routes catalog actions by exact target and scales only from that target observation', async () => {
  await nativeCatalog();
  expect((await tool({ type: 'observe', target: 'first' })).isError).not.toBe(true);
  expect((await tool({ type: 'click', target: 'first', x: 250, y: 100 })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)).toEqual({ id: 'first', token: agentToken, action: { type: 'click', x: 500, y: 200, epoch: 7 } });
  expect((await tool({ type: 'observe', target: 'Browser 2' })).isError).not.toBe(true);
  expect((await tool({ type: 'click', x: 250, y: 100 })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)).toEqual({ id: 'second', token: 'b'.repeat(48), action: { type: 'click', x: 250, y: 100, epoch: 7 } });
  expect((await tool({ type: 'type', text: 'hello' })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)?.action).toEqual({ type: 'type', text: 'hello', epoch: 7 });
  expect((await tool({ type: 'observe' })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)?.id).toBe('second');
});

it('blocks mismatched input until the requested target has been observed', async () => {
  await nativeCatalog();
  expect((await tool({ type: 'observe', target: 'first' })).isError).not.toBe(true);
  expect((await tool({ type: 'type', target: 'second', text: 'wrong browser' })).isError).toBe(true);
  expect((await tool({ type: 'click', target: 'second', x: 1, y: 1 })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(1);
  expect((await tool({ type: 'observe', target: 'second' })).isError).not.toBe(true);
  expect((await tool({ type: 'type', target: 'second', text: 'right browser' })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)).toMatchObject({ id: 'second', action: { type: 'type', text: 'right browser' } });
});

it('preserves an observed frame when another catalog target changes or closes', async () => {
  const targets = await nativeCatalog();
  expect((await tool({ type: 'observe', target: 'first' })).isError).not.toBe(true);
  await catalog([targets[0], { ...targets[1], agentToken: 'c'.repeat(48) }]);
  expect((await tool({ type: 'list' })).isError).not.toBe(true);
  expect((await tool({ type: 'click', x: 20, y: 10 })).isError).not.toBe(true);
  await catalog([targets[0]]);
  expect((await tool({ type: 'type', text: 'still first' })).isError).not.toBe(true);
  expect(nativeRequests.map(request => request.id)).toEqual(['first', 'first', 'first']);
});

it('never falls back after the selected catalog target closes or is replaced', async () => {
  const targets = await nativeCatalog();
  expect((await tool({ type: 'observe', target: 'first' })).isError).not.toBe(true);
  await catalog([targets[1]]);
  expect((await tool({ type: 'click', x: 1, y: 1 })).isError).toBe(true);
  expect((await tool({ type: 'observe' })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(1);
  expect((await tool({ type: 'observe', target: 'second' })).isError).not.toBe(true);
  await catalog([{ ...targets[1], agentToken: 'c'.repeat(48) }]);
  expect((await tool({ type: 'observe' })).isError).toBe(true);
  expect((await tool({ type: 'type', target: 'second', text: 'stale' })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(2);
  expect((await tool({ type: 'observe', target: 'second' })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)?.token).toBe('c'.repeat(48));
});

it('defaults to the only catalog target before the first observation', async () => {
  const targets = await nativeCatalog();
  await catalog([targets[1]]);
  expect((await tool({ type: 'observe' })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)?.id).toBe('second');
});

it('rejects unknown action fields without sending them to the host', async () => {
  await nativeCatalog();
  expect((await tool({ type: 'observe', target: 'first', endpoint: 'unix:///private/tmp/other.sock' })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(0);
});

it('requires an exact ID when browser labels are ambiguous', async () => {
  const targets = await nativeCatalog();
  await catalog(targets.map(target => ({ ...target, label: 'Browser' })));
  expect((await tool({ type: 'observe', target: 'Browser' })).isError).toBe(true);
  expect((await tool({ type: 'observe', target: 'missing' })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(0);
  expect((await tool({ type: 'observe', target: 'first' })).isError).not.toBe(true);
});

it('clears the selected frame after a stale input epoch', async () => {
  await nativeCatalog();
  expect((await tool({ type: 'observe', target: 'second' })).isError).not.toBe(true);
  nativeReplies.set('second', { mode: 'agent', epoch: 8 });
  expect((await tool({ type: 'key', key: 'Enter' })).isError).toBe(true);
  nativeReplies.delete('second');
  expect((await tool({ type: 'click', x: 1, y: 1 })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(2);
  expect((await tool({ type: 'observe' })).isError).not.toBe(true);
  expect(nativeRequests.at(-1)?.id).toBe('second');
});

it('retains the queued target through unrelated changes and stops when it closes', async () => {
  const targets = await nativeCatalog();
  nativeReplies.set('first', { mode: 'waiting', paused: false, driver: 'other', waiting: ['agent'] });
  const pending = tool({ type: 'observe', target: 'first' });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(nativeRequests).toHaveLength(1);
  await catalog([targets[0]]);
  nativeReplies.delete('first');
  expect((await pending).isError).not.toBe(true);
  expect(nativeRequests.map(request => request.id)).toEqual(['first', 'first']);
  nativeReplies.set('first', { mode: 'waiting', paused: false, driver: 'other', waiting: ['agent'] });
  const closed = tool({ type: 'observe' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await catalog([targets[1]]);
  expect((await closed).isError).toBe(true);
  expect(nativeRequests.map(request => request.id)).toEqual(['first', 'first', 'first']);
});

it('cancels a queued catalog observation without polling or switching targets', async () => {
  await nativeCatalog();
  nativeReplies.set('second', { mode: 'waiting', paused: true, driver: null, waiting: ['agent'] });
  const controller = new AbortController();
  const pending = client.callTool({ name: 'browser_use', arguments: { type: 'observe', target: 'second' } }, undefined, { signal: controller.signal });
  void pending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(nativeRequests).toHaveLength(1);
  controller.abort(new Error('owner cancelled the turn'));
  await expect(pending).rejects.toThrow('owner cancelled');
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(nativeRequests.map(request => request.id)).toEqual(['second']);
});

it('rejects duplicate IDs, unknown catalog fields, excessive targets and escaped sockets', async () => {
  const targets = await nativeCatalog();
  for (const invalid of [
    { version: 2, targets: [targets[0], targets[0]] },
    { version: 2, targets, ownerToken: agentToken },
    { version: 2, targets: Array.from({ length: 5 }, (_, n) => ({ ...targets[0], id: String(n) })) },
    { version: 2, targets: [{ ...targets[0], endpoint }] },
    { version: 2, targets: [{ ...targets[0], endpoint: 'unix:///private/tmp/other/control.sock' }] },
    { version: 2, targets: [{ ...targets[0], ownerToken: agentToken }] },
  ]) {
    await writeFile(sessionFile, JSON.stringify(invalid));
    expect((await tool({ type: 'list' })).isError).toBe(true);
  }
  await writeFile(sessionFile, ' '.repeat(8193));
  expect((await tool({ type: 'list' })).isError).toBe(true);
  expect(nativeRequests).toHaveLength(0);
});

it('does not expose capabilities in native errors or malformed descriptors', async () => {
  await nativeCatalog();
  nativeReplies.set('first', { error: `Rejected token ${agentToken}` });
  let result = await tool({ type: 'observe', target: 'first' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(agentToken);
  nativeReplies.set('first', `token=${agentToken}`);
  result = await tool({ type: 'observe', target: 'first' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(agentToken.slice(0, 5));
  await writeFile(sessionFile, `{"agentToken":${agentToken}`);
  result = await tool({ type: 'list' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain(agentToken);
});

it('waits through owner pause and only returns a fresh observation after the handoff', async () => {
  behavior = 'waiting';
  const pending = tool({ type: 'observe' });
  let settled = false;
  void pending.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(settled).toBe(false);
  expect(requests.map(request => request.type)).toEqual(['observe']);
  behavior = 'ok';
  expect((await pending).isError).not.toBe(true);
  await tool({ type: 'click', x: 20, y: 30 });
  expect(requests.at(-1)).toMatchObject({ type: 'click', epoch: 7, x: 40, y: 60 });
});

it('stops polling a queued observation when its MCP request is cancelled', async () => {
  behavior = 'waiting';
  const controller = new AbortController();
  const pending = client.callTool({ name: 'browser_use', arguments: { type: 'observe' } }, undefined, { signal: controller.signal });
  void pending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(requests).toHaveLength(1);
  controller.abort(new Error('owner cancelled the turn'));
  await expect(pending).rejects.toThrow('owner cancelled');
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(requests).toHaveLength(1);
});

it('uses a private native socket beside the descriptor and clears a revoked observation', async () => {
  const path = join(dir, 'control.sock');
  let granted = true;
  const received: Record<string, unknown>[] = [];
  const native = createUnixServer(socket => {
    let body = '';
    socket.on('data', bytes => {
      body += bytes;
      if (!body.endsWith('\n')) return;
      const request = JSON.parse(body);
      expect(request.token).toBe(agentToken);
      received.push(request.action);
      socket.end(JSON.stringify(granted ? { mode: 'agent', epoch: 7, ...(request.action.type === 'observe' ? {
        data: jpeg, viewport: { clientWidth: 2000, clientHeight: 1000 },
      } : {}) } : { error: 'Owner took control', mode: 'human', epoch: 8 }) + '\n');
    });
  });
  native.listen(path);
  await once(native, 'listening');
  try {
    await descriptor({ endpoint: `unix://${path}` });
    expect((await tool({ type: 'observe' })).isError).not.toBe(true);
    expect((await tool({ type: 'click', x: 100, y: 50 })).isError).not.toBe(true);
    expect(received.at(-1)).toEqual({ type: 'click', x: 200, y: 100, epoch: 7 });
    granted = false;
    expect((await tool({ type: 'type', text: 'blocked' })).isError).toBe(true);
    const count = received.length;
    expect((await tool({ type: 'type', text: 'still blocked' })).isError).toBe(true);
    expect(received).toHaveLength(count);
    await descriptor({ endpoint: 'unix:///private/tmp/unrelated.sock' });
    expect((await tool({ type: 'observe' })).isError).toBe(true);
    expect(received).toHaveLength(count);
  } finally { await new Promise<void>(resolve => native.close(() => resolve())); }
});

it('uses the granted surface and maps observed pixels to its input coordinates', async () => {
  expect((await tool({ type: 'click', x: 250, y: 100 })).isError).toBe(true);
  expect(requests).toHaveLength(0);
  const observed = await tool({ type: 'observe' });
  expect(observed.isError).not.toBe(true);
  expect(observed.content).toContainEqual({ type: 'image', mimeType: 'image/jpeg', data: jpeg });
  await tool({ type: 'click', x: 250, y: 100 });
  expect(requests.at(-1)).toMatchObject({ type: 'click', x: 500, y: 200, epoch: 7 });
  await tool({ type: 'scroll', x: 300, y: 200, deltaY: 120 });
  expect(requests.at(-1)).toMatchObject({ type: 'wheel', x: 600, y: 400, deltaX: 0, deltaY: 120, epoch: 7 });
  expect((await tool({ type: 'click', x: 1000, y: 1 })).isError).toBe(true);
  expect((await tool({ type: 'mode', value: 'agent' })).isError).toBe(true);
});

it('clears the observation after revocation and after switching to a different surface', async () => {
  await tool({ type: 'observe' });
  behavior = 'revoked';
  expect((await tool({ type: 'type', text: 'denied' })).isError).toBe(true);
  behavior = 'ok';
  const before = requests.length;
  expect((await tool({ type: 'click', x: 1, y: 1 })).isError).toBe(true);
  expect(requests).toHaveLength(before);
  await tool({ type: 'observe' });
  await descriptor({ id: 'different-browser' });
  expect((await tool({ type: 'type', text: 'wrong target' })).isError).toBe(true);
  expect(requests).toHaveLength(before + 1);
  expect((await tool({ type: 'observe' })).isError).not.toBe(true);
});

it('lists tools without a browser but fails actions until a target is explicitly connected', async () => {
  await rm(sessionFile);
  expect((await client.listTools()).tools.map(t => t.name)).toEqual(['browser_use']);
  const result = await tool({ type: 'observe' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain('Connect a surface');
  expect(requests).toHaveLength(0);
});

it.each([
  { endpoint: 'https://example.com' },
  { endpoint: 'http://localhost.evil.invalid:1234' },
  { endpoint: 'http://127.0.0.1:1234/other' },
  { endpoint: 'http://user:secret@127.0.0.1:1234' },
  { uiToken: 'owner-must-not-be-exposed' },
  { agentToken: '' },
  { version: 2 },
])('rejects an invalid or overprivileged descriptor %j', async overrides => {
  await descriptor(overrides);
  expect((await tool({ type: 'observe' })).isError).toBe(true);
  expect(requests).toHaveLength(0);
});

it.each(['redirect', 'malformed'] as const)('fails closed on %s responses', async value => {
  await tool({ type: 'observe' });
  behavior = value;
  expect((await tool({ type: 'observe' })).isError).toBe(true);
  behavior = 'ok';
  const before = requests.length;
  expect((await tool({ type: 'click', x: 1, y: 1 })).isError).toBe(true);
  expect(requests).toHaveLength(before);
});
