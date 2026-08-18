/**
 * The company counts endpoint — the STABLE identity clients point at
 * (DEFAULT_SKILL_COUNTS_URL). Proxies the verifying Supabase edge
 * function; when the real domain lands, only DNS changes. POST = a
 * signed 40201 receipt (schnorr-verified upstream; forgeries 401),
 * GET = aggregates.
 */

const UPSTREAM = "https://oxspgofacphchtuduaum.supabase.co/functions/v1/skill-installs";

export async function GET(request: Request) {
  const search = new URL(request.url).search;
  const upstream = await fetch(UPSTREAM + search, { next: { revalidate: 30 } });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function POST(request: Request) {
  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
}
