import type { CommandContext, FezExtensionAPI } from "@fezchat/extension-api/headless";
import { makeX402Deps, x402FetchRaw, type X402ToolDeps } from "@fezchat/wallet";
import { dispatchRidges, type FetchLike, type X402Call, type X402Outcome } from "./dispatch.js";
import { ridgesDir } from "./home.js";
import { createPollerState, pollOnce } from "./poller.js";
import { formatJob, statusReport } from "./status.js";
import { readJobs, upsertJob, updatesChannel, setUpdatesChannel } from "./store.js";

const POLL_INTERVAL_MS = 90_000;

/**
 * fez-ridges, headless part — `/ridges <issue-url>`.
 *
 * The agent-facing half of this same flow (the `ridges_dispatch` tool)
 * runs in mcp.ts, a separate `skill` part/process per this repo's
 * convention for agent tools (fez-wallet's mcp.ts) — the headless
 * `FezExtensionAPI` (registerCommand/registerScheduledTask/…) has no
 * tool-registration surface of its own. Both call the same
 * `dispatchRidges`, so the command and the tool can never disagree.
 *
 * No money logic here: `x402FetchRaw` (via the wallet) makes every
 * spend decision; this file only turns a command line into a call and
 * a call's outcome into a reply.
 */
export default function fezRidges(api: FezExtensionAPI): void {
  api.registerCommand("ridges", async (args: string, ctx: CommandContext) => {
    const issueUrl = args.trim();
    if (/^status(?:\s|$)/.test(issueUrl)) {
      const offset = issueUrl.split(/\s+/)[1] ?? "0";
      if (!/^\d+$/.test(offset)) return ctx.reply("Use /ridges status [offset]");
      return ctx.reply(statusReport(ridgesDir(), { offset: Number(offset) }));
    }
    if (/^watch(?:\s|$)/.test(issueUrl)) {
      const target = issueUrl.split(/\s+/)[1];
      if (target === "off") { setUpdatesChannel(ridgesDir(), null); return ctx.reply("Ridges channel updates disabled. History remains available with /ridges status."); }
      if (!target) return ctx.reply(`Updates channel: ${updatesChannel(ridgesDir()) ?? "off"}. Use /ridges watch <channel-id> to publish local Ridges job updates there.`);
      if (!api.channels || !(await api.channels.list()).some(c => c.id === target)) return ctx.reply("Choose a channel ID from this workspace; no updates channel was changed.");
      setUpdatesChannel(ridgesDir(), target);
      return ctx.reply(`Ridges updates for local paid jobs will be posted in channel ${target} by the sentinel. /ridges watch off disables them.`);
    }
    if (!issueUrl) {
      return ctx.reply("ridges: /ridges <github-issue-url> · /ridges status [offset] · /ridges watch <channel-id|off>");
    }
    // A command typed by the workspace owner has no FEZ_AGENT_PERSONA of
    // its own — "owner" is the established fallback identity elsewhere
    // in this repo (src/cli/cmd-persona.ts) for exactly this case.
    const persona = process.env.FEZ_AGENT_PERSONA ?? "owner";
    try {
      const x402Deps = await makeX402Deps(persona);
      const reply = await dispatchRidges(
        { persona, dir: ridgesDir(), x402: asX402Call(), x402Deps },
        { issueUrl }
      );
      return ctx.reply(reply);
    } catch (e) {
      return ctx.reply(`ridges: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Watches GitHub for the PR a paid dispatch bought, and transitions job
  // rows honestly as it moves — same convention as fez-git's
  // "git-branch-threads" scheduled task (registerScheduledTask + a
  // module-held cursor/state, since a task can be retried or double-run
  // and must never depend on foreground behavior). State lives here, not
  // in ctx, because poller.ts's etags/backoff are this task's own cursor,
  // not something another surface needs to see.
  const pollerState = createPollerState();
  api.registerScheduledTask("ridges-pr-poll", POLL_INTERVAL_MS, async (ctx) => {
    await pollOnce({ dir: ridgesDir(), fetchImpl: fetch as unknown as FetchLike, state: pollerState });
    const channel = updatesChannel(ridgesDir());
    if (!channel) return;
    if (!(await ctx.channels.list()).some(c => c.id === channel)) throw Error("Ridges updates channel is unavailable; pending updates retained");
    await announceUpdates(ridgesDir(), text => ctx.channels.say(channel, text), () => updatesChannel(ridgesDir()) === channel);
  });
}

export async function announceUpdates(dir: string, deliver: (text: string) => Promise<unknown>, allowed: () => boolean = () => true): Promise<void> {
  for (const job of readJobs(dir).filter(j => j.pendingUpdate)) {
    if (!allowed()) break;
    await deliver(`Ridges update\n${formatJob(job)}`);
    const current = readJobs(dir).find(j => j.id === job.id);
    if (current && current.updatedAt === job.updatedAt && current.status === job.status && current.pollingNote === job.pollingNote)
      upsertJob(dir, { ...current, pendingUpdate: false });
  }
}

/**
 * Adapts the wallet's `x402FetchRaw` (which knows the real, sensitive
 * `X402ToolDeps` shape) to `dispatchRidges`'s deliberately opaque
 * `X402Call` — the one cast this package takes, so `dispatch.ts` itself
 * never imports a wallet-internal type.
 */
function asX402Call(): X402Call {
  return (deps, args) => x402FetchRaw(deps as X402ToolDeps, args) as Promise<X402Outcome>;
}
