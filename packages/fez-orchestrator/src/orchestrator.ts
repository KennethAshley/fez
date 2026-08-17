#!/usr/bin/env node
import {
  RelayConnection,
  CapabilityClient,
  findPersona,
  KIND_AGENT_ATTESTATION,
  KIND_AGENT_METADATA,
  KIND_CHANNEL,
  KIND_CHANNEL_MESSAGE,
  KIND_DELETION,
  KIND_MEMBERSHIP,
  KIND_REACTION,
} from "@fez/protocol";
import { isSmallTalk, agentTool } from "./route-logic.js";
import { loadServiceKey, resolveChannels, parseThreadRef } from "./service-common.js";

/**
 * @fez — the orchestrator. A standing agent (run via `fez run`, same
 * shape as channel-agent) that routes: mention @fez with a task and it
 * decides which agent should take it, then @-mentions that agent in the
 * same thread. From there every existing primitive does the rest —
 * auto-spawn picks the agent up, reactions/typing/drafts fire, the reply
 * threads under your message. fez needs no special powers; it routes by
 * speaking the protocol like everyone else.
 *
 * WHO it can route to comes off the wire, not from a registry: every
 * agent's 47000 metadata (name, about, skills) becomes one function in
 * an OpenAI function-calling request. The router model only picks the
 * function; the routed message carries the ORIGINAL request text —
 * small routers extract lossy task spans, so we never trust them with
 * the words, only the choice.
 *
 * The model behind it is a seam: FEZ_ORCHESTRATOR_URL is any
 * OpenAI-compatible endpoint. The reference setup is fully local —
 * cactus serve + needle (a 26M-param tool-calling model):
 *
 *   brew install cactus-compute/cactus/cactus
 *   cactus serve Cactus-Compute/needle --no-cloud-handoff --no-cloud-tele
 *
 * Prompt shape is tuned for tiny routers (verified against needle): no
 * system message, tool name = agent name, verb-heavy description.
 * Bigger endpoints just route better with the same shape.
 *
 * Config (env):
 *   FEZ_ORCHESTRATOR_URL    OpenAI-compatible base (default http://127.0.0.1:8080/v1)
 *   FEZ_ORCHESTRATOR_MODEL  model id (default: first model the endpoint lists)
 *   FEZ_ORCHESTRATOR_NAME   the orchestrator's @name (default fez)
 *   FEZ_AGENT_CHANNELS      comma-separated channel names/ids to serve
 *   FEZ_AGENT_RESPOND_TO    anyone | owner | allowlist:<pk,...> (default owner)
 *   FEZ_AGENT_OWNER         owner pubkey (owner mode + sibling gate)
 */
const MAX_CHAIN_DEPTH = 5;

interface KnownAgent {
  pubkey: string;
  name: string;
  about?: string;
  skills?: string[];
  tasks?: string[];
  updatedAt: number;
}

