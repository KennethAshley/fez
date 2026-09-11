import type { ClientEvents, FezClient } from "@fezchat/client";

export function requireGuiPermission(name: string, granted: readonly string[], operation: string, ...permissions: string[]): void {
  if (!permissions.some(p => granted.includes(p))) {
    throw new Error(`extension "${name}" denied ${operation}: needs ${permissions.join(" or ")} permission`);
  }
}

/** The supported GUI client surface. No raw client, wire, or mutable host state
 * escapes through it. This guards API use; same-webview code is not sandboxed. */
export function createGuiClient(client: FezClient, name: string, granted: readonly string[]) {
  const check = (operation: string, ...permissions: string[]) => requireGuiPermission(name, granted, `client.${operation}`, ...permissions);
  const read = <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => structuredClone(fn(...args));
  const write = <A extends unknown[], R>(operation: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      check(operation, "publish");
      return structuredClone(await fn(...args));
    };

  return {
    pubkey: client.pubkey,
    // Snapshots preserve the familiar read shape without exposing WorkspaceState
    // methods or references that can change the host's roster or channel cache.
    get state() {
      return {
        ...structuredClone({ scope: client.state.scope, workspace: client.state.workspace }),
        isMember: (pk: string) => client.state.isMember(pk),
      };
    },
    relayInfo: read(client.relayInfo.bind(client)),
    channelsFrom: read(client.channelsFrom.bind(client)),
    async listChannels() {
      check("listChannels", "read:channels");
      return structuredClone([...client.state.workspace.channels.values()]
        .filter(channel => !channel.archived)
        .map(({ id, name, source, meta }) => ({ id, name, source, meta })));
    },
    displayName: client.displayName.bind(client),
    pkByName: client.pkByName.bind(client),
    messages: read(client.messages.bind(client)),
    msgById: read(client.msgById.bind(client)),
    threadReplies: read(client.threadReplies.bind(client)),
    reactions: read(client.reactions.bind(client)),
    myReactionTo: client.myReactionTo.bind(client),
    myReactionTimeTo: client.myReactionTimeTo.bind(client),
    paymentReceiptsFor: read(client.paymentReceiptsFor.bind(client)),
    docsByChannel: read(client.docsByChannel.bind(client)),
    agents() {
      check("agents", "read:agents");
      return structuredClone(client.agents());
    },
    workingAgents() {
      check("workingAgents", "read:agents");
      return structuredClone(client.workingAgents());
    },
    async runQuery(...args: Parameters<FezClient["runQuery"]>) {
      if (args[0].source === "runs") check("runQuery(runs)", "read:agents");
      return structuredClone(await client.runQuery(...args));
    },
    // These notifications carry identifiers only. Other client events include
    // private content; don't forward new events just because core adds them.
    on<E extends "channelsChanged" | "paymentReceipt">(event: E, handler: ClientEvents[E]): () => void {
      if (event !== "channelsChanged" && event !== "paymentReceipt") {
        throw new Error(`extension "${name}" cannot subscribe to client.${event}`);
      }
      return client.on(event, handler);
    },
    ensureChannel: write("ensureChannel", client.ensureChannel.bind(client)),
    createChannel: write("createChannel", client.createChannel.bind(client)),
    sendChannelMessage: write("sendChannelMessage", client.sendChannelMessage.bind(client)),
    toggleReaction: write("toggleReaction", client.toggleReaction.bind(client)),
    publishDoc: write("publishDoc", client.publishDoc.bind(client)),
    publishDocComment: write("publishDocComment", client.publishDocComment.bind(client)),
    publishArtifact: write("publishArtifact", client.publishArtifact.bind(client)),
    async httpAuthHeader(...args: Parameters<FezClient["httpAuthHeader"]>) {
      check("httpAuthHeader", "sign", "publish");
      return client.httpAuthHeader(...args);
    },
    async decryptFrom(...args: Parameters<FezClient["decryptFrom"]>) {
      check("decryptFrom", "sign", "read:dms");
      return client.decryptFrom(...args);
    },
    async extensionConfig<T>(extension: string): Promise<T | undefined> {
      check("extensionConfig", "sign");
      return client.extensionConfig<T>(extension);
    },
    async saveExtensionConfig(extension: string, config: unknown): Promise<void> {
      check("saveExtensionConfig", "publish");
      await client.saveExtensionConfig(extension, config);
    },
  };
}

export type GuiClient = ReturnType<typeof createGuiClient>;
