import type { FezExtensionAPI } from "./api-types.js";
import { formatPoll, parsePollCommand } from "./format.js";

/**
 * fez-polls, headless part — /poll in any client, no GUI required.
 * The poll is a plain message; votes are reactions (bare clients react
 * manually with the option number emoji). Tallying is deterministic
 * and identical everywhere (shared vote-logic).
 */

interface ClientLike {
  state: { scope?: { channelId: string; communityId: string } };
  sendChannelMessage(text: string, opts?: object): Promise<unknown>;
}

export default function polls(api: FezExtensionAPI): void {
  const client = api.client as ClientLike | undefined;
  if (!client) return;

  api.registerCommand("poll", async (args, ctx) => {
    const parsed = parsePollCommand(args);
    if ("error" in parsed) {
      ctx.reply(`📊 ${parsed.error}`);
      return;
    }
    if (!client.state.scope) {
      ctx.reply("📊 open a channel first.");
      return;
    }
    await client.sendChannelMessage(formatPoll(parsed.question, parsed.options, Date.now() + parsed.durationMs));
    ctx.reply(`📊 poll posted — vote by reacting with the option number; it closes in ${Math.round(parsed.durationMs / 60_000)}m.`);
  });
}
