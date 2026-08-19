import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Loads the SHIPPED gui bundle the way fez-desktop's loader does — an
 * IIFE evaluated in a scope with fetch/WebSocket/XMLHttpRequest
 * shadowed — and drives it with a mock api.
 *
 * This exists because of a specific failure: WKWebView imports an IIFE
 * bundle as an empty module WITHOUT throwing, so every gui extension
 * silently registered nothing and the app looked merely featureless
 * rather than broken. A bundle that compiles is not a bundle that
 * works, and nothing else in the suite would notice the difference.
 */

const code = readFileSync(new URL("../../fez-kanban/dist/gui.js", import.meta.url), "utf8");

const BOARD = `# Sprint

\`\`\`fez:board
done: Shipped
limit: In Progress = 1
\`\`\`

## Backlog

- [ ] Audit the consent copy @researcher
- [ ] Multi-relay fan-out @nobody

## In Progress

- [ ] Ship the board @researcher
- [ ] Second card, over the limit

## Shipped

- [x] Extension permissions
`;

interface Node {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}
interface View {
  name: string;
  match: (content: string) => boolean | "default";
  render: (props: Record<string, unknown>) => Node;
}

function load() {
  const factory = new Function(
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    `${code}\n;return (typeof __fezExt !== "undefined" ? __fezExt : undefined);`
  );
  const denied = () => {
    throw new Error("blocked");
  };
  const mod = factory(denied, denied, denied) as { default?: (api: unknown) => void; activate?: (api: unknown) => void };
  const activate = mod?.default ?? mod?.activate;

  const views: View[] = [];
  const blocks = new Map<string, unknown>();
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({
    type,
    props: props ?? {},
    children: children.flat().filter(Boolean),
  });
  const states: unknown[] = [];
  let cursor = 0;
  const useState = (initial: unknown) => {
    const slot = cursor++;
    if (states.length <= slot) states.push(typeof initial === "function" ? (initial as () => unknown)() : initial);
    return [states[slot], () => {}];
  };

  activate?.({
    React: { createElement: h, useState },
    client: { displayName: (pk: string) => pk, pkByName: (n: string) => (n === "researcher" ? "pk" : undefined) },
    registerPageView: (name: string, match: View["match"], render: View["render"]) => views.push({ name, match, render }),
    registerBlockRenderer: (lang: string, render: unknown) => blocks.set(lang, render),
    registerGuiCommand: () => {},
  });
  return { views, blocks, reset: () => (cursor = 0) };
}

/** Flatten a rendered tree to text, calling function components as it goes. */
function text(node: unknown): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const element = node as Node;
  if (typeof element.type === "function") return text((element.type as (p: unknown) => unknown)(element.props));
  return text(element.children ?? []);
}

describe("the kanban gui bundle as shipped", () => {
  const { views, blocks, reset } = load();
  const view = views[0];

  it("registers a page view — the failure mode is registering nothing", () => {
    expect(views).toHaveLength(1);
    expect(view.name).toBe("▦ board");
    expect(blocks.has("fez:board")).toBe(true);
  });

  it("opens board documents as boards and leaves prose alone", () => {
    expect(view.match(BOARD)).toBe("default");
    expect(view.match("## Todo\n\n- [ ] a\n\n## Done\n\n- [x] b\n")).toBe(true);
    expect(view.match("# Notes\n\nJust writing.\n")).toBe(false);
  });

  it("renders the columns, cards, assignees and limits", () => {
    reset();
    const tree = view.render({
      content: BOARD,
      save: async () => {},
      comment: async () => {},
      title: "Sprint",
      channelId: "c",
      communityId: "u",
      editable: true,
    });
    reset();
    const rendered = text((tree.type as (p: unknown) => unknown)(tree.props));

    for (const column of ["Backlog", "In Progress", "Shipped"]) expect(rendered).toContain(column);
    expect(rendered).toContain("Audit the consent copy");
    expect(rendered).toContain("@researcher");
    expect(rendered).toContain("2/1"); // count against the WIP limit
    expect(rendered).toContain("over the limit of 1");
    expect(rendered).toContain("✓"); // the done card is ticked
  });
});
