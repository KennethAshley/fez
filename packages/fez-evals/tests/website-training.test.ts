import { expect, it, vi } from 'vitest';
import { canDownload, MAX_DATASET_BYTES, serviceUrl, submissionSchema, trainingApi, validateDatasets } from '../../../web/lib/training.js';

const id = 'd9490e36-dcc8-4f6c-9eaa-c1864c34ac78';
const job = { id, name: 'model-selection-v1', status: 'uploading' as const };
const input = { name: job.name, acceptance: { min_accuracy: 0.8, min_brier_improvement: 0.01 }, allow_training_data_export: true as const };
const storage = 'https://private-storage.example';
const descriptor = { method: 'PUT' as const, headers: { 'Content-Type': 'application/octet-stream' as const, 'x-upsert': 'false' as const }, url: `${storage}/storage/v1/object/upload/sign/fez-training-data/object?token=upload-only` };
const row = (split: string, extra = {}) => ({ id: `${split}-1`, group_id: `${split}-group`, family: 'model-selection', state: { task: split }, question: { type: 'choice', criteria: { small: 'Simple', large: 'Complex' } }, label: 'small', ...extra });
const blob = (value: unknown) => new Blob([JSON.stringify(value) + '\n']);
const files = () => ({ train: blob(row('train')), calibration: blob(row('calibration')), test: blob(row('test')) });
const result = { delivery: { status: 'accepted' as const, uid: 1, sha256: 'abc', acceptance: input.acceptance }, baseline: { accuracy: 0.7, brier: 0.4, skill: 0.2 }, miners: [{ uid: 1, status: 'eligible', accuracy: 0.85, brier: 0.2, skill: 0.6 }], weights: { '1': 1 } };

it('validates policy and explicit export consent before submission', () => {
  expect(submissionSchema.parse(input)).toEqual(input);
  for (const name of ['UPPER', '../private', '', 'x'.repeat(65), '-name']) expect(submissionSchema.safeParse({ ...input, name }).success).toBe(false);
  for (const min_accuracy of [-1, 1.1, NaN, Infinity]) expect(submissionSchema.safeParse({ ...input, acceptance: { ...input.acceptance, min_accuracy } }).success).toBe(false);
  expect(submissionSchema.safeParse({ ...input, allow_training_data_export: false }).success).toBe(false);
});

it('checks all JSONL splits locally and accepts supported question types', async () => {
  expect(await validateDatasets(files())).toEqual({ train: 1, calibration: 1, test: 1 });
  for (const [question, label] of [[{ type: 'noul' }, 'true'], [{ type: 'score', criteria: ['Low', 'High'] }, '1']] as const) {
    const data = files();
    data.train = blob(row('train', { question, label }));
    expect((await validateDatasets(data)).train).toBe(1);
  }
});

it('rejects invalid rows and cross-split leakage without echoing dataset content', async () => {
  for (const change of [
    { label: 'missing' }, { group_id: '' }, { question: { type: 'choice', criteria: { only: 'one' } } },
    { question: { type: 'noul', criteria: { maybe: 'No' } }, label: 'true' },
  ]) await expect(validateDatasets({ ...files(), test: blob(row('test', change)) })).rejects.toThrow();
  await expect(validateDatasets({ ...files(), test: blob(row('test', { id: 'train-1' })) })).rejects.toThrow('duplicate case ID');
  await expect(validateDatasets({ ...files(), test: blob(row('test', { group_id: 'train-group' })) })).rejects.toThrow('source group');
  await expect(validateDatasets({ ...files(), test: blob(row('test', { state: { task: 'train' } })) })).rejects.toThrow('exact prompt');
  await expect(validateDatasets({ ...files(), test: blob(row('test', { family: 'other' })) })).rejects.toThrow('same families');
  await expect(validateDatasets({ ...files(), train: new Blob(['private broken JSON']) })).rejects.toThrow('train, line 1: invalid JSON');
  const empty = new Blob([]);
  await expect(validateDatasets({ ...files(), train: empty })).rejects.toThrow('nonempty');
  const oversized = new Blob(['x']);
  Object.defineProperty(oversized, 'size', { value: MAX_DATASET_BYTES + 1 });
  await expect(validateDatasets({ ...files(), train: oversized })).rejects.toThrow('128 MiB');
  const aborted = AbortSignal.abort();
  await expect(validateDatasets(files(), aborted)).rejects.toThrow();
});

