import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import oro, { createOroSubmission } from '../../fez-oro/src/miner.js';
import { checkSource, source } from '../../fez-oro/src/source.js';

const crypto = createRequire(resolve(__dirname, '../../fez-oro/package.json'))('@polkadot/util-crypto');
const phrase = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
const agentId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const oldId = '33333333-3333-4333-8333-333333333333';
const now = Date.parse('2026-09-10T12:00:00Z');
const dirs: string[] = [];
it('declares every local evaluator setting and keeps runtime keys private and optional', () => {
  const fields = oro[0].config;
  expect(fields.map(field => field.key).sort()).toEqual([
    'name', 'evaluation_checkout', 'evaluation_commit', 'evaluation_pack',
    'evaluation_validator_image', 'evaluation_sandbox_image', 'evaluation_proxy_image', 'evaluation_search_image',
    'evaluation_provider', 'evaluation_model', 'openrouter_api_key', 'chutes_api_key',
  ].sort());
  expect(fields.filter(field => field.type === 'secret').map(field => field.key).sort()).toEqual(['chutes_api_key', 'openrouter_api_key']);
  expect(fields.every(field => !field.required)).toBe(true);
  expect(fields.find(field => field.key === 'evaluation_provider')?.options).toEqual(['openrouter', 'chutes']);
});
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  await crypto.cryptoWaitReady();
  const pair = crypto.sr25519PairFromSeed(crypto.mnemonicToMiniSecret(phrase));
  const hotkey: string = crypto.encodeAddress(pair.publicKey, 42);
  const dir = await mkdtemp(join(tmpdir(), 'oro-test-')); dirs.push(dir);
  const file = join(dir, 'agent.py');
  await writeFile(file, 'def agent_main(problem_data):\n    return None\n');
  const ctx = { persona: 'coder', hotkey, workDir: dir, walletBin: '/fake/fez-wallet', config: { name: 'Fez coder', openrouter_api_key: 'LOCAL-RUNTIME-SECRET' } };
  const state = {
    network: 'finney', endpoint: 'wss://entrypoint-finney.opentensor.ai:443', caps: true, created: false,
    walletHotkey: hotkey, canSubmit: true, connected: true, throwUpload: false, oversized: false, readbackFailure: false,
    admission: 'ACCEPTED', versions: [] as Array<{ agent_version_id: string; version_number: number; submitted_at: string; state: string }>,
    racing: null as string | null, owner: hotkey,
  };
  const exec = vi.fn(async (_bin: string, args: string[]) => {
    if (args[0] === 'network') return { code: 0, stdout: `network: ${state.network}\nendpoint: ${state.endpoint}\n` };
    if (args[0] === 'capabilities') return { code: 0, stdout: JSON.stringify({ existingHotkey: state.caps }) };
    expect(args).toEqual(['export-hotkey', 'coder', '--existing', '--json']);
    return { code: 0, stdout: JSON.stringify({ persona: 'coder', created: state.created, ss58Address: state.walletHotkey, keyfile: { secretPhrase: phrase, ss58Address: state.walletHotkey } }) };
  });
  const run = vi.fn(async (args: string[], bytes?: Buffer) => {
    if (args[0] === 'rm') return '';
    expect(args).toEqual(expect.arrayContaining(['--network=none', '--read-only', '--pull=never']));
    return execFileSync('python3', ['-I', '-B', '-c', args.at(-1)!], { input: bytes, encoding: 'utf8', stdio: 'pipe' });
  });
  const nonces = new Set<string>();
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); expect(url.startsWith('https://api.oroagents.com/')).toBe(true);
    expect(init?.redirect).toBe('error'); expect(init?.signal).toBeDefined();
    if (url.includes('/v1/miner/')) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Hotkey')).toBe(hotkey);
      const nonce = headers.get('X-Nonce')!; expect(nonces.has(nonce)).toBe(false); nonces.add(nonce);
      const message = `${hotkey}:${Math.floor(now / 1000)}:${nonce}`;
      expect(crypto.signatureVerify(message, headers.get('X-Signature'), hotkey).isValid).toBe(true);
    }
    if (state.oversized) return new Response('x'.repeat(1024 * 1024 + 1));
    if (url.endsWith('/v1/miner/agents')) return Response.json({ agents: state.versions.length ? [{ agent_id: agentId, miner_hotkey: state.owner, agent_name: ctx.config.name, created_at: '2026-09-01T00:00:00Z' }] : [], can_submit: state.canSubmit, next_allowed_at: state.canSubmit ? null : '2026-09-11T06:00:00Z', racing_agent_version_id: state.racing, racing_agent_id: state.racing ? agentId : null });
    if (url.endsWith(`/agents/${agentId}/versions`)) return Response.json(state.versions);
    if (url.includes('/agent-versions/')) {
      if (state.readbackFailure) throw Error('PRIVATE SERVER DETAIL');
      const id = url.split('/').at(-2)!;
      const row = state.versions.find(v => v.agent_version_id === id);
      return Response.json({ ...(row ?? { agent_version_id: versionId, version_number: 1, submitted_at: new Date(now).toISOString(), state: 'QUEUED' }), agent_name: ctx.config.name, miner_hotkey: state.owner, is_active_qualifier: state.racing === id, final_score: null });
    }
    if (url.endsWith('/inference-auth')) return Response.json({ providers: [{ provider: 'openrouter', connected: state.connected }], default_provider: 'openrouter' });
    expect(url).toBe('https://api.oroagents.com/v1/miner/submit');
    expect(init?.method).toBe('POST');
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['agent_name', 'file']);
    expect(form.get('agent_name')).toBe('Fez coder');
    expect(await (form.get('file') as Blob).text()).toBe(await readFile(file, 'utf8'));
    if (state.throwUpload) throw Error('LOCAL-RUNTIME-SECRET');
    return Response.json({ admission_status: state.admission, hotkey: state.owner, agent_id: agentId, agent_version_id: versionId, next_allowed_at: '2026-09-11T06:00:00Z' });
  });
  return { ctx, file, state, exec, run, fetcher, adapter: createOroSubmission({ exec, run, fetch: fetcher, now: () => now }) };
}

