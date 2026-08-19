import type { FezExtensionAPI } from "./api-types.js";
import { formatLiveBlock, parseLiveCommand } from "./format.js";

/**
 * fez-live-blocks, headless part — /live in the TUI and any bare client.
 * The block is plain markdown in the channel doc, so a client without
 * the gui part still sees the agent's latest output (just unstyled).
 */

interface ClientLike {
  state: { scope?: { channelId: string; communityId: string } };
  docsByChannel(): ReadonlyMap<string, { latestContent: string; latestId: string }>;
  publishDoc(channelId: string, communityId: string, content: string, baseId?: string): Promise<void>;
}

export default function liveBlocks(api: FezExtensionAPI): void {
  const client = api.client as ClientLike | undefined;
  if (!client) return;

  api.registerCommand("live", async (args, ctx) => {
    const parsed = parseLiveCommand(args);
    if ("error" in parsed) {
      ctx.reply(`◉ ${parsed.error}`);
      return;
    }
    if (!client.state.scope) {
      ctx.reply("◉ open a channel first.");
      return;
    }
    const { channelId, communityId } = client.state.scope;
    const doc = client.docsByChannel().get(channelId);
    const next = `${doc?.latestContent?.trim() ? doc.latestContent.trimEnd() + "\n\n" : ""}${formatLiveBlock(parsed.block)}\n`;
    await client.publishDoc(channelId, communityId, next, doc?.latestId);
    ctx.reply(`◉ live block added to the channel doc — @${parsed.block.agent} owns it. Comment on it (or ↻ in the GUI) to refresh.`);
  });
}