async function main() {
  const relayUrl = process.env.FEZ_RELAY || "wss://relay.damus.io";
  const name = process.env.FEZ_ORCHESTRATOR_NAME || "fez";

  // Primary config is a persona file, same as every other agent —
  // ~/.fez/personas/fez.md; env vars are overrides. Frontmatter:
  //   harness: router            required by the persona loader; marks
  //                              this as not-a-channel-agent (no such
  //                              harness exists to spawn)
  //   url: http://127.0.0.1:8080/v1   OpenAI-compatible router endpoint
  //   model: needle-prebuilt     optional; auto-discovered when absent
  //   channels: [general]        channels to orchestrate
  //   aliases: [orchestrator]    extra @names that reach it
  //   description: ...           47000 about
  // Body = the greeting fez opens with (roster appended).
  const persona = await findPersona(name);
  const listRaw = (raw?: string) => (raw ?? "").replace(/^\[|\]$/g, "");
  const baseUrl = (process.env.FEZ_ORCHESTRATOR_URL || persona?.extra.url || "http://127.0.0.1:8080/v1").replace(/\/$/, "");
  const channelSpecs = (process.env.FEZ_AGENT_CHANNELS || listRaw(persona?.extra.channels))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const respondTo = process.env.FEZ_AGENT_RESPOND_TO || persona?.extra.respondTo || "owner";
  const owner = process.env.FEZ_AGENT_OWNER || persona?.extra.owner;

  if (channelSpecs.length === 0) {
    console.error(
      `No channels configured — add "channels: [general]" to ~/.fez/personas/${name}.md or set FEZ_AGENT_CHANNELS.`
    );
    process.exit(1);
  }

  // Model id: env wins, then the persona file; otherwise ask the endpoint.
  let model = process.env.FEZ_ORCHESTRATOR_MODEL || persona?.extra.model;
  if (!model) {
    try {
      const res = await fetch(`${baseUrl}/models`);
      const body = (await res.json()) as { data?: { id: string }[] };
      model = body.data?.[0]?.id;
    } catch {
      /* endpoint down — reported below */
    }
  }
  if (!model) {
    console.error(`No model at ${baseUrl} — is the router endpoint running? (e.g. cactus serve Cactus-Compute/needle)`);
    process.exit(1);
  }

  const client = new CapabilityClient({ relay: relayUrl, privateKey: loadServiceKey(name) });
  const relay = new RelayConnection({ url: relayUrl, authSigner: client.authSigner });
  await relay.connect();
  const myPubkey = client.getPubkey();
  const channels = await resolveChannels(relay, channelSpecs, relayUrl);

  const allowlist = respondTo.startsWith("allowlist:")
    ? new Set(respondTo.slice("allowlist:".length).split(",").map((s) => s.trim()))
    : undefined;

  // Sibling gate, same shape as channel-agent: only the owner's 47006
  // attestations make a pubkey family.
  const siblingCache = new Map<string, { verdict: boolean; ts: number }>();
  async function isSibling(pubkey: string): Promise<boolean> {
    if (!owner) return false;
    const cached = siblingCache.get(pubkey);
    if (cached && (cached.verdict || Date.now() - cached.ts < 300_000)) return cached.verdict;
    const attestations = await relay
      .query([{ kinds: [KIND_AGENT_ATTESTATION], authors: [owner], "#p": [pubkey] }])
      .catch(() => []);
    const verdict = attestations.length > 0;
    siblingCache.set(pubkey, { verdict, ts: Date.now() });
    return verdict;
  }
  async function authorAllowed(pubkey: string): Promise<boolean> {
    if (respondTo === "anyone") return true;
    if (pubkey === owner) return true;
    if (allowlist?.has(pubkey)) return true;
    return isSibling(pubkey);
  }

  // Routing turns are cheap but a mention flood shouldn't fan out to the
  // whole fleet — budget is the backstop, like channel-agent's.
  const maxTurnsPerHour = Number(process.env.FEZ_AGENT_MAX_TURNS_PER_HOUR || 60);
  const turnTimes: number[] = [];
  function budgetExhausted(): boolean {
    const cutoff = Date.now() - 3_600_000;
    while (turnTimes.length > 0 && turnTimes[0] < cutoff) turnTimes.shift();
    return turnTimes.length >= maxTurnsPerHour;
  }

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
      console.warn(`⚠️  Not a member of channel ${channelId} — messages will be dropped by other clients until the creator runs /invite ${myPubkey} bot`);
    }
  }

  // ── Roster: every agent that has ever announced itself (47000 is a
  // stored kind — agents that aren't running right now still count;
  // mentioning them triggers auto-spawn). Latest event per pubkey wins.
  const roster = new Map<string, KnownAgent>(); // pubkey -> agent
  const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/; // OpenAI function-name charset
  function absorbAgent(event: { pubkey: string; created_at: number; content: string }): KnownAgent | undefined {
    if (event.pubkey === myPubkey) return undefined;
    const existing = roster.get(event.pubkey);
    if (existing && event.created_at <= existing.updatedAt) return undefined;
    try {
      const meta = JSON.parse(event.content) as { name?: string; about?: string; skills?: string[]; supported_tasks?: string[] };
      if (!meta.name || !NAME_RE.test(meta.name) || meta.name === name) return undefined;
      const agent: KnownAgent = {
        pubkey: event.pubkey,
        name: meta.name,
        about: typeof meta.about === "string" ? meta.about : undefined,
        skills: Array.isArray(meta.skills) ? meta.skills.filter((s): s is string => typeof s === "string") : undefined,
        tasks: Array.isArray(meta.supported_tasks) ? meta.supported_tasks.filter((s): s is string => typeof s === "string") : undefined,
        updatedAt: event.created_at,
      };
      roster.set(event.pubkey, agent);
      return agent;
    } catch {
      return undefined;
    }
  }
  const metadataEvents = await relay.query([{ kinds: [KIND_AGENT_METADATA] }]);
  for (const event of metadataEvents.sort((a, b) => a.created_at - b.created_at)) absorbAgent(event);

  // One tool per agent. Tuned for tiny routers, verified against needle:
  // the tool NAME carries most of the routing signal (researcher/reviewer
  // route 6/6, opaque names like scout/critic misroute) — so the name IS
  // the agent name, descriptions are supporting detail. Services that
  // don't take chat (no "channel-chat" in supported_tasks) aren't
  // routable and would only add noise a small model trips over.
  function buildTools(): { tools: object[]; byName: Map<string, KnownAgent> } {
    const byName = new Map<string, KnownAgent>();
    const tools: object[] = [];
    for (const agent of roster.values()) {
      if (agent.tasks && !agent.tasks.includes("channel-chat")) continue;
      if (byName.has(agent.name) && byName.get(agent.name)!.updatedAt >= agent.updatedAt) continue;
      byName.set(agent.name, agent);
    }
    for (const agent of byName.values()) tools.push(agentTool(agent));
    return { tools, byName };
  }

  /** Ask the router model who should take this. Returns agent names, deduped, routable-only. */
  async function route(message: string): Promise<string[]> {
    const { tools, byName } = buildTools();
    if (tools.length === 0) return [];
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: message }],
        tools,
      }),
    });
    if (!res.ok) throw new Error(`router ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[];
    };
    const calls = body.choices?.[0]?.message?.tool_calls ?? [];
    const picked: string[] = [];
    for (const call of calls) {
      const toolName = call.function?.name;
      if (toolName && byName.has(toolName) && !picked.includes(toolName)) picked.push(toolName);
    }
    return picked;
  }

  // Routing fires ONLY on an explicit @name in the text — never on a bare
  // p-tag. Channel agents p-tag whoever they're answering, so fez's own
  // routed handoffs come back as replies p-tagging fez; treating those as
  // requests re-routes every ANSWER (live-tested: one question echoed
  // through the roster until the depth cap). Explicit @fez = a request;
  // a p-tag alone = reply addressing. Persona aliases are extra @names.
  const mentionNames = [name, ...(persona?.aliases ?? [])].filter((n) => /^[\w-]+$/.test(n));
  const nameMentionRe = new RegExp(`(^|\\W)@(${mentionNames.join("|")})\\b`, "i");
  const isMention = (event: { content: string; tags: string[][] }) => nameMentionRe.test(event.content);

  const announce = async () => {
    await relay.publish(
      client.signEvent({
        kind: KIND_AGENT_METADATA,
        tags: [],
        content: JSON.stringify({
          name,
          supported_tasks: ["orchestrate"],
          about: persona?.description ?? `Orchestrator — mention @${name} with a task and it brings in the right agent.`,
          aliases: persona?.aliases,
        }),
      })
    );
  };
  await announce();
  const heartbeat = setInterval(announce, 12 * 60 * 60 * 1000);

  const say = async (channelId: string, communityId: string, content: string, extraTags: string[][] = []) => {
    await relay.publish(
      client.signEvent({
        kind: KIND_CHANNEL_MESSAGE,
        tags: [["h", channelId], ["c", communityId], ...extraTags],
        content,
      })
    );
  };

  // Channel id -> community id, learned from traffic and channel metadata;
  // greetings need a community tag before any message has arrived.
  const communityOf = new Map<string, string>();
  {
    const channelMeta = await relay.query([{ kinds: [KIND_CHANNEL], "#d": channels }]);
    for (const event of channelMeta) {
      const d = event.tags.find((t) => t[0] === "d")?.[1];
      const c = event.tags.find((t) => t[0] === "c")?.[1];
      if (d && c) communityOf.set(d, c);
    }
  }

  // ── The pop-in: fez says hi when it arrives, with the current crew
  // (the ROUTABLE crew — same filter the router sees, so the greeting
  // never advertises an agent fez wouldn't actually hand work to).
  // Names are deliberately NOT @-prefixed anywhere ambient: channel
  // agents treat their @name in any sibling message as a mention, so an
  // @-studded greeting would summon the entire roster just to say hi.
  // @ is reserved for actual routing.
  const routableNames = () => [...buildTools().byName.keys()];
  const rosterLine = () => {
    const names = routableNames();
    return names.length > 0 ? ` On deck: ${names.join(", ")}.` : "";
  };
  // Persona body = the user's own greeting voice; canned lines otherwise.
  const GREETINGS = persona?.systemPrompt
    ? [persona.systemPrompt.split(/\n\s*\n/)[0].trim()]
    : [
        `👋 ${name} here — mention @${name} with a task and I'll pull in the right agent.`,
        `🎩 @${name} online. Toss me anything and I'll find who should take it.`,
        `👋 popping in — need something done but not sure who does it? Just @${name} it.`,
      ];
  for (const channelId of channels) {
    const communityId = communityOf.get(channelId);
    if (!communityId) continue;
    await say(channelId, communityId, GREETINGS[Math.floor(Math.random() * GREETINGS.length)] + rosterLine()).catch(() => {});
  }

  console.log(`🟢 @${name} orchestrating ${channels.length} channel(s) on ${relayUrl}`);
  console.log(`   Router: ${baseUrl} (${model}) | roster: ${roster.size} agent(s) | respondTo: ${respondTo}`);

  const handleMention = async (event: {
    id: string;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  }): Promise<void> => {
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    const communityId = event.tags.find((t) => t[0] === "c")?.[1];
    if (!channelId || !communityId || event.pubkey === myPubkey) return;
    communityOf.set(channelId, communityId);
    if (!isMention(event)) return;
    if (!(await authorAllowed(event.pubkey))) return;
    if (!(memberships.get(channelId)?.members.has(event.pubkey) ?? false)) return;

    const triggerDepth = Number(event.tags.find((t) => t[0] === "depth")?.[1] ?? 0);
    if (triggerDepth >= MAX_CHAIN_DEPTH) return;
    if (budgetExhausted()) {
      console.log(`⛔ Turn budget exhausted (${maxTurnsPerHour}/hour) — not routing`);
      return;
    }
    turnTimes.push(Date.now());

    // 👀 while routing; deleted when the routed mention is out. Same
    // ReactionGuard shape as channel-agent — status, not history.
    const statusReactionIds: string[] = [];
    try {
      const reaction = client.signEvent({
        kind: KIND_REACTION,
        tags: [["e", event.id], ["h", channelId], ["c", communityId], ["p", event.pubkey]],
        content: "👀",
      });
      statusReactionIds.push(reaction.id);
      void relay.publish(reaction).catch(() => {});
    } catch { /* cosmetic */ }

    // NIP-10: route INTO the thread of the trigger, so the target agent's
    // reply lands under the user's message.
    const { rootId } = parseThreadRef(event.tags);
    const threadTags = [
      ...(rootId ? [["e", rootId, "", "root"]] : []),
      ["e", event.id, "", "reply"],
      ["depth", String(triggerDepth + 1)],
    ];

    // The router picks WHO; the routed message carries the user's own
    // words. Tiny models extract lossy task spans — never let the router
    // rewrite the request.
    const cleaned = event.content.replace(nameMentionRe, "$1").replace(/\s+/g, " ").trim();

    // Small talk never reaches the router — measured: needle routes "yo"
    // to an agent and returns nothing for "how are you?" (a routing
    // model always wants to route). Greetings are cheap to detect
    // deterministically, and fez answering in person beats delegating
    // your hello to a research agent.
    if (isSmallTalk(cleaned)) {
      const names = routableNames();
      const replies = [
        `🎩 all good — router's warm${names.length > 0 ? `, ${names.join(" and ")} on deck` : ""}. Toss me a task and I'll route it.`,
        `👋 hey! Around and routing. Need something done?`,
        `Doing great.${names.length > 0 ? ` On deck: ${names.join(", ")}.` : ""} What can I route for you?`,
      ];
      console.log(`💬 Small talk from ${event.pubkey.slice(0, 8)} — answering in person`);
      await say(channelId, communityId, replies[Math.floor(Math.random() * replies.length)], threadTags).catch(() => {});
      if (statusReactionIds.length > 0) {
        void relay
          .publish(
            client.signEvent({
              kind: KIND_DELETION,
              tags: [...statusReactionIds.map((id) => ["e", id]), ["h", channelId], ["c", communityId]],
              content: "",
            })
          )
          .catch(() => {});
      }
      return;
    }
    try {
      const picked = await route(cleaned || event.content);
      if (picked.length > 0) {
        const { byName } = buildTools();
        for (const agentName of picked) {
          const agent = byName.get(agentName)!;
          await say(channelId, communityId, `@${agentName} ${cleaned}`, [
            ...threadTags,
            ["p", agent.pubkey],
          ]);
          console.log(`🎯 Routed to @${agentName}: ${cleaned.slice(0, 60)}`);
        }
      } else {
        const names = routableNames();
        await say(
          channelId,
          communityId,
          names.length > 0
            ? `Hmm, not sure who's best for that. Around here: ${names.join(", ")} — mention one directly?`
            : `Nobody's announced themselves yet — once agents are registered I'll route to them.`,
          // plain names on purpose — an @-list here would summon everyone
          threadTags
        );
      }
    } catch (err) {
      console.error(`❌ Routing failed:`, err instanceof Error ? err.message : err);
      await say(channelId, communityId, `⚠️ My router isn't reachable right now (${baseUrl}).`, threadTags).catch(() => {});
    } finally {
      if (statusReactionIds.length > 0) {
        void relay
          .publish(
            client.signEvent({
              kind: KIND_DELETION,
              tags: [...statusReactionIds.map((id) => ["e", id]), ["h", channelId], ["c", communityId]],
              content: "",
            })
          )
          .catch(() => {});
      }
    }
  };

  // Welcome pop-in: a 47000 from a pubkey we've never seen while we're
  // running = someone new came online. One welcome per pubkey per process,
  // rate-limited so a fleet restart doesn't turn into a parade.
  const welcomed = new Set<string>(roster.keys());
  let lastWelcomeAt = 0;
  relay.subscribe(
    [
      { kinds: [KIND_CHANNEL_MESSAGE], "#h": channels, since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_MEMBERSHIP], "#d": channels, since: Math.floor(Date.now() / 1000) },
      { kinds: [KIND_AGENT_METADATA], since: Math.floor(Date.now() / 1000) },
    ],
    (event) => {
      if (event.kind === KIND_MEMBERSHIP) {
        absorbMembership(event);
        return;
      }
      if (event.kind === KIND_AGENT_METADATA) {
        const fresh = absorbAgent(event);
        if (fresh && !welcomed.has(fresh.pubkey) && Date.now() - lastWelcomeAt > 60_000) {
          welcomed.add(fresh.pubkey);
          lastWelcomeAt = Date.now();
          for (const channelId of channels) {
            const communityId = communityOf.get(channelId);
            if (communityId) void say(channelId, communityId, `👋 ${fresh.name} just came online — I'll loop them in when something fits.`).catch(() => {});
          }
        } else if (fresh) {
          welcomed.add(fresh.pubkey);
        }
        return;
      }
      void handleMention(event);
    }
  );

  process.on("SIGINT", () => {
    clearInterval(heartbeat);
    const goodbyes = channels
      .map((channelId) => {
        const communityId = communityOf.get(channelId);
        return communityId ? say(channelId, communityId, `🎩 ${name} ducking out — back soon.`).catch(() => {}) : Promise.resolve();
      });
    void Promise.allSettled(goodbyes).then(() => {
      relay.disconnect();
      console.log(`\n🔴 @${name} stopped.`);
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
