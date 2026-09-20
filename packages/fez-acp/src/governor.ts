/**
 * Thread governor: before a fellow agent's message costs a harness turn,
 * ask the judge a few yes/no questions about the thread and decide
 * whether the turn is worth running. Pure logic here; agent.ts wires it
 * to the relay and the judge. Fails open — any judge problem runs the
 * turn exactly as before, so the governor can only remove turns that
 * would have been noise, never block work.
 *
 * Two stages:
 *  - mention:    a plain sibling mention → run / skip / escalate
 *  - completion: a worker's successful result for work I assigned →
 *                accept (chit + one templated line, no model turn) / run
 */
import type { JudgeQuestion, JudgeResult } from "../../fez-orchestrator/src/typesafe.js";

export type GovernorOutcome = "run" | "skip" | "escalate";
export interface GovernorValues { needs_me: number; resolved: number; contradiction: number }
export interface GovernorVerdict {
  outcome: GovernorOutcome;
  reason: string;
  values?: GovernorValues;
  latencyMs: number;
  error?: string;
}

// ponytail: fixed thresholds from nothing but priors; every decision is
// logged with its raw values so these get calibrated from real traffic.
export const ESCALATE_AT = 0.8;
export const RESOLVED_AT = 0.8;
export const NEEDS_ME_BELOW = 0.3;
/** A direct request at or above this runs even in a thread the judge calls resolved. */
export const NEEDS_ME_DIRECT = 0.5;
/** State budget in characters — well under Jev's 32k-token state cap even for CJK. */
export const STATE_CHARS = 12_000;

export function governorQuestions(me: string): Record<"needs_me" | "resolved" | "contradiction", JudgeQuestion> {
  return {
    // Wording checked live 2026-09-20: a workflow's summons in an already
    // answered thread scored 0.66 under "require a substantive response"
    // and 0.91 under this; the skip/run scenarios were unchanged.
    needs_me: {
      type: "noul",
      instructions: { agent: me, question: "Does the latest message in `thread` ask `agent` to do, answer, or produce something?" },
      criteria: {
        true: "It addresses or names `agent` and requests an action, an answer, or a deliverable — even if the rest of the thread is already settled.",
        false: "It is an acknowledgment, thanks, a status note, or a message that asks nothing of `agent`.",
      },
    },
    resolved: {
      type: "noul",
      instructions: "Is the task or question in `thread` complete or decided, with no further agent action needed?",
    },
    contradiction: {
      type: "noul",
      instructions: "Do the last two agent messages in `thread` contradict each other on a matter of fact or a decision?",
    },
  };
}

/** Most recent lines that fit the budget; the trigger (last line) is always kept. */
export function governorState(lines: readonly string[], budget = STATE_CHARS): { thread: string[] } {
  const thread: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (thread.length > 0 && used + cost > budget) break;
    thread.unshift(lines[i]);
    used += cost;
  }
  return { thread };
}

// "Resolved" describes the thread's ORIGINAL task. A follow-up that
// addresses this agent directly (a workflow's summons, a new question)
// lands in a resolved thread by design, so a direct request outranks it —
// found live when a workflow's "@quill one sentence please" was skipped.
export function governorDecision(values: GovernorValues): { outcome: GovernorOutcome; reason: string } {
  if (values.contradiction >= ESCALATE_AT) return { outcome: "escalate", reason: `contradiction ${values.contradiction.toFixed(2)}` };
  if (values.needs_me < NEEDS_ME_BELOW) return { outcome: "skip", reason: `no response needed ${values.needs_me.toFixed(2)}` };
  if (values.resolved >= RESOLVED_AT && values.needs_me < NEEDS_ME_DIRECT) return { outcome: "skip", reason: `thread resolved ${values.resolved.toFixed(2)}, needs me ${values.needs_me.toFixed(2)}` };
  return { outcome: "run", reason: `needs me ${values.needs_me.toFixed(2)}` };
}

