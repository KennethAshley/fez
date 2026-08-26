/** Persona effort → pi's ThinkingLevel. Junk is ignored, not guessed. */
export function piThinkingLevel(effort?: string): string | undefined {
  return effort === "low" || effort === "medium" || effort === "high" ? effort : undefined;
}
