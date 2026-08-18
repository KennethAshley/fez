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
    /^(what agents? (are (there|available|around|online)|do (you|we) have|can i use)|who('s| is) (available|around|online|on deck|in the fleet)|list (the |your |all )?agents?|what can (you all|everyone|the fleet) do|who do you have)$/.test(
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
