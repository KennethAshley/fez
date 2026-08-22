import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { lanesFor, lineOfRoot } from "../../fez-git/src/board.js";
import type { PushEntry } from "../../fez-git/src/journal-format.js";

/**
 * The SHIPPED repos panel, loaded the way fez-desktop loads it.
 *
 * Same reason kanban-gui.test.ts exists: WKWebView imports a bad bundle
 * as an empty module WITHOUT throwing, so an extension that registers
 * nothing looks merely featureless rather than broken. Compiling is not
 * working. This one has a second failure mode of its own — the panel
 * reaches into `client` for three members that live in @fezchat/client, and
 * a bundle is loaded from a blob URL at boot with no build step between
 * it and the user.
 */

const code = readFileSync(new URL("../../fez-git/dist/gui.js", import.meta.url), "utf8");

interface Node {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

const OWNER = "a".repeat(64);
const ADVERTISING = { pubkey: OWNER, fez_git: { clone_base: "https://relay.example/git" } };

let hookCount = 0;
const hookCalls = (): number => hookCount;

interface Ensured {
  name: string;
  source?: string;
  meta?: Record<string, string>;
}

function load(opts: { info?: Record<string, unknown>; pubkey?: string; channels?: Ensured[] } = {}) {
  const factory = new Function(
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    `${code}\n;return (typeof __fezExt !== "undefined" ? __fezExt : undefined);`
  );
  const denied = () => {
    throw new Error("blocked");
  };
  const mod = factory(denied, denied, denied) as { default?: (api: unknown) => void };

  const panels: { name: string; render: () => Node; opts?: { source?: string } }[] = [];
  const threadViews: { name: string; match: (c: string) => boolean; render: (p: Record<string, unknown>) => Node }[] = [];
  const decorators: { match: (c: string) => boolean; render: (p: Record<string, unknown>) => Node }[] = [];
  const opened: { channelId: string; rootId: string }[] = [];
  const commands = new Map<string, (args: string) => Promise<string> | string>();
  const ensured: Ensured[] = [];
  const sent: { text: string; channelId?: string }[] = [];
  const existing = opts.channels ?? [];

  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({
    type,
    props: props ?? {},
    children: children.flat().filter(Boolean),
  });
  const states: unknown[] = [];
  let cursor = 0;
  const useState = (initial: unknown) => {
    hookCount++;
    const slot = cursor++;
    if (states.length <= slot) states.push(typeof initial === "function" ? (initial as () => unknown)() : initial);
    return [states[slot], (next: unknown) => (states[slot] = next)];
  };

  mod?.default?.({
    // Effects RUN. A mock that swallowed them would hide the very bug
    // this file exists to catch: a panel that renders nothing until
    // something else happens to re-render it.
    React: {
      createElement: h,
      useState,
      useEffect: (fn: () => void | (() => void)) => void fn(),
      useCallback: (fn: unknown) => fn,
    },
    client: {
      pubkey: opts.pubkey ?? OWNER,
      relayInfo: () => opts.info,
      channelsFrom: (source: string) =>
        existing
          .filter((c) => c.source === source)
          .map((c, i) => ({ id: `id-${i}`, name: c.name, meta: c.meta })),
      ensureChannel: async (spec: Ensured) => {
        ensured.push(spec);
        return opts.pubkey && opts.pubkey !== OWNER ? undefined : "new-id";
      },
      on: () => () => {},
      sendChannelMessage: async (text: string, opts?: { channelId?: string }) => {
        sent.push({ text, channelId: opts?.channelId });
        return {};
      },
      httpAuthHeader: () => undefined, // board degrades to an empty state
      messages: () => [],
      threadReplies: (_c: string, root: string) =>
        root === "line-1"
          ? [
              { id: "s1", content: "↳ `reviewer/feat-x` — reviewer is working this line" },
              { id: "s2", content: "↳ `researcher/feat-x` — researcher is working this line" },
            ]
          : [],
      displayName: (pk: string) => pk.slice(0, 8),
      workingAgents: () => new Map(),
    },
    openUrl: async () => {},
    registerSettingsPanel: (name: string, render: () => Node, o?: { source?: string }) =>
      panels.push({ name, render, opts: o }),
    registerGuiCommand: (name: string, run: (args: string) => Promise<string> | string) => commands.set(name, run),
    registerThreadView: (name: string, match: (c: string) => boolean, render: (p: Record<string, unknown>) => Node) =>
      threadViews.push({ name, match, render }),
    registerMessageDecorator: (match: (c: string) => boolean, render: (p: Record<string, unknown>) => Node) =>
      decorators.push({ match, render }),
    watchAgent: () => {},
    openThread: (channelId: string, rootId: string) => opened.push({ channelId, rootId }),
  });

  return { panels, commands, ensured, sent, threadViews, decorators, opened, reset: () => (cursor = 0) };
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

describe("the repos panel as shipped", () => {
  it("mounts as a component — render() must not run hooks itself", () => {
    // The host calls panel.render() during ITS OWN render. A panel
    // registered as a bare component function runs its hooks in the
    // host's hook list — an invalid-hook-call crash that blanks the
    // whole app, which is exactly what happened. render() must return
    // an ELEMENT (an uncalled component) and touch no hooks doing it.
    const { panels } = load({ info: ADVERTISING });
    const before = hookCalls();
    const node = panels[0].render();
    expect(hookCalls()).toBe(before);
    expect(typeof (node as { type?: unknown }).type).toBe("function");
  });

  it("registers a panel and a command — the failure mode is registering nothing", () => {
    const { panels, commands } = load({ info: ADVERTISING });
    expect(panels).toHaveLength(1);
    // The source is what lets the rail's group for repo channels offer a
    // settings button; dropping it is how that button went missing before.
    expect(panels[0].opts?.source).toBe("fez-git");
    expect(commands.has("repo")).toBe(true);
  });

  it("shows each repo's clone url and what it protects", () => {
    const { panels, reset } = load({
      info: ADVERTISING,
      channels: [
        { name: "fleet", source: "fez-git", meta: { repo: "fleet", clone: "https://relay.example/git/fleet.git", protect: "main" } },
      ],
    });
    reset();
    const out = text(panels[0].render());
    expect(out).toContain("#fleet");
    expect(out).toContain("https://relay.example/git/fleet.git");
    expect(out).toContain("protects refs/heads/main");
    expect(out).toContain("fast-forward only");
  });

  it("says a repo with no stated policy still protects main", () => {
    // Read through the same resolver the relay enforces with, so the
    // panel can never show a policy that is not the one being applied.
    const { panels, reset } = load({
      info: ADVERTISING,
      channels: [{ name: "old", source: "fez-git", meta: { repo: "old", clone: "x" } }],
    });
    reset();
    expect(text(panels[0].render())).toContain("protects refs/heads/main");
  });

  it("says `none` plainly rather than leaving a blank", () => {
    const { panels, reset } = load({
      info: ADVERTISING,
      channels: [{ name: "open", source: "fez-git", meta: { repo: "open", clone: "x", protect: "none" } }],
    });
    reset();
    expect(text(panels[0].render())).toContain("protects nothing");
  });

  it("does NOT invent a clone url when the relay advertises no git", () => {
    // The old bug this mirrors: deriving http:// from the websocket
    // address is right on a laptop and silently wrong behind a proxy.
    const { panels, reset } = load({ info: { pubkey: OWNER } });
    reset();
    const out = text(panels[0].render());
    expect(out).toContain("does not advertise");
    expect(out).not.toMatch(/https?:\/\/[^\s]*\.git/);
  });
});

describe("the lane board as shipped", () => {
  it("registers a thread view that claims exactly ⑂ roots", () => {
    const { threadViews } = load({ info: ADVERTISING });
    expect(threadViews).toHaveLength(1);
    expect(threadViews[0].match("⑂ `feat-auth` — line opened.")).toBe(true);
    expect(threadViews[0].match("just a chat message")).toBe(false);
  });

  it("renders the empty state when the journal is unreachable", () => {
    const { threadViews, reset } = load({
      info: ADVERTISING,
      channels: [{ name: "fleet", source: "fez-git", meta: { repo: "fleet", clone: "c" } }],
    });
    reset();
    const out = text(threadViews[0].render({ channelId: "id-0", rootId: "r", rootContent: "⑂ `feat-auth` — line opened." }));
    expect(out).toContain("no pushes on this line yet");
  });
});

describe("the line chip in the channel", () => {
  it("summarizes lanes from stub replies and opens the board", () => {
    const { decorators, opened } = load({ info: ADVERTISING });
    expect(decorators).toHaveLength(1);
    expect(decorators[0].match("⑂ `feat-x` — line opened.")).toBe(true);
    expect(decorators[0].match("plain chat")).toBe(false);
    const out = decorators[0].render({ content: "⑂ `feat-x` — line opened.", msgId: "line-1", channelId: "c1", authorName: "You" });
    expect(text(out)).toContain("2 lane(s)");
    // the walk down is a real navigation, not prose
    const btn = findButton(out);
    (btn!.props.onClick as () => void)();
    expect(opened).toEqual([{ channelId: "c1", rootId: "line-1" }]);
  });
});

/** first button node in a rendered tree */
function findButton(node: unknown): Node | undefined {
  if (node == null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child);
      if (hit) return hit;
    }
    return undefined;
  }
  const el = node as Node;
  if (el.type === "button") return el;
  return findButton(el.children);
}

