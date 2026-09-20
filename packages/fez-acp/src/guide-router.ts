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

/** Route only when the hosted router is at least this sure. Below it, the model decides. */
export const ROUTE_AT = 0.8;
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

export interface RouterAnswer { choice?: string; confidence?: number }
export type RouterCall = (body: object) => Promise<RouterAnswer>;

export interface RouteDecision { agent: RosterAgent; reply: string; confidence?: number; reason: "explicit" | "router" }

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
}): Promise<RouteDecision | undefined> {
  const cleaned = cleanRequest(opts.text, opts.guideNames);
  const candidates = routable(opts.roster);
  if (!cleaned || candidates.length === 0) return undefined;
  if (isSmallTalk(cleaned)) return undefined;
  const names = candidates.map((a) => a.name);
  if (fleetQuestion(cleaned, names)) return undefined;
  const handoff = (agent: RosterAgent) => `@${agent.name} (from ${opts.asker}) ${cleaned}`;
  const explicit = explicitActor(cleaned, names);
  if (explicit) {
    const agent = candidates.find((a) => a.name === explicit)!;
    return { agent, reply: handoff(agent), reason: "explicit" };
  }
  let answer: RouterAnswer;
  try {
    answer = await opts.call(routerBody("tools", opts.model, scrubNames(cleaned, names), [...candidates.map(agentTool), noneTool()]));
  } catch { return undefined; }
  const agent = candidates.find((a) => a.name === answer.choice);
  if (!agent || answer.confidence === undefined || answer.confidence < ROUTE_AT) return undefined;
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
