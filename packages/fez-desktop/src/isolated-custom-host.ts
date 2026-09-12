import { invoke } from "@tauri-apps/api/core";
import type { FezClient, WireEvent } from "@fezchat/client";
import type { CustomSurface } from "../../../src/extensions/gui-custom-contributions";
import { createGuiClient } from "./gui-client";
import { invitePersona } from "./invite-persona";
import { notifyEvent } from "./notify";
import { toast } from "./toast";

export type CustomOperation = { op: "custom"; name: string; action: string; args: unknown; grants: string[] };
export interface CustomHostHooks {
  openTab?(id: string): void;
  openChannel(id: string): void;
  openThread(channelId: string, rootId: string): void;
  openGuestDm(guest: { pk: string; relay: string; name?: string; picture?: string; rateTaoHr?: number; draft?: string }): void;
}
export interface CustomSnapshot {
  surface: CustomSurface;
  grants: string[];
  pubkey: string;
  owner?: string;
  channels: { id: string; name: string; source?: string; archived?: boolean; visibility?: "open" | "closed"; meta?: Record<string, string> }[];
  workspaces: { relay: string; name: string; active: boolean }[];
  agents: [string, string][] | null;
  names: [string, string][];
  pubkeysByName: [string, string][];
  message?: { id: string; content: string; authorPk: string; ts: number };
  reactions: [string, number][];
  receipts: WireEvent[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid custom operation arguments");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0")) throw Error("Invalid custom operation text");
  return value;
}
const identifier = (value: unknown) => {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw Error("Invalid custom operation name");
  return result;
};
const record = (value: unknown, max = 32): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > max) throw Error("Invalid custom operation values");
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [text(key, 128), text(value, 65_536, true)]));
};
const bounded = <T,>(value: T, max = 1_048_576): T => {
  if ((JSON.stringify(value)?.length ?? 0) > max) throw Error("Custom view response exceeds its size limit");
  return value;
};

/** Public channel state only; the view's target comes from its main-owned opening. */
export function customSnapshot(client: FezClient, surface: CustomSurface, grants: string[]): CustomSnapshot {
  const read = grants.includes("read:channels");
  let message: CustomSnapshot["message"];
  let current = surface;
  if (surface.kind === "message" || surface.kind === "thread") {
    if (!read) throw Error("Custom message views require read:channels permission");
    if (!client.state.workspace.channels.has(surface.channelId)) throw Error("The channel is no longer available");
    const id = surface.kind === "message" ? surface.msgId : surface.rootId;
    const found = client.messages(surface.channelId).find(message => message.id === id);
    if (!found) throw Error("The channel message is no longer available");
    message = { id: found.id, content: found.content, authorPk: found.authorPk, ts: found.ts };
    current = surface.kind === "message" ? { ...surface, content: found.content, authorName: client.displayName(found.authorPk) }
      : { ...surface, rootContent: found.content };
  }
  const names = read ? [...client.knownNames()] : [];
  // Preserve FezClient's agent-before-profile resolution for consent attribution.
  const pubkeysByName = [...new Set(names.map(([, name]) => name.toLowerCase()))]
    .flatMap(name => { const pk = client.pkByName(name); return pk ? [[name, pk] as [string, string]] : []; });
  const channels = read ? client.channelsFrom().map(({ id, name, source, archived, visibility, meta }) => ({ id, name, source, archived, visibility, meta })) : [];
  const agents = read && grants.includes("read:agents") ? [...client.agents()] : null;
  if (names.length > 5000 || channels.length > 2000 || (agents?.length ?? 0) > 1000) throw Error("Workspace is too large for a custom view snapshot");
  const receipts = message ? [...client.paymentReceiptsFor(message.id)] : [];
  // Receipts from the authenticated client stay verbatim. The wallet retains
  // its existing parsing and unverified-settlement labels.
  return bounded({ surface: current, grants: [...grants], pubkey: client.pubkey, owner: read ? client.state.workspace.owner : undefined,
    channels, workspaces: read ? client.workspaces() : [], agents, names, pubkeysByName, message,
    reactions: message ? ["✅", "❌", "-"].flatMap(emoji => {
      const time = client.myReactionTimeTo(message.id, emoji);
      return time === undefined ? [] : [[emoji, time] as [string, number]];
    }) : [], receipts,
  });
}