it('sends bearer auth only to the coordinator and uploads files without session credentials', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ job, uploads: { train: descriptor, calibration: descriptor, test: descriptor } }))
    .mockResolvedValueOnce(new Response('', { status: 200 }))
    .mockResolvedValueOnce(Response.json({ job: { ...job, status: 'validating' } }));
  const api = trainingApi('https://coordinator.example', storage, async () => 'session-only', request);
  const created = await api.create(input);
  if ('uploaded' in created.uploads.train) throw new Error('Expected an upload descriptor.');
  await api.upload('train', created.uploads.train, files().train);
  expect((await api.submit(job.id)).job.status).toBe('validating');
  expect(request.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer session-only', 'Content-Type': 'application/json' });
  expect(request.mock.calls[1][1]?.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' });
  expect(request.mock.calls[1][1]?.credentials).toBe('omit');
  expect(request.mock.calls[1][1]?.redirect).toBe('error');
  expect(request.mock.calls[2][0]).toBe(`https://coordinator.example/v1/jobs/${id}/submit`);
});

it('does not upload to an unexpected host, retry mutations, or invent jobs on errors', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'Awaiting operator setup.' }, { status: 503 }));
  const api = trainingApi('https://coordinator.example', storage, async () => 'token', request);
  await expect(api.list()).rejects.toThrow('Awaiting operator setup.');
  expect(request).toHaveBeenCalledTimes(1);
  await expect(api.upload('train', { ...descriptor, url: 'https://other.example/storage/v1/object/upload/sign/x' }, files().train)).rejects.toThrow('upload failed');
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(api.list()).rejects.toMatchObject({ status: 401 });
  request.mockResolvedValueOnce(Response.json({ jobs: [{ ...job, status: 'made-up' }] }));
  await expect(api.list()).rejects.toThrow('unsupported response');
  request.mockResolvedValueOnce(new Response('private storage internals', { status: 409 }));
  await expect(api.upload('test', descriptor, files().test)).rejects.toThrow('test upload failed');
});

it('requires current authentication and gates signed model downloads on accepted completion', async () => {
  const request = vi.fn<typeof fetch>();
  const signedOut = trainingApi('https://coordinator.example', storage, async () => '', request);
  await expect(signedOut.list()).rejects.toMatchObject({ status: 401 });
  expect(request).not.toHaveBeenCalled();
  const api = trainingApi('https://coordinator.example', storage, async () => 'token', request);
  const rejected = { ...job, status: 'completed' as const, result: { ...result, delivery: { ...result.delivery, status: 'no_qualifying_model' as const } } };
  expect(canDownload(rejected)).toBe(false);
  await expect(api.downloads(rejected)).rejects.toThrow('accepted');
  expect(request).not.toHaveBeenCalled();
  const downloads = Object.fromEntries(['adapter_config.json', 'adapter_model.safetensors', 'head.pt', 'release.json'].map(name => [name, { url: `${storage}/storage/v1/object/sign/fez-training-models/${name}?token=private` }]));
  request.mockResolvedValueOnce(Response.json({ downloads }));
  expect((await api.downloads({ ...job, status: 'completed', result })).map(file => file.name)).toContain('head.pt');
});

it('allows local development but rejects insecure remote coordinator configuration', () => {
  expect(serviceUrl('http://127.0.0.1:4179/')).toBe('http://127.0.0.1:4179');
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com?token=x', 'javascript:alert(1)']) expect(() => serviceUrl(url)).toThrow();
});

it('resumes only missing upload slots and supports cancellation without overwrites', async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ job, uploads: { train: { uploaded: true }, calibration: descriptor, test: descriptor } }))
    .mockResolvedValueOnce(Response.json({ job: { ...job, status: 'failed', error: 'Cancelled by customer.' } }));
  const api = trainingApi('https://coordinator.example', storage, async () => 'token', request);
  expect((await api.resume(id)).uploads.train).toEqual({ uploaded: true });
  expect((await api.cancel(id)).job.status).toBe('failed');
  expect(request.mock.calls.map(call => call[0])).toEqual([`https://coordinator.example/v1/jobs/${id}/uploads`, `https://coordinator.example/v1/jobs/${id}/cancel`]);
});
