/**
 * One purchase from a gamma service, with the judge making the two calls
 * that used to need a market: which service (or none), and did the result
 * deliver. Gamma is prepaid and cannot be refunded, so the pick must pass
 * and the caller must hand over a request before anything is sent. How
 * much may be spent is the caller's business (the owner's daily limit).
 */
import type { JudgeQuestion, JudgeResult } from "../../fez-orchestrator/src/judge.js";
import type { WalletPair } from "./derive.js";
import { gammaCall } from "./gamma.js";

export interface GammaService { netuid: number; name: string; hotkey: string; description: string }
export type Ask = (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>;

export type Purchase =
  | { outcome: "no_service"; confidence: number }
  | { outcome: "no_request"; service: GammaService }
  | { outcome: "unfunded"; service: GammaService }
  | { outcome: "delivered" | "not_delivered"; service: GammaService; status: number; delivered: number; result: unknown };

/** Below these the agent does not spend. Starting values, not calibrated on real purchases. */
export const PICK_AT = 0.6;
export const DELIVERED_AT = 0.5;

export async function buyWithGamma(opts: {
  need: string;
  services: GammaService[];
  ask: Ask;
  pair: WalletPair;
  /** The request that fulfils `need` at the chosen service, or undefined when there is none it may send there. */
  request: (service: GammaService) => Promise<{ url: string; method: string; body?: unknown } | undefined>;
}): Promise<Purchase> {
  const byKey = new Map(opts.services.map((s) => [`sn${s.netuid}`, s]));
  const criteria = { ...Object.fromEntries([...byKey].map(([key, s]) => [key, `${s.name}: ${s.description}`])), none: "no listed service sells what `need` asks for" };
  const picked = (await opts.ask({ need: opts.need }, {
    service: { type: "choice", instructions: "Which service sells what `need` asks for? Choose none unless one clearly does.", criteria },
  })).answers.service;
  const service = picked.type === "choice" ? byKey.get(picked.choice) : undefined;
  const confidence = picked.type === "choice" ? picked.confidence : 0;
  if (!service || confidence < PICK_AT) return { outcome: "no_service", confidence };

  const request = await opts.request(service);
  if (!request) return { outcome: "no_request", service };

  const answer = await gammaCall(opts.pair, service.hotkey, request);
  if (!answer.paid) return { outcome: "unfunded", service };

  const check = (await opts.ask({ need: opts.need, status: answer.status, result: answer.body }, {
    delivered: { type: "noul", instructions: "Does `result` deliver what `need` asked for?" },
  })).answers.delivered;
  const delivered = check.type === "noul" ? check.noul : 0;
  return { outcome: delivered >= DELIVERED_AT ? "delivered" : "not_delivered", service, status: answer.status, delivered, result: answer.body };
}
