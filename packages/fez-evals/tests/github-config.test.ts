import { describe, it, expect } from "vitest";
import { parseConfig, EMPTY } from "../../fez-github/src/config.js";
import { verificationUrl, DEFAULT_CLIENT_ID } from "../../fez-github/src/app-id.js";

/**
 * The GitHub bridge's config comes off the relay, which means it comes
 * from bytes — a truncated write, an older fez, or a hand-edited event.
 * parseConfig is the boundary that decides what the poller and the
 * panel will believe, and triage is the field where believing something
 * wrong spends money.
 */
describe("parseConfig", () => {
  it("keeps the shape it understands", () => {
    expect(
      parseConfig({
        repos: ["a/b", "c/d"],
        login: "someone",
        pollSeconds: 300,
        available: [{ repo: "a/b", private: true }],
        triage: ["a/b"],
      })
    ).toEqual({
      repos: ["a/b", "c/d"],
      login: "someone",
      pollSeconds: 300,
      available: [{ repo: "a/b", private: true }],
      triage: ["a/b"],
    });
  });

  it("never triages a repo it is not watching", () => {
    // Otherwise un-watching a repo would leave a standing instruction
    // with nothing to trigger it — and re-watching it later would
    // silently resume spending on an agent per new issue.
    const config = parseConfig({ repos: ["a/b"], triage: ["a/b", "ghost/repo"] });
    expect(config.triage).toEqual(["a/b"]);
  });

  it("drops triage entirely when nothing watched survives", () => {
    expect(parseConfig({ repos: [], triage: ["a/b"] }).triage).toBeUndefined();
  });

  it("survives anything the relay might hand it", () => {
    expect(parseConfig(undefined)).toEqual(EMPTY);
    expect(parseConfig("nonsense")).toEqual(EMPTY);
    expect(parseConfig({})).toEqual(EMPTY);
    expect(parseConfig({ repos: "not-a-list" })).toEqual(EMPTY);
    expect(parseConfig({ repos: [1, "a/b", null] }).repos).toEqual(["a/b"]);
    expect(parseConfig({ repos: ["a/b"], pollSeconds: "soon" }).pollSeconds).toBeUndefined();
    expect(parseConfig({ repos: ["a/b"], pollSeconds: Number.NaN }).pollSeconds).toBeUndefined();
  });

  it("keeps only well-formed rows in the repo cache", () => {
    const config = parseConfig({
      repos: [],
      available: [{ repo: "a/b", private: true }, { nope: 1 }, null, "x", { repo: 7 }],
    });
    expect(config.available).toEqual([{ repo: "a/b", private: true }]);
  });

  it("treats a missing private flag as public rather than as true", () => {
    // A repo shown as private when it is not is only cosmetic; the
    // reverse would label a private repo public in the picker.
    expect(parseConfig({ repos: [], available: [{ repo: "a/b" }] }).available).toEqual([
      { repo: "a/b", private: false },
    ]);
  });
});

describe("verificationUrl", () => {
  it("carries the code, so the browser opens with the field filled", () => {
    const url = verificationUrl({ userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" });
    expect(url).toBe("https://github.com/login/device?user_code=WDJB-MJHT");
  });

  it("falls back to the plain page rather than throwing on a junk URI", () => {
    // GitHub hands us this string; a bad one must not take out the one
    // button the panel has.
    expect(verificationUrl({ userCode: "X", verificationUri: "not a url" })).toBe(
      "https://github.com/login/device"
    );
  });

  it("ships a client id, because connecting is a button now", () => {
    // Public by design — it authorises nothing without a human approving
    // on github.com. The test is here so removing it fails loudly rather
    // than quietly restoring the paste-your-own-Client-ID setup.
    expect(DEFAULT_CLIENT_ID).toMatch(/^Iv23/);
  });
});
