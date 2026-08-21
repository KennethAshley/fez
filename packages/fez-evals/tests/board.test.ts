import { describe, expect, it } from "vitest";
import { orderVersions } from "../../fez-client/dist/index.js";
import {
  addCard,
  currentVersion,
  describeBoard,
  doneColumn,
  findCard,
  isBoard,
  moveCard,
  overLimit,
  parseBoard,
  parseSettings,
  serializeBoard,
} from "../../fez-kanban/src/board.js";

/**
 * The board rewrites the user's document on every drag. If the parser
 * loses a line, someone's notes are gone and the version history says a
 * person did it. So the property under test is not "does it parse" but
 * "does everything it did not understand come back out".
 */

const BOARD = `# Sprint 14

Notes for whoever picks this up.

\`\`\`fez:board
done: Shipped
limit: In Progress = 2
\`\`\`

## Backlog

Pulled from the roadmap, roughly ordered.

- [ ] Audit the consent copy
- [ ] Multi-relay fan-out @wren
  needs a decision on dedup first

## In Progress

- [ ] Ship the board extension @claude

## Shipped

- [x] Extension permissions
`;

describe("board format", () => {
  it("reads columns and cards out of ordinary markdown", () => {
    const board = parseBoard(BOARD);
    expect(board.columns.map((c) => c.name)).toEqual(["Backlog", "In Progress", "Shipped"]);
    expect(board.columns[0].cards.map((c) => c.text)).toEqual([
      "Audit the consent copy",
      "Multi-relay fan-out @wren",
    ]);
    expect(board.columns[2].cards[0].done).toBe(true);
    expect(board.columns[0].cards[1].assignees).toEqual(["wren"]);
    expect(board.columns[0].cards[1].detail).toEqual(["  needs a decision on dedup first"]);
  });

  it("keeps prose, front matter and other people's lines verbatim", () => {
    const board = parseBoard(BOARD);
    expect(board.preamble.join("\n")).toContain("# Sprint 14");
    expect(board.preamble.join("\n")).toContain("Notes for whoever picks this up.");
    expect(board.columns[0].lead).toEqual(["Pulled from the roadmap, roughly ordered."]);
    // the settings fence is preamble, not a column — `##` inside a fence
    // would otherwise open a phantom column
    expect(serializeBoard(board)).toContain("```fez:board");
  });

  it("round-trips: writing a board back changes nothing but blank lines", () => {
    const once = serializeBoard(parseBoard(BOARD));
    const twice = serializeBoard(parseBoard(once));
    expect(twice).toBe(once);
    for (const line of BOARD.split("\n").filter((l) => l.trim())) {
      expect(once, `lost: ${line}`).toContain(line);
    }
  });

  it("does not mistake fenced code for columns or cards", () => {
    const doc = "## Real\n\n- [ ] a real card\n\n```md\n## Not a column\n\n- [ ] not a card\n```\n";
    const board = parseBoard(doc);
    expect(board.columns.map((c) => c.name)).toEqual(["Real"]);
    expect(board.columns[0].cards).toHaveLength(1);
    expect(serializeBoard(board)).toContain("## Not a column");
  });

  it("reads settings and applies WIP limits", () => {
    expect(parseSettings(BOARD)).toEqual({ done: "Shipped", limits: { "In Progress": 2 } });
    const board = parseBoard(BOARD);
    expect(doneColumn(board)?.name).toBe("Shipped");
    expect(overLimit(board, board.columns[1])).toBeUndefined();
    addCard(board, "In Progress", "one too many");
    addCard(board, "In Progress", "and another");
    expect(overLimit(board, board.columns[1])).toBe(2);
  });

  it("falls back to a column named done when nothing is configured", () => {
    const board = parseBoard("## Todo\n\n- [ ] x\n\n## Done\n\n- [x] y\n");
    expect(doneColumn(board)?.name).toBe("Done");
  });
});

