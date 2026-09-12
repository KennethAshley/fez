const UPSTREAM = process.env.FEZ_EMAIL_SIGNUPS_URL
  ?? 'https://oxspgofacphchtuduaum.supabase.co/functions/v1/email-signups';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  // Next.js can reconstruct request.url with an internal hostname/protocol.
  // Host identifies the public destination even behind TLS termination.
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (origin && ![`https://${host}`, `http://${host}`].includes(origin)) {
    return Response.json({ error: 'Submit this form from fez.chat.' }, { status: 403 });
  }
  try {
    const body = await request.text();
    if (body.length > 1024) return Response.json({ error: 'Request too large' }, { status: 413 });
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (upstream.status === 400) {
      return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
    }
    if (upstream.ok && (await upstream.json()).ok === true) {
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
  } catch {
    // Keep provider errors and submitted addresses out of public responses/logs.
  }
  return Response.json({ error: "Couldn't save your email. Please try again." }, { status: 503 });
}
