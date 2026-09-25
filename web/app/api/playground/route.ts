import { parseRequest } from '../../../lib/playground';
import { infer, InferenceError, MAX_BODY_BYTES, playgroundConfig, readLimited } from '../../../lib/playground-server';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  return Response.json(playgroundConfig(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const text = await readLimited(request, MAX_BODY_BYTES);
    let input;
    try { input = parseRequest(JSON.parse(text)); }
    catch (error) { return Response.json({ error: error instanceof SyntaxError ? 'Request must be valid JSON.' : (error as Error).message }, { status: 400, headers }); }
    if (!playgroundConfig().models.some(m => m.id === input.model)) return Response.json({ error: 'Select an available model.' }, { status: 400, headers });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
    return Response.json(await infer(input, signal), { headers });
  } catch (error) {
    const known = error instanceof InferenceError;
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return Response.json({ error: known ? error.message : timedOut ? 'The Fez model timed out. Try fewer questions or try again later.' : 'Could not reach the Fez model. Try again shortly.' }, { status: known ? error.status : timedOut ? 504 : 502, headers });
  }
}
