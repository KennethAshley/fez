import type { CommandContext, FezExtensionAPI } from "@fezchat/extension-api/headless";
import { makeX402Deps, x402FetchRaw, type X402ToolDeps } from "@fezchat/wallet";
import { dispatchRidges, type X402Call, type X402Outcome } from "./dispatch.js";
import { ridgesDir } from "./home.js";

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
    if (!issueUrl) {
      return ctx.reply("ridges: /ridges <github-issue-url> — e.g. /ridges https://github.com/acme/widgets/issues/42");
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
