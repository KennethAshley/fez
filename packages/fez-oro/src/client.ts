import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { cryptoWaitReady, mnemonicToMiniSecret, mnemonicValidate, sr25519PairFromSeed, sr25519Sign, encodeAddress } from '@polkadot/util-crypto';
import { z } from 'zod';
import type { SubmissionContext, SubmissionStatus } from '@fezchat/extension-api';

export const API = 'https://api.oroagents.com';
const ENDPOINT = 'wss://entrypoint-finney.opentensor.ai:443';
export const uuid = z.string().uuid();
export const date = z.string().datetime({ offset: true });
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9 ._-]+$/).refine(s => !!s.trim());
const state = z.enum(['RECEIVED', 'QUEUED', 'RUNNING', 'ELIGIBLE', 'DISCARDED', 'CANCELLED']);
const version = z.object({ agent_version_id: uuid, version_number: z.number().int().positive(), submitted_at: date, state,
  final_score: z.number().finite().nullable().optional(), eliminated_at: date.nullable().optional() });
const agents = z.object({ agents: z.array(z.object({ agent_id: uuid, miner_hotkey: z.string(), agent_name: name, created_at: date })).max(1000),
  can_submit: z.boolean(), next_allowed_at: date.nullable().optional(), racing_agent_version_id: uuid.nullable().optional(), racing_agent_id: uuid.nullable().optional() });
const statusSchema = version.extend({ agent_name: name, miner_hotkey: z.string(), is_active_qualifier: z.boolean().optional() });
export type Exec = (bin: string, args: string[], options: { timeoutMs: number; maxBytes: number }) => Promise<{ code: number; stdout: string }>;
export const exec: Exec = (bin, args, options) => new Promise((resolve, reject) => {
  execFile(bin, args, { encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxBytes, killSignal: 'SIGKILL' }, (error, stdout) => {
    if (error) reject(Error('Wallet command failed; private output suppressed'));
    else resolve({ code: 0, stdout });
  });
});
export function remaining(deadline: number, cap = 15000): number {
  const value = Math.min(cap, deadline - Date.now());
  if (value <= 0) throw Error('ORO operation timed out');
  return value;
}
export function agentName(ctx: SubmissionContext): string { return name.parse(ctx.config.name ?? `Fez ${ctx.persona}`); }
export function validContext(ctx: SubmissionContext): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ctx.persona) || !isAbsolute(ctx.workDir) || !isAbsolute(ctx.walletBin)) throw Error('Invalid ORO persona or local path');
}
type Identity = { address: string; pair: ReturnType<typeof sr25519PairFromSeed>; close(): void };
export async function identity(ctx: SubmissionContext, execute: Exec, deadline: number): Promise<Identity> {
  validContext(ctx);
  const run = async (args: string[]) => {
    const result = await execute(ctx.walletBin, args, { timeoutMs: remaining(deadline), maxBytes: 16384 });
    if (result.code !== 0) throw Error('Wallet command failed');
    return result.stdout;
  };
  let output: string;
  try { output = await run(['network']); } catch { throw Error('Could not verify wallet mainnet network'); }
  const lines = output.trim().split(/\r?\n/);
  if (lines.filter(l => l.startsWith('network:')).join('') !== 'network: finney' || lines.filter(l => l.startsWith('endpoint:')).join('') !== `endpoint: ${ENDPOINT}`)
    throw Error('ORO requires wallet network finney and the official mainnet endpoint');
  try { if (JSON.parse(await run(['capabilities', '--json'])).existingHotkey !== true) throw Error(); }
  catch { throw Error('Update Wallet: existingHotkey capability required before signing'); }
  let pair: ReturnType<typeof sr25519PairFromSeed> | undefined;
  try {
    const exported = JSON.parse(await run(['export-hotkey', ctx.persona, '--existing', '--json']));
    if (exported.created !== false || exported.persona !== ctx.persona || typeof exported.keyfile?.secretPhrase !== 'string') throw Error();
    await cryptoWaitReady();
    if (!mnemonicValidate(exported.keyfile.secretPhrase)) throw Error();
    const seed = mnemonicToMiniSecret(exported.keyfile.secretPhrase);
    try { pair = sr25519PairFromSeed(seed); } finally { seed.fill(0); }
    const address = encodeAddress(pair.publicKey, 42);
    if (address !== exported.ss58Address || (exported.keyfile.ss58Address !== undefined && address !== exported.keyfile.ss58Address) || (ctx.hotkey && ctx.hotkey !== address)) throw Error();
    const held = pair;
    return { address, pair, close: () => { held.secretKey.fill(0); } };
  } catch { pair?.secretKey.fill(0); throw Error('Could not load matching existing wallet hotkey; private output suppressed'); }
}

