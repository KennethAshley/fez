/**
 * Guide routing: when the guide persona (@fez) is mentioned with a TASK,
 * the router decides who takes it and the agent posts a templated handoff
 * — no harness turn. Questions about fez, small talk, fleet questions,
 * and anything the router isn't confident about still run the model.
 *
 * Why: on a capable harness every @fez mention was a full model turn —
 * measured 13 turns at a mean of 23 s and $0.22 — and most of them only
 * decided which teammate to summon, a decision the hosted router already
 * makes in ~0.4 s with a calibrated confidence. Same prelayers and request
 * shape as the standalone orchestrator (route-logic.ts), same handoff text
 * ("@agent (from asker) <the user's own words>"); the reply then rides the
 * agent's normal publish path, so p/task tags and inbox bookkeeping are
 * exactly what a model-written handoff would get.
 */
import { agentTool, explicitActor, fleetQuestion, isSmallTalk, noneTool, routerBody, scrubNames } from "../../fez-orchestrator/src/route-logic.js";

export interface RosterAgent { pubkey: string; name: string; about?: string; skills?: string[]; tasks?: string[]; routable: boolean; updatedAt: number }

/**
 * Route only when the hosted router is at least this sure; below it the
 * model decides. Deliberately low: the 97-case battery routed 96/97 with
 * no bar at all and its one wrong pick scored 0.82, so confidence barely
 * separates right from wrong picks. With eight routable agents a correct
 * pick landed at 0.77 live. This bar only rejects near-uniform spreads.
 */
export const ROUTE_AT = 0.5;
const NAME_RE = /^[\w-]{1,32}$/;

/** Newest 47000 announcement per pubkey, excluding the guide itself. */
export function buildRoster(events: { pubkey: string; kind: number; created_at: number; content: string }[], selfPubkey: string): RosterAgent[] {
  const byPubkey = new Map<string, RosterAgent>();
  for (const event of events) {
    if (event.kind !== 47000 || event.pubkey === selfPubkey) continue;
    const existing = byPubkey.get(event.pubkey);
    if (existing && event.created_at <= existing.updatedAt) continue;
    try {
      const meta = JSON.parse(event.content) as { name?: string; about?: string; skills?: string[]; supported_tasks?: string[]; routable?: boolean };
      if (!meta.name || !NAME_RE.test(meta.name)) continue;
      byPubkey.set(event.pubkey, {
        pubkey: event.pubkey, name: meta.name, updatedAt: event.created_at,
        about: typeof meta.about === "string" ? meta.about : undefined,
        skills: Array.isArray(meta.skills) ? meta.skills.filter((s): s is string => typeof s === "string") : undefined,
        tasks: Array.isArray(meta.supported_tasks) ? meta.supported_tasks.filter((s): s is string => typeof s === "string") : undefined,
        routable: meta.routable !== false,
      });
    } catch { /* not an announcement */ }
  }
  return [...byPubkey.values()];
}