describe("lanes, from the journal", () => {
  const ZERO = "0".repeat(40);
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const entry = (ref: string, sha: string, ts: number): PushEntry => ({ ts, pusher: "p".repeat(64), old: ZERO, new: sha, ref });

  it("keeps only this line's branches, tips last-write-wins", () => {
    const lanes = lanesFor(
      [
        entry("refs/heads/reviewer/feat-auth", A, 1),
        entry("refs/heads/reviewer/feat-auth", B, 2),
        entry("refs/heads/researcher/other-line", A, 3),
        entry("refs/heads/feat-auth", A, 4),
        entry("refs/heads/main", A, 5),
      ],
      "feat-auth"
    );
    expect(lanes.map((l) => l.branch)).toEqual(["reviewer/feat-auth", "feat-auth"]);
    expect(lanes[0].tip).toBe(B);
    expect(lanes[0].agent).toBe("reviewer");
  });

  it("drops a deleted lane", () => {
    const lanes = lanesFor(
      [entry("refs/heads/reviewer/feat-auth", A, 1), { ts: 2, pusher: "p".repeat(64), old: A, new: ZERO, ref: "refs/heads/reviewer/feat-auth" }],
      "feat-auth"
    );
    expect(lanes).toEqual([]);
  });

  it("reads the line off a root marker", () => {
    expect(lineOfRoot("⑂ `feat-auth` — line opened.")).toBe("feat-auth");
    expect(lineOfRoot("⑂ `reviewer/feat-auth` — reviewer pushed `abc`")).toBe("reviewer/feat-auth");
    expect(lineOfRoot("hello")).toBeUndefined();
  });
});