describe("moving cards", () => {
  it("moves a card and ticks it when it lands in the done column", () => {
    const board = parseBoard(BOARD);
    const result = moveCard(board, "Ship the board extension", "Shipped");
    expect(result.error).toBeUndefined();
    expect(result.summary).toBe('moved "Ship the board extension @claude" from In Progress to Shipped');
    const text = serializeBoard(result.board);
    expect(text).toContain("- [x] Ship the board extension @claude");
    expect(parseBoard(text).columns[1].cards).toHaveLength(0);
  });

  it("un-ticks a card dragged back out of done", () => {
    const board = parseBoard(BOARD);
    const text = serializeBoard(moveCard(board, "Extension permissions", "Backlog").board);
    expect(text).toContain("- [ ] Extension permissions");
    expect(text).not.toContain("- [x] Extension permissions");
  });

  it("carries a card's detail lines with it", () => {
    const moved = serializeBoard(moveCard(parseBoard(BOARD), "Multi-relay fan-out", "In Progress").board);
    const board = parseBoard(moved);
    const card = board.columns[1].cards.find((c) => c.text.startsWith("Multi-relay"));
    expect(card?.detail).toEqual(["  needs a decision on dedup first"]);
  });

  it("respects the drop position within a column", () => {
    const board = moveCard(parseBoard(BOARD), "Extension permissions", "Backlog", 0).board;
    expect(board.columns[0].cards[0].text).toBe("Extension permissions");
  });

  it("loses nothing else in the document when a card moves", () => {
    const after = serializeBoard(moveCard(parseBoard(BOARD), "Audit the consent copy", "Shipped").board);
    for (const line of ["# Sprint 14", "Notes for whoever picks this up.", "done: Shipped", "Pulled from the roadmap, roughly ordered."]) {
      expect(after, `lost: ${line}`).toContain(line);
    }
  });

  it("says what it could not find instead of guessing", () => {
    const missing = moveCard(parseBoard(BOARD), "something nobody wrote", "Shipped");
    expect(missing.error).toContain("no card");
    expect(missing.error).toContain("Audit the consent copy"); // tells the caller what IS there
    const wrongColumn = moveCard(parseBoard(BOARD), "Audit the consent copy", "Nowhere");
    expect(wrongColumn.error).toContain("Backlog, In Progress, Shipped");
  });

  it("matches a card by a prefix, since agents quote the first few words", () => {
    expect(findCard(parseBoard(BOARD), "audit the consent")?.card.text).toBe("Audit the consent copy");
    // …but not on a fragment too short to be unambiguous
    expect(findCard(parseBoard(BOARD), "au")).toBeUndefined();
  });
});

/**
 * Found by moving two cards in a row through the MCP server: both edits
 * landed in the same second, "latest" was decided by a coin flip
 * between them, and the second move read the pre-move document and
 * quietly undid the first. Two implementations of this rule exist (the
 * client and the extension, which cannot share code across a webview
 * and a node bundle), so both are held to it here.
 */
describe("which version is current", () => {
  const version = (id: string, created_at: number, base?: string) => ({
    id,
    created_at,
    tags: base ? [["base", base]] : [],
  });

  for (const [name, latest] of [
    ["client", (events: ReturnType<typeof version>[]) => orderVersions(events).at(-1)],
    ["extension", (events: ReturnType<typeof version>[]) => currentVersion(events)],
  ] as const) {
    describe(name, () => {
      it("follows the base chain, not the clock, when edits share a second", () => {
        // three edits, all at t=100: the chain is the only ordering there is
        const events = [version("a", 100), version("b", 100, "a"), version("c", 100, "b")];
        for (const shuffled of [events, [...events].reverse(), [events[1], events[2], events[0]]]) {
          expect(latest(shuffled)?.id, name).toBe("c");
        }
      });

      it("still works when versions are properly spaced", () => {
        expect(latest([version("a", 100), version("b", 200, "a")])?.id).toBe("b");
      });

      it("picks the newest branch when two people edited the same base", () => {
        const events = [version("a", 100), version("b", 200, "a"), version("c", 300, "a")];
        expect(latest(events)?.id).toBe("c");
      });

      it("survives a first version with no base tag, and a single version", () => {
        expect(latest([version("a", 100)])?.id).toBe("a");
        expect(latest([])).toBeUndefined();
      });

      it("does not hang or throw if the base tags form a cycle", () => {
        const events = [version("a", 100, "b"), version("b", 100, "a")];
        expect(latest(events)).toBeDefined();
      });
    });
  }

  it("keeps the version list in chronological order for the history picker", () => {
    const ordered = orderVersions([
      { id: "c", created_at: 300, tags: [["base", "b"]] },
      { id: "a", created_at: 100, tags: [] },
      { id: "b", created_at: 200, tags: [["base", "a"]] },
    ]);
    expect(ordered.map((v) => v.id)).toEqual(["a", "b", "c"]);
  });
});

describe("offering the board view", () => {
  it("defaults to the board when the document says it is one", () => {
    expect(isBoard(BOARD)).toBe("default");
  });

  it("offers a board for a hand-kept one, without taking over", () => {
    expect(isBoard("## Todo\n\n- [ ] a\n\n## Done\n\n- [x] b\n")).toBe(true);
  });

  it("leaves ordinary documents alone", () => {
    expect(isBoard("# Notes\n\nSome prose.\n\n- [ ] one stray task\n")).toBe(false);
    expect(isBoard("# Notes\n\n## Background\n\nprose\n\n## Detail\n\nmore prose\n")).toBe(false);
  });

  it("describes a board for an agent reading it through a tool", () => {
    expect(describeBoard(parseBoard(BOARD))).toContain("## In Progress (1)");
    expect(describeBoard(parseBoard(BOARD))).toContain("[x] Extension permissions");
  });
});