it('declares mainnet SN15 and checks source without wallet, network, inference or execution', async () => {
  expect(oro[0]).toMatchObject({ netuid: 15, network: 'finney' });
  expect(oro[0].submission?.notice).toMatch(/inference|billed/);
  const f = await fixture();
  await writeFile(f.file, 'raise Exception("must not run")\ndef agent_main(problem_data):\n    return None\n');
  const receipt = await f.adapter.test(f.ctx, f.file);
  expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/); expect(receipt.prediction).toBeUndefined();
  expect(f.exec).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.run.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(['rm', '-f']);
});

it('signs current ORO auth and performs only GETs for status', async () => {
  const f = await fixture();
  expect(await f.adapter.status(f.ctx)).toMatchObject({ hotkey: f.ctx.hotkey, phase: 'not-submitted', versions: [] });
  expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
});

it('preserves old racing version while latest is queued, and rejects foreign ownership', async () => {
  const f = await fixture();
  f.state.versions = [
    { agent_version_id: versionId, version_number: 2, submitted_at: '2026-09-10T11:00:00Z', state: 'QUEUED' },
    { agent_version_id: oldId, version_number: 1, submitted_at: '2026-09-09T11:00:00Z', state: 'ELIGIBLE' },
  ]; f.state.racing = oldId;
  const status = await f.adapter.status(f.ctx);
  expect(status).toMatchObject({ phase: 'pending', activeVersionId: oldId });
  expect(status.versions.every(v => v.activatedAt === null)).toBe(true);
  f.state.versions[0].state = 'DISCARDED';
  expect(await f.adapter.status(f.ctx)).toMatchObject({ phase: 'failed', activeVersionId: oldId });
  f.state.owner = 'wrong-owner'; await expect(f.adapter.status(f.ctx)).rejects.toThrow(/response|owner/i);
});

it('requires mainnet, existing-key capability, and matching wallet identity before HTTP', async () => {
  const f = await fixture();
  f.state.network = 'test'; await expect(f.adapter.status(f.ctx)).rejects.toThrow(/finney|mainnet/i);
  expect(f.exec.mock.calls.some(([, args]) => args[0] === 'export-hotkey')).toBe(false);
  f.state.network = 'finney'; f.state.caps = false;
  await expect(f.adapter.status(f.ctx)).rejects.toThrow(/wallet|capabilit/i);
  expect(f.exec.mock.calls.some(([, args]) => args[0] === 'export-hotkey')).toBe(false);
  f.state.caps = true; f.state.created = true;
  await expect(f.adapter.status(f.ctx)).rejects.toThrow(/hotkey|wallet/i);
  f.state.created = false; f.state.walletHotkey = 'wrong';
  await expect(f.adapter.status(f.ctx)).rejects.toThrow(/hotkey|wallet/i);
  expect(f.fetcher).not.toHaveBeenCalled();
});