describe("/repo in the desktop composer", () => {
  it("opens a repo with main protected, matching the TUI", async () => {
    const { commands, ensured } = load({ info: ADVERTISING });
    const out = await commands.get("repo")!("new demo");
    expect(ensured.at(-1)).toEqual({
      name: "demo",
      source: "fez-git",
      meta: { repo: "demo", clone: "https://relay.example/git/demo.git", protect: "main" },
    });
    expect(out).toContain("https://relay.example/git/demo.git");
    expect(out).toContain("`main` is protected");
  });

  it("changes what a repo protects", async () => {
    const { commands, ensured } = load({
      info: ADVERTISING,
      channels: [{ name: "fleet", source: "fez-git", meta: { repo: "fleet", clone: "c", protect: "main" } }],
    });
    await commands.get("repo")!("protect fleet release/*");
    expect(ensured.at(-1)?.meta?.protect).toBe("release/*");
  });

  it("opens a line from the composer — same contract as the TUI command", async () => {
    const { commands, sent } = load({
      info: ADVERTISING,
      channels: [{ name: "fleet", source: "fez-git", meta: { repo: "fleet", clone: "c" } }],
    });
    const out = await commands.get("repo")!("branch fleet feat-x");
    expect(out).toContain("line `feat-x` opened");
    expect(sent).toHaveLength(1);
    expect(sent[0].channelId).toBe("id-0");
    expect(sent[0].text).toContain("⑂ `feat-x`"); // the thread task's marker
  });

  it("says why when merge cannot sign from this client", async () => {
    const { commands } = load({
      info: ADVERTISING,
      channels: [{ name: "fleet", source: "fez-git", meta: { repo: "fleet", clone: "c" } }],
    });
    const out = await commands.get("repo")!("merge fleet reviewer/feat-x");
    expect(out).toContain("cannot sign");
  });

  it("refuses a name that is not a repo name, without reaching the wire", async () => {
    const { commands, ensured } = load({ info: ADVERTISING });
    const out = await commands.get("repo")!("new ../../etc/passwd");
    expect(out).toContain("is not a repo name");
    expect(ensured).toHaveLength(0);
  });

  it("says who may, rather than failing silently", async () => {
    const { commands } = load({ info: ADVERTISING, pubkey: "b".repeat(64) });
    expect(await commands.get("repo")!("new demo")).toContain("only the workspace owner");
  });
});
