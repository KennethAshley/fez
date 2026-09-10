import { describe, it, expect } from "vitest";
import { summonMentions } from "../../../src/agent/summon.js";

/**
 * Mention ≠ summon. A message that merely SPEAKS ABOUT an agent —
 * example text in backticks, tool source in a fence, a quoted phrase —
 * must not spawn it. The live case that motivated this: asking @loom to
 * build a button that posts "@scout what's new" summoned @scout at
 * weave time, before the button existed.
 */
describe("summonMentions — prose mentions summon, quoted/coded ones don't", () => {
  it("summons a plain prose mention", () => {
    expect(summonMentions("@scout what's new on subnet 64")).toEqual(["scout"]);
  });

  it("summons mid-sentence prose mentions", () => {
    expect(summonMentions("hey @chip and @scout look at this")).toEqual(["chip", "scout"]);
  });

  it("ignores email, SSH, path and doubled-at tokens while keeping prose mentions", () => {
    expect(summonMentions("ken@scout.example user@chip path/@loom @@pilot")).toEqual([]);
    expect(summonMentions("ken@scout.example then @chip take over")).toEqual(["chip"]);
  });

  it("ignores a mention in inline backticks", () => {
    expect(summonMentions("the button should run `@scout what's new`")).toEqual([]);
  });

  it("ignores mentions inside a fenced code block", () => {
    expect(summonMentions('```js\nfez.message("@scout hi")\n```')).toEqual([]);
  });

  it("ignores a double-quoted mention", () => {
    expect(summonMentions('a button that posts "@scout what\'s new"')).toEqual([]);
  });

  it("ignores smart-quoted mentions (macOS keyboards)", () => {
    expect(summonMentions("posts “@scout what's new” when clicked")).toEqual([]);
  });

  it("keeps the addressed agent while dropping the quoted one", () => {
    expect(summonMentions('@loom build a button that posts "@scout hi"')).toEqual(["loom"]);
  });

  it("fails open on an unbalanced quote (summon rather than silently drop)", () => {
    expect(summonMentions('she said "hi @scout')).toEqual(["scout"]);
  });

  it("dedupes and lowercases", () => {
    expect(summonMentions("@Scout then @scout again")).toEqual(["scout"]);
  });
});
