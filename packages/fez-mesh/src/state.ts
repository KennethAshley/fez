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

/** What `fez-mesh models --json` prints: the one shared model, or nothing before the machine is configured. */
export function modelList(s: MeshState): Array<{ id: string; label: string; status: "ready" | "offline"; detail: string }> {
  if (!s.configured) return [];
  const short = s.model === "fez-mini-qwen3-4b" ? "Qwen3 4B" : s.model;
  return [{ id: s.model, label: `${short} · ${s.label}`, status: s.status,
    detail: `Model runs on ${s.label}. Tools run on this Mac. Saving grants this agent access to ${s.label}.${s.detail ? ` ${s.detail}.` : ""}` }];
}

/** Why `fez-mesh prepare` must refuse, or undefined when the agent may be connected. */
export function prepareCheck(s: MeshState, model: string): string | undefined {
  if (!s.configured || s.status !== "ready") return `Start ${s.label} in Settings → Shared Models, then save again.`;
  if (s.model !== model) return "The shared model changed. Select it again before saving.";
  return undefined;
}
