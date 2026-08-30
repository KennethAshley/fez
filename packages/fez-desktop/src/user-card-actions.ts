import { moderationControls, type Role } from "./manage-guard.js";

/**
 * Which actions the user card shows, split across the two planes. Authority
 * actions reuse the roster guard rail (moderationControls); mute is the
 * personal plane — available on anyone but yourself, no authority needed.
 */
export function cardActions(
  viewerRole: Role | undefined,
  targetRole: Role | undefined,
  viewerIsOwner: boolean,
  targetIsSelf: boolean,
): { makeAdmin: boolean; removeAdmin: boolean; timeout: boolean; kick: boolean; ban: boolean; mute: boolean } {
  const c = moderationControls(viewerRole, targetRole, viewerIsOwner);
  return {
    makeAdmin: c.promote,
    removeAdmin: c.demote,
    timeout: c.ban, // same authority threshold as ban
    kick: c.kick,
    ban: c.ban,
    mute: !targetIsSelf,
  };
}

export type { Role };
