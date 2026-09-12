import { expect, it } from "vitest";
import { parseWorkspaceInvite, workspaceInvite } from "../../fez-client/src/workspace-invite.js";

const owner = "a".repeat(64);
it("carries the trusted owner through a workspace invite while preserving old relay-only invites", () => {
  const code = workspaceInvite("wss://Relay.example:443/", owner);
  expect(code).toBe(`fez-join:wss://relay.example#owner=${owner}`);
  expect(parseWorkspaceInvite(code)).toEqual({ relay: "wss://relay.example", owner });
  expect(parseWorkspaceInvite("fez-join:wss://relay.example#old-community")).toEqual({ relay: "wss://relay.example" });
  expect(parseWorkspaceInvite("wss://relay.example/Case?Query=Case")).toEqual({ relay: "wss://relay.example/Case?Query=Case" });
});

it("rejects malformed or ambiguous owner pins instead of treating them as legacy invites", () => {
  for (const code of ["fez-join:hello", "https://relay.example", `fez-join:wss://relay.example#owner=bad`,
    `fez-join:wss://relay.example#owner=${owner}&owner=${owner}`]) {
    expect(() => parseWorkspaceInvite(code)).toThrow();
  }
});
