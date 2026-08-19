import { describe, expect, test } from "vitest";
import * as protocol from "@fez/protocol";
import { K } from "../../fez-client/dist/index.js";

/**
 * Registry integrity gate (GAPS.md §2.6): src/kinds.ts is THE registry;
 * fez-client's K table is a deliberate dependency-light mirror. They had
 * already drifted once (7 kinds lived only in K) — this gate makes drift
 * a test failure instead of a latent bug. Buzz's equivalent:
 * no_duplicate_kind_values + compile-time range asserts in kind.rs.
 */

const registryKinds = Object.fromEntries(
  Object.entries(protocol).filter(([name, value]) => name.startsWith("KIND_") && typeof value === "number")
) as Record<string, number>;

// K-name → registry-name. Every K entry MUST map; a new K entry without a
// registry counterpart fails the coverage test below.
const K_TO_REGISTRY: Record<string, string> = {
  AGENT_METADATA: "KIND_AGENT_METADATA",
  COMMUNITY: "KIND_COMMUNITY",
  CHANNEL: "KIND_CHANNEL",
  MEMBERSHIP: "KIND_MEMBERSHIP",
  MESSAGE: "KIND_CHANNEL_MESSAGE",
  TYPING: "KIND_TYPING",
  PRESENCE: "KIND_PRESENCE",
  DRAFT: "KIND_DRAFT",
  OBSERVER: "KIND_OBSERVER",
  THREAD_SUMMARY: "KIND_THREAD_SUMMARY",
  WORKFLOW_RUN: "KIND_WORKFLOW_RUN",
  REACTION: "KIND_REACTION",
  DELETION: "KIND_DELETION",
  GIFT_WRAP: "KIND_GIFT_WRAP",
  READ_STATE: "KIND_READ_STATE",
  MSG_EDIT: "KIND_MSG_EDIT",
  MSG_PIN: "KIND_MSG_PIN",
  MSG_BOOKMARK: "KIND_MSG_BOOKMARK",
  SCHEDULED: "KIND_SCHEDULED",
  REMINDER: "KIND_REMINDER",
  DOC: "KIND_DOC",
  DOC_COMMENT: "KIND_DOC_COMMENT",
  DOC_TASK: "KIND_DOC_TASK",
  PROFILE: "KIND_PROFILE",
  USER_STATUS: "KIND_USER_STATUS",
  BAN_LIST: "KIND_BAN_LIST",
  ARTIFACT: "KIND_ARTIFACT",
};

describe("kind registry", () => {
  test("no duplicate kind numbers in src/kinds.ts", () => {
    const values = Object.values(registryKinds);
    const dupes = values.filter((v, i) => values.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  test("fez kinds live in sane nostr ranges", () => {
    for (const [name, value] of Object.entries(registryKinds)) {
      expect(value, name).toBeGreaterThanOrEqual(0);
      expect(value, name).toBeLessThan(65536);
    }
    // Ephemeral kinds must actually be in the ephemeral range (relays
    // would otherwise store what we designed to be live-only).
    for (const name of ["KIND_TYPING", "KIND_PRESENCE", "KIND_DRAFT", "KIND_OBSERVER"]) {
      expect(registryKinds[name], name).toBeGreaterThanOrEqual(20000);
      expect(registryKinds[name], name).toBeLessThan(30000);
    }
    // Addressable state must be parameterized-replaceable so real relays
    // compact it (engrams, read state, thread summaries).
    for (const name of ["KIND_AGENT_ENGRAM", "KIND_READ_STATE", "KIND_THREAD_SUMMARY"]) {
      expect(registryKinds[name], name).toBeGreaterThanOrEqual(30000);
      expect(registryKinds[name], name).toBeLessThan(40000);
    }
  });

  test("every fez-client K entry matches the registry — no drift", () => {
    for (const [kName, kValue] of Object.entries(K)) {
      const registryName = K_TO_REGISTRY[kName];
      expect(registryName, `K.${kName} has no mapping — add the kind to src/kinds.ts and this table`).toBeDefined();
      expect(registryKinds[registryName], `K.${kName} vs ${registryName}`).toBe(kValue);
    }
  });
});
