import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { MinerSubmission, SubmissionContext, SubmissionStatus, SubnetMiner } from '@fezchat/extension-api';
import { agentName, date, exec, identity, request, requireInference, snapshot, uuid, validContext, type Exec } from './client.js';
import { checkSource, IMAGE, source, type Run } from './source.js';
import { evaluateOro, oroDevelopmentInstructions } from './evaluation.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({ format: z.literal(1), sha256: digest, persona: z.string(), name: z.string(), hotkey: z.string().optional(), image: z.literal(IMAGE) });
const attemptSchema = z.object({ persona: z.string(), name: z.string(), hotkey: z.string(), sha256: digest,
  state: z.enum(['unknown', 'accepted', 'rejected']), versionId: uuid.optional(), nextAllowedAt: date.nullable().optional() });
type Attempt = z.infer<typeof attemptSchema>;
async function read(file: string): Promise<unknown | undefined> {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw Error('Cannot read ORO receipt; preserve it before recovery'); }
  try {
    if ((await handle.stat()).size > 65536) throw Error();
    return JSON.parse(await handle.readFile('utf8'));
  } catch { throw Error('Invalid ORO receipt; preserve it before recovery'); }
  finally { await handle.close(); }
}
async function save(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
async function attempt(ctx: SubmissionContext): Promise<Attempt | undefined> {
  const value = await read(join(ctx.workDir, 'oro-upload.json'));
  if (value === undefined) return undefined;
  const parsed = attemptSchema.parse(value);
  if (parsed.persona !== ctx.persona) throw Error('ORO receipt persona mismatch');
  return parsed;
}
function pending(status: SubmissionStatus, saved?: Attempt): SubmissionStatus {
  if (!saved || saved.hotkey !== status.hotkey) return status;
  if (saved.state === 'unknown') return { ...status, phase: 'pending', detail: 'ORO upload outcome unknown. Inspect the ORO dashboard and preserve the local receipt before any retry. ' + status.detail };
  if (saved.state === 'accepted' && saved.versionId && !status.versions.some(v => v.id === saved.versionId)) {
    return { ...status, phase: 'pending', ...(saved.nextAllowedAt ? { nextUploadAt: saved.nextAllowedAt } : {}),
      detail: `ORO accepted version ${saved.versionId}; metadata awaits status readback. No execution or rewards are confirmed.` };
  }
  return status;
}
async function safe<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof z.ZodError) throw Error('Invalid ORO response or configuration; private values suppressed'); throw e; }
}

/** Mainnet submission only; key export is existing-only and enrollment is never automatic. */
export function createOroSubmission(deps: { exec?: Exec; run?: Run; fetch?: typeof fetch; now?: () => number } = {}): MinerSubmission {
  const execute = deps.exec ?? exec, fetcher = deps.fetch ?? fetch, now = deps.now ?? Date.now;
  return {
    notice: 'Unsupported for testnet mining. No public ORO testnet service has been verified. Submitting to ORO starts mainnet SN15 evaluation and bills the inference provider linked in the ORO dashboard. Attempts may consume an 18-hour cooldown, including rejected code. Code is later released publicly. No automatic registration, provider linking or retry.',
    status: ctx => safe(async () => {
      validContext(ctx); agentName(ctx);
      const deadline = Date.now() + 90000;
      const who = await identity(ctx, execute, deadline);
      try {
        const saved = await attempt(ctx);
        if (saved && saved.hotkey !== who.address) throw Error('ORO receipt hotkey differs from wallet identity');
        const current = await snapshot(ctx, who, fetcher, deadline, now);
        return pending(current.status, saved?.name === agentName(ctx) || saved?.state === 'unknown' ? saved : undefined);
      } finally { who.close(); }
    }),
    test: (ctx, file) => safe(async () => {
      validContext(ctx); await mkdir(ctx.workDir, { recursive: true });
      const receipt = join(ctx.workDir, 'oro-test.json'); await rm(receipt, { force: true });
      const bytes = await source(file); await checkSource(bytes, deps.run);
      const sha256 = hash(bytes);
      await save(receipt, { format: 1, sha256, persona: ctx.persona, name: agentName(ctx), hotkey: ctx.hotkey, image: IMAGE });
      return { sha256, detail: 'Python syntax and synchronous agent_main(problem_data) checked in keyless networkless Docker. Candidate code was not executed. ORO security/integrity checks, environment behavior, inference and scores remain unverified.' };
    }),
    submit: (ctx, file, sha256) => safe(async () => {
      validContext(ctx); const name = agentName(ctx);
      const bytes = await source(file);
      if (!digest.safeParse(sha256).success || hash(bytes) !== sha256) throw Error('Source hash changed; test the exact candidate again');
      const checked = receiptSchema.safeParse(await read(join(ctx.workDir, 'oro-test.json')));
      if (!checked.success || checked.data.sha256 !== sha256 || checked.data.persona !== ctx.persona || checked.data.name !== name || (checked.data.hotkey && checked.data.hotkey !== ctx.hotkey)) throw Error('A matching successful ORO test receipt is required');
      await mkdir(ctx.workDir, { recursive: true });
      const lockPath = join(ctx.workDir, 'oro-submit.lock');
      const lock = await open(lockPath, 'wx').catch(() => { throw Error('Another ORO upload is running or was interrupted; inspect its outcome before retrying'); });
      try {
        const previous = await attempt(ctx);
        if (previous?.state === 'unknown') throw Error('Prior ORO upload outcome unknown; inspect the dashboard before recovery, never retry blindly');
        if (previous?.nextAllowedAt && Date.parse(previous.nextAllowedAt) > now()) throw Error('Prior ORO attempt cooldown is still active');
        const deadline = Date.now() + 90000;
        const who = await identity(ctx, execute, deadline);
        try {
          if (previous && previous.hotkey !== who.address) throw Error('ORO upload receipt hotkey differs from wallet identity');
          const before = await snapshot(ctx, who, fetcher, deadline, now);
          if (!before.canSubmit || (before.status.nextUploadAt && Date.parse(before.status.nextUploadAt) > now())) throw Error('ORO submission cooldown active or submission not allowed');
          await requireInference(who, fetcher, deadline, now());
          const record: Attempt = { persona: ctx.persona, name, hotkey: who.address, sha256, state: 'unknown' };
          const recordPath = join(ctx.workDir, 'oro-upload.json');
          await save(recordPath, record); // Before POST: interruption must not permit blind retry.
          const body = new FormData(); body.append('agent_name', name);
          body.append('file', new Blob([new Uint8Array(bytes)], { type: 'text/x-python' }), 'agent.py');
          let admission;
          try {
            admission = z.object({ admission_status: z.enum(['ACCEPTED', 'REJECTED']), hotkey: z.string(), agent_id: uuid.nullable().optional(), agent_version_id: uuid.nullable().optional(), next_allowed_at: date.nullable().optional() })
              .parse(await request(who, '/v1/miner/submit', fetcher, deadline, now(), body));
            if (admission.hotkey !== who.address || (admission.admission_status === 'ACCEPTED' && (!admission.agent_id || !admission.agent_version_id))) throw Error();
          } catch { throw Error('ORO upload outcome unknown; response could not confirm acceptance. Inspect the dashboard before recovery.'); }
          record.state = admission.admission_status === 'ACCEPTED' ? 'accepted' : 'rejected';
          record.nextAllowedAt = admission.next_allowed_at;
          if (record.state === 'accepted') record.versionId = admission.agent_version_id!;
          await save(recordPath, record);
          if (record.state === 'rejected') throw Error('ORO rejected the submission; inspect dashboard admission details and cooldown before retrying');
          // Acceptance is durable even if the immediately following read is stale or fails.
          try { return pending((await snapshot(ctx, who, fetcher, deadline, now)).status, record); }
          catch { return pending(before.status, record); }
        } finally { who.close(); }
      } finally { await lock.close(); await rm(lockPath, { force: true }); }
    }),
  };
}

