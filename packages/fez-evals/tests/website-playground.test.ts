import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseRequest, parseResponse, PRESETS } from '../../../web/lib/playground.js';
import { POST } from '../../../web/app/api/playground/route.js';

const request = { model: 'fez-0.8b-experimental', state: 'The parcel is broken.', questions: { damaged: { type: 'noul', instructions: 'Is it damaged?' } } };
const response = { model: 'fez-0.8b-experimental', answers: { damaged: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 20, output_tokens: 10 }, latency_ms: 42 };
const post = (value: unknown) => new Request('http://localhost/api/playground', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

beforeEach(() => { vi.stubEnv('FEZ_DECISION_API_URL', 'https://inference.example/v1/systemone'); });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('accepts all presets and rejects invalid questions before inference', () => {
  for (const preset of PRESETS) expect(parseRequest({ ...request, state: preset.state, questions: preset.questions }).questions).toEqual(preset.questions);
  for (const questions of [{}, { q: { type: 'chat' } }, { q: { type: 'choice', criteria: {} } }, { q: { type: 'score', criteria: 'high' } }, { q: { type: 'noul', criteria: { maybe: 'maybe' } } }]) {
    expect(() => parseRequest({ ...request, questions })).toThrow();
  }
  expect(() => parseRequest({ ...request, endpoint: 'http://localhost/private' })).toThrow();
});

it('rejects missing answers, mismatched types and invalid probability distributions', () => {
  const parsed = parseRequest(request);
  expect(parseResponse(response, parsed)).toEqual(response);
  expect(() => parseResponse({ ...response, answers: {} }, parsed)).toThrow();
  expect(() => parseResponse({ ...response, answers: { damaged: { type: 'noul', noul: 1.1 } } }, parsed)).toThrow();
  const choice = parseRequest({ ...request, questions: { damaged: { type: 'choice', criteria: { yes: null, no: null } } } });
  expect(() => parseResponse(response, choice)).toThrow();
  expect(() => parseResponse({ ...response, answers: { damaged: { type: 'choice', choice: 'yes', confidence: 0.8, probabilities: { yes: 0.9, no: 0.9 } } } }, choice)).toThrow();
});

it('never falls back to another provider when Fez is disconnected', async () => {
  vi.stubEnv('FEZ_DECISION_API_URL', '');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const result = await POST(post(request));
  expect(result.status).toBe(503);
  expect(await result.text()).toContain('not connected');
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects responses labeled as another model', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...response, model: 'jev-latest' })));
  expect((await POST(post(request))).status).toBe(502);
});

it('keeps custom endpoint credentials server-side and does not follow redirects', async () => {
  vi.stubEnv('FEZ_DECISION_API_URL', 'https://inference.example/v1/systemone');
  vi.stubEnv('FEZ_DECISION_API_KEY', 'private-test-key');
  vi.stubEnv('FEZ_DECISION_MODEL', 'fez-candidate-9b');
  const fetch = vi.fn().mockResolvedValue(Response.json({ ...response, model: 'fez-candidate-9b' }));
  vi.stubGlobal('fetch', fetch);
  const result = await POST(post({ ...request, model: 'fez-candidate-9b' }));
  expect(result.status).toBe(200);
  expect(fetch.mock.calls[0][0]).toBe('https://inference.example/v1/systemone');
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer private-test-key');
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  expect(await result.text()).not.toContain('private-test-key');
});

it('returns actionable errors without exposing the upstream response', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('private provider details', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  expect((await POST(post({ ...request, model: 'fake-model' }))).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
  const result = await POST(post(request));
  expect(result.status).toBe(503);
  expect(await result.text()).not.toContain('private provider details');
  expect((await POST(post({ ...request, state: 'a'.repeat(70000) }))).status).toBe(413);
  expect((await POST(new Request('http://localhost/api/playground', { method: 'POST', body: '{' }))).status).toBe(400);
});
