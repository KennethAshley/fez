/** fez mem — NIP-AE agent memory (engrams), for agents in a harness shell and owners with --persona. */
import type { Command } from "commander";
import { unixNow } from "../shared/time.js";

export function registerMemCommands(program: Command): void {
// ─── mem — NIP-AE agent memory (engrams) ────────────────────────────────────
//
// Two callers, one command: an AGENT invoking it from inside its harness
// shell (FEZ_AGENT_PERSONA/FEZ_AGENT_OWNER are in its env — fez-acp put
// them there), or the OWNER inspecting/seeding a local agent's memory
// with --persona (the agent key lives in local custody, and the
// conversation key is symmetric, so both sides read the same records).

const mem = program.command("mem").description("Agent memory (NIP-AE engrams) — set/get/list persistent agent memory");

interface MemContext {
  agentSecret: Uint8Array;
  agentPubkey: string;
  ownerPubkey: string;
  relayUrl: string;
}

async function memContext(personaFlag?: string): Promise<MemContext> {
  const { getKey } = await import("../identity/keys.js");
  const { resolveRelay } = await import("../shared/settings.js");
  const { getPublicKey: pk } = await import("nostr-tools/pure");
  const persona = personaFlag ?? process.env.FEZ_AGENT_PERSONA;
  if (!persona) {
    console.error("No persona in scope — run inside an agent shell, or pass --persona <name>.");
    process.exit(1);
  }
  const agentHex = getKey(`agent:${persona}`);
  if (!agentHex) {
    console.error(`No local key for agent "${persona}" (it gets one the first time it runs).`);
    process.exit(1);
  }
  const ownerPubkey =
    process.env.FEZ_AGENT_OWNER ??
    (() => {
      const hex = getKey("default");
      return hex ? pk(Uint8Array.from(Buffer.from(hex, "hex"))) : undefined;
    })();
  if (!ownerPubkey) {
    console.error("No owner in scope (FEZ_AGENT_OWNER unset and no default identity).");
    process.exit(1);
  }
  const agentSecret = Uint8Array.from(Buffer.from(agentHex, "hex"));
  return { agentSecret, agentPubkey: pk(agentSecret), ownerPubkey, relayUrl: resolveRelay() };
}

/** Query all engram candidates for the pair; returns heads map. */
async function memHeads(ctx: MemContext) {
  const { RelayConnection } = await import("../protocol/relay.js");
  const { conversationKey, engramHeads, KIND_AGENT_ENGRAM } = await import("../agent/engram.js");
  const relay = new RelayConnection({ url: ctx.relayUrl });
  await relay.connect();
  const events = await relay.query([{ kinds: [KIND_AGENT_ENGRAM], authors: [ctx.agentPubkey], "#p": [ctx.ownerPubkey] }]);
  const convKey = conversationKey(ctx.agentSecret, ctx.ownerPubkey);
  return { relay, convKey, heads: engramHeads(events as never, ctx.agentPubkey, ctx.ownerPubkey, convKey) };
}

mem
  .command("set <slug> <text>")
  .description('Write a memory record ("core" or "mem/...") — as the agent in scope')
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (slug: string, text: string, options) => {
    const { isValidSlug, buildEngramEvent } = await import("../agent/engram.js");
    const { finalizeEvent } = await import("nostr-tools/pure");
    if (!isValidSlug(slug)) {
      console.error(`Bad slug "${slug}" — use "core" or mem/<lowercase-alnum-_->[/...]`);
      process.exit(1);
    }
    const ctx = await memContext(options.persona);
    const { relay, convKey, heads } = await memHeads(ctx);
    const prior = heads.get(slug);
    // Monotonic created_at defeats the same-second tiebreak (spec: Writing step 2).
    const createdAt = Math.max(unixNow(), (prior?.event.created_at ?? 0) + 1);
    const body = slug === "core" ? { slug, profile: text } : { slug, value: text };
    const template = buildEngramEvent(convKey, ctx.ownerPubkey, body, createdAt);
    await relay.publish(finalizeEvent({ ...template, pubkey: ctx.agentPubkey } as never, ctx.agentSecret));
    console.log(`✅ ${slug} written (${text.length} chars)`);
    relay.disconnect();
  });

mem
  .command("get <slug>")
  .description("Read a memory record")
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (slug: string, options) => {
    const ctx = await memContext(options.persona);
    const { relay, heads } = await memHeads(ctx);
    relay.disconnect();
    const head = heads.get(slug);
    if (!head || head.body.value === null) {
      console.log(`(no entry for ${slug})`);
      process.exitCode = 1;
      return;
    }
    console.log(slug === "core" ? head.body.profile : head.body.value);
  });

mem
  .command("del <slug>")
  .description("Tombstone a mem/... record (core cannot be deleted, only rewritten)")
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (slug: string, options) => {
    if (slug === "core") {
      console.error('core cannot be tombstoned — rewrite it with `fez mem set core "..."`.');
      process.exit(1);
    }
    const { buildEngramEvent } = await import("../agent/engram.js");
    const { finalizeEvent } = await import("nostr-tools/pure");
    const ctx = await memContext(options.persona);
    const { relay, convKey, heads } = await memHeads(ctx);
    const createdAt = Math.max(unixNow(), (heads.get(slug)?.event.created_at ?? 0) + 1);
    const template = buildEngramEvent(convKey, ctx.ownerPubkey, { slug, value: null }, createdAt);
    await relay.publish(finalizeEvent({ ...template, pubkey: ctx.agentPubkey } as never, ctx.agentSecret));
    console.log(`🪦 ${slug} tombstoned`);
    relay.disconnect();
  });

mem
  .command("list")
  .description("List memory entries (and whether a core exists)")
  .option("--persona <name>", "agent persona (default: FEZ_AGENT_PERSONA)")
  .action(async (options) => {
    const ctx = await memContext(options.persona);
    const { relay, heads } = await memHeads(ctx);
    relay.disconnect();
    const core = heads.get("core");
    console.log(core ? `core: ${(core.body.profile ?? "").slice(0, 80)}${(core.body.profile ?? "").length > 80 ? "…" : ""}` : "core: (not set)");
    const entries = [...heads.values()]
      .filter((h) => h.body.slug !== "core" && h.body.value !== null)
      .sort((a, b) => a.body.slug.localeCompare(b.body.slug));
    for (const entry of entries) {
      console.log(`  ${entry.body.slug}: ${String(entry.body.value).slice(0, 70)}`);
    }
    if (entries.length === 0) console.log("  (no memory entries)");
  });
}
