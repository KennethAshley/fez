import { useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FezClient } from "@fezchat/client";
import { createGuiClient } from "./gui-client";

type HostOperation =
  | { op: "list_channels" }
  | { op: "create_channel"; name: string }
  | { op: "get_config"; scope: string }
  | { op: "set_config"; scope: string; value: unknown }
  | { op: "has_secret"; scope: string; key: string }
  | { op: "set_secret"; scope: string; key: string; value: string }
  | { op: "open_url"; url: string };

// Called only by the native channel bound when this main-window launcher opens.
// Rust supplies the scope and checks the live grant before delivering a request.
export async function handlePanelRequest(client: FezClient, id: number): Promise<void> {
  let result: { Ok: unknown } | { Err: string };
  try {
    const request = await invoke<HostOperation>("isolated_panel_host_request", { id });
    switch (request.op) {
      case "list_channels": result = { Ok: await createGuiClient(client, "isolated-panel", ["read:channels"]).listChannels() }; break;
      case "create_channel": result = { Ok: await client.createChannel(request.name) }; break;
      case "get_config": result = { Ok: { value: await client.extensionConfig(request.scope) } }; break;
      case "set_config": await client.saveExtensionConfig(request.scope, request.value); result = { Ok: null }; break;
      case "has_secret": result = { Ok: await invoke<boolean>("has_skill_secret", { skill: request.scope, key: request.key }) }; break;
      case "set_secret": await invoke("set_skill_secret", { skill: request.scope, key: request.key, value: request.value }); result = { Ok: null }; break;
      case "open_url": await openUrl(request.url); result = { Ok: null }; break;
      default: throw new Error("Unsupported panel host operation");
    }
  } catch (error) { result = { Err: String(error) }; }
  // Closing or timing out the panel can invalidate an otherwise completed reply.
  await invoke("isolated_panel_reply", { id, result }).catch(() => {});
}

export function IsolatedPanelLauncher({ name, client }: { name: string; client: FezClient }) {
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    setError("");
    try {
      const hostRequests = new Channel<number>(id => { void handlePanelRequest(client, id); });
      await invoke("open_isolated_panel", { name, agents: [...client.agents()], hostRequests });
    } catch (error) { setError(String(error)); }
    finally { setOpening(false); }
  };
  return <div>
    <p className="settings-hint">Opens this extension’s settings in a separate window.</p>
    <button className="agent-action" disabled={opening} onClick={() => void open()}>Open {name} settings</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