/** Same filter the standalone orchestrator applies: chat-capable, delegable, one per name (newest wins). */
export function routable(roster: RosterAgent[]): RosterAgent[] {
  const byName = new Map<string, RosterAgent>();
  for (const agent of roster) {
    if (agent.tasks && !agent.tasks.includes("channel-chat")) continue;
    if (!agent.routable) continue;
    const prior = byName.get(agent.name);
    if (prior && prior.updatedAt >= agent.updatedAt) continue;
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

/**
 * The router's escape hatch for the GUIDE's own work. `nobody` means "no
 * agent can do this task"; questions about fez itself are not tasks, and
 * without this option Jev routed "how do slash commands work in fez" to
 * the research agent at 0.62. Checked live 2026-09-20: three fez questions
 * scored guide 0.95–1.00, tasks stayed with their agents, a limerick went
 * to nobody.
 */
export function guideTool() {
  return {
    type: "function",
    function: {
      name: "guide",
      description: "questions about fez itself — the protocol, relays, extensions, the CLI, slash commands, git hosting, how agents and personas work, how to install or configure things — the guide answers these in person instead of delegating",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    },
  };
}

export interface RouterAnswer { choice?: string; confidence?: number }
export type RouterCall = (body: object) => Promise<RouterAnswer>;

export interface RouteDecision { agent: RosterAgent; reply: string; confidence?: number; reason: "explicit" | "router" }
/** Why the model ran instead — logged so the bar and prelayers can be tuned from real traffic. */
export interface RouteSkip { skipped: string; choice?: string; confidence?: number }
export type RouteOutcome = RouteDecision | RouteSkip;
export const isRouted = (o: RouteOutcome | undefined): o is RouteDecision => !!o && "agent" in o;

/** Strip the guide's own @name(s) from the request so the forwarded words are the user's task. */
export function cleanRequest(text: string, guideNames: string[]): string {
  const alt = guideNames.filter((n) => /^[\w-]+$/.test(n)).join("|");
  return (alt ? text.replace(new RegExp(`(^|\\W)@(${alt})\\b`, "gi"), "$1") : text).replace(/\s+/g, " ").trim();
}

/**
 * Decide whether this mention is a routable task. Returns a decision only
 * when routing is safe without the model: an explicitly named actor, or a
 * router pick at or above ROUTE_AT. Everything else — small talk, fleet
 * questions, "nobody", low confidence, no confidence reported, router
 * errors — returns undefined and the model runs as before.
 */
export async function decideRoute(opts: {
  text: string; guideNames: string[]; asker: string; roster: RosterAgent[]; call: RouterCall; model: string;
}): Promise<RouteOutcome> {
  const cleaned = cleanRequest(opts.text, opts.guideNames);
  const candidates = routable(opts.roster);
  if (!cleaned) return { skipped: "empty request" };
  if (candidates.length === 0) return { skipped: "no routable agents" };
  if (isSmallTalk(cleaned)) return { skipped: "small talk" };
  const names = candidates.map((a) => a.name);
  if (fleetQuestion(cleaned, names)) return { skipped: "fleet question" };
  const handoff = (agent: RosterAgent) => `@${agent.name} (from ${opts.asker}) ${cleaned}`;
  const explicit = explicitActor(cleaned, names);
  if (explicit) {
    const agent = candidates.find((a) => a.name === explicit)!;
    return { agent, reply: handoff(agent), reason: "explicit" };
  }
  let answer: RouterAnswer;
  try {
    answer = await opts.call(routerBody("tools", opts.model, scrubNames(cleaned, names), [...candidates.map(agentTool), guideTool(), noneTool()]));
  } catch (error) { return { skipped: `router error: ${error instanceof Error ? error.message : String(error)}` }; }
  const agent = candidates.find((a) => a.name === answer.choice);
  if (!agent) {
    const why = answer.choice === "guide" ? "guide question" : answer.choice === "nobody" ? "nobody fits" : `unknown pick ${answer.choice ?? "(none)"}`;
    return { skipped: why, ...answer };
  }
  if (answer.confidence === undefined) return { skipped: "no confidence reported", ...answer };
  if (answer.confidence < ROUTE_AT) return { skipped: `confidence below ${ROUTE_AT}`, ...answer };
  return { agent, reply: handoff(agent), confidence: answer.confidence, reason: "router" };
}

/** The hosted router's OpenAI-shaped reply plus the X-Fez-Router-Confidence header. */
export function routerCall(baseUrl: string, key: string | undefined, timeoutMs = 6000): RouterCall {
  return async (body) => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`router HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[] };
    const confidence = Number(res.headers.get("x-fez-router-confidence"));
    return {
      choice: json.choices?.[0]?.message?.tool_calls?.[0]?.function?.name,
      confidence: Number.isFinite(confidence) && res.headers.has("x-fez-router-confidence") ? confidence : undefined,
    };
  };
}