const oro: SubnetMiner = {
  netuid: 15, network: 'finney', name: 'ORO',
  config: [
    { key: 'name', label: 'ORO agent name', type: 'string', pattern: '[A-Za-z0-9 ._-]{1,100}', help: 'Unique per hotkey. Defaults to Fez <persona>; connect live inference separately in the ORO dashboard.' },
    { key: 'evaluation_checkout', label: 'Local evaluator checkout', type: 'string', help: 'Absolute path to the reviewed, clean ORO checkout. Used only for local evaluation.' },
    { key: 'evaluation_commit', label: 'Reviewed evaluator commit', type: 'string', default: 'ffb98e581e8976fbe33cc4a3a467eb617d4b0328', pattern: 'ffb98e581e8976fbe33cc4a3a467eb617d4b0328' },
    { key: 'evaluation_pack', label: 'Local EnvPack archive', type: 'string', help: 'Absolute path to the actual pinned local-test archive, not a Git LFS pointer.' },
    { key: 'evaluation_validator_image', label: 'Validator image digest', type: 'string', pattern: 'ghcr\\.io/oro-ai/oro/validator@sha256:[a-f0-9]{64}', help: 'Install the reviewed AMD64 image on local Docker before evaluation.' },
    { key: 'evaluation_sandbox_image', label: 'Sandbox image digest', type: 'string', pattern: 'ghcr\\.io/oro-ai/oro/sandbox@sha256:[a-f0-9]{64}' },
    { key: 'evaluation_proxy_image', label: 'Proxy image digest', type: 'string', pattern: 'ghcr\\.io/oro-ai/oro/proxy@sha256:[a-f0-9]{64}' },
    { key: 'evaluation_search_image', label: 'Search image digest', type: 'string', pattern: 'ghcr\\.io/oro-ai/oro/search-server@sha256:[a-f0-9]{64}' },
    { key: 'evaluation_provider', label: 'Local evaluation provider', type: 'select', options: ['openrouter', 'chutes'], default: 'openrouter', help: 'Local evaluation bills this provider. Live submission uses the provider linked separately in the ORO dashboard.' },
    { key: 'evaluation_model', label: 'Local evaluation model', type: 'string', pattern: '[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}' },
    { key: 'openrouter_api_key', label: 'OpenRouter runtime key (local evaluation)', type: 'secret', help: 'Private runtime key, not a management key. Never sent to the ORO submission API.' },
    { key: 'chutes_api_key', label: 'Chutes runtime key (local evaluation)', type: 'secret', help: 'Private local evaluation credential. Never sent to the ORO submission API.' },
  ],
  submission: createOroSubmission(),
  development: { instructions: oroDevelopmentInstructions, evaluate: evaluateOro },
};
export default [oro];
