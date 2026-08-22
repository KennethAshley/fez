/**
 * A kanban board that IS a markdown document.
 *
 * The board has no database, no card records, no status events. A
 * column is an `## heading`, a card is a `- [ ] line` under it, and
 * moving a card means moving that line. Everything the parser does not
 * understand — prose between columns, front matter, other fenced
 * blocks, nested lists under a card — comes back out verbatim, because
 * the document belongs to whoever wrote it and a board view is only one
 * way of looking at it.
 *
 * That constraint is the whole design. It means a board renders as a
 * perfectly ordinary checklist in any markdown reader, an agent can
 * move a card with the doc-writing tool it already has, the version
 * history is the board's history, and a doc comment on a card line is a
 * comment on that card. The alternative — cards as signed events with
 * the markdown as a projection — buys stable identity across edits and
 * costs the property that makes this worth building.
 *
 * Format (Obsidian Kanban's convention, which people already know):
 *
 *   # Sprint                       ← preamble, verbatim
 *
 *   ```fez:board                   ← optional settings, verbatim
 *   done: Shipped
 *   limit: In Progress = 3
 *   ```
 *
 *   ## Backlog                     ← a column
 *
 *   - [ ] Audit the consent copy   ← a card
 *     needs the strings from @wren ←   its detail, verbatim
 *
 *   ## Shipped
 *
 *   - [x] Extension permissions    ← done, because it sits in `done:`
 *
 * Cards are identified by their TEXT rather than a block id. Obsidian
 * mints `^ids` because its card state lives outside the line; ours is
 * the line, so an id would be ceremony in the markdown that buys
 * nothing — and text is a handle an agent can actually use ("move
 * 'audit the consent copy' to Shipped").
 */

export const BOARD_LANG = "fez:board";

const HEADING = /^##\s+(.+?)\s*$/;
const CARD = /^([-*+])\s+\[([ xX])\]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export interface Card {
  /** the card's text, exactly as written after the checkbox */
  text: string;
  done: boolean;
  /** indented lines under the card — kept verbatim, moved with it */
  detail: string[];
  /** @names mentioned in the text; the first is "whose card this is" */
  assignees: string[];
  /** `-`, `*` or `+`, preserved so we don't restyle someone's document */
  bullet: string;
}

export interface Column {
  name: string;
  /** prose between the heading and the first card */
  lead: string[];
  cards: Card[];
  /** lines after the cards that aren't card detail */
  tail: string[];
}

export interface BoardSettings {
  /** the column that means finished — cards moved there get ticked */
  done?: string;
  /** work-in-progress limits per column name */
  limits: Record<string, number>;
}

export interface Board {
  /** everything before the first column heading, verbatim */
  preamble: string[];
  columns: Column[];
  settings: BoardSettings;
}

/**
 * Is this document worth offering a board view for?
 *
 * The settings fence is an explicit yes. Otherwise we infer: two or
 * more `##` sections with checkboxes under them is, in practice, always
 * somebody keeping a board by hand. Inference only offers the toggle —
 * the document still opens as markdown — so a false positive costs a
 * button, not a surprise.
 */
export function isBoard(markdown: string): boolean | "default" {
  if (settingsFence(markdown)) return "default";
  const board = parseBoard(markdown);
  const withCards = board.columns.filter((column) => column.cards.length > 0);
  return withCards.length >= 2 || (withCards.length >= 1 && board.columns.length >= 2);
}

function settingsFence(markdown: string): string | undefined {
  const match = new RegExp("```" + BOARD_LANG + "\\s*\\n([\\s\\S]*?)```", "i").exec(markdown);
  return match?.[1];
}

export function parseSettings(markdown: string): BoardSettings {
  const settings: BoardSettings = { limits: {} };
  const body = settingsFence(markdown);
  if (!body) return settings;
  for (const line of body.split("\n")) {
    const done = /^\s*done\s*:\s*(.+?)\s*$/i.exec(line);
    if (done) {
      settings.done = done[1];
      continue;
    }
    const limit = /^\s*limit\s*:\s*(.+?)\s*=\s*(\d+)\s*$/i.exec(line);
    if (limit) settings.limits[limit[1].trim()] = Number(limit[2]);
  }
  return settings;
}

export function parseBoard(markdown: string): Board {
  const lines = markdown.split("\n");
  const board: Board = { preamble: [], columns: [], settings: parseSettings(markdown) };
  let column: Column | undefined;
  let card: Card | undefined;
  // A `## heading` inside a fenced block is code, not a column — and the
  // settings block itself lives in a fence, so this is not hypothetical.
  let fence: string | undefined;

  for (const line of lines) {
    const fenceMark = FENCE.exec(line)?.[1];
    if (fenceMark) {
      if (!fence) fence = fenceMark;
      else if (line.trim().startsWith(fence)) fence = undefined;
    }

    const heading = fence ? undefined : HEADING.exec(line);
    if (heading) {
      column = { name: heading[1], lead: [], cards: [], tail: [] };
      board.columns.push(column);
      card = undefined;
      continue;
    }

    if (!column) {
      board.preamble.push(line);
      continue;
    }

    const cardMatch = fence ? undefined : CARD.exec(line);
    if (cardMatch) {
      card = {
        bullet: cardMatch[1],
        done: cardMatch[2].toLowerCase() === "x",
        text: cardMatch[3].trim(),
        detail: [],
        assignees: [...cardMatch[3].matchAll(/@([\w-]+)/g)].map((m) => m[1]),
      };
      column.cards.push(card);
      continue;
    }

    // An indented line under a card is that card's — it travels with it.
    if (card && line.trim() && /^\s/.test(line)) {
      card.detail.push(line);
      continue;
    }
    if (!line.trim()) {
      card = undefined; // a blank line ends a card's detail
      continue;
    }
    if (column.cards.length === 0) column.lead.push(line);
    else column.tail.push(line);
    card = undefined;
  }

  return board;
}

