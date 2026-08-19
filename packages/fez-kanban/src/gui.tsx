/**
 * fez-kanban, gui part — the board view.
 *
 * Enters through the page-view seam: a document with columns of
 * checkboxes gets a "board" toggle in its header, and a document with a
 * ```fez:board``` settings fence opens as one. Dragging a card rewrites
 * the markdown and publishes a version — so a move is a signed edit by
 * whoever made it, it shows up in the page history next to everyone
 * else's, and any client that has never heard of this extension still
 * reads the board as a perfectly ordinary checklist.
 *
 * The point of the whole thing is the other half: an agent moves a card
 * with fez_board_move, which does exactly what a drag does. "Assign"
 * posts a doc comment anchored to the card's line mentioning the agent —
 * the same summon path a comment on any other line uses — so the agent
 * picks up the card, does the work, and moves its own card to Done.
 */

import {
  BOARD_LANG,
  addCard,
  doneColumn,
  isBoard,
  moveCard,
  overLimit,
  parseBoard,
  serializeBoard,
  type Board,
  type Card,
  type Column,
} from "./board.js";

interface PageViewProps {
  content: string;
  save: (next: string) => Promise<void>;
  comment: (text: string, anchor: string, mentions: string[]) => Promise<void>;
  title: string;
  channelId: string;
  slug?: string;
  editable: boolean;
}

interface BlockProps {
  info: string;
  body: string;
  raw: string;
}

interface GuiApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React: any;
  client: { displayName(pk: string): string; pkByName(name: string): string | undefined };
  registerPageView(
    name: string,
    match: (content: string) => boolean | "default",
    render: (props: PageViewProps) => unknown
  ): void;
  registerBlockRenderer(lang: string, render: (props: BlockProps) => unknown, menu?: object): void;
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let h: (...args: any[]) => unknown;
let useState: <T>(initial: T | (() => T)) => [T, (next: T | ((previous: T) => T)) => void];

export default function activate(api: GuiApi): void {
  h = api.React.createElement;
  useState = api.React.useState;
  knownAgent = (name) => !!api.client.pkByName(name);

  api.registerPageView("▦ board", isBoard, (props) => h(BoardView, props));

  // The settings fence is configuration, not content — in the markdown
  // view it reads as a small chip instead of a wall of code.
  api.registerBlockRenderer(
    BOARD_LANG,
    ({ body }) => {
    const done = /done\s*:\s*(.+)/i.exec(body)?.[1]?.trim();
    const limits = [...body.matchAll(/limit\s*:\s*(.+?)\s*=\s*(\d+)/gi)].map((m) => `${m[1].trim()} ≤ ${m[2]}`);
    return h(
      "div",
      { className: "board-settings" },
      h("span", { className: "board-settings-tag" }, "▦ board"),
      done && h("span", { className: "board-settings-item" }, `done: ${done}`),
        ...limits.map((limit) => h("span", { className: "board-settings-item", key: limit }, limit))
      );
    },
    {
      label: "board",
      description: "kanban — columns are headings, cards are checkboxes",
      keywords: ["kanban", "cards", "columns", "sprint", "tasks"],
      template:
        "```fez:board\ndone: Done\n```\n\n## Backlog\n\n- [ ] $0\n\n## In Progress\n\n## Done\n",
    }
  );
}

interface Drag {
  card: string;
  from: string;
}