/** Explicit operations preserve native identity and never dispatch arbitrary client methods. */
export function createCustomHost(client: FezClient, current: () => CustomSurface | undefined, hooks: CustomHostHooks) {
  return async (operation: CustomOperation, authorize?: () => Promise<void>): Promise<unknown> => {
    const name = identifier(operation.name);
    const require = (...permissions: string[]) => {
      for (const permission of permissions) if (!operation.grants.includes(permission)) throw Error(`Extension requires ${permission} permission`);
    };
    require("ui");
    bounded(operation.args);
    await authorize?.();
    const surface = current();
    if (!surface) throw Error("Custom view closed");
    const gui = createGuiClient(client, name, operation.grants);
    switch (operation.action) {
      case "snapshot": object(operation.args, []); return customSnapshot(client, surface, operation.grants);
      case "storage_get": {
        const args = object(operation.args, ["key"]), key = identifier(args.key);
        const state: unknown = JSON.parse(await invoke<string>("extension_storage_read", { name }));
        if (!state || typeof state !== "object" || Array.isArray(state)) throw Error("Invalid extension storage");
        return bounded({ value: Object.hasOwn(state, key) ? Reflect.get(state, key) : undefined });
      }
      case "process_run": {
        require("processes");
        const args = object(operation.args, ["bin", "args"]);
        if (!Array.isArray(args.args) || args.args.length > 128) throw Error("Invalid process arguments");
        return invoke("run_extension_bin", { extension: name, bin: identifier(args.bin), args: args.args.map(value => text(value, 65_536, true)) });
      }
      case "agent_spawn": {
        require("processes");
        const args = object(operation.args, ["bin", "name", "env"]);
        const env = args.env === undefined ? {} : record(args.env);
        return invoke("spawn_extension_agent", { extension: name, bin: identifier(args.bin), name: identifier(args.name),
          env: Object.entries({ FEZ_OWNER_PK: client.pubkey, FEZ_WORKSPACE_RELAY: client.workspaces().find(workspace => workspace.active)?.relay ?? "", ...env }),
        });
      }
      case "agent_stop": case "agent_alive": case "agent_last_exit": {
        require("processes");
        const args = object(operation.args, ["name", "bin"]);
        // A bin is mandatory: a bare persona could stop another extension's process.
        return invoke(operation.action === "agent_stop" ? "kill_agent" : operation.action === "agent_alive" ? "agent_alive" : "agent_last_exit",
          { persona: identifier(args.name), bin: identifier(args.bin) });
      }
      case "persona_list": require("personas"); object(operation.args, []); return invoke("list_personas");
      case "persona_read": {
        require("personas"); const args = object(operation.args, ["name"]);
        return invoke("read_persona", { name: identifier(args.name) });
      }
      case "persona_update": case "persona_create": {
        require("personas"); const args = object(operation.args, ["name", "content"]);
        await invoke(operation.action === "persona_update" ? "update_persona" : "write_persona", { name: identifier(args.name), content: text(args.content, 1_048_576, true) });
        return null;
      }
      case "persona_invite": {
        require("personas", "publish"); const args = object(operation.args, ["name", "role"]);
        if (args.role !== undefined && args.role !== "bot" && args.role !== "member") throw Error("Invalid persona role");
        return (await invitePersona(client, identifier(args.name), args.role ?? "bot")).kind;
      }
      case "ensure_channel": {
        require("read:channels", "publish"); const args = object(operation.args, ["spec"]);
        const spec = object(args.spec, ["id", "name", "source", "visibility", "meta"]);
        if (spec.visibility !== undefined && spec.visibility !== "open" && spec.visibility !== "closed") throw Error("Invalid channel visibility");
        return gui.ensureChannel({ name: text(spec.name), ...(spec.id === undefined ? {} : { id: text(spec.id) }),
          ...(spec.source === undefined ? {} : { source: text(spec.source, 80) }),
          ...(spec.visibility === undefined ? {} : { visibility: spec.visibility }),
          ...(spec.meta === undefined ? {} : { meta: record(spec.meta) }),
        });
      }
      case "toggle_reaction": {
        require("read:channels", "publish"); const args = object(operation.args, ["channelId", "targetId", "emoji"]);
        if (surface.kind !== "message" || args.channelId !== surface.channelId || args.targetId !== surface.msgId) throw Error("Reaction belongs to another message");
        customSnapshot(client, surface, operation.grants); // Refuse deleted/hidden/non-channel targets.
        await gui.toggleReaction(surface.channelId, surface.msgId, text(args.emoji, 64)); return null;
      }
      case "open_channel": {
        require("read:channels"); const args = object(operation.args, ["id"]), id = text(args.id);
        if (!client.state.workspace.channels.has(id)) throw Error("Unknown channel");
        hooks.openChannel(id); return null;
      }
      case "open_tab": {
        const args = object(operation.args, ["id"]);
        if (surface.kind !== "navSummary" || !hooks.openTab) throw Error("This view has no channel tabs");
        hooks.openTab(text(args.id, 80)); return null;
      }
      case "open_thread": {
        require("read:channels"); const args = object(operation.args, ["channelId", "rootId"]), channelId = text(args.channelId);
        if (!client.state.workspace.channels.has(channelId)) throw Error("Unknown channel");
        hooks.openThread(channelId, text(args.rootId)); return null;
      }
      case "open_guest_dm": {
        const args = object(operation.args, ["guest"]), guest = object(args.guest, ["pk", "relay", "name", "picture", "rateTaoHr", "draft"]);
        const pk = text(guest.pk, 64), relay = new URL(text(guest.relay, 8192));
        if (!/^[a-f0-9]{64}$/.test(pk) || relay.protocol !== "wss:" || relay.username || relay.password) throw Error("Invalid guest destination");
        if (guest.rateTaoHr !== undefined && (typeof guest.rateTaoHr !== "number" || !Number.isFinite(guest.rateTaoHr) || guest.rateTaoHr < 0)) throw Error("Invalid guest rate");
        hooks.openGuestDm({ pk, relay: relay.href,
          ...(guest.name === undefined ? {} : { name: text(guest.name) }),
          ...(guest.picture === undefined ? {} : { picture: text(guest.picture, 8192) }),
          ...(guest.draft === undefined ? {} : { draft: text(guest.draft, 65_536, true) }),
          ...(guest.rateTaoHr === undefined ? {} : { rateTaoHr: guest.rateTaoHr }),
        }); return null;
      }
      case "toast": {
        const args = object(operation.args, ["message", "variant"]), variant = args.variant ?? "info";
        if (variant !== "info" && variant !== "success" && variant !== "warn" && variant !== "error") throw Error("Invalid toast variant");
        toast[variant](text(args.message, 4096)); return null;
      }
      case "notify": {
        require("notifications"); const args = object(operation.args, ["title", "body", "kind"]);
        if (args.kind !== undefined && args.kind !== "needs_action" && args.kind !== "agent_error") throw Error("Invalid notification kind");
        notifyEvent({ key: `ext:${name}:${text(args.title)}`, title: text(args.title), body: text(args.body, 4096, true), label: name, kind: args.kind ?? "needs_action" }); return null;
      }
      default: throw Error("Unsupported custom view operation");
    }
  };
}
