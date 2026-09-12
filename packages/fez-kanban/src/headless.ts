import type { FezExtensionAPI, ScheduledTaskContext } from "@fezchat/extension-api/headless";
import { bridgeScope, bridgeTask, publishOnce, queryBridgeEvents, readBridgeConfig, requireBridgeTarget } from "../../fez-client/src/bridge-work.js";
import { workResult } from "../../fez-client/src/work-completion.js";
import { dailySlot, parseReviews, reviewKey, reviewPrompt } from "./reviews.js";

/** The sentinel owns timing and delivery; the agent owns the board's work and progress. */
export async function pollReviews(api: Pick<FezExtensionAPI, "storage" | "workspace">, ctx: ScheduledTaskContext, now = Date.now()): Promise<void> {
  const config = await readBridgeConfig(ctx.nostr, "fez-kanban", parseReviews);
  const scope = bridgeScope(ctx.ownerPubkey, api.workspace?.relayUrl);
  const failures: Error[] = [];
  for (const review of config.reviews) {
    try {
      const day = dailySlot(review, now);
      if (!day) continue;
      const key = reviewKey(review), signature = JSON.stringify(review);
      const current = async () => {
        if (bridgeScope(ctx.ownerPubkey, api.workspace?.relayUrl) !== scope) return false;
        const latest = (await readBridgeConfig(ctx.nostr, "fez-kanban", parseReviews)).reviews.find(r => reviewKey(r) === key);
        return JSON.stringify(latest) === signature;
      };
      await requireBridgeTarget(ctx.nostr, ctx.channels, review.channelId, review.worker, api.workspace?.owner);
      const prior = (await queryBridgeEvents(ctx.nostr, [{ kinds: [47103], authors: [ctx.ownerPubkey], "#h": [review.channelId], "#j": [key], limit: 1 }]))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
      if (prior) {
        if (prior.tags.some(t => t[0] === "r" && t[1] >= day)) continue;
        const results = await queryBridgeEvents(ctx.nostr, [{ kinds: [47103], authors: prior.tags.filter(t => t[0] === "task").map(t => t[1]), "#h": [review.channelId], "#e": [prior.id] }]);
        if (!results.some(result => workResult(result, prior))) continue;
      }
      const template = bridgeTask({ channelId: review.channelId, worker: review.worker, content: reviewPrompt(review) });
      // All hosts sign the same board/day event, including hosts catching up late.
      // UTC+14 is the earliest local day start; this timestamp is never future.
      template.created_at = Date.parse(`${day}T00:00:00Z`) / 1000 - 14 * 3600;
      template.tags.push(["j", key], ["r", day]);
      const guarded = { ...ctx.nostr, publish: async (event: Parameters<typeof ctx.nostr.publish>[0]) => {
        // Recheck after the outbox write as well as before it: a pause must win over a pending send.
        await requireBridgeTarget(ctx.nostr, ctx.channels, review.channelId, review.worker, api.workspace?.owner);
        if (!await current()) throw Error("Kanban review changed or paused before delivery");
        return ctx.nostr.publish(event);
      } };
      if (await current()) await publishOnce(guarded, api.storage, `${scope}:${key}:${day}`, template);
    } catch (error) {
      failures.push(new Error(`${review.title}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join("; "));
}

export default function activate(api: FezExtensionAPI): void {
  api.registerScheduledTask("kanban-daily-review", 60_000, ctx => pollReviews(api, ctx));
}