function nouls<K extends string>(result: JudgeResult, names: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const name of names) {
    const answer = result.answers[name];
    if (answer?.type !== "noul") throw new Error(`governor: missing noul ${name}`);
    out[name] = answer.noul;
  }
  return out;
}

export async function governThread(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  me: string,
  lines: readonly string[],
): Promise<GovernorVerdict> {
  const startedAt = Date.now();
  try {
    const result = await ask(governorState(lines), governorQuestions(me));
    const values = nouls(result, ["needs_me", "resolved", "contradiction"] as const);
    return { ...governorDecision(values), values, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "run", reason: "judge unavailable", latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error) };
  }
}

// ── owner acknowledgments ────────────────────────────────────────────

export interface OwnerMentionVerdict { outcome: "run" | "skip"; reason: string; needsMe?: number; latencyMs: number; error?: string }

/**
 * Owner messages always ran — rightly, for anything that asks something.
 * But "thanks, that's all I needed" cost a full turn to compose "glad it
 * landed" (measured: 5.5 s, $0.19, then hidden by the attention tag).
 * One noul, the same needs_me question the sibling governor asks; only
 * the skip rule applies — an owner message is never "resolved away" and
 * never escalated. Below the bar the agent reacts 👍 instead of replying.
 */
export async function governOwnerMention(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  me: string,
  lines: readonly string[],
): Promise<OwnerMentionVerdict> {
  const startedAt = Date.now();
  try {
    const { needs_me } = governorQuestions(me);
    const result = await ask(governorState(lines), { needs_me });
    const needsMe = nouls(result, ["needs_me"] as const).needs_me;
    return needsMe < NEEDS_ME_BELOW
      ? { outcome: "skip", reason: `acknowledgment, needs me ${needsMe.toFixed(2)}`, needsMe, latencyMs: Date.now() - startedAt }
      : { outcome: "run", reason: `needs me ${needsMe.toFixed(2)}`, needsMe, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "run", reason: "judge unavailable", latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── completion stage ─────────────────────────────────────────────────

export type CompletionOutcome = "accept" | "run";
export interface CompletionValues { satisfies: number; owner_needs_more: number; /** the judge's label for how the result responded (logged, not gating) */ outcome?: string }
export interface CompletionVerdict {
  outcome: CompletionOutcome;
  reason: string;
  values?: CompletionValues;
  latencyMs: number;
  error?: string;
}

// ponytail: same story — priors, logged, calibrate later. Acceptance is
// the one place the judge makes a call the model used to make, so the
// bar is deliberately high and anything short of it runs the turn.
export const ACCEPT_AT = 0.85;
export const OWNER_NEEDS_MORE_BELOW = 0.3;

export function completionQuestions(me: string, worker: string): Record<"satisfies" | "owner_needs_more" | "outcome", JudgeQuestion> {
  return {
    // Wording chosen on ten cases (2026-09-20, five live research loops +
    // five synthetic): "state every point … to cover" scored correct
    // research answers 0.82–0.87 (under the bar, paying a model turn);
    // "directly answer what brief asks for" scores them 0.93–0.95 with the
    // bad ones ≤ 0.15. Length and caveats are named as ignorable because
    // Jev reads a "two-sentence" brief literally otherwise.
    satisfies: {
      type: "noul",
      instructions: {
        requester: me, worker,
        question: "Does `result` directly answer what `brief` asks `worker` for, giving the requested facts or deliverable?",
        ignore: "length, sentence count, format, caveats, and any extra correct detail",
      },
      criteria: {
        true: "It answers the brief's question or request with specific facts or the requested deliverable; caveats and extra detail are fine.",
        false: "It leaves a requested point unanswered, contradicts a fact stated in `brief`, or asks a question or reports a blocker instead of answering.",
      },
    },
    // One hop, named state: the original ask is passed as `request`
    // instead of "see the start of `thread`" — the thread is the recent
    // buffer trimmed from the end, so on a long one the ask that pointer
    // named was gone, and Jev reads such pointers literally.
    owner_needs_more: {
      type: "noul",
      instructions: "Does `request` ask for information that `result` does not provide?",
      criteria: {
        true: "A fact or answer `request` asked for is missing from `result`.",
        false: "`result` provides every fact or answer `request` asked for; length and format do not matter.",
      },
    },
    // Logged, not gating: names WHY a result fell short so the bar can be
    // read against reasons, not just numbers. Scored the ten cases with
    // full confidence and p(answered) 0.90–0.99 on every correct result.
    outcome: {
      type: "choice",
      instructions: { requester: me, worker, question: "How does `result` respond to what `brief` asked `worker` for?" },
      criteria: {
        answered: "gives the requested facts or deliverable; caveats, extra detail, and any length are fine",
        partial: "answers some of it but a requested point is missing",
        wrong: "states something that contradicts a fact given in `brief`",
        deferred: "asks a question back or reports a blocker instead of answering",
      },
    },
  };
}

export function completionDecision(values: CompletionValues): { outcome: CompletionOutcome; reason: string } {
  if (values.satisfies >= ACCEPT_AT && values.owner_needs_more < OWNER_NEEDS_MORE_BELOW) {
    return { outcome: "accept", reason: `satisfies ${values.satisfies.toFixed(2)}, owner needs more ${values.owner_needs_more.toFixed(2)}` };
  }
  return { outcome: "run", reason: `satisfies ${values.satisfies.toFixed(2)}, owner needs more ${values.owner_needs_more.toFixed(2)}` };
}

export async function governCompletion(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  me: string,
  worker: string,
  brief: string,
  result: string,
  /** The thread's original ask (root message); the brief stands in when it can't be fetched. */
  request: string | undefined,
  lines: readonly string[],
): Promise<CompletionVerdict> {
  const startedAt = Date.now();
  try {
    // Request, brief, result AND the recent thread. Dropping the thread
    // was tried (Jev's notes warn about irrelevant state) and lowered every
    // live case by 0.04–0.11: here the thread is the context, not noise.
    const state = { request: (request ?? brief).slice(0, STATE_CHARS), brief: brief.slice(0, STATE_CHARS), result: result.slice(0, STATE_CHARS), ...governorState(lines) };
    const answers = await ask(state, completionQuestions(me, worker));
    const outcome = answers.answers.outcome;
    const values: CompletionValues = { ...nouls(answers, ["satisfies", "owner_needs_more"] as const), ...(outcome?.type === "choice" ? { outcome: outcome.choice } : {}) };
    return { ...completionDecision(values), values, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "run", reason: "judge unavailable", latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error) };
  }
}

// ── busy stage: steer or queue ───────────────────────────────────────

export type SteerOutcome = "steer" | "queue";
export interface SteerVerdict { outcome: SteerOutcome; reason: string; value?: number; latencyMs: number; error?: string }

/**
 * A mention that lands mid-turn in the same thread used to steer every
 * time: abort the in-flight turn and restart with the new message woven
 * in. Fine for "actually, make it two sentences"; wasteful for "thanks!"
 * or an aside, which threw away a running turn to answer nothing. The
 * judge decides whether the new message bears on the work in flight.
 */
export const STEER_AT = 0.7;

export function steerQuestions(): Record<"changes_work", JudgeQuestion> {
  return {
    changes_work: {
      type: "noul",
      instructions: "Does `new_message` change, correct, add to, or cancel the work described in `in_flight`?",
      criteria: {
        true: "It gives new requirements, corrects a fact, narrows or widens the task, or asks to stop — the in-flight work should restart with it.",
        false: "It is thanks, an acknowledgment, a reaction, an unrelated aside, or a question the in-flight work will already answer.",
      },
    },
  };
}

/** Fails open to steer — today's behavior — so a judge problem never leaves a real correction waiting behind a stale turn. */
export async function governSteer(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  inFlight: string,
  newMessage: string,
): Promise<SteerVerdict> {
  const startedAt = Date.now();
  try {
    const result = await ask({ in_flight: inFlight.slice(0, STATE_CHARS), new_message: newMessage.slice(0, STATE_CHARS) }, steerQuestions());
    const { changes_work } = nouls(result, ["changes_work"] as const);
    const outcome: SteerOutcome = changes_work >= STEER_AT ? "steer" : "queue";
    return { outcome, reason: `changes work ${changes_work.toFixed(2)}`, value: changes_work, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "steer", reason: "judge unavailable", latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── attention stage: does this reply need the owner ─────────────────

export type Attention = "now" | "later" | "none";
export interface AttentionVerdict { level: Attention; reason: string; values?: { needs_owner: number; urgency: string }; latencyMs: number; error?: string }

/**
 * Every agent reply to the owner's message is p-tagged to the owner by
 * the thread rules, so the inbox was every reply — handoff lines,
 * acknowledgments, steps toward an answer. The tag says which ones the
 * owner actually needs to read, and how soon. Fails open to "now": on a
 * judge problem everything shows, as before.
 */
export const NEEDS_OWNER_AT = 0.6;

export function attentionQuestions(owner: string): Record<"needs_owner" | "urgency", JudgeQuestion> {
  return {
    needs_owner: {
      type: "noul",
      instructions: { owner, question: "Does `reply` give `owner` something to read or act on — an answer to `request`, a decision to make, a blocker, or a result they asked for?" },
      criteria: {
        true: "It delivers an answer, a result, a question for the owner, or news of a blocker.",
        false: "It is an acknowledgment, a status note, a handoff to another agent, or an intermediate step with nothing for the owner yet.",
      },
    },
    urgency: {
      type: "choice",
      instructions: "If `owner` should see `reply`, how soon? Read `request` for how urgently they asked.",
      criteria: {
        now: "it answers what they asked, asks them something, or reports a blocker — and nothing in `request` said it could wait",
        later: "useful to read at some point, nothing waits on them — including any answer to a `request` that said no rush, when you get a chance, or whenever",
        none: "nothing for the owner in it",
      },
    },
  };
}

export async function governAttention(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  owner: string,
  request: string,
  reply: string,
): Promise<AttentionVerdict> {
  const startedAt = Date.now();
  try {
    const result = await ask({ request: request.slice(0, STATE_CHARS), reply: reply.slice(0, STATE_CHARS) }, attentionQuestions(owner));
    const { needs_owner } = nouls(result, ["needs_owner"] as const);
    const urgencyAnswer = result.answers.urgency;
    const urgency = urgencyAnswer?.type === "choice" ? urgencyAnswer.choice : "now";
    const level: Attention = needs_owner < NEEDS_OWNER_AT ? "none" : urgency === "later" ? "later" : "now";
    return { level, reason: `needs owner ${needs_owner.toFixed(2)}, urgency ${urgency}`, values: { needs_owner, urgency }, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { level: "now", reason: "judge unavailable", latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── narration: publish the answer, not the process ──────────────────

export interface NarrationVerdict { reply: string; kept: number; dropped: number; values?: number[]; latencyMs: number; error?: string }

/**
 * Some harnesses narrate: "Let me check…", "Now I can see…", "I'll verify
 * that directly", then the sentence that was asked for. Live 2026-09-20
 * quill's replies were 1.3–3k characters of process around a one-line
 * deliverable. One request, one noul per paragraph: is this paragraph part
 * of the deliverable? Narration paragraphs are dropped before publishing.
 * Fails open: any judge problem, a reply with code fences, or a verdict
 * that would drop everything publishes the reply untouched.
 */
export const DELIVERABLE_AT = 0.5;
const MAX_PARAGRAPHS = 32;

export function splitParagraphs(reply: string): string[] {
  return reply.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export function narrationQuestions(count: number): Record<string, JudgeQuestion> {
  const questions: Record<string, JudgeQuestion> = {};
  for (let i = 0; i < count; i++) {
    questions[`p${i}`] = {
      type: "noul",
      instructions: `Is \`paragraphs[${i}]\` part of what the asker wanted from \`request\` — an answer, a fact, a result, a source, or a question back to them — rather than narration about the process of producing it?`,
      criteria: {
        true: "It states or supports the deliverable: the answer, its details, sources, caveats about the answer, or a question the asker must answer.",
        false: "It describes what the agent is doing or about to do: checking, looking up, reading the thread, deciding how to respond, confirming it has finished, or restating the request.",
      },
    };
  }
  return questions;
}

export async function governNarration(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  request: string,
  reply: string,
): Promise<NarrationVerdict> {
  const startedAt = Date.now();
  const paragraphs = splitParagraphs(reply);
  const untouched = (error?: string) => ({ reply, kept: paragraphs.length, dropped: 0, latencyMs: Date.now() - startedAt, ...(error ? { error } : {}) });
  if (paragraphs.length < 2 || paragraphs.length > MAX_PARAGRAPHS || reply.includes("```")) return untouched();
  try {
    const result = await ask({ request: request.slice(0, STATE_CHARS), paragraphs }, narrationQuestions(paragraphs.length));
    const values = paragraphs.map((_, i) => {
      const answer = result.answers[`p${i}`];
      if (answer?.type !== "noul") throw new Error(`narration: missing noul p${i}`);
      return answer.noul;
    });
    const kept = paragraphs.filter((_, i) => values[i] >= DELIVERABLE_AT);
    if (kept.length === 0) return { ...untouched(), values };
    return { reply: kept.join("\n\n"), kept: kept.length, dropped: paragraphs.length - kept.length, values, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return untouched(error instanceof Error ? error.message : String(error));
  }
}

// ── a reply is a result ─────────────────────────────────────────────

export interface DeliverableVerdict { outcome: "result" | "error"; reason: string; value?: number; latencyMs: number; error?: string }

/**
 * A worker that answers in plain text but never calls fez_complete_work
 * used to have its answer filed as an ERROR result ("no terminal result
 * was submitted… unverified"), and the requester spent a model turn
 * relaying it. Live: drift answered "Go 1.27 shipped August 19" correctly
 * and skipped the tool once. If the reply contains the deliverable the
 * brief asked for, it IS the result. Fails open to today's error result.
 */
export const DELIVERS_AT = 0.8;

export function deliverableQuestion(): Record<"delivers", JudgeQuestion> {
  return {
    delivers: {
      type: "noul",
      instructions: "Does `reply` contain the deliverable that `brief` asked for — the answer, result, or requested artifact — rather than a question back, a status update, a partial attempt, or a refusal?",
      criteria: {
        true: "The requested answer or deliverable is stated in `reply`, even with caveats or extra detail.",
        false: "`reply` asks something, reports progress or a blocker, delivers only part of what was asked, or declines.",
      },
    },
  };
}

export async function governDeliverable(
  ask: (state: unknown, questions: Record<string, JudgeQuestion>) => Promise<JudgeResult>,
  brief: string,
  reply: string,
): Promise<DeliverableVerdict> {
  const startedAt = Date.now();
  try {
    const result = await ask({ brief: brief.slice(0, STATE_CHARS), reply: reply.slice(0, STATE_CHARS) }, deliverableQuestion());
    const { delivers } = nouls(result, ["delivers"] as const);
    return delivers >= DELIVERS_AT
      ? { outcome: "result", reason: `delivers ${delivers.toFixed(2)}`, value: delivers, latencyMs: Date.now() - startedAt }
      : { outcome: "error", reason: `delivers ${delivers.toFixed(2)}`, value: delivers, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: "error", reason: "judge unavailable", latencyMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The judge-unsure fallback runs the model to decide; when it accepts it
 * replies with the single word ACCEPTED and the agent posts nothing (the
 * chit is the record). Tolerates punctuation and markdown around the word;
 * anything more is a real reply and gets published.
 */
export function silentAccept(reply: string): boolean {
  return /^\W*accepted\W*$/i.test(reply.trim());
}
