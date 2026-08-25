/** fez doc — the channel's living document (kind 40100, Buzz's canvas). */
import type { Command } from "commander";
import { unixNow } from "../shared/time.js";

export function registerDocCommands(program: Command): void {
// ─── doc — the channel's living document (kind 40100, Buzz's canvas) ────────
// Agent-facing like `fez mem`: agents APPEND by default (append-only
// contributions don't clobber each other); `set` replaces wholesale and is
// for when someone asked for a rewrite. Signs as the persona in scope
// (FEZ_AGENT_PERSONA / --persona), else as the user.

const doc = program.command("doc").description("Channel doc (shared markdown, kind 40100) — append/set/get as the identity in scope");

interface DocCliContext {
  secret: Uint8Array;
  pubkey: string;
  relay: import("../protocol/relay.js").RelayConnection;
  channelId: string;
  latest?: { id: string; created_at: number; content: string };
}

async function docContext(channelFlag: string | undefined, personaFlag: string | undefined): Promise<DocCliContext> {
  const { getKey } = await import("../identity/keys.js");
  const { resolveRelays } = await import("../shared/settings.js");
  const { getPublicKey: pk } = await import("nostr-tools/pure");
  const { RelayConnection } = await import("../protocol/relay.js");
  const persona = personaFlag ?? process.env.FEZ_AGENT_PERSONA;
  const hex = persona ? getKey(`agent:${persona}`) : getKey("default");
  if (!hex) {
    console.error(persona ? `No local key for agent "${persona}".` : "No fez identity — fez keygen first.");
    process.exit(1);
  }
  const channelSpec = channelFlag ?? process.env.FEZ_DOC_CHANNEL;
  if (!channelSpec) {
    console.error("No channel — pass --channel <name-or-id>.");
    process.exit(1);
  }
  const relay = new RelayConnection({ urls: resolveRelays() });
  await relay.connect();
  // Resolve name-or-id against stored 47101s; the community rides the c tag.
  const channels = await relay.query([{ kinds: [47101] }]);
  const match = channels.find((e) => {
    const d = e.tags.find((t) => t[0] === "d")?.[1];
    if (d === channelSpec) return true;
    try {
      return (JSON.parse(e.content).name ?? "").toLowerCase() === channelSpec.replace(/^#/, "").toLowerCase();
    } catch {
      return false;
    }
  });
  const channelId = match?.tags.find((t) => t[0] === "d")?.[1];
  if (!channelId) {
    console.error(`No channel "${channelSpec}" on the relay.`);
    relay.disconnect();
    process.exit(1);
  }
  const versions = await relay.query([{ kinds: [40100], "#h": [channelId], limit: 200 }]);
  const latest = versions.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1)).at(-1);
  const secret = Uint8Array.from(Buffer.from(hex, "hex"));
  return { secret, pubkey: pk(secret), relay, channelId, latest };
}

async function docPublish(ctx: DocCliContext, content: string): Promise<void> {
  const { finalizeEvent } = await import("nostr-tools/pure");
  // Monotonic vs the latest version — same-second ties resolve by lowest
  // id, which would make concurrent-edit outcomes arbitrary.
  const createdAt = Math.max(unixNow(), (ctx.latest?.created_at ?? 0) + 1);
  await ctx.relay.publish(
    finalizeEvent(
      {
        kind: 40100,
        created_at: createdAt,
        tags: [["h", ctx.channelId], ...(ctx.latest ? [["base", ctx.latest.id]] : [])],
        content,
      },
      ctx.secret
    )
  );
}

doc
  .command("append <text>")
  .description("Add to the channel doc (the agent default — appends never clobber)")
  .option("--channel <name-or-id>", "channel (default: FEZ_DOC_CHANNEL)")
  .option("--persona <name>", "sign as this agent (default: FEZ_AGENT_PERSONA, else you)")
  .action(async (text: string, options) => {
    const ctx = await docContext(options.channel, options.persona);
    await docPublish(ctx, ctx.latest ? `${ctx.latest.content}\n\n${text.replace(/\\n/g, "\n")}` : text.replace(/\\n/g, "\n"));
    console.log(`📄 appended (${text.length} chars)`);
    ctx.relay.disconnect();
  });

doc
  .command("set <text>")
  .description("Replace the channel doc wholesale — only when a rewrite was asked for")
  .option("--channel <name-or-id>", "channel (default: FEZ_DOC_CHANNEL)")
  .option("--persona <name>", "sign as this agent (default: FEZ_AGENT_PERSONA, else you)")
  .action(async (text: string, options) => {
    const ctx = await docContext(options.channel, options.persona);
    await docPublish(ctx, text.replace(/\\n/g, "\n"));
    console.log(`📄 doc replaced (${text.length} chars)`);
    ctx.relay.disconnect();
  });

doc
  .command("get")
  .description("Print the channel doc")
  .option("--channel <name-or-id>", "channel (default: FEZ_DOC_CHANNEL)")
  .option("--persona <name>", "sign as this agent (default: FEZ_AGENT_PERSONA, else you)")
  .action(async (options) => {
    const ctx = await docContext(options.channel, options.persona);
    console.log(ctx.latest ? ctx.latest.content : "(no doc yet)");
    ctx.relay.disconnect();
  });
}
