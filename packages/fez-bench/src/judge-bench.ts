import type { BenchCase, RosterAgent } from "./cases.js";
import { runCases, type RunOutput } from "./runner.js";
import { hashInputs } from "./core.js";
import { agentTool, noneTool } from "../../fez-orchestrator/src/route-logic.js";
import { chooseRoute, routeQuestions, ZILS_JUDGE_MODEL, type JudgeRoute } from "../../fez-orchestrator/src/judge.js";

export async function runJudgeBench(
  apiKey: string, roster: RosterAgent[], cases: BenchCase[],
  options: { model?: string; timeoutMs?: number; baseUrl?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<RunOutput & { decisions: JudgeRoute[] }> {
  if (!apiKey.trim()) throw new Error("Set ZILS_API_KEY before running the live benchmark");
  const model = options.model ?? ZILS_JUDGE_MODEL;
  const tools = [...roster.map(agentTool), noneTool()];
  const criteria = Object.fromEntries(tools.map((tool) => [tool.function.name, tool.function.description]));
  if (!roster.length || Object.keys(criteria).length !== roster.length + 1) {
    throw new Error("Routing requires unique agent names, excluding nobody");
  }
  const questions = routeQuestions(criteria);
  const decisions: JudgeRoute[] = [];
  const results = await runCases(roster, cases, async (message) => {
    const decision = await chooseRoute(apiKey, message, criteria, options);
    decisions.push(decision);
    return decision.choice === "nobody" ? "none" : decision.choice;
  }, options.onProgress);
  return { results, model, hash: hashInputs([questions], model), decisions };
}
