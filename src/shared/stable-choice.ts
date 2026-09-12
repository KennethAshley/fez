/** Stable identity assignment; list order is part of the saved default contract. */
export function stableChoice<T>(identity: string, choices: readonly T[]): T {
  if (!choices.length) throw Error("A stable choice requires at least one option");
  let hash = 0;
  for (let i = 0; i < identity.length; i++) hash = (hash * 31 + identity.charCodeAt(i)) >>> 0;
  return choices[hash % choices.length];
}
