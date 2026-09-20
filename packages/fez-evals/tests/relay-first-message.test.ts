import { describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { membershipPolicy } from "../../fez-relay/dist/policies.js";

/**
 * First run, live 2026-09-20: the desktop posted the welcome opener a beat
 * before the first roster landed and the OWNER saw "this workspace has no
 * roster yet" on their own message. The owner is the roster's signer and
 * a member by definition, so before any roster exists they may publish
 * and read; everyone else still waits for the roster.
 */
const owner = generateSecretKey(), stranger = generateSecretKey();
const ownerPk = getPublicKey(owner);
const post = (key: Uint8Array) => finalizeEvent({ kind: 47103, created_at: Math.floor(Date.now() / 1000), tags: [["h", "bootstrap-welcome"]], content: "hello" }, key);
const noRoster = { query: () => [] };

describe("membership policy before the first roster", () => {
  test("the owner may publish into a channel", () => {
    const policy = membershipPolicy(ownerPk);
    expect(policy.onEvent!(post(owner) as never, noRoster as never)).toMatchObject({ accept: true });
  });
  test("anyone else is still blocked until a roster exists", () => {
    const policy = membershipPolicy(ownerPk);
    const verdict = policy.onEvent!(post(stranger) as never, noRoster as never) as { accept: boolean; reason?: string };
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toMatch(/no roster yet/);
  });
  test("an unclaimed workspace (no owner) blocks everyone as before", () => {
    const policy = membershipPolicy(undefined);
    expect((policy.onEvent!(post(owner) as never, noRoster as never) as { accept: boolean }).accept).toBe(false);
  });
  test("the owner reads their own channel before the roster; a stranger does not", () => {
    const policy = membershipPolicy(ownerPk);
    expect(policy.onDeliver!(post(owner) as never, { ...noRoster, authedPubkey: ownerPk } as never)).toBe(true);
    expect(policy.onDeliver!(post(owner) as never, { ...noRoster, authedPubkey: getPublicKey(stranger) } as never)).toBe(false);
  });
});
