import { describe, expect, test } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { matchFilter, type Event, type Filter } from "nostr-tools";
import { FezClient } from "../../fez-client/dist/index.js";

/**
 * The share path's contract: re-publication means republishing the
 * SIGNATURE, not a copy — fez.chat's shared-artifacts endpoint verifies
 * schnorr, so the desktop must hand it the verbatim signed event. A
 * reconstructed event (new tag order, trimmed field) would 401 at the
 * door. fetchEvent is the seam that fetches an event back by id.
 */

const sk = generateSecretKey();
const artifact: Event = finalizeEvent(
  {
    kind: 40300,
    created_at: 1_700_000_000,
    tags: [["type", "markdown"], ["h", "chan1"]],
    content: JSON.stringify({ type: "markdown", title: "t", content: "# hi" }),
  },
  sk
);

// Real NIP-01 filter semantics over an in-memory store — the wire seam
// FezClient is built on, minus sockets.
const wire = {
  pubkey: "00".repeat(32),
  query: (filters: Filter[]) => Promise.resolve([artifact].filter((e) => filters.some((f) => matchFilter(f, e)))),
} as never;

describe("FezClient.fetchEvent", () => {
  test("returns the verbatim signed event by id", async () => {
    const client = new FezClient(wire);
    const got = await client.fetchEvent(artifact.id);
    expect(got).toEqual(artifact); // every field, sig included
  });

  test("unknown id resolves undefined, not a throw", async () => {
    const client = new FezClient(wire);
    await expect(client.fetchEvent("f".repeat(64))).resolves.toBeUndefined();
  });
});
