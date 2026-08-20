import {
  agentTool,
  detectProfile,
  explicitActor,
  fleetQuestion,
  isSmallTalk,
  noneTool,
  routerBody,
  scrubNames,
  type RouterProfile,
} from "../../fez-orchestrator/src/route-logic.js";
import type { BenchCase, RosterAgent } from "./cases.js";
import type { CaseResult } from "./core.js";
import { hashInputs } from "./core.js";

/**
 * Runs the battery through the orchestrator's ACTUAL pipeline —
 * production fidelity is the whole point. Same layers, same order, same
 * tool shapes as the runtime: small talk short-circuits, fleet
 * questions answer from the roster, everything else hits the router
 * with agentTool()-built tools.
 */

export interface RunOutput {
  results: CaseResult[];
  model: string;
  hash: string;
}

/** Same bearer as the routing calls — a keyed endpoint 401s here first. */
export function routerAuthHeaders(): Record<string, string> {
  const key = process.env.FEZ_ORCHESTRATOR_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export async function resolveModel(base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/models`, { headers: routerAuthHeaders(), signal: AbortSignal.timeout(2500) });
    const body = (await res.json()) as { data?: { id: string }[] };
    return body.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function runBench(
  base: string,
  roster: RosterAgent[],
  cases: BenchCase[],
  onProgress?: (done: number, total: number) => void
): Promise<RunOutput> {
  const model = await resolveModel(base);
  if (!model) throw new Error(`no router at ${base} — start it (cactus serve …) or set FEZ_ORCHESTRATOR_URL`);
  const tools = [...roster.map(agentTool), noneTool()];
  const names = roster.map((agent) => agent.name);
  // Same shape the runtime sends, or the bench measures a router nobody
  // ships. It also pins temperature: llama.cpp defaults to 0.8, which
  // moved scores ±4 points between identical runs until this landed.
  const profile: RouterProfile =
    (process.env.FEZ_ORCHESTRATOR_PROFILE as RouterProfile | undefined) || detectProfile(model);
  const hash = hashInputs([...tools, { profile }], model);

  const results: CaseResult[] = [];
  for (const bench of cases) {
    const started = Date.now();
    let got = "none";
    let layer: CaseResult["layer"] = "router";
    if (isSmallTalk(bench.q)) {
      layer = "smalltalk";
    } else if (fleetQuestion(bench.q, names)) {
      layer = "fleet";
    } else if ((got = explicitActor(bench.q, names) ?? "none") !== "none") {
      layer = "actor";
    } else {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...routerAuthHeaders() },
        body: JSON.stringify(routerBody(profile, model, scrubNames(bench.q, names), tools)),
      });
      const body = (await res.json()) as {
        choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[];
      };
      const picked = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name ?? "none";
      got = picked === "nobody" ? "none" : picked;
    }
    results.push({ bench, got, pass: bench.expect.includes(got), layer, ms: Date.now() - started });
    onProgress?.(results.length, cases.length);
  }
  return { results, model, hash };
}
