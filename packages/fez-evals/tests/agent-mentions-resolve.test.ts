import { expect, it } from "vitest";
import { resolveAgentName } from "../../fez-client/src/agent-mentions.js";

const profile = (pubkey: string, content: object, created_at = 1) =>
  ({ pubkey, id: `${pubkey}-${created_at}`, created_at, content: JSON.stringify(content) });

const alice = "a".repeat(64), bob = "b".repeat(64);

it("resolves one exact published name or alias, case-insensitively", () => {
  const events = [profile(alice, { name: "Quill" }), profile(bob, { name: "Rex", aliases: ["researcher"] })];
  expect(resolveAgentName("quill", events)).toBe(alice);
  expect(resolveAgentName("RESEARCHER", events)).toBe(bob);
});

// The reply path feeds this into agentMessageTags, whose contract is
// `Promise<string | undefined>`: an unresolvable name is dropped, never
// guessed, and never fails a turn the model has already finished.
it("returns undefined for a name nobody has published", () => {
  expect(resolveAgentName("everyone", [profile(alice, { name: "Quill" })])).toBeUndefined();
  expect(resolveAgentName("quill", [])).toBeUndefined();
});

it("still refuses an ambiguous name so a handoff cannot pick a member at random", () => {
  const events = [profile(alice, { name: "Quill" }), profile(bob, { name: "quill" })];
  expect(() => resolveAgentName("quill", events)).toThrow(/resolves to 2 workspace members/);
});

it("uses each member's newest profile", () => {
  const events = [profile(alice, { name: "Quill" }, 1), profile(alice, { name: "Scribe" }, 2)];
  expect(resolveAgentName("scribe", events)).toBe(alice);
  expect(resolveAgentName("quill", events)).toBeUndefined();
});