/**
 * Back to markdown. Content lines survive byte-for-byte; blank lines are
 * normalized, since tracking every blank through a move buys nothing a
 * reader would notice and costs a much fussier parser.
 */
export function serializeBoard(board: Board): string {
  const out: string[] = [];
  const preamble = trimBlanks(board.preamble);
  if (preamble.length) out.push(...preamble, "");

  for (const column of board.columns) {
    out.push(`## ${column.name}`, "");
    const lead = trimBlanks(column.lead);
    if (lead.length) out.push(...lead, "");
    for (const card of column.cards) {
      out.push(`${card.bullet} [${card.done ? "x" : " "}] ${card.text}`);
      out.push(...card.detail);
    }
    if (column.cards.length) out.push("");
    const tail = trimBlanks(column.tail);
    if (tail.length) out.push(...tail, "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function trimBlanks(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

/** Find a card by its text, tolerant of case and surrounding space. */
export function findCard(board: Board, text: string): { column: Column; card: Card; index: number } | undefined {
  const wanted = normalize(text);
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => normalize(card.text) === wanted);
    if (index >= 0) return { column, card: column.cards[index], index };
  }
  // Fall back to a prefix match so an agent quoting the first few words
  // of a long card still moves the right one.
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => normalize(card.text).startsWith(wanted) && wanted.length >= 8);
    if (index >= 0) return { column, card: column.cards[index], index };
  }
  return undefined;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function findColumn(board: Board, name: string): Column | undefined {
  const wanted = normalize(name);
  return (
    board.columns.find((column) => normalize(column.name) === wanted) ??
    board.columns.find((column) => normalize(column.name).startsWith(wanted))
  );
}

/** Which column means "finished": what the settings say, else one called done. */
export function doneColumn(board: Board): Column | undefined {
  if (board.settings.done) return findColumn(board, board.settings.done);
  return board.columns.find((column) => /^(done|shipped|complete|completed|closed)$/i.test(column.name.trim()));
}

export interface MoveResult {
  board: Board;
  /** what changed, in words — the message an agent gets back */
  summary: string;
  error?: string;
}

/**
 * Move a card to another column. The checkbox follows the column: a card
 * that lands in `done:` is ticked, one that leaves it is un-ticked. Two
 * representations of "finished" that can disagree is a bug generator, so
 * only one of them is authored and the other is derived.
 */
export function moveCard(board: Board, cardText: string, toColumnName: string, index?: number): MoveResult {
  const found = findCard(board, cardText);
  if (!found) {
    return { board, summary: "", error: `no card matching "${cardText}" — cards are: ${cardList(board)}` };
  }
  const target = findColumn(board, toColumnName);
  if (!target) {
    return {
      board,
      summary: "",
      error: `no column "${toColumnName}" — this board has: ${board.columns.map((c) => c.name).join(", ")}`,
    };
  }
  const from = found.column;
  from.cards.splice(found.index, 1);
  const at = index === undefined ? target.cards.length : Math.max(0, Math.min(index, target.cards.length));
  target.cards.splice(at, 0, found.card);

  const done = doneColumn(board);
  if (done) found.card.done = target.name === done.name;

  return {
    board,
    summary:
      from.name === target.name
        ? `reordered "${found.card.text}" in ${target.name}`
        : `moved "${found.card.text}" from ${from.name} to ${target.name}`,
  };
}

export function addCard(board: Board, columnName: string, text: string): MoveResult {
  const target = findColumn(board, columnName);
  if (!target) {
    return {
      board,
      summary: "",
      error: `no column "${columnName}" — this board has: ${board.columns.map((c) => c.name).join(", ")}`,
    };
  }
  const done = doneColumn(board);
  target.cards.push({
    bullet: target.cards[0]?.bullet ?? "-",
    done: !!done && target.name === done.name,
    text: text.trim(),
    detail: [],
    assignees: [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1]),
  });
  return { board, summary: `added "${text.trim()}" to ${target.name}` };
}

function cardList(board: Board): string {
  const all = board.columns.flatMap((column) => column.cards.map((card) => `"${card.text}"`));
  return all.length ? all.slice(0, 12).join(", ") : "(none — this board is empty)";
}

/** Over its WIP limit? The number people actually want a board to tell them. */
export function overLimit(board: Board, column: Column): number | undefined {
  const limit = board.settings.limits[column.name];
  return limit !== undefined && column.cards.length > limit ? limit : undefined;
}

/**
 * Which of a page's versions is current. Mirrors orderVersions in
 * @fezchat/client — the extension can't import it (it bundles for a
 * webview and for node with no shared dependency), and the rule
 * matters enough to be pinned in both places by the same eval: an
 * agent that reads a stale version overwrites somebody's edit.
 */
export function currentVersion<T extends { id: string; created_at: number; tags: string[][] }>(
  versions: T[]
): T | undefined {
  if (versions.length <= 1) return versions[0];
  const superseded = new Set(
    versions.map((event) => event.tags.find((t) => t[0] === "base")?.[1]).filter((id): id is string => !!id)
  );
  const tips = versions.filter((event) => !superseded.has(event.id));
  const ranked = (tips.length ? tips : versions).sort(
    (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1)
  );
  return ranked[0];
}

/** One line describing a board, for an agent reading it through a tool. */
export function describeBoard(board: Board): string {
  return board.columns
    .map((column) => {
      const cards = column.cards.map((card) => `  ${card.done ? "[x]" : "[ ]"} ${card.text}`).join("\n");
      return `## ${column.name} (${column.cards.length})${cards ? "\n" + cards : ""}`;
    })
    .join("\n");
}
