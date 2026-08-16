/**
 * Pure routing logic, shared by the orchestrator runtime and fez-evals —
 * the evals import THIS module, so a regression here fails a gate
 * instead of shipping. No I/O, no relay, no state.
 */

/**
 * Greetings/pleasantries, detected deterministically: short and matching
 * a smalltalk shape. Anything else is a task for the router. Measured on
 * needle (26M): a router-side "chat" pseudo-tool does NOT work — "yo"
 * still routed to an agent — so this stays regex, not model.
 */
export const SMALL_TALK_RE =
  /^(yo|hey( there)?|hi( there)?|hiya|hello|howdy|sup|what'?s up|gm|good (morning|afternoon|evening|night)|how are you( doing)?( today)?|how's it going|you (there|ok|good)|thanks?|thank you|ty|nice( one)?|cool|great|awesome|lol|ok(ay)?)([\s!?.,…]+fez)?[\s!?.,…🎩👋]*$/i;

export function isSmallTalk(text: string): boolean {
  return text.split(/\s+/).length <= 6 && SMALL_TALK_RE.test(text);
}

export interface RoutableAgent {
  name: string;
  about?: string;
  skills?: string[];
}

/**
 * One OpenAI function per agent. Tuned for tiny routers, measured on
 * needle: the tool NAME carries most of the routing signal
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
      parameters: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
    },
  };
}
