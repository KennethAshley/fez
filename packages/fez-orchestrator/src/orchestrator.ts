#!/usr/bin/env node
import {
  RelayConnection,
  CapabilityClient,
  findPersona,
  KIND_AGENT_ATTESTATION,
  KIND_AGENT_METADATA,
  KIND_CHANNEL_MESSAGE,
  KIND_DELETION,
  KIND_MEMBERSHIP,
  KIND_REACTION,
  resolveRelays,
} from "@fez/protocol";
import {
  isSmallTalk,
  agentTool,
  fleetQuestion,
  noneTool,
  explicitActor,
  scrubNames,
  detectProfile,
  routerBody,
  type RouterProfile,
} from "./route-logic.js";
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
 * OpenAI-compatible endpoint — the hosted fez router, a local cactus +
 * needle, ollama, llama.cpp, or a cloud model.
 *
 * The seam is a URL *and a profile*, because the request shape is part
 * of the model choice. Measured on the 97-case battery: Qwen3-0.6B sent
 * needle's shape scores 70.1% vs needle's 71.1% — the bigger model buys
 * nothing by itself — while the shape it wants takes it to ~91% and
 * drops needle to 19.6%. See RouterProfile in route-logic.ts. The
 * profile is auto-detected from the model id, so a local needle setup
 * needs no config change.
 *
 * Config (env):
 *   FEZ_ORCHESTRATOR_URL      OpenAI-compatible base (default http://127.0.0.1:8080/v1)
 *   FEZ_ORCHESTRATOR_MODEL    model id (default: first model the endpoint lists)
 *   FEZ_ORCHESTRATOR_PROFILE  needle | tools (default: detected from the model id)
 *   FEZ_ORCHESTRATOR_KEY      bearer token, for endpoints that want one
 *   FEZ_ORCHESTRATOR_NAME     the orchestrator's @name (default fez)
 *   FEZ_AGENT_CHANNELS        comma-separated channel names/ids to serve
 *   FEZ_AGENT_RESPOND_TO      anyone | owner | allowlist:<pk,...> (default owner)
 *   FEZ_AGENT_OWNER           owner pubkey (owner mode + sibling gate)
 */
const MAX_CHAIN_DEPTH = 5;

interface KnownAgent {
  pubkey: string;
  name: string;
  about?: string;
  skills?: string[];
  tasks?: string[];
  /** false = infrastructure: still @mentionable, never delegated to. */
  routable?: boolean;
  updatedAt: number;
}

async function main() {
  const relayUrls = resolveRelays();
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

  // A hosted endpoint needs a credential; a loopback one never does.
  // Env is the documented home for it — a persona file is a plain
  // markdown doc people paste into issues, which is a poor place for a
  // token, so `key:` is supported for parity but not advertised.
  const routerKey = process.env.FEZ_ORCHESTRATOR_KEY || persona?.extra.key;
  const routerHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(routerKey ? { Authorization: `Bearer ${routerKey}` } : {}),
  };

  // Model id: env wins, then the persona file; otherwise ask the endpoint.
  let model = process.env.FEZ_ORCHESTRATOR_MODEL || persona?.extra.model;
  if (!model) {
    try {
      const res = await fetch(`${baseUrl}/models`, { headers: routerHeaders });
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

  // The request shape travels with the model, not the URL — see
  // RouterProfile. Auto-detection keeps every existing local cactus
  // setup on the shape it was tuned for without touching its persona.
  const profileRaw = process.env.FEZ_ORCHESTRATOR_PROFILE || persona?.extra.profile;
  if (profileRaw && profileRaw !== "needle" && profileRaw !== "tools") {
    console.error(`Unknown router profile "${profileRaw}" — expected "needle" or "tools".`);
    process.exit(1);
  }
  const profile: RouterProfile = (profileRaw as RouterProfile) || detectProfile(model);
  // Narrowed once here: `model` is a let, so its non-undefined type is
  // lost inside route()'s closure.
  const modelId: string = model;

  const client = new CapabilityClient({ relay: relayUrls, privateKey: loadServiceKey(name) });
  const relay = new RelayConnection({ urls: relayUrls, authSigner: client.authSigner });
  await relay.connect();
  const myPubkey = client.getPubkey();
  const channels = await resolveChannels(relay, channelSpecs, relayUrls.join(", "));

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
      const meta = JSON.parse(event.content) as {
        name?: string;
        about?: string;
        skills?: string[];
        supported_tasks?: string[];
        routable?: boolean;
      };
      if (!meta.name || !NAME_RE.test(meta.name) || meta.name === name) return undefined;
      const agent: KnownAgent = {
        pubkey: event.pubkey,
        name: meta.name,
        about: typeof meta.about === "string" ? meta.about : undefined,
        skills: Array.isArray(meta.skills) ? meta.skills.filter((s): s is string => typeof s === "string") : undefined,
        tasks: Array.isArray(meta.supported_tasks) ? meta.supported_tasks.filter((s): s is string => typeof s === "string") : undefined,
        routable: meta.routable !== false,
        updatedAt: event.created_at,
      };
      roster.set(event.pubkey, agent);
      return agent;
    } catch {
      return undefined;
    }
  }
  // Human display names (kind 0) — forwards carry WHO asked, and
  // "(from 4d9a4f80)" is not a who.
  const profileNames = new Map<string, string>();
  for (const event of await relay.query([{ kinds: [0], limit: 200 }])) {
    try {
      const name = (JSON.parse(event.content) as { name?: string }).name;
      if (name) profileNames.set(event.pubkey, name);
    } catch { /* ignore */ }
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
      if (agent.routable === false) continue; // infrastructure: mentionable, not delegable
      if (byName.has(agent.name) && byName.get(agent.name)!.updatedAt >= agent.updatedAt) continue;
      byName.set(agent.name, agent);
    }
    for (const agent of byName.values()) tools.push(agentTool(agent));
    if (tools.length > 0) tools.push(noneTool()); // honest exit for no-fit tasks; filtered from picks
    return { tools, byName };
  }

  /** Ask the router model who should take this. Returns agent names, deduped, routable-only. */
  async function route(message: string): Promise<string[]> {
    const { tools, byName } = buildTools();
    if (tools.length === 0) return [];
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: routerHeaders,
      body: JSON.stringify(routerBody(profile, modelId, message, tools)),
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

  const say = async (channelId: string, content: string, extraTags: string[][] = []) => {
    await relay.publish(
      client.signEvent({
        kind: KIND_CHANNEL_MESSAGE,
        tags: [["h", channelId], ...extraTags],
        content,
      })
    );
  };


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
    await say(channelId, GREETINGS[Math.floor(Math.random() * GREETINGS.length)] + rosterLine()).catch(() => {});
  }

  console.log(`🟢 @${name} orchestrating ${channels.length} channel(s) on ${relayUrls.join(", ")}`);
  console.log(
    `   Router: ${baseUrl} (${model}, ${profile}${routerKey ? ", keyed" : ""}) | roster: ${roster.size} agent(s) | respondTo: ${respondTo}`
  );

  const handleMention = async (event: {
    id: string;
    pubkey: string;
    created_at: number;
    content: string;
    tags: string[][];
  }): Promise<void> => {
    const channelId = event.tags.find((t) => t[0] === "h")?.[1];
    if (!channelId || event.pubkey === myPubkey) return;
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
        tags: [["e", event.id], ["h", channelId], ["p", event.pubkey]],
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
      await say(channelId, replies[Math.floor(Math.random() * replies.length)], threadTags).catch(() => {});
      if (statusReactionIds.length > 0) {
        void relay
          .publish(
            client.signEvent({
              kind: KIND_DELETION,
              tags: [...statusReactionIds.map((id) => ["e", id]), ["h", channelId]],
              content: "",
            })
          )
          .catch(() => {});
      }
      return;
    }
    // Fleet meta-questions ("what can researcher do?", "who's available?")
    // are fez's own to answer — it holds the roster; routing them is a
    // guaranteed misroute. Names in the reply are deliberately NOT
    // @-prefixed: siblings treat @name anywhere as a summons.
    const fleet = fleetQuestion(cleaned, routableNames());
    if (fleet) {
      const { byName } = buildTools();
      let reply: string;
      if (fleet.kind === "agent") {
        const agent = byName.get(fleet.name);
        reply = `🎩 ${fleet.name} — ${agent?.about ?? "hasn't announced a description"}${
          agent?.skills?.length ? `. Skills: ${agent.skills.join(", ")}` : ""
        }. Summon it with an @-mention.`;
      } else {
        const rows = [...byName.values()].map(
          (agent) => `• ${agent.name} — ${agent.about ?? "no description"}${agent.skills?.length ? ` (skills: ${agent.skills.join(", ")})` : ""}`
        );
        reply = rows.length > 0 ? `🎩 the fleet right now:\n${rows.join("\n")}` : "🎩 nobody has announced themselves yet.";
      }
      console.log(`📖 Fleet question from ${event.pubkey.slice(0, 8)} — answering from the roster`);
      await say(channelId, reply, threadTags).catch(() => {});
      if (statusReactionIds.length > 0) {
        void relay
          .publish(
            client.signEvent({
              kind: KIND_DELETION,
              tags: [...statusReactionIds.map((id) => ["e", id]), ["h", channelId]],
              content: "",
            })
          )
          .catch(() => {});
      }
      return;
    }
    try {
      // Deterministic pre-layers (bench-measured): an explicitly named
      // actor skips the router; remaining roster names are CONTENT and
      // get neutralized so they can't pull routing (name-as-content was
      // 2/7 before the scrub).
      const preNames = routableNames();
      const actor = explicitActor(cleaned, preNames);
      const picked = actor ? [actor] : await route(scrubNames(cleaned || event.content, preNames));
      if (picked.length > 0) {
        const { byName } = buildTools();
        // The forward names its origin: the routed agent's prompt would
        // otherwise say the message came from fez, and "Ken asked via
        // fez" vs "fez asked" changes how an agent should answer. The
        // author tag carries the pubkey for machines; the (from …)
        // prefix carries it for the model. No @ on the name — an @ is a
        // summons, and the asker doesn't need summoning.
        const askerName = roster.get(event.pubkey)?.name ?? profileNames.get(event.pubkey) ?? event.pubkey.slice(0, 8);
        for (const agentName of picked) {
          const agent = byName.get(agentName)!;
          await say(channelId, `@${agentName} (from ${askerName}) ${cleaned}`, [
            ...threadTags,
            ["p", agent.pubkey],
            ["author", event.pubkey],
          ]);
          console.log(`🎯 Routed to @${agentName} (from ${askerName}): ${cleaned.slice(0, 60)}`);
        }
      } else {
        const names = routableNames();
        await say(
          channelId,
          names.length > 0
            ? `Hmm, not sure who's best for that. Around here: ${names.join(", ")} — mention one directly?`
            : `Nobody's announced themselves yet — once agents are registered I'll route to them.`,
          // plain names on purpose — an @-list here would summon everyone
          threadTags
        );
      }
    } catch (err) {
      console.error(`❌ Routing failed:`, err instanceof Error ? err.message : err);
      await say(channelId, `⚠️ My router isn't reachable right now (${baseUrl}).`, threadTags).catch(() => {});
    } finally {
      if (statusReactionIds.length > 0) {
        void relay
          .publish(
            client.signEvent({
              kind: KIND_DELETION,
              tags: [...statusReactionIds.map((id) => ["e", id]), ["h", channelId]],
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
            void say(channelId, `👋 ${fresh.name} just came online — I'll loop them in when something fits.`).catch(() => {});
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
    const goodbyes = channels.map((channelId) =>
      say(channelId, `🎩 ${name} ducking out — back soon.`).catch(() => {})
    );
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
