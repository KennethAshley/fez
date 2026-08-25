/**
 * The stable share endpoint clients point at. Proxies the verifying
 * Supabase edge function: POST = a full signed kind-40300 event
 * (schnorr-verified upstream; forgeries 401), GET ?id= = the stored
 * event. Sharing is explicit re-publication — nothing here reads a
 * relay, so a share can never bypass workspace read gating.
 */

const UPSTREAM = "https://oxspgofacphchtuduaum.supabase.co/functions/v1/shared-artifacts";

export async function GET(request: Request) {
  const search = new URL(request.url).search;
  const upstream = await fetch(UPSTREAM + search, { next: { revalidate: 60 } });
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
