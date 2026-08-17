import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyEvent } from "npm:nostr-tools@2.14.0/pure";

// fez skill-install counter — company-tier index over signed 40201
// receipts. See ../README.md for the trust model.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const HEX64 = /^[0-9a-f]{64}$/;
const KIND_SKILL_INSTALL = 40201;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const name = url.searchParams.get("name");
    const author = url.searchParams.get("author");
    let query = supabase.from("fez_skill_install_counts").select("skill_name, listing_author, installs").limit(500);
    if (name) query = query.eq("skill_name", name);
    if (author) query = query.eq("listing_author", author);
    const { data, error } = await query;
    if (error) return json({ error: error.message }, 500);
    return json({ counts: data });
  }

  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);

  let event: { id: string; kind: number; pubkey: string; created_at: number; content: string; tags: string[][]; sig: string };
  try {
    event = await req.json();
  } catch {
    return json({ error: "body must be a signed nostr event" }, 400);
  }

  if (event.kind !== KIND_SKILL_INSTALL) return json({ error: "kind must be 40201" }, 400);
  const skillName = event.tags?.find((t) => t[0] === "skill")?.[1];
  const listingAuthor = event.tags?.find((t) => t[0] === "p")?.[1];
  if (!skillName || skillName.length > 64) return json({ error: "missing/oversized skill tag" }, 400);
  if (!listingAuthor || !HEX64.test(listingAuthor)) return json({ error: "missing p tag (listing author)" }, 400);
  if (Math.abs(Date.now() / 1000 - event.created_at) > 7 * 24 * 3600) return json({ error: "receipt too old/new" }, 400);

  let valid = false;
  try {
    valid = verifyEvent(event as never);
  } catch {
    valid = false;
  }
  if (!valid) return json({ error: "bad signature" }, 401);

  const { error } = await supabase.from("fez_skill_installs").upsert(
    { skill_name: skillName, listing_author: listingAuthor, installer: event.pubkey, event_id: event.id },
    { onConflict: "skill_name,listing_author,installer", ignoreDuplicates: true }
  );
  if (error) return json({ error: error.message }, 500);

  const { data } = await supabase
    .from("fez_skill_install_counts")
    .select("installs")
    .eq("skill_name", skillName)
    .eq("listing_author", listingAuthor)
    .maybeSingle();
  return json({ ok: true, installs: data?.installs ?? 1 });
});