function BoardView(props: PageViewProps) {
  const [board, setBoard] = useState<Board>(() => parseBoard(props.content));
  const [source, setSource] = useState<string>(props.content);
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Someone else — a person in another client, or an agent moving its
  // own card — published a new version while this was open. Take it,
  // unless a drag is mid-flight, in which case the drop wins and their
  // version becomes its base.
  if (props.content !== source && !drag) {
    setSource(props.content);
    setBoard(parseBoard(props.content));
  }

  const done = doneColumn(board);

  /** Apply a change optimistically, then publish. */
  const commit = async (next: Board, failure?: string) => {
    if (failure) {
      setError(failure);
      return;
    }
    setError(undefined);
    const markdown = serializeBoard(next);
    setBoard(parseBoard(markdown));
    setSource(markdown);
    setBusy(true);
    try {
      await props.save(markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // put the document back the way it was — a failed publish that
      // leaves the card in its new column is a lie about shared state
      setBoard(parseBoard(props.content));
      setSource(props.content);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (columnName: string, index?: number) => {
    if (!drag || !props.editable) return;
    const current = drag;
    setDrag(undefined);
    setOver(undefined);
    const result = moveCard(parseBoard(serializeBoard(board)), current.card, columnName, index);
    await commit(result.board, result.error);
  };

  const add = async (columnName: string) => {
    const text = draft.trim();
    setAdding(undefined);
    setDraft("");
    if (!text) return;
    const result = addCard(parseBoard(serializeBoard(board)), columnName, text);
    await commit(result.board, result.error);
  };

  /**
   * Hand a card to an agent: a doc comment anchored to the card's line,
   * mentioning them. No new mechanism — agents already treat a comment
   * on a line as work, and this way the request, the answer and the
   * card all live in the same document.
   */
  const assign = async (card: Card, agent: string) => {
    const line = `- [${card.done ? "x" : " "}] ${card.text}`;
    await props.comment(
      `@${agent} this card is yours: ${card.text}\n\nWhen you pick it up move it to "In Progress" with fez_board_move, and to "${done?.name ?? "Done"}" when it's finished.`,
      line,
      [agent]
    );
  };

  return h(
    "div",
    { className: "board" },
    error &&
      h(
        "div",
        { className: "board-error" },
        error,
        h("button", { className: "mini", onClick: () => setError(undefined) }, "dismiss")
      ),
    h(
      "div",
      { className: "board-columns" },
      ...board.columns.map((column: Column) => {
        const limit = overLimit(board, column);
        const isDone = done?.name === column.name;
        return h(
          "div",
          {
            key: column.name,
            className: `board-column${over === column.name ? " over" : ""}${limit !== undefined ? " over-limit" : ""}`,
            onDragOver: (event: DragEvent) => {
              if (!drag) return;
              event.preventDefault();
              setOver(column.name);
            },
            onDragLeave: () => setOver((current: string | undefined) => (current === column.name ? undefined : current)),
            onDrop: (event: DragEvent) => {
              event.preventDefault();
              void drop(column.name);
            },
          },
          h(
            "div",
            { className: "board-column-head" },
            h("span", { className: "board-column-name" }, column.name),
            h(
              "span",
              { className: "board-column-count" },
              `${column.cards.length}${board.settings.limits[column.name] !== undefined ? `/${board.settings.limits[column.name]}` : ""}`
            ),
            props.editable &&
              h(
                "button",
                {
                  className: "board-add",
                  title: `add a card to ${column.name}`,
                  onClick: () => {
                    setAdding(adding === column.name ? undefined : column.name);
                    setDraft("");
                  },
                },
                "+"
              )
          ),
          limit !== undefined && h("div", { className: "board-limit-warn" }, `over the limit of ${limit}`),
          adding === column.name &&
            h("textarea", {
              className: "board-new",
              value: draft,
              autoFocus: true,
              rows: 2,
              placeholder: "card… @agent to give it to someone",
              onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
              onKeyDown: (event: KeyboardEvent) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void add(column.name);
                }
                if (event.key === "Escape") setAdding(undefined);
              },
            }),
          ...column.cards.map((card: Card, index: number) =>
            h(CardTile, {
              key: `${column.name}:${index}:${card.text}`,
              card,
              column,
              index,
              isDone,
              editable: props.editable && !busy,
              dragging: drag?.card === card.text,
              onDragStart: () => setDrag({ card: card.text, from: column.name }),
              onDragEnd: () => {
                setDrag(undefined);
                setOver(undefined);
              },
              onDropBefore: () => void drop(column.name, index),
              onAssign: (agent: string) => void assign(card, agent),
            })
          ),
          column.cards.length === 0 &&
            adding !== column.name &&
            h("div", { className: "board-column-empty" }, props.editable ? "drop a card here" : "empty")
        );
      })
    ),
    !props.editable && h("div", { className: "board-readonly" }, "an older version — switch to the latest to move cards")
  );
}

/** Set at activate time — a card shows whether its @name is anyone real. */
let knownAgent: (name: string) => boolean = () => false;

interface TileProps {
  card: Card;
  column: Column;
  index: number;
  isDone: boolean;
  editable: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropBefore: () => void;
  onAssign: (agent: string) => void;
}

function CardTile(props: TileProps) {
  const { card } = props;
  const assignee = card.assignees[0];

  return h(
    "div",
    {
      className: `board-card${card.done ? " done" : ""}${props.dragging ? " dragging" : ""}`,
      draggable: props.editable,
      onDragStart: (event: DragEvent) => {
        event.dataTransfer?.setData("text/plain", card.text);
        props.onDragStart();
      },
      onDragEnd: props.onDragEnd,
      onDragOver: (event: DragEvent) => event.preventDefault(),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        props.onDropBefore();
      },
    },
    h(
      "div",
      { className: "board-card-text" },
      card.done && h("span", { className: "board-card-tick" }, "✓"),
      renderText(card.text)
    ),
    card.detail.length > 0 && h("div", { className: "board-card-detail" }, card.detail.map((line) => line.trim()).join("\n")),
    // The footer deliberately does NOT repeat the assignee: the @name is
    // already in the card text, because that's where the markdown puts
    // it. It carries only what the text can't say — that nobody has this
    // card, or that its @name matches nobody here.
    foot(card) &&
      h(
        "div",
        { className: "board-card-foot" },
        !assignee
          ? h("span", { className: "board-card-who none" }, "unassigned")
          : h("span", { className: "board-card-who unknown" }, `@${assignee} isn't here`)
      ),
    // Hand-off lives in the corner on hover, like every other action in
    // this app — a button per card, always shown, is a row of noise on a
    // surface whose whole job is to be scannable.
    props.editable &&
      assignee &&
      knownAgent(assignee) &&
      h(
        "button",
        {
          className: "board-card-hand",
          title: `ask @${assignee} to pick this up — posts a comment on this card`,
          onClick: () => props.onAssign(assignee),
        },
        "→"
      )
  );
}

/** Is there anything for the footer to say? Usually not — silence is the default. */
function foot(card: Card): boolean {
  const assignee = card.assignees[0];
  return assignee ? !knownAgent(assignee) : !card.done;
}

/** @mentions get a highlight; everything else is plain text. */
function renderText(text: string): unknown[] {
  const out: unknown[] = [];
  let last = 0;
  for (const match of text.matchAll(/@([\w-]+)/g)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(h("span", { className: "board-mention", key: `${at}` }, match[0]));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
