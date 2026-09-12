import type { FezClient } from "@fezchat/client";
import { parseGuiContributions, matchPageDocument } from "../../../src/extensions/gui-contributions";
import { registerPageView, registerMessageDecorator, registerBlockRenderer } from "./gui-extensions";
import { IsolatedPanelLauncher } from "./IsolatedPanelLauncher";

export function registerIsolatedContributions(name: string, client: FezClient, value: unknown) {
  // Validate the entire declaration before adding anything to a host registry.
  const data = parseGuiContributions(value);
  registerPageView(data.page.name, content => matchPageDocument(content, data.page.match),
    props => <IsolatedPanelLauncher key={`${props.channelId}:${props.slug ?? ""}`} name={name} client={client} page={props} pageView={data.page.name} />, { isolated: true });
  for (const message of data.messages ?? []) {
    registerMessageDecorator(content => {
      const lines = content.split("\n", message.linePrefixes.length + 1);
      return message.linePrefixes.every((prefix, i) => lines[i]?.startsWith(prefix) && lines[i].length > prefix.length)
        && lines[message.linePrefixes.length] === "";
    }, ({ content }) => <section className="extension-message-summary" aria-label={message.label}>
      <span>{message.label}</span>
      <strong>{content.split("\n", 1)[0].slice(message.linePrefixes[0].length)}</strong>
      <p>{message.summary}</p>
      <details><summary>{message.detailsLabel}</summary><div>{content}</div></details>
    </section>, { replaceBody: true });
  }
  for (const block of data.blocks ?? []) {
    registerBlockRenderer(block.language, ({ body }) => <details className="extension-block-summary">
      <summary>{block.label}</summary><pre>{body}</pre>
    </details>, { label: block.label, description: block.description, keywords: block.keywords, template: block.template });
  }
}
