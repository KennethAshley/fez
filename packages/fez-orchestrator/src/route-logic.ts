/**
 * Pure routing logic, shared by the orchestrator runtime and fez-evals —
 * the evals import THIS module, so a regression here fails a gate
 * instead of shipping. No I/O, no relay, no state.
 */

/**
 * Greetings/pleasantries, detected deterministically: short and matching
 * a smalltalk shape. Anything else is a task for the router. Measured on
 * On very small routers a router-side "chat" pseudo-tool does NOT work — "yo"
 * still routed to an agent — so this stays regex, not model.
 */
const SMALL_TALK_ATOM =
  "yo|hey( there)?|hi( there)?|hiya|hello|howdy|sup|what'?s up|gm|good (morning|afternoon|evening|night)|how are you( doing)?( today)?|how'?s it going|you (there|ok|good)|thanks?|thank you|ty|nice( one)?|cool|great|awesome|lol|ok(ay)?( cool| great| thanks)?|sounds good";

/**
 * Repeated, because people CHAIN pleasantries: "hey how's it going",
 * "hi there thanks", "ok cool thanks". Each half matched on its own but
 * the whole string did not, so those fell through to the router and paid
 * ~90ms to be told nobody fits. The ≤6-word guard in isSmallTalk is what
 * keeps the repetition from swallowing a real request that happens to
 * open with a greeting ("hi there is a bug in relay.ts" still routes —
 * the tail does not match an atom, so the whole match fails).
 */
export const SMALL_TALK_RE = new RegExp(
  `^(?:(?:${SMALL_TALK_ATOM})[\\s,]*)+([\\s!?.,…]+fez)?[\\s!?.,…🎩👋]*$`,
  "iu"
);

export function isSmallTalk(text: string): boolean {
  return text.split(/\s+/).length <= 6 && SMALL_TALK_RE.test(text);
}

