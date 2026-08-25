import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyEvent } from "npm:nostr-tools@2.14.0/pure";

// fez shared artifacts — the storage behind fez.chat/a/<event-id>.
// Sharing is EXPLICIT RE-PUBLICATION: the desktop POSTs the full signed
// kind-40300 event here when the user chooses to share; nothing is read
// from any relay, so a share can never bypass workspace read gating.
// Signature verification IS the auth (verify_jwt off, same as
// skill-installs). Deployed source mirrored in infra/shared-artifacts.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "company" } }
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const HEX64 = /^[0-9a-f]{64}$/;
const KIND_ARTIFACT = 40300;
// The relay's own content cap — an artifact that fits on the wire fits here.
const MAX_EVENT_BYTES = 256 * 1024;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!HEX64.test(id)) return json({ error: "id must be a 64-hex event id" }, 400);
    const { data, error } = await supabase
      .from("fez_shared_artifacts")
      .select("event, shared_at")
      .eq("event_id", id)
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: "not found" }, 404);
    return json({ event: data.event, sharedAt: data.shared_at });
  }

  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);

  const raw = await req.text();
  if (raw.length > MAX_EVENT_BYTES) return json({ error: "event exceeds 256KB" }, 413);

  let event: { id: string; kind: number; pubkey: string; created_at: number; content: string; tags: string[][]; sig: string };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "body must be a signed nostr event" }, 400);
  }

  if (event.kind !== KIND_ARTIFACT) return json({ error: "kind must be 40300" }, 400);
  if (!HEX64.test(event.id ?? "") || !HEX64.test(event.pubkey ?? "")) {
    return json({ error: "malformed event" }, 400);
  }

  let valid = false;
  try {
    valid = verifyEvent(event as never);
  } catch {
    valid = false;
  }
  if (!valid) return json({ error: "bad signature" }, 401);

  let artifactType = event.tags?.find((t) => t[0] === "type")?.[1] ?? "";
  let title: string | undefined;
  try {
    const body = JSON.parse(event.content) as { type?: string; title?: string };
    artifactType = artifactType || body.type || "";
    title = typeof body.title === "string" ? body.title.slice(0, 200) : undefined;
  } catch {
    // content isn't JSON — the type tag alone decides
  }
  if (!artifactType || artifactType.length > 32) return json({ error: "missing artifact type" }, 400);

  const { error } = await supabase.from("fez_shared_artifacts").upsert(
    {
      event_id: event.id,
      pubkey: event.pubkey,
      artifact_type: artifactType,
      title: title ?? null,
      event,
      event_created_at: event.created_at,
    },
    { onConflict: "event_id", ignoreDuplicates: true }
  );
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, id: event.id, url: `https://fez.chat/a/${event.id}` });
});
