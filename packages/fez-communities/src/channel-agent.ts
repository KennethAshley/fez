#!/usr/bin/env node
import {
  RelayConnection,
  CapabilityClient,
  findHarness,
  findPersona,
  findMcpServer,
  registerBuiltinHarnesses,
  KIND_AGENT_METADATA,
  KIND_CHANNEL_MESSAGE,
  KIND_DELETION,
  KIND_MEMBERSHIP,
  KIND_REACTION,
  KIND_TYPING,
} from "@fez/protocol";
import { loadServiceKey, resolveChannels } from "./service-common.js";

/**
 * Standing channel agent — Buzz-style. Runs as its own process via
 * `fez run` (which passes FEZ_RELAY / FEZ_PRIVATE_KEY through env, see
 * fez's cli.ts). Subscribes to its channels, fires the persona's harness
 * when a channel message p-tags it, replies into the channel over the
 * relay. The TUI never dispatches these — anyone in the channel can
 * mention this agent while your terminal is closed.
 *
 * Config (env):
 *   FEZ_AGENT_PERSONA     persona id (harness + prompt + skills, ~/.fez/personas)
 *   FEZ_AGENT_CHANNELS    comma-separated channel ids to serve
 *   FEZ_AGENT_RESPOND_TO  who may trigger it: anyone | owner | allowlist:<pk,pk,...>
 *   FEZ_AGENT_OWNER       owner pubkey (required for owner mode)
 *
 * Author gate = respondTo policy AND membership in the channel's winning
 * 47102 (same client-side trust rules as the TUI extension). On startup it
 * checks its own membership per channel and warns loudly if missing —
 * other clients drop replies from non-members until the creator /invites
 * this agent's pubkey (role: bot).
 */
