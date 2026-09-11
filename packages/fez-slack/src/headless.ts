import { keychainSecret } from "../../../src/extensions/mcp-servers.js";
import { createHash } from "node:crypto";
import { bridgeScope, readBridgeConfig, queryBridgeEvents, requireBridgeTarget } from "../../fez-client/src/bridge-work.js";
import { SlackBridge } from "./bridge.js";
import { configKey, parseConfig } from "./config.js";
import { SlackApi, SlackSocket } from "./slack.js";
import type { FezExtensionAPI, ScheduledTaskContext } from "./api-types.js";

export default function activate(api: FezExtensionAPI): void {
  let bridge: SlackBridge | undefined, socket: SlackSocket | undefined, controller: AbortController | undefined;
  let binding = "", running: Promise<void> = Promise.resolve(), unsubscribe: (() => void) | undefined;
  let configSubscription: (() => void) | undefined;
  const warn = () => console.warn("fez-slack: bridge paused or disconnected; check settings, tokens, network and agent access.");
  async function refresh(ctx: ScheduledTaskContext): Promise<void> {
    const scope = () => `${bridgeScope(ctx.ownerPubkey, api.workspace?.relayUrl)}:${api.workspace?.owner ?? ""}`;
    const capturedScope = scope();
    const read = async () => {
      if (scope() !== capturedScope) throw new Error("Slack workspace changed");
      const config = await readBridgeConfig(ctx.nostr, "fez-slack", parseConfig);
      if (scope() !== capturedScope) throw new Error("Slack workspace changed");
      return config;
    };
    const config = await read();
    const botToken = keychainSecret("fez-slack", "bot_token"), appToken = keychainSecret("fez-slack", "app_token");
    const configured = configKey(config);
    const next = config.enabled && botToken?.startsWith("xoxb-") && appToken?.startsWith("xapp-") ? createHash("sha256").update(JSON.stringify([configured, capturedScope, botToken, appToken])).digest("hex") : "";
    if (next !== binding) {
      socket?.stop(); controller?.abort(); unsubscribe?.(); await bridge?.stop(true);
      bridge = undefined; socket = undefined; binding = "";
      if (!next || !botToken || !appToken) return;
      await requireBridgeTarget(ctx.nostr, ctx.channels, config.fezChannel, config.worker, api.workspace?.owner);
      const currentController = new AbortController(); controller = currentController;
      const slack = new SlackApi(botToken, appToken, fetch, currentController.signal);
      const identity = await slack.identity();
      if (identity.team !== config.teamId) throw new Error("Slack token belongs to another workspace");
      if (configKey(await read()) !== configured) return;
      const currentBridge = new SlackBridge({ nostr: ctx.nostr, storage: api.storage, channels: ctx.channels, workspaceOwner: api.workspace?.owner, relay: api.workspace?.relayUrl, config: read, post: (thread, text, id) => slack.post(config.channelId, thread, text, id) });
      await currentBridge.start(config, identity.bot);
      bridge = currentBridge; binding = next;
      unsubscribe = ctx.nostr.subscribe([{ kinds: [47103], authors: [config.worker], "#h": [config.fezChannel] }], event => { void currentBridge.result(event).catch(warn); });
      socket = new SlackSocket(slack, (event, ack) => currentBridge.receive(event, ack), async () => {
        if (controller !== currentController || currentController.signal.aborted) return false;
        if (configKey(await read()) === configured) return true;
        socket?.stop(); currentController.abort(); await currentBridge.stop(true); return false;
      }, warn);
      await socket.start();
    }
    if (bridge) {
      await bridge.retry();
      for (const request of bridge.requests()) {
        const events = await queryBridgeEvents(ctx.nostr, [{ kinds: [47103], authors: [config.worker], "#e": [request.id], "#h": [config.fezChannel] }]);
        for (const event of events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) await bridge.result(event);
      }
    }
  }
  const tick = (ctx: ScheduledTaskContext) => {
    running = running.catch(() => {}).then(() => refresh(ctx)).catch(() => { socket?.stop(); controller?.abort(); unsubscribe?.(); void bridge?.stop(); bridge = undefined; binding = ""; warn(); });
    return running;
  };
  api.registerScheduledTask("slack-bridge", 60_000, async ctx => {
    if (!configSubscription) configSubscription = ctx.nostr.subscribe([{ kinds: [30078], authors: [ctx.ownerPubkey], "#d": ["ext:fez-slack"] }], () => { void tick(ctx); });
    await tick(ctx);
  });
}
