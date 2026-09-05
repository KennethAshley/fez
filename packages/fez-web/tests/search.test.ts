import { describe, expect, it } from "vitest";
import { webSearch } from "../src/search.js";

const FIXTURE = JSON.stringify({
  results: [
    { title: "Octopus - Wikipedia", url: "https://en.wikipedia.org/wiki/Octopus", content: "Octopuses have three hearts..." },
    { title: "NOAA on octopus hearts", url: "https://oceanservice.noaa.gov/facts/octopus-hearts.html", content: "Two branchial hearts..." },
    { title: "no-url entry is dropped", url: "", content: "junk" },
  ],
});

const fakeFetch = (async (url: string) => {
  if (!url.includes("format=json")) throw new Error("searx must be asked for json");
  return { finalUrl: url, status: 200, contentType: "application/json", body: FIXTURE };
}) as never;

describe("webSearch", () => {
  it("shapes searx json into results, drops url-less rows", async () => {
    const r = await webSearch("octopus hearts", 5, fakeFetch);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ title: "Octopus - Wikipedia", url: "https://en.wikipedia.org/wiki/Octopus", snippet: "Octopuses have three hearts..." });
  });
  it("caps results", async () => {
    const r = await webSearch("octopus hearts", 1, fakeFetch);
    expect(r.length).toBe(1);
  });
  it("unreachable instance is a plain sentence", async () => {
    const dead = (async () => { throw new Error("connect ECONNREFUSED"); }) as never;
    await expect(webSearch("x", 3, dead)).rejects.toThrow(/search .*unreachable|unreachable.*search/i);
  });
});
