import type { BenchCase, RosterAgent } from "./cases.js";
import { runCases, type RunOutput } from "./runner.js";
import { hashInputs } from "./core.js";
import { agentTool, noneTool } from "../../fez-orchestrator/src/route-logic.js";
import { chooseTypeSafeRoute, typeSafeQuestions, type TypeSafeDecision } from "../../fez-orchestrator/src/typesafe.js";

export async function runTypeSafeBench(
  apiKey: string, roster: RosterAgent[], cases: BenchCase[],
  options: { model?: string; timeoutMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<RunOutput & { decisions: TypeSafeDecision[] }> {
  if (!apiKey.trim()) throw new Error("Set TYPESAFE_API_KEY before running the live benchmark");
  const model = options.model ?? "jev-1.13.0";
  const tools = [...roster.map(agentTool), noneTool()];
  const criteria = Object.fromEntries(tools.map((tool) => [tool.function.name, tool.function.description]));
  if (!roster.length || Object.keys(criteria).length !== roster.length + 1) {
    throw new Error("TypeSafe requires unique agent names, excluding nobody");
  }
  const questions = typeSafeQuestions(criteria);
  const decisions: TypeSafeDecision[] = [];
  const results = await runCases(roster, cases, async (message) => {
    const decision = await chooseTypeSafeRoute(apiKey, message, criteria, options);
    decisions.push(decision);
    return decision.choice === "nobody" ? "none" : decision.choice;
  }, options.onProgress);
  return { results, model, hash: hashInputs([questions], model), decisions };
}
