export const MODEL_PROVIDER = "ext-mesh-mini";

export interface MeshState {
  configured: boolean;
  provider: string;
  model: string;
  label: string;
  machine: string;
  status: "ready" | "offline";
  detail?: string;
  callersVerified: boolean;
  callers: Array<{ persona: string; pubkey: string }>;
}

/** The GUI only receives public machine and membership data from the CLI. */
export function parseMeshState(raw: string): MeshState {
  try {
    const s = JSON.parse(raw) as MeshState;
    if (!s || typeof s.configured !== "boolean" || s.provider !== MODEL_PROVIDER ||
        typeof s.model !== "string" || typeof s.label !== "string" || typeof s.machine !== "string" ||
        !["ready", "offline"].includes(s.status) || (s.detail !== undefined && typeof s.detail !== "string") ||
        typeof s.callersVerified !== "boolean" ||
        !Array.isArray(s.callers) || !s.callers.every(c => c && /^[a-z0-9][a-z0-9-]{1,31}$/.test(c.persona) && /^[a-f0-9]{64}$/.test(c.pubkey))) throw Error();
    return { configured: s.configured, provider: s.provider, model: s.model, label: s.label, machine: s.machine,
      status: s.status, detail: s.detail, callersVerified: s.callersVerified,
      callers: s.callers.map(c => ({ persona: c.persona, pubkey: c.pubkey })) };
  } catch { throw Error("Shared Models returned an invalid status. Rebuild or update the extension."); }
}
