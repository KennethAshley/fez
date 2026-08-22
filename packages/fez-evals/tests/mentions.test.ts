import { describe, it, expect } from "vitest";
import { mentionedNames, mentionTags } from "@fezchat/protocol";

/**
 * The one place a name becomes a tag. Everything downstream — the inbox,
 * unread counts, notifications, an agent's own {"#p": [self]} filter —
 * reads tags, never text, so a path that writes the name without the tag
 * ships a message that looks addressed and reaches nobody.
 */
describe("mentionedNames", () => {
  it("finds names anywhere in a message, deduped and lowercased", () => {
    expect(mentionedNames("@Reviewer please review\n\nthen @researcher, and @reviewer again")).toEqual([
      "reviewer",
      "researcher",
    ]);
  });

  it("does not mention the domain of an email address", () => {
    // The hand-rolled /@([\w-]+)/g each path used matched here, so
    // quoting "ken@example.com" tagged whoever was called "example".
    expect(mentionedNames("write to ken@example.com about it")).toEqual([]);
    expect(mentionedNames("ken@example.com and @reviewer")).toEqual(["reviewer"]);
  });

  it("keeps a name that opens a line or follows punctuation", () => {
    expect(mentionedNames("done. @coder your turn (@reviewer too)")).toEqual(["coder", "reviewer"]);
  });

  it("finds nothing in a message that names nobody", () => {
    expect(mentionedNames("reviewer already confirmed this")).toEqual([]);
  });
});

describe("mentionTags", () => {
  const roster: Record<string, string> = { reviewer: "pk-reviewer", researcher: "pk-researcher" };
  const resolve = (name: string) => roster[name];

  it("tags each resolvable name once", async () => {
    expect(await mentionTags("@reviewer and @researcher and @reviewer", resolve)).toEqual([
      ["p", "pk-reviewer"],
      ["p", "pk-researcher"],
    ]);
  });

  it("drops a name nobody here answers to rather than guessing", async () => {
    expect(await mentionTags("@nobody please help", resolve)).toEqual([]);
  });

  it("honours exclusions, so a path cannot double-tag or self-tag", async () => {
    expect(await mentionTags("@reviewer @researcher", resolve, ["pk-reviewer"])).toEqual([
      ["p", "pk-researcher"],
    ]);
  });

  it("treats a failed lookup as unresolved, not as a crash", async () => {
    const flaky = (name: string) => {
      if (name === "reviewer") throw new Error("relay hiccup");
      return roster[name];
    };
    expect(await mentionTags("@reviewer @researcher", flaky)).toEqual([["p", "pk-researcher"]]);
  });

  it("resolves asynchronously, since a roster walk is a query", async () => {
    const slow = async (name: string) => roster[name];
    expect(await mentionTags("@researcher", slow)).toEqual([["p", "pk-researcher"]]);
  });
});