it('requires a matching source receipt before any upload and a connected inference provider', async () => {
  const f = await fixture();
  await expect(f.adapter.submit(f.ctx, f.file, 'a'.repeat(64))).rejects.toThrow(/receipt|test|Source/i);
  const receipt = await f.adapter.test(f.ctx, f.file);
  f.state.connected = false;
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/connect|provider/i);
  expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  await writeFile(f.file, 'changed');
  const count = f.fetcher.mock.calls.length;
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/Source|hash/i);
  expect(f.fetcher.mock.calls).toHaveLength(count);
});

it('uploads only confirmed bytes, persists accepted UUID, and never uploads local credentials', async () => {
  const f = await fixture(); const receipt = await f.adapter.test(f.ctx, f.file); f.state.readbackFailure = true;
  const result = await f.adapter.submit(f.ctx, f.file, receipt.sha256);
  expect(result.phase).toBe('pending'); expect(result.detail).toContain(versionId);
  expect(await readFile(join(f.ctx.workDir, 'oro-upload.json'), 'utf8')).toContain(versionId);
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('LOCAL-RUNTIME-SECRET');
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/cooldown|accepted|prior/i);
});

it('blocks retries after uncertain upload and suppresses raw failures', async () => {
  const f = await fixture(); const receipt = await f.adapter.test(f.ctx, f.file); f.state.throwUpload = true;
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/unknown|uncertain/i);
  const count = f.fetcher.mock.calls.length;
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/unknown|uncertain|prior/i);
  expect(f.fetcher.mock.calls).toHaveLength(count);
  expect(await readFile(join(f.ctx.workDir, 'oro-upload.json'), 'utf8')).not.toContain('LOCAL-RUNTIME-SECRET');
});

it('enforces server cooldown and bounded status responses', async () => {
  const f = await fixture(); const receipt = await f.adapter.test(f.ctx, f.file); f.state.canSubmit = false;
  await expect(f.adapter.submit(f.ctx, f.file, receipt.sha256)).rejects.toThrow(/cooldown|allowed/i);
  expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  f.state.oversized = true; await expect(f.adapter.status(f.ctx)).rejects.toThrow(/response|large/i);
});

it('rejects async or malformed source and clears a previous successful test receipt', async () => {
  const f = await fixture(); await f.adapter.test(f.ctx, f.file);
  await writeFile(f.file, 'async def agent_main(problem_data):\n    return None\n');
  await expect(f.adapter.test(f.ctx, f.file)).rejects.toThrow();
  await expect(readFile(join(f.ctx.workDir, 'oro-test.json'))).rejects.toThrow();
  await writeFile(f.file, 'x'.repeat(1024 * 1024 + 1)); await expect(source(f.file)).rejects.toThrow();
  const run = vi.fn(async () => { throw Error('unavailable'); });
  await expect(checkSource(Buffer.from('bad'), run)).rejects.toThrow();
  expect(run.mock.calls).toHaveLength(2);
});

it('signs an authenticated read from the standalone ESM bundle without wallet internals', async () => {
  const f = await fixture();
  const bundle = join(f.ctx.workDir, 'oro.mjs');
  execFileSync(resolve(__dirname, '../../../node_modules/.bin/esbuild'), [resolve(__dirname, '../../fez-oro/src/miner.ts'), '--bundle', '--format=esm', '--platform=node', `--outfile=${bundle}`], { stdio: 'pipe' });
  const script = `
    import {pathToFileURL} from 'node:url';
    const {createOroSubmission} = await import(pathToFileURL(process.argv[1]));
    const ctx = JSON.parse(process.argv[2]);
    let signed = false;
    const adapter = createOroSubmission({
      exec: async (_bin,args) => ({code:0,stdout:args[0]==='network'
        ? 'network: finney\\nendpoint: wss://entrypoint-finney.opentensor.ai:443\\n'
        : JSON.stringify(args[0]==='capabilities' ? {existingHotkey:true}
          : {persona:ctx.persona,created:false,ss58Address:ctx.hotkey,keyfile:{secretPhrase:${JSON.stringify(phrase)}}})}),
      fetch: async (_url, init) => {
        signed = /^0x[0-9a-f]{128}$/.test(new Headers(init.headers).get('X-Signature'));
        return Response.json({agents:[],can_submit:true});
      }
    });
    await adapter.status(ctx);
    if (!signed) throw Error('Missing request signature');
    console.log('signed');
  `;
  expect(execFileSync(process.execPath, ['--input-type=module', '-e', script, bundle, JSON.stringify({...f.ctx, config:{name:'Fez coder'}})], { encoding:'utf8', stdio:'pipe', timeout:15000 }).trim()).toBe('signed');
});
