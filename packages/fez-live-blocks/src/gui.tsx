/**
 * fez-live-blocks, gui part — a doc block an agent keeps up to date.
 *
 * Enters through the block-renderer seam: any ```fez:live``` fence in a
 * wiki page or channel doc renders as a card showing the agent's last
 * output, who wrote it and how long ago, with a refresh button.
 *
 * Refresh deliberately invents NO new mechanism: it posts a doc comment
 * anchored to the block and mentioning the owning agent. Agents already
 * treat a comment as work — they read the doc, do the task, rewrite the
 * block, and answer in the thread. So a live block is just a standing
 * request that anyone can re-fire, and every refresh is a signed edit
 * with an audit trail.
 *
 * JSX with `--jsx-factory=h` (the shared-React shape): markup reads as
 * markup, compiles to the same host-React createElement calls.
 */

import { ago, parseLiveBlock, formatLiveBlock, parseLiveCommand, LIVE_LANG } from "./format.js";

interface ClientLike {
  displayName(pk: string): string;
  pkByName(name: string): string | undefined;
  state: { scope: { channelId: string } | null };
  sendChannelMessage(text: string, opts?: object): Promise<unknown>;
  publishDocComment(
    channelId: string,
    text: string,
    opts?: { anchor?: string; slug?: string; parentId?: string; mentionPks?: string[]; resolve?: boolean }
  ): Promise<void>;
  docsByChannel(): ReadonlyMap<string, { latestContent: string; latestId: string }>;
  publishDoc(channelId: string, content: string, baseId?: string): Promise<void>;
}

interface BlockProps {
  info: string;
  body: string;
  raw: string;
  channelId: string;
  slug?: string;
}

export interface GuiApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  React: { createElement: (...args: any[]) => unknown; useState: <T>(v: T) => [T, (v: T) => void] };
  client?: ClientLike;
  registerBlockRenderer(lang: string, render: (props: BlockProps) => unknown): void;
  registerGuiCommand(name: string, run: (args: string) => Promise<string> | string): void;
  toast?(message: string, variant?: "success" | "error" | "warn" | "info"): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let h: any;

export default function activate(api: GuiApi): void {
  h = api.React.createElement;
  if (!api.client) throw new Error("fez-live-blocks needs read:channels permission");
  const { client } = api;

  api.registerBlockRenderer(LIVE_LANG, ({ info, body, raw, channelId, slug }) => {
    const block = parseLiveBlock(info, body);
    const stale = block.everyMs && block.updatedAt ? Date.now() - block.updatedAt * 1000 > block.everyMs : !block.updatedAt;

    const refresh = async () => {
      if (!block.agent) return;
      const pk = client.pkByName(block.agent);
      try {
        await client.publishDocComment(
          channelId,
          `@${block.agent} refresh this live block. Do the task below, then rewrite ONLY this block in the document — keep the \`\`\`${LIVE_LANG}\`\`\` fence and its agent=/every= attributes, set updated=${Math.floor(Date.now() / 1000)}, put your result under the --- line, and leave the rest of the page untouched.\n\nTask: ${block.prompt}`,
          { anchor: raw.split("\n")[0], slug, mentionPks: pk ? [pk] : [] }
        );
        // The work happens off-screen in a doc thread, so ↻ has no visible
        // effect of its own — say that the ask went out (or didn't).
        api.toast?.(`asked @${block.agent} to refresh`, "success");
      } catch (err) {
        api.toast?.(`refresh failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    };

    return (
      <div className={`live-block${stale ? " stale" : ""}`}>
        <div className="live-block-head">
          <span className="live-block-dot">◉</span>
          <span className="live-block-agent">{block.agent ? `@${block.agent}` : "unassigned"}</span>
          <span className="live-block-meta">
            {`${ago(block.updatedAt, Date.now())}${block.everyMs ? ` · every ${info.match(/every=(\S+)/)?.[1] ?? ""}` : " · manual"}`}
          </span>
          <button className="live-block-refresh" title="ask the agent to update this now" onClick={() => void refresh()}>
            ↻
          </button>
        </div>
        {block.output ? (
          <div className="live-block-output">{block.output}</div>
        ) : (
          <div className="live-block-empty">{`${block.prompt} — no output yet; ↻ asks @${block.agent ?? "an agent"} to fill it in.`}</div>
        )}
      </div>
    );
  });

  // /live @agent every=1d <prompt> — appends a block to the channel doc,
  // which is exactly where "standing information for this channel" goes.
  api.registerGuiCommand("live", async (args) => {
    const parsed = parseLiveCommand(args);
    if ("error" in parsed) return `◉ ${parsed.error}`;
    const scope = client.state.scope;
    if (!scope) return "◉ open a channel first.";
    if (parsed.block.agent && !client.pkByName(parsed.block.agent)) {
      return `◉ nobody named @${parsed.block.agent} is known here — invite them first.`;
    }
    const doc = client.docsByChannel().get(scope.channelId);
    const next = `${doc?.latestContent?.trim() ? doc.latestContent.trimEnd() + "\n\n" : ""}${formatLiveBlock(parsed.block)}\n`;
    await client.publishDoc(scope.channelId, next, doc?.latestId);
    return `◉ live block added to this channel's info — @${parsed.block.agent} keeps it current. Open the channel info bar to see it.`;
  });
}
