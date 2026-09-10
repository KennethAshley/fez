import { describe, expect, it } from "vitest";
import { documentChange, docBlocks, docSelectionRange } from "../../fez-desktop/src/doc-workspace.js";

describe("document change presentation", () => {
  it("keeps both endpoints when a selection crosses Markdown blocks", () => {
    const blocks = docBlocks("Alpha first.\n\nMiddle.\n\nLast omega.");
    expect(docSelectionRange(blocks[0], blocks[2], "first.", "Last")).toEqual({ start: 6, end: 27 });
    expect(docSelectionRange(blocks[0], blocks[2], "formatted first", "formatted last")).toEqual({ start: 0, end: 34 });
  });
  it("isolates replacement text without including unchanged context", () => {
    expect(documentChange("Start. Old wording. End.", "Start. New wording. End.")).toEqual({
      start: 7, before: "Old", after: "New", end: 10,
    });
    expect(documentChange("Same", "Same")).toBeUndefined();
    expect(documentChange("abc", "abXYc")).toEqual({ start: 2, end: 4, before: "", after: "XY" });
    expect(documentChange("abXYc", "abc")).toEqual({ start: 2, end: 2, before: "XY", after: "" });
  });

  it("keeps source offsets for equal passages and fenced content", () => {
    const text = "# Title\n\nSame paragraph.\n\nSame paragraph.\n\n````md\n```js\nx\n```\n````\n";
    expect(docBlocks(text)).toEqual([
      { text: "# Title", start: 0, end: 7 },
      { text: "Same paragraph.", start: 9, end: 24 },
      { text: "Same paragraph.", start: 26, end: 41 },
      { text: "````md\n```js\nx\n```\n````", start: 43, end: 66 },
    ]);
  });
});
