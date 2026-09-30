import { z } from 'zod';

export const SPLITS = ['train', 'calibration', 'test'] as const;
export type Split = typeof SPLITS[number];
export const MAX_DATASET_BYTES = 128 * 1024 * 1024;
export const acceptanceSchema = z.object({ min_accuracy: z.number().min(0).max(1), min_brier_improvement: z.number().min(0).max(2) });
export const submissionSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Use 1–64 lowercase letters, digits, or hyphens; start with a letter or digit.'),
  acceptance: acceptanceSchema,
  allow_training_data_export: z.literal(true, { error: 'Confirm permission to export training data to approved workers.' }),
});
export type Submission = z.infer<typeof submissionSchema>;
export const STATUSES = ['uploading', 'validating', 'awaiting_approval', 'queued', 'running', 'evaluating', 'completed', 'failed'] as const;
const metrics = z.object({ accuracy: z.number().min(0).max(1), brier: z.number().min(0).max(2), skill: z.number().min(0).max(1) });
export const jobSchema = z.object({
  id: z.string().uuid(), name: z.string(), status: z.enum(STATUSES), created_at: z.string().optional(), error: z.string().nullable().optional(),
  result: z.object({
    delivery: z.object({ status: z.enum(['accepted', 'no_qualifying_model']), uid: z.number().optional(), sha256: z.string().optional(), brier_improvement: z.number().optional(), acceptance: acceptanceSchema }),
    baseline: metrics,
    miners: z.array(z.object({ uid: z.number(), status: z.string(), accuracy: z.number().optional(), brier: z.number().optional(), skill: z.number().optional() })),
    weights: z.record(z.string(), z.number()),
  }).nullable().optional(),
});
export type Job = z.infer<typeof jobSchema>;
export const STATUS_COPY: Record<Job['status'], string> = {
  uploading: 'Waiting for dataset uploads and submission.', validating: 'Checking dataset structure and separation.',
  awaiting_approval: 'An operator must assign approved workers before training data is shared.',
  queued: 'Approved and waiting for a worker.', running: 'Workers are training candidates.', evaluating: 'Comparing candidates against the baseline.',
  completed: 'Evaluation finished. Review the delivery decision below.', failed: 'This job could not finish. Review the error below.',
};
export const terminal = (job: Job) => job.status === 'completed' || job.status === 'failed';
export const canDownload = (job: Job) => job.status === 'completed' && job.result?.delivery.status === 'accepted';
export const DOWNLOAD_FILES = ['adapter_config.json', 'adapter_model.safetensors', 'head.pt', 'release.json'] as const;

export function serviceUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS service URL (HTTP is allowed only for local development).');
  return url.href.replace(/\/$/, '');
}

const json = z.json();
const rowSchema = z.object({ id: z.string().min(1), group_id: z.string().min(1), family: z.string().min(1), state: json, question: z.object({ type: z.enum(['noul', 'choice', 'score']), criteria: json.optional() }).passthrough(), label: z.string().min(1) });
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Stream files locally; retain only IDs, group membership, and prompt hashes. */
export async function validateDatasets(files: Record<Split, Blob>, signal?: AbortSignal): Promise<Record<Split, number>> {
  const ids = new Set<string>();
  const groups = new Map<string, Split>();
  const prompts = new Map<string, Split>();
  const families = { train: new Set<string>(), calibration: new Set<string>(), test: new Set<string>() };
  const counts = { train: 0, calibration: 0, test: 0 };
  for (const split of SPLITS) {
    const file = files[split];
    if (!file || file.size === 0 || file.size > MAX_DATASET_BYTES) throw new Error(`${split}: choose a nonempty JSONL file, at most 128 MiB.`);
    let line = 0;
    const consume = async (text: string) => {
      signal?.throwIfAborted();
      line++;
      if (!text.trim()) return;
      let input: unknown;
      try { input = JSON.parse(text); } catch { throw new Error(`${split}, line ${line}: invalid JSON.`); }
      const parsed = rowSchema.safeParse(input);
      if (!parsed.success) throw new Error(`${split}, line ${line}: requires id, group_id, family, state, question, and label with valid types.`);
      const row = parsed.data;
      const q = row.question;
      const choices = q.type === 'noul' ? ['false', 'true'] : q.type === 'score' && Array.isArray(q.criteria) ? q.criteria.map((_, i) => String(i)) : q.type === 'choice' && q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : [];
      if (q.type === 'noul' && q.criteria != null && (typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).some(key => !['true', 'false'].includes(key)))) throw new Error(`${split}, line ${line}: noul criteria must use true/false keys.`);
      if (new TextEncoder().encode(JSON.stringify(input)).length > 128 * 1024) throw new Error(`${split}, line ${line}: case exceeds 128 KiB.`);
      if (choices.length < 2 || choices.length > 255 || choices.some(key => !key) || !choices.includes(row.label)) throw new Error(`${split}, line ${line}: question needs at least two outcomes and a label matching an outcome.`);
      if (ids.has(row.id)) throw new Error(`${split}, line ${line}: duplicate case ID across the datasets.`);
      ids.add(row.id);
      if (groups.has(row.group_id) && groups.get(row.group_id) !== split) throw new Error(`${split}, line ${line}: related source group crosses dataset splits.`);
      groups.set(row.group_id, split);
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical([row.state, row.question])));
      const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (prompts.has(key) && prompts.get(key) !== split) throw new Error(`${split}, line ${line}: exact prompt crosses dataset splits.`);
      prompts.set(key, split);
      families[split].add(row.family);
      counts[split]++;
    };
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let start = 0;
        for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', start)) {
          await consume(pending.slice(start, end));
          start = end + 1;
        }
        pending = pending.slice(start);
        if (done) { if (pending) await consume(pending); break; }
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (!counts[split]) throw new Error(`${split}: no dataset rows found.`);
  }
  if (families.calibration.size !== families.test.size || [...families.test].some(family => !families.calibration.has(family) || !families.train.has(family))) throw new Error('Calibration and test must have the same families, all present in training.');
  return counts;
}

