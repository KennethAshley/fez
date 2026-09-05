import { describe, it, expect } from "vitest";
import { shapeWeb, shapeX, costOf } from "../../fez-desearch/src/desearch.js";

/**
 * The part of fez-desearch that breaks when Desearch's JSON drifts: the
 * shaping from their response into fez's flat hit shapes. Pure functions,
 * no key, no network.
 */

describe("shapeWeb", () => {
  const body = JSON.stringify({
    data: [
      { title: "A", link: "https://a.com", snippet: "sa" },
      { title: "B", link: "https://b.com", snippet: "sb" },
      { title: "no link dropped" },
    ],
  });
  it("maps link→url and drops linkless rows", () => {
    const r = shapeWeb(body, 5);
    expect(r).toEqual([
      { title: "A", url: "https://a.com", snippet: "sa" },
      { title: "B", url: "https://b.com", snippet: "sb" },
    ]);
  });
  it("caps to max", () => {
    expect(shapeWeb(body, 1)).toHaveLength(1);
  });
  it("throws a human error on non-JSON", () => {
    expect(() => shapeWeb("<html>rate limited", 5)).toThrow(/non-JSON/);
  });
  it("tolerates a missing data array", () => {
    expect(shapeWeb("{}", 5)).toEqual([]);
  });
});

describe("shapeX", () => {
  const tweet = {
    text: "hi", url: "https://x.com/u/1", created_at: "2026-01-01T00:00:00Z",
    like_count: 10, retweet_count: 2, user: { username: "u", name: "You" },
  };
  it("flattens a bare array of tweets", () => {
    expect(shapeX(JSON.stringify([tweet]), 20)[0]).toEqual({
      text: "hi", url: "https://x.com/u/1", author: "You", handle: "@u",
      created: "2026-01-01T00:00:00Z", likes: 10, retweets: 2,
    });
  });
  it("also accepts a {data:[...]} envelope", () => {
    expect(shapeX(JSON.stringify({ data: [tweet] }), 20)).toHaveLength(1);
  });
  it("drops tweets with no url and defaults missing counts", () => {
    const r = shapeX(JSON.stringify([{ text: "x", url: "https://x.com/y", user: {} }]), 20);
    expect(r[0].likes).toBe(0);
    expect(r[0].handle).toBe("");
  });
});

describe("costOf", () => {
  it("reads the cost header", () => {
    expect(costOf(new Headers({ "x-desearch-cost-usd": "0.00015" }))).toBeCloseTo(0.00015);
  });
  it("is null when absent or unparseable", () => {
    expect(costOf(new Headers())).toBeNull();
    expect(costOf(new Headers({ "x-desearch-cost-usd": "n/a" }))).toBeNull();
  });
});
