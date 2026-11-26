/**
 * One purchase from a gamma service, with the judge making the three calls
 * that used to need a market: which service (or none), is the owner's
 * policy fine with it, and did the result deliver. Gamma is prepaid and
 * cannot be refunded, so the first two calls must both pass before a
 * single request is sent.
 */
import type { JudgeQuestion, JudgeResult } from "../../fez-orchestrator/src/judge.js";
import type { WalletPair } from "./derive.js";
import { gammaCall } from "./gamma.js";

export interface GammaService { netuid: number; name: string; hotkey: string; description: string }
export type Ask = (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>;

export type Purchase =
  | { outcome: "no_service"; confidence: number }
  | { outcome: "no_request"; service: GammaService }
  | { outcome: "not_allowed"; service: GammaService; allowed: number }
  | { outcome: "unfunded"; service: GammaService }
  | { outcome: "delivered" | "not_delivered"; service: GammaService; status: number; delivered: number; result: unknown };

/** Below these the agent does not spend. Starting values, not calibrated on real purchases. */
export const PICK_AT = 0.6;
export const ALLOW_AT = 0.7;
export const DELIVERED_AT = 0.5;

export async function buyWithGamma(opts: {
  need: string;
  /** The owner's spending rule, in their own words. */
  policy: string;
  services: GammaService[];
  ask: Ask;
  pair: WalletPair;
  /** The request that fulfils `need` at the chosen service, or undefined when there is none it may send there. */
  request: (service: GammaService) => { url: string; method: string; body?: unknown } | undefined;
}): Promise<Purchase> {
  const byKey = new Map(opts.services.map((s) => [`sn${s.netuid}`, s]));
  const criteria = { ...Object.fromEntries([...byKey].map(([key, s]) => [key, `${s.name}: ${s.description}`])), none: "no listed service sells what `need` asks for" };
  const picked = (await opts.ask({ need: opts.need }, {
    service: { type: "choice", instructions: "Which service sells what `need` asks for? Choose none unless one clearly does.", criteria },
  })).answers.service;
  const service = picked.type === "choice" ? byKey.get(picked.choice) : undefined;
  const confidence = picked.type === "choice" ? picked.confidence : 0;
  if (!service || confidence < PICK_AT) return { outcome: "no_service", confidence };

  const request = opts.request(service);
  if (!request) return { outcome: "no_request", service };

  const gate = (await opts.ask({ need: opts.need, policy: opts.policy, service: `${service.name}: ${service.description}` }, {
    allowed: { type: "noul", instructions: "Does `policy`, the owner's spending rule, allow paying `service` for `need`?" },
  })).answers.allowed;
  const allowed = gate.type === "noul" ? gate.noul : 0;
  if (allowed < ALLOW_AT) return { outcome: "not_allowed", service, allowed };

  const answer = await gammaCall(opts.pair, service.hotkey, request);
  if (!answer.paid) return { outcome: "unfunded", service };

  const check = (await opts.ask({ need: opts.need, status: answer.status, result: answer.body }, {
    delivered: { type: "noul", instructions: "Does `result` deliver what `need` asked for?" },
  })).answers.delivered;
  const delivered = check.type === "noul" ? check.noul : 0;
  return { outcome: delivered >= DELIVERED_AT ? "delivered" : "not_delivered", service, status: answer.status, delivered, result: answer.body };
}
