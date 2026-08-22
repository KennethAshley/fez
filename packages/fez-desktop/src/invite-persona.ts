import { invoke } from "@tauri-apps/api/core";
import { getPublicKey } from "nostr-tools/pure";
import type { FezClient } from "@fezchat/client";

/**
 * Invite a LOCAL persona to the workspace — before it has ever run.
 *
 * fez deliberately rosters agents individually (revoking one agent
 * revokes exactly one agent), which leaves a gap Buzz's model doesn't
 * have: a persona this machine knows but the workspace has never met is
 * un-invitable by name. The gap closes because agent keys are STABLE —
 * `agent:<name>` in the keychain, minted once and reused — so the
 * pubkey exists to invite whether or not a process ever spawned.
 *
 * One implementation for the slash command and the agents pane: the
 * two surfaces answering differently is how "nobody named @reviewer"
 * shipped in one of them after the other learned better.
 */
export type InviteResult =
  | { kind: "invited"; persona: string; role: string }
  | { kind: "no-key"; persona: string }
  | { kind: "unknown" };

export async function invitePersona(client: FezClient, rawName: string, role: "bot" | "member" = "bot"): Promise<InviteResult> {
  const wanted = rawName.replace(/^@/, "").toLowerCase();
  const personas = await invoke<string[]>("list_personas").catch(() => [] as string[]);
  const persona = personas.find((p) => p.toLowerCase() === wanted);
  if (!persona) return { kind: "unknown" };
  try {
    const keyHex = await invoke<string>("get_identity", { account: `agent:${persona}` });
    const pk = getPublicKey(Uint8Array.from(keyHex.trim().match(/../g)!.map((b) => parseInt(b, 16))));
    await client.invite(pk, role as never);
    return { kind: "invited", persona, role };
  } catch {
    // No key yet — the runtime mints one on first spawn, and the
    // webview deliberately cannot create keys. Summoning both spawns
    // and invites, so that is the honest redirect.
    return { kind: "no-key", persona };
  }
}
