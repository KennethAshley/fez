import { useEffect, useState } from "react";
import type { FezClient } from "@fezchat/client";
import { customChannelId, matchCustomContent, parseCustomGuiContributions, type CustomSurface } from "../../../src/extensions/gui-custom-contributions";
import { registerSettingsPanel, registerNavView, registerThreadView, registerMessageDecorator, type AgentProfileContext } from "./gui-extensions";
import { IsolatedPanelLauncher } from "./IsolatedPanelLauncher";
import type { MountRender } from "./mount-result";

export interface CustomContributionHooks {
  openPanel(title: string, render: MountRender): unknown;
  registerAgentProfileSection(label: string, render: (props: AgentProfileContext) => ReturnType<MountRender>): void;
}

/** Register host-owned shells from a validated manifest, without loading extension code. */
export function registerIsolatedCustomContributions(name: string, client: FezClient, value: unknown, hooks: CustomContributionHooks) {
  const data = parseCustomGuiContributions(value);
  const panel = (surface: CustomSurface) => <IsolatedPanelLauncher name={name} client={client} custom={surface} />;
  const open = (label: string, surface: CustomSurface) => hooks.openPanel(label, () => panel(surface));
  if (data.settings) registerSettingsPanel(name, () => panel({ kind: "settings" }));
  for (const nav of data.nav) {
    registerNavView(`${name}:${nav.name}`, { label: nav.label, glyph: nav.glyph,
      ...(nav.channel ? { channelWorkspace: {
        getChannelId: () => customChannelId(client.channelsFrom(), nav.channel!),
        tabs: nav.tabs.map(tab => ({ ...tab, render: () => panel({ kind: "navTab", name: nav.name, tab: tab.id }) })),
        ...(nav.summary ? { summary: ({ openTab }: { openTab: (id: string) => void }) => <IsolatedPanelLauncher name={name} client={client}
          custom={{ kind: "navSummary", name: nav.name }} customOpenTab={id => {
            if (!nav.tabs.some(tab => tab.id === id)) throw Error("Unknown channel tab");
            openTab(id);
          }} /> } : {}),
      } } : {}),
    }, () => panel({ kind: "nav", name: nav.name }));
  }
  for (const thread of data.threads) {
    registerThreadView(`${name}:${thread.name}`, content => matchCustomContent(content, thread.match),
      props => <button className="agent-action" onClick={() => open(thread.label, { kind: "thread", name: thread.name, ...props })}>{thread.label}</button>);
  }
  function MessageLauncher({ index, content, msgId, channelId, authorName }: Omit<Extract<CustomSurface, { kind: "message" }>, "kind">) {
    const declaration = data.messages[index];
    const [, refresh] = useState(0);
    useEffect(() => client.on("paymentReceipt", (channel, target) => {
      if (channel === channelId && target === msgId) refresh(value => value + 1);
    }), [channelId, msgId]);
    if (declaration.match.hasReceipts && !client.paymentReceiptsFor(msgId).length) return null;
    return <button className="agent-action custom-message-details" onClick={() => open(declaration.label,
      { kind: "message", index, content, msgId, channelId, authorName })}>{declaration.label}</button>;
  }
  data.messages.forEach((message, index) => registerMessageDecorator(content => matchCustomContent(content, message.match),
    props => <MessageLauncher index={index} {...props} />));
  data.profiles.forEach((profile, index) => hooks.registerAgentProfileSection(profile.label,
    props => <button className="agent-action" onClick={() => open(profile.label, { kind: "profile", index, ...props })}>{profile.label}</button>));
  return data;
}