const uploadSchema = z.object({ url: z.string().url(), method: z.literal('PUT'), headers: z.object({ 'Content-Type': z.literal('application/octet-stream'), 'x-upsert': z.literal('false') }).strict() });
const uploadSlot = z.union([uploadSchema, z.object({ uploaded: z.literal(true) })]);
const uploadsSchema = z.object({ train: uploadSlot, calibration: uploadSlot, test: uploadSlot });
export class TrainingApiError extends Error { constructor(message: string, public status: number) { super(message); } }

export function trainingApi(baseUrl: string, storageUrl: string, token: () => Promise<string>, request: typeof fetch = fetch) {
  const base = serviceUrl(baseUrl);
  const storageOrigin = new URL(serviceUrl(storageUrl)).origin;
  function signedUrl(raw: string) {
    const url = new URL(raw);
    if (url.origin !== storageOrigin || !url.pathname.startsWith('/storage/v1/object/') || url.username || url.password) throw new Error('The coordinator returned an unexpected storage destination.');
    return url.href;
  }
  async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
    const accessToken = await token();
    if (!accessToken) throw new TrainingApiError('Your session expired. Sign in again.', 401);
    let response: Response;
    try {
      response = await request(`${base}/v1/jobs${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), cache: 'no-store', credentials: 'omit', redirect: 'error' });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Cannot reach the training coordinator. Check your connection and try again.');
    }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ error: z.string().max(2000) }).safeParse(data);
      throw new TrainingApiError(response.status === 401 ? 'Your session expired. Sign in again.' : error.success ? error.data.error : `Training request failed (${response.status}).`, response.status);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error('The coordinator returned an unsupported response. Refresh or contact the operator.');
    return parsed.data;
  }
  const idPath = (id: string) => `/${z.string().uuid().parse(id)}`;
  return {
    list: (signal?: AbortSignal) => call('', z.object({ jobs: z.array(jobSchema) }), undefined, signal),
    get: (id: string, signal?: AbortSignal) => call(idPath(id), z.object({ job: jobSchema }), undefined, signal),
    create: (input: Submission, signal?: AbortSignal) => call('', z.object({ job: jobSchema, uploads: uploadsSchema }), submissionSchema.parse(input), signal),
    resume: (id: string, signal?: AbortSignal) => call(`${idPath(id)}/uploads`, z.object({ job: jobSchema, uploads: uploadsSchema }), {}, signal),
    cancel: (id: string, signal?: AbortSignal) => call(`${idPath(id)}/cancel`, z.object({ job: jobSchema }), {}, signal),
    submit: (id: string, signal?: AbortSignal) => call(`${idPath(id)}/submit`, z.object({ job: jobSchema }), {}, signal),
    downloads: async (job: Job, signal?: AbortSignal) => {
      if (!canDownload(job)) throw new Error('Downloads require a completed, accepted model.');
      const schema = z.object({ downloads: z.object({ 'adapter_config.json': z.object({ url: z.string() }), 'adapter_model.safetensors': z.object({ url: z.string() }), 'head.pt': z.object({ url: z.string() }), 'release.json': z.object({ url: z.string() }) }) });
      const data = await call(`${idPath(job.id)}/downloads`, schema, undefined, signal);
      return DOWNLOAD_FILES.map(name => ({ name, url: signedUrl(data.downloads[name].url) }));
    },
    upload: async (split: Split, descriptor: z.infer<typeof uploadSchema>, file: Blob, signal?: AbortSignal) => {
      const valid = uploadSchema.parse(descriptor);
      if (!file.size || file.size > MAX_DATASET_BYTES) throw new Error(`${split}: file must be nonempty and at most 128 MiB.`);
      try {
        const response = await request(signedUrl(valid.url), { method: valid.method, headers: valid.headers, body: file, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000) });
        if (!response.ok) throw new Error('Upload rejected.');
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`${split} upload failed. Uploaded files are not overwritten. Use Resume missing uploads with the original files, or retry submission if all files arrived.`);
      }
    },
  };
}
