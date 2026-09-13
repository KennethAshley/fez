// Public signup writes only. The service key stays in the edge runtime;
// the table has no public read or write grants.
const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});
const unavailable = () => json({ error: "Couldn't save your email. Please try again." }, 503);

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 1024) return json({ error: "Request too large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Enter a valid email address." }, 400);
  }
  if (!body || typeof body !== "object" || !("email" in body) || typeof body.email !== "string") {
    return json({ error: "Enter a valid email address." }, 400);
  }

  // ponytail: catches basic form bots; add a verified challenge if abuse appears.
  if ("website" in body && body.website) return json({ ok: true });
  const email = body.email.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex -- reject control characters in submitted email addresses.
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  if (!url || !key) return unavailable();

  try {
    const saved = await fetch(`${url}/rest/v1/fez_email_signups?on_conflict=email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(8000),
    });
    if (!saved.ok) return unavailable();
    // The same response for new and existing addresses prevents list enumeration.
    return json({ ok: true });
  } catch {
    return unavailable();
  }
});
