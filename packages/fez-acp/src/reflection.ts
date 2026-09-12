const DEFAULT_PROMPT = "Review your standing responsibilities, relevant recent changes, and unfinished work. Choose at most one useful next action within your existing authority. If nothing warrants action, do nothing.";

/** Invalid intervals fail startup instead of becoming a rapid, billable timer. */
export function reflectionConfig(extra: Record<string, string>, env: Record<string, string | undefined> = process.env): { everyMs: number; prompt: string } | undefined {
  const interval = (env.FEZ_AGENT_REFLECTION_EVERY ?? extra.reflectionEvery)?.trim().toLowerCase();
  if (!interval || interval === "off" || interval === "0") return;
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(interval);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const everyMs = match ? Number(match[1]) * units[match[2] as keyof typeof units] : NaN;
  if (!Number.isSafeInteger(everyMs) || everyMs < 60_000 || everyMs > 2 ** 31 - 1) {
    throw new Error("reflectionEvery must be a duration from 60s to 24d (e.g. 30m, 2h), or off");
  }
  const prompt = (env.FEZ_AGENT_REFLECTION_PROMPT ?? extra.reflectionPrompt ?? DEFAULT_PROMPT).trim();
  if (!prompt) throw new Error("reflectionPrompt must not be empty");
  return { everyMs, prompt };
}
