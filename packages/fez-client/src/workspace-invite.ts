import { normalizeWorkspaceRelay, resolveWorkspaceOwner } from "./workspace-owner.js";

export function workspaceInvite(relay: string, owner: string): string {
  return `fez-join:${normalizeWorkspaceRelay(relay)}#owner=${resolveWorkspaceOwner(undefined, owner)}`;
}

/** Legacy fragments named a community; an owner= fragment always carries trust
 * and must never silently degrade to an unpinned invitation. */
export function parseWorkspaceInvite(code: string): { relay: string; owner?: string } {
  const trimmed = code.trim();
  if (!/^fez-join:/i.test(trimmed) && !/^wss?:\/\//i.test(trimmed)) {
    throw new Error("That doesn't look like an invite — paste a fez-join:… code or a wss:// URL");
  }
  const value = trimmed.replace(/^fez-join:/i, "");
  const [address, ...parts] = value.split("#");
  let relay: string;
  try { relay = normalizeWorkspaceRelay(address); }
  catch { throw new Error("That invite doesn't name a relay — expected fez-join:wss://…"); }
  const fragment = parts.join("#");
  if (!fragment.includes("=")) return { relay };
  if (!/^owner=[a-f0-9]{64}$/i.test(fragment)) throw new Error("Invalid workspace owner in invite");
  return { relay, owner: resolveWorkspaceOwner(undefined, fragment.slice(6)) };
}