export interface RoutableAgent {
  name: string;
  about?: string;
  skills?: string[];
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type FleetQuestion = { kind: "agent"; name: string } | { kind: "roster" };

/**
 * Questions ABOUT the fleet never reach the router: fez holds the
 * roster (names, descriptions, resolved skills) and answers them
 * itself. Found live: "what can researcher do?" routed to reviewer —
 * a 26M router has no concept of meta-questions, so this layer is
 * deterministic, like small talk.
 */
export function fleetQuestion(text: string, agentNames: string[]): FleetQuestion | undefined {
  const t = text.trim().toLowerCase().replace(/[\s?!.…]+$/, "");
  if (
    /^(what agents? (are (there|available|around|online)|do (you|we) have|can i use)|who('s| is) (available|around|online|on deck|in the fleet|on the (team|roster)|here)|list (the |your |all )?agents?|what can (you all|everyone|the fleet) do|who do you have)$/.test(
      t
    )
  ) {
    return { kind: "roster" };
  }
  for (const name of agentNames) {
    const n = escapeRe(name.toLowerCase());
    const re = new RegExp(
      `^(what (can|does) @?${n} (do|handle)|what('s| is) @?${n}( for| good at| about)?|who('s| is) @?${n}|what are @?${n}('s)? skills|tell me about @?${n}|describe @?${n})$`
    );
    if (re.test(t)) return { kind: "agent", name };
  }
  return undefined;
}

/**
 * One OpenAI function per agent. Tuned for tiny routers, measured on
 * On tiny routers the tool NAME carries most of the routing signal
 * (researcher/reviewer route 6/6; opaque names like scout/critic
 * misroute), descriptions are supporting verb-phrase detail.
 */
export function agentTool(agent: RoutableAgent): object {
  const description =
    [agent.about, agent.skills?.length ? `skills: ${agent.skills.join(", ")}` : undefined]
      .filter(Boolean)
      .join(" — ") || "a general-purpose agent";
  return {
    type: "function",
    function: {
      name: agent.name,
      description,
      // The `task` argument is generated and then THROWN AWAY — the
      // orchestrator reads only `function.name` and forwards the asker's
      // original words, because small routers extract lossy task spans.
      //
      // It still earns its tokens. Removing it (2026-08-21) dropped the
      // battery from 87/98 to 75/98, under-routes 10 → 22: writing the
      // task out is what makes the model commit to a pick instead of
      // bailing to `nobody`. It is cheap chain-of-thought wearing a
      // schema, and the ~7 tokens it costs are the price of 12 points.
      parameters: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
    },
  };
}

/**
 * "Nobody fits" pseudo-tool — gives a router that always wants to route
 * an honest exit. Measured caveat: a chat pseudo-tool did NOT absorb
 * small talk on a tiny router (that stays regex); this one targets no-fit
 * TASKS ("write me a haiku"), a semantically different decision. The
 * orchestrator filters it out of picks, landing in the existing
 * "not sure who's best" fallback.
 */
export function noneTool(): object {
  return {
    type: "function",
    function: {
      name: "nobody",
      description: "ONLY for tasks clearly outside every agent's abilities, like creative writing, drawing, or personal errands",
      parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    },
  };
}

/**
 * The request shape is part of the model choice, not separate from it.
 *
 * Measured on the 97-case battery: the "tools" shape (system message,
 * tool_choice, pinned sampling) is what capable models want and buys
 * ~20 points over a bare request. A few very small, restricted routers
 * do the opposite — a system message costs them every direct case — so
 * they need the bare "minimal" shape. Mixing a shape with the wrong
 * endpoint ships the worst of both, so the shape is chosen per endpoint,
 * defaulting to "tools" for any real model.
 *
 *   tools    general instruct models behind an OpenAI-compatible API (default).
 *   minimal  no system message, no tool_choice, no sampling overrides —
 *            for restricted tiny routers only, opt in explicitly.
 */
export type RouterProfile = "minimal" | "tools";

/**
 * Kept short deliberately. Longer variants scored no better, and every
 * token here is prompt-eval time on a 1-vCPU box.
 */
export const ROUTER_SYSTEM =
  "You are a router. Call exactly one function to pick who should handle the user's request. " +
  "Do not write any prose. Do not answer the request yourself. If no function fits, call nobody.";

/**
 * Why 96: general models write a prose preamble before the tool call,
 * and uncapped they ramble into the context limit — 10-12s on one CPU
 * core, per route. Measured, cap 96 scores IDENTICALLY to cap 512
 * (90.7% both, same cases) because nothing legitimate needs more, so
 * this is a pure latency-tail fix, not an accuracy trade.
 */
export const ROUTER_MAX_TOKENS = 96;

/**
 * Greedy, always. llama.cpp defaults to temperature 0.8, which moved
 * every score ±4 points run-to-run and made the bench unreproducible
 * until it was pinned. A router picking a different agent for the same
 * sentence twice is a bug, not variety.
 */
export const ROUTER_TEMPERATURE = 0;

/**
 * Which request shape an endpoint wants. Standard OpenAI
 * function-calling ("tools") is the default and works with any capable
 * model — a cloud API, ollama, llama.cpp, or a tuned router. A few very
 * small, restricted routers reject the system message / sampling
 * overrides and need the bare shape; that is "minimal", and it is an
 * explicit opt-in (`profile: minimal` in the persona, or
 * FEZ_ORCHESTRATOR_PROFILE=minimal), never guessed from a model name.
 */
export function detectProfile(_model: string): RouterProfile {
  return "tools";
}

/** The `/chat/completions` body for one routing decision. */
export function routerBody(
  profile: RouterProfile,
  model: string,
  message: string,
  tools: object[]
): object {
  if (profile === "minimal") {
    return { model, messages: [{ role: "user", content: message }], tools };
  }
  return {
    model,
    messages: [
      { role: "system", content: ROUTER_SYSTEM },
      { role: "user", content: message },
    ],
    tools,
    tool_choice: "required",
    temperature: ROUTER_TEMPERATURE,
    max_tokens: ROUTER_MAX_TOKENS,
  };
}

const nameAlt = (names: string[]) => names.map(escapeRe).join("|");

/**
 * Explicit actor: the asker NAMED who should act ("have researcher dig
 * this up", "researcher: find X"). Deterministic — skips the router
 * entirely, and exempts that name from scrubbing.
 */
export function explicitActor(text: string, names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  const alt = nameAlt(names);
  const verb = text.match(new RegExp(`\\b(?:have|ask|get|tell|send|use|let|make|want)\\s+@?(${alt})\\b`, "i"));
  if (verb) return names.find((n) => n.toLowerCase() === verb[1].toLowerCase());
  const leading = text.match(new RegExp(`^\\s*@?(${alt})\\s*[,:]`, "i"));
  if (leading) return names.find((n) => n.toLowerCase() === leading[1].toLowerCase());
  return undefined;
}

/**
 * Name-as-content scrub: roster names inside a routed task pull a tiny
 * router toward that agent even when the name is clearly not the actor
 * (measured: "reviewer signed off, ship it" routed to reviewer 5/7
 * shapes). Since explicit actors are handled deterministically above,
 * any name still in the text IS content — neutralize it.
 */
export function scrubNames(text: string, names: string[]): string {
  if (names.length === 0) return text;
  return text.replace(new RegExp(`@?\\b(${nameAlt(names)})\\b`, "gi"), "a teammate");
}