async function main() {
  const relayUrl = process.env.FEZ_RELAY || "wss://relay.damus.io";
  const personaId = process.env.FEZ_AGENT_PERSONA;
  const channelSpecs = (process.env.FEZ_AGENT_CHANNELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const respondTo = process.env.FEZ_AGENT_RESPOND_TO || "owner";
  const owner = process.env.FEZ_AGENT_OWNER;

  if (!personaId || channelSpecs.length === 0) {
    console.error("Usage: FEZ_AGENT_PERSONA=<id> FEZ_AGENT_CHANNELS=<name-or-id,...> [FEZ_AGENT_RESPOND_TO=anyone|owner|allowlist:<pks>] fez run channel-agent.js");
    process.exit(1);
  }

  registerBuiltinHarnesses();
  const persona = await findPersona(personaId);
  if (!persona) {
    console.error(`No persona "${personaId}" (looked in ~/.fez/personas/)`);
    process.exit(1);
  }
  const harness = findHarness(persona.harness);
  if (!harness || !(await harness.detect())) {
    console.error(`Persona "${personaId}" needs harness "${persona.harness}" which isn't available`);
    process.exit(1);
  }
  const mcpServers = persona.mcpServers
    .map((name) => findMcpServer(name))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);

  // Identity: one stable key per persona (~/.fez/agents/<persona>.key).
  // Deliberately NOT process.env.FEZ_PRIVATE_KEY — `fez run` fills that
  // from ~/.fez/default.key (the *user's* identity), and an agent must not
  // impersonate its owner: invites, membership, and respondTo gates are
  // all bound to the agent's own pubkey surviving restarts.
  const client = new CapabilityClient({ relay: relayUrl, privateKey: loadServiceKey(personaId) });
  const relay = new RelayConnection({ url: relayUrl });
  await relay.connect();
  const myPubkey = client.getPubkey();

  const channels = await resolveChannels(relay, channelSpecs, relayUrl);

  const allowlist = respondTo.startsWith("allowlist:")
    ? new Set(respondTo.slice("allowlist:".length).split(",").map((s) => s.trim()))
    : undefined;

  function authorAllowed(pubkey: string): boolean {
    if (respondTo === "anyone") return true;
    if (allowlist) return allowlist.has(pubkey);
    return owner !== undefined && pubkey === owner; // owner mode
  }

  // Channel membership (latest creator-signed 47102 per channel). The
  // creator pubkey isn't known here, so v1 takes the latest 47102 per
  // d-tag — same-relay assumption as the rest of the client-side model.
  const memberships = new Map<string, { createdAt: number; members: Set<string> }>();
  function absorbMembership(event: { created_at: number; tags: string[][] }): void {
    const channelId = event.tags.find((t) => t[0] === "d")?.[1];
    if (!channelId || !channels.includes(channelId)) return;
    const existing = memberships.get(channelId);
    if (existing && event.created_at < existing.createdAt) return;
    const members = new Set<string>(event.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]));
    memberships.set(channelId, { createdAt: event.created_at, members });
  }

  const membershipEvents = await relay.query([{ kinds: [KIND_MEMBERSHIP], "#d": channels }]);
  for (const event of membershipEvents) absorbMembership(event);
  for (const channelId of channels) {
    if (!memberships.get(channelId)?.members.has(myPubkey)) {
      console.warn(`⚠️  Not a member of channel ${channelId} — replies will be dropped by other clients until the creator runs /invite ${myPubkey} bot`);
    }
  }

  // Announce identity so TUIs show a name instead of a truncated pubkey.
  const announce = async () => {
    const event = client.signEvent({
      kind: KIND_AGENT_METADATA,
      tags: [],
      content: JSON.stringify({ name: personaId, supported_tasks: ["channel-chat"] }),
    });
    await relay.publish(event);
  };
  await announce();
  const heartbeat = setInterval(announce, 12 * 60 * 60 * 1000);

  console.log(`🟢 @${personaId} standing by in ${channels.length} channel(s) on ${relayUrl}`);
  console.log(`   Pubkey: ${myPubkey} | respondTo: ${respondTo}`);

  const recent = new Map<string, string[]>(); // channelId -> last few messages, as harness context
  let busy = false;

  relay.subscribe(
    [
      { kinds: [KIND_CHANNEL_MESSAGE], "#h": channels, since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_MEMBERSHIP], "#d": channels, since: Math.floor(Date.now() / 1000) },
    ],
    async (event) => {
      if (event.kind === KIND_MEMBERSHIP) {
        absorbMembership(event);
        return;
      }
      const channelId = event.tags.find((t) => t[0] === "h")?.[1];
      const communityId = event.tags.find((t) => t[0] === "c")?.[1];
      if (!channelId || !communityId || event.pubkey === myPubkey) return;

      const context = recent.get(channelId) ?? [];
      context.push(`${event.pubkey.slice(0, 8)}: ${event.content}`);
      recent.set(channelId, context.slice(-10));

      const mentioned = event.tags.some((t) => t[0] === "p" && t[1] === myPubkey);
      const authorIsMember = memberships.get(channelId)?.members.has(event.pubkey) ?? false;

      if (!mentioned) return;
      if (!authorAllowed(event.pubkey)) return;
      if (!authorIsMember) return;
      if (busy) return; // one turn at a time, v1

      busy = true;

      // Status-reaction lifecycle, Buzz's model (buzz-acp ReactionGuard):
      // 👀 "seen, will handle" the moment the mention is accepted, 💬
      // "working" when the turn starts, and BOTH deleted when the turn
      // ends — the reply is the permanent artifact, the reactions are
      // live status. Fire-and-forget throughout; reactions are cosmetic.
      const statusReactionIds: string[] = [];
      const react = async (emoji: string) => {
        try {
          const reaction = client.signEvent({
            kind: KIND_REACTION,
            tags: [["e", event.id], ["h", channelId], ["c", communityId], ["p", event.pubkey]],
            content: emoji,
          });
          statusReactionIds.push(reaction.id);
          await relay.publish(reaction);
        } catch { /* cosmetic */ }
      };
      const clearStatusReactions = () => {
        if (statusReactionIds.length === 0) return;
        void relay
          .publish(
            client.signEvent({
              kind: KIND_DELETION,
              tags: [...statusReactionIds.map((id) => ["e", id]), ["h", channelId], ["c", communityId]],
              content: "",
            })
          )
          .catch(() => {});
      };
      void react("👀");
      // Slack-style "is typing": heartbeat an ephemeral 20002 into the
      // channel while the harness turn runs; receivers expire it
      // client-side, so no stop event is needed (crash-safe by design).
      // Typing scope follows where the trigger came from (Buzz carries
      // NIP-10 markers on typing events): a mention inside a thread means
      // thread-scoped typing; a plain channel mention means channel-scoped
      // — the mentioning user is looking at the channel view, and a
      // thread-scoped indicator there would be invisible to them.
      const typingThreadRoot =
        event.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ??
        event.tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
      const typing = setInterval(() => {
        void relay
          .publish(
            client.signEvent({
              kind: KIND_TYPING,
              tags: [
                ["h", channelId],
                ["c", communityId],
                ...(typingThreadRoot ? [["e", typingThreadRoot, "", "root"]] : []),
              ],
              content: JSON.stringify({ name: personaId }),
            })
          )
          .catch(() => {});
      }, 3000);
      try {
        const prompt = [
          persona.systemPrompt ?? "",
          `You are @${personaId}, responding in a group chat channel. Recent messages:`,
          ...(recent.get(channelId) ?? []),
          `Reply to the last message that mentioned you. Be concise — this is chat.`,
        ].filter(Boolean).join("\n\n");

        console.log(`💬 Mention from ${event.pubkey.slice(0, 8)}… — invoking ${persona.harness}`);
        void react("💬"); // "working" — the turn is actually starting
        const reply = await harness.invoke(prompt, process.cwd(), undefined, mcpServers);

        // NIP-10 markers, Buzz's exact shape (threading.ts): replying to a
        // message that's already in a thread carries that thread's root as
        // a root-marked tag; replying to a root message carries only the
        // reply marker (the trigger IS the root). Root of the trigger =
        // its root-marked e-tag, falling back to its reply-marked parent.
        const triggerParent = event.tags.filter((t) => t[0] === "e" && t[3] === "reply").at(-1)?.[1];
        const triggerRoot = event.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? triggerParent;
        const replyEvent = client.signEvent({
          kind: KIND_CHANNEL_MESSAGE,
          tags: [
            ["h", channelId],
            ["c", communityId],
            ...(triggerRoot ? [["e", triggerRoot, "", "root"]] : []),
            ["e", event.id, "", "reply"],
            ["p", event.pubkey],
          ],
          content: reply,
        });
        await relay.publish(replyEvent);
        console.log(`✅ Replied (${reply.length} chars)`);
      } catch (err) {
        console.error(`❌ Turn failed:`, err instanceof Error ? err.message : err);
      } finally {
        // Buzz's ReactionGuard shape: status reactions clear on every exit
        // path — the reply (or nothing, on failure) is what remains.
        clearStatusReactions();
        clearInterval(typing);
        busy = false;
      }
    }
  );

  process.on("SIGINT", () => {
    clearInterval(heartbeat);
    relay.disconnect();
    console.log(`\n🔴 @${personaId} stopped.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
