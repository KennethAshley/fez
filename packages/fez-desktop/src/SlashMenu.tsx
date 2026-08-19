import { useEffect, useRef, useState } from "react";
import { extensionBlockMenu, type BlockMenuItem } from "./gui-extensions";

/**
 * `/` in the document — Notion's actual discoverability mechanism.
 *
 * Every block type we shipped (fez:query, fez:board, fez:live, plus
 * whatever an extension registers) was invisible: you could only insert
 * one by already knowing its fence existed, that it took English, and
 * which English it understood. Three things nobody can learn from
 * looking at an empty editor.
 *
 * So: type `/`, see what's possible, pick one. It inserts real markdown
 * at the caret and gets out of the way — no hidden state, nothing that
 * needs the menu to have existed in order for the document to make
 * sense later.
 */

/** `$0` marks where the caret should land after inserting. */
const CORE_BLOCKS: BlockMenuItem[] = [
  {
    label: "query",
    description: "a live list from the relay — tasks, approvals, pages",
    template: "```fez:query\nopen tasks, by page$0\n```\n",
    keywords: ["search", "list", "dashboard", "tasks", "find"],
  },
  {
    label: "table",
    description: "a plain markdown table",
    template: "| $0 |  |\n| --- | --- |\n|  |  |\n",
    keywords: ["grid", "rows", "columns"],
  },
  {
    label: "checklist",
    description: "task list — ticking one is a signed event",
    template: "- [ ] $0\n- [ ] \n",
    keywords: ["todo", "tasks", "checkbox"],
  },
  { label: "heading", description: "section heading", template: "## $0\n", keywords: ["title", "section", "h2"] },
  { label: "quote", description: "block quote", template: "> $0\n", keywords: ["callout", "note"] },
  { label: "code", description: "fenced code block", template: "```\n$0\n```\n", keywords: ["snippet", "pre"] },
  { label: "divider", description: "horizontal rule", template: "\n---\n\n$0", keywords: ["hr", "line", "separator"] },
  {
    label: "link a page",
    description: "wiki link — an unwritten page starts when you click it",
    template: "[[$0]]",
    keywords: ["wiki", "backlink", "reference"],
  },
];

export interface SlashState {
  /** Index in the textarea where the "/" sits. */
  start: number;
  query: string;
  top: number;
  left: number;
}

/**
 * Where the caret is, in pixels relative to the textarea.
 *
 * A textarea gives no caret geometry, so the standard trick: render the
 * text into a hidden div with identical metrics and measure a marker
 * span. Anchoring to the textarea's edge instead would put the menu a
 * screen away from where you're typing in a full-height editor, which
 * is the whole difference between "in the document" and "somewhere on
 * the page".
 */
export function caretPosition(textarea: HTMLTextAreaElement, index: number): { top: number; left: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of [
    "boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "textIndent",
  ] as const) {
    mirror.style[property] = style[property];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop - textarea.scrollTop;
  const left = marker.offsetLeft;
  document.body.removeChild(mirror);
  return { top, left };
}

/**
 * Should a "/" here open the menu? Only at the start of a line or after
 * whitespace — otherwise every URL and every "and/or" pops a menu open
 * while someone is trying to write a sentence.
 */
export function slashAt(value: string, caret: number): SlashState | undefined {
  const before = value.slice(0, caret);
  const slash = before.lastIndexOf("/");
  if (slash < 0) return undefined;
  const preceding = slash === 0 ? "\n" : before[slash - 1];
  if (!/\s/.test(preceding)) return undefined;
  const typed = before.slice(slash + 1);
  // A space or newline after "/" means they moved on; this isn't a command.
  if (/[\s\n]/.test(typed)) return undefined;
  return { start: slash, query: typed, top: 0, left: 0 };
}

export function menuItems(query: string): BlockMenuItem[] {
  const all = [...CORE_BLOCKS, ...extensionBlockMenu()];
  const wanted = query.trim().toLowerCase();
  if (!wanted) return all;
  return all.filter(
    (item) =>
      item.label.toLowerCase().includes(wanted) ||
      item.keywords?.some((keyword) => keyword.includes(wanted)) ||
      item.description?.toLowerCase().includes(wanted)
  );
}

export default function SlashMenu({
  state,
  onPick,
  onClose,
}: {
  state: SlashState;
  onPick: (item: BlockMenuItem) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const items = menuItems(state.query);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(0), [state.query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (items.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((current) => (current + 1) % items.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((current) => (current - 1 + items.length) % items.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        onPick(items[active]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    // Capture: the textarea's own Enter handler must not also fire.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items, active, onPick, onClose]);

  useEffect(() => {
    ref.current?.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (items.length === 0) {
    return (
      <div className="slash-menu" style={{ top: state.top, left: state.left }}>
        <div className="slash-empty">nothing called “{state.query}” — esc to keep typing</div>
      </div>
    );
  }

  return (
    <div className="slash-menu" ref={ref} style={{ top: state.top, left: state.left }}>
      {items.map((item, index) => (
        <button
          key={item.label}
          className={index === active ? "slash-item active" : "slash-item"}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => {
            event.preventDefault(); // keep focus in the textarea
            onPick(item);
          }}
        >
          <span className="slash-label">{item.label}</span>
          {item.description && <span className="slash-desc">{item.description}</span>}
        </button>
      ))}
    </div>
  );
}