/** ORO authenticates each request, not the file hash. Bind uploads locally to tested bytes. */
export async function request(identity: Identity, route: string, fetcher: typeof fetch, deadline: number, now: number, body?: FormData): Promise<unknown> {
  const nonce = randomUUID(), timestamp = String(Math.floor(now / 1000));
  const headers = route.startsWith('/v1/miner/') ? { 'X-Hotkey': identity.address, 'X-Timestamp': timestamp, 'X-Nonce': nonce,
    'X-Signature': `0x${Buffer.from(sr25519Sign(Buffer.from(`${identity.address}:${timestamp}:${nonce}`), identity.pair)).toString('hex')}` } : undefined;
  try {
    const response = await fetcher(API + route, { method: body ? 'POST' : 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(remaining(deadline, body ? 45000 : 15000)) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Error(`HTTP ${response.status}`); }
    if (!response.body) throw Error('Empty response');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw Error('Response too large'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw Error(body ? 'ORO upload outcome unknown; inspect the dashboard before any retry' : 'ORO request failed or response invalid/oversized; no private output shown'); }
}

export async function snapshot(ctx: SubmissionContext, who: Identity, fetcher: typeof fetch, deadline: number, now: () => number): Promise<{ status: SubmissionStatus; canSubmit: boolean }> {
  const desiredName = agentName(ctx);
  const list = agents.parse(await request(who, '/v1/miner/agents', fetcher, deadline, now()));
  if (list.agents.some(a => a.miner_hotkey !== who.address) || new Set(list.agents.map(a => a.agent_id)).size !== list.agents.length || new Set(list.agents.map(a => a.agent_name)).size !== list.agents.length) throw Error('Invalid ORO response ownership or duplicate agent');
  const selected = list.agents.find(a => a.agent_name === desiredName);
  const history = selected ? z.array(version).max(1000).parse(await request(who, `/v1/miner/agents/${selected.agent_id}/versions`, fetcher, deadline, now())).sort((a, b) => b.version_number - a.version_number) : [];
  if (new Set(history.map(v => v.agent_version_id)).size !== history.length || new Set(history.map(v => v.version_number)).size !== history.length) throw Error('Invalid ORO duplicate version response');
  const latest = history[0];
  const activeId = selected && list.racing_agent_id === selected.agent_id ? list.racing_agent_version_id ?? undefined : undefined;
  if (activeId && !history.some(v => v.agent_version_id === activeId && v.state === 'ELIGIBLE' && !v.eliminated_at)) throw Error('Inconsistent ORO active version response');
  // Validate public status against owned history; code-release timestamps are NOT activation.
  for (const v of history.filter(v => v === latest || v.agent_version_id === activeId)) {
    const detail = statusSchema.parse(await request(who, `/v1/public/agent-versions/${v.agent_version_id}/status`, fetcher, deadline, now()));
    if (detail.agent_version_id !== v.agent_version_id || detail.miner_hotkey !== who.address || detail.agent_name !== desiredName || detail.version_number !== v.version_number || detail.state !== v.state) throw Error('Invalid or changed ORO status response; refresh');
  }
  const phase = !latest ? 'not-submitted' : latest.state === 'DISCARDED' || latest.state === 'CANCELLED' || latest.eliminated_at ? 'failed' : activeId === latest.agent_version_id ? 'active' : 'pending';
  return { canSubmit: list.can_submit, status: { hotkey: who.address, phase, checkedAt: new Date(now()).toISOString(),
    versions: history.map(v => ({ id: v.agent_version_id, name: desiredName, version: v.version_number, createdAt: v.submitted_at, activatedAt: null })),
    ...(activeId ? { activeVersionId: activeId } : {}), ...(list.next_allowed_at ? { nextUploadAt: list.next_allowed_at } : {}),
    detail: latest ? `ORO ${latest.state}. ${activeId ? 'The backend reports the racing candidate; activation time is not published.' : 'No racing candidate reported for this agent.'} Eligibility is not proof of current execution or rewards. Qualifying score: ${latest.final_score ?? 'not reported'}.`
      : `No ORO versions reported for ${desiredName}. Mainnet SN15 enrollment and inference-provider linking are separate dashboard prerequisites.`,
  } };
}

export async function requireInference(who: Identity, fetcher: typeof fetch, deadline: number, now: number): Promise<void> {
  const list = z.object({ providers: z.array(z.object({ provider: z.string().max(32), connected: z.boolean() })).max(10), default_provider: z.string().nullable().optional() })
    .parse(await request(who, '/v1/miner/inference-auth', fetcher, deadline, now));
  const connected = list.providers.filter(p => p.connected && ['openrouter', 'chutes'].includes(p.provider));
  if (!connected.length || (list.default_provider && !connected.some(p => p.provider === list.default_provider)) || (!list.default_provider && connected.length !== 1))
    throw Error('Connect an inference provider and choose its default in the ORO dashboard before submitting; local runtime keys are never uploaded');
}
