import { describe, it, expect } from "vitest";
import { mentionedNames as protocolNames } from "@fezchat/protocol";
import { mentionedNames as clientNames, splitMentions } from "../../fez-client/dist/index.js";

/**
 * The mirror gate, same as kinds.ts ↔ K.
 *
 * @fezchat/client carries its own copy so it stays dependency-light and
 * browser-safe. If the two ever disagree, the GUI paints a mention the
 * publisher won't tag (or the reverse) — which is the exact failure that
 * made a highlighted @name reach nobody.
 */
const HOSTILE = [
  "@reviewer please review",
  "ken@example.com about it",
  "ken@example.com and @reviewer",
  "done. @coder your turn (@reviewer too)",
  "@a @b @a",
  "@UPPER and @upper",
  "no mentions here at all",
  "@name-with-dash and @name_with_underscore",
  "email me@here.com, cc @ops",
  "@",
  "@@doubled",
  "path/@notamention",
  "line one\n@second-line",
  "trailing @",
  "@edge",
];

describe("mentions mirror", () => {
  for (const content of HOSTILE) {
    it(`agrees on ${JSON.stringify(content)}`, () => {
      expect(clientNames(content)).toEqual(protocolNames(content));
    });
  }

  it("splits losslessly — the parts rebuild the input exactly", () => {
    for (const content of HOSTILE) {
      expect(splitMentions(content).map((part) => part.text).join("")).toBe(content);
    }
  });

  it("marks exactly the names it found, and no others", () => {
    for (const content of HOSTILE) {
      const marked = splitMentions(content)
        .filter((part) => part.name)
        .map((part) => part.name!.toLowerCase());
      expect([...new Set(marked)]).toEqual(protocolNames(content));
    }
  });
});
