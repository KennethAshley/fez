/**
 * Protocol limits — the numbers every participant must agree on.
 *
 * Kinds live in kinds.ts; this is its sibling for the values that are not
 * kinds but are just as much a shared contract: a limit one participant
 * enforces at a different number than another is a limit that does not
 * exist.
 */

/**
 * How many consecutive agent hops a chain may take before every host stops
 * relaying it.
 *
 * Human messages carry no `depth` tag (depth 0); each agent reply writes
 * `trigger + 1`. Two agents naming each other would otherwise ping-pong
 * harness turns forever — an @name is a summons, so "thanks, @scribe!" is
 * a new turn, not a pleasantry.
 *
 * Enforced in two places for two different failures: the *replying* agent
 * refuses to answer past the cap (fez-acp), and the *summoner* refuses to
 * wake a sleeping persona past it (agent/summon.ts). Both are needed — a
 * summoner with a higher cap than the agents spawns a persona into a chain
 * the running agents have already abandoned, which the user sees as an
 * agent that starts up and says nothing.
 *
 * Deliberately high. A depth counter cannot tell a loop from a productive
 * chain, so this is a circuit breaker, not a policy: it should never fire
 * on healthy work. A cap that trips on legitimate coordination manufactures
 * unexplained silence, which is a worse bug than the loop it prevents.
 */
export const MAX_CHAIN_DEPTH = 5;
