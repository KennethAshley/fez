import { describe, it, expect } from "vitest";
import { classifyTurnError } from "../../../src/agent/harness.js";

/**
 * A refused turn fails as itself.
 *
 * `session.prompt()`'s rejection used to be discarded, so a provider that
 * refused a request outright — never sending a single update — surfaced as
 * an idle timeout instead. That text matched "went silent", which
 * classifies TRANSIENT, so an unrecoverable refusal was retried three times
 * with the same payload and then reported as a timeout that never happened.
 *
 * The rejection is now raced against the update loop and surfaces verbatim.
 * The turn ends sooner and says why. What that costs: a provider blip whose
 * wording matches none of the transient patterns no longer gets retried by
 * accident — hence the log line in classifyTurnError, so the next unknown
 * string is visible rather than inferred from a complaint.
 */
describe("classifyTurnError", () => {
  it("keeps retrying the failures that are actually worth retrying", () => {
    for (const message of ["timed out", "went silent for 900ms", "ECONNRESET", "overloaded", "rate limit", "529"]) {
      expect(classifyTurnError(new Error(message)), message).toBe("transient");
    }
  });

  it("never burns a retry on an auth failure that cannot self-repair", () => {
    expect(classifyTurnError(new Error("API Error: 401"))).toBe("auth");
    expect(classifyTurnError(new Error("Re-authenticate to continue"))).toBe("auth");
  });

  it("passes an abort through untouched", () => {
    const abort = new Error("turn aborted (steer)");
    abort.name = "AbortError";
    expect(classifyTurnError(abort)).toBe("aborted");
  });

  it("ends the turn on a capability refusal instead of replaying it", () => {
    // The case that motivated all of this: a text-only model refusing image
    // input. Retrying cannot help — the payload is the problem — so the
    // turn should die once, with the provider's own words.
    expect(classifyTurnError(new Error("is not a multimodal model"))).toBe("fatal");
    expect(classifyTurnError(new Error("No endpoints found that support image input"))).toBe("fatal");
  });
});
