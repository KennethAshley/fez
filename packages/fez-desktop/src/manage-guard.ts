export type Role = "owner" | "admin" | "member" | "bot";

/**
 * Which moderation controls a viewer sees on one member row. Pure so the
 * guard rail can be tested without a running app: an admin may act on plain
 * members but not on the owner or another admin; only the owner promotes,
 * demotes, or outranks an admin.
 */
export function moderationControls(
  viewerRole: Role | undefined,
  targetRole: Role | undefined,
  viewerIsOwner: boolean,
): { kick: boolean; ban: boolean; promote: boolean; demote: boolean } {
  const viewerCanMod = viewerIsOwner || viewerRole === "admin";
  const targetProtected = targetRole === "owner" || targetRole === "admin";
  const canAct = viewerCanMod && targetRole !== "owner" && (viewerIsOwner || !targetProtected);
  return {
    kick: canAct,
    ban: canAct,
    promote: viewerIsOwner && targetRole === "member",
    demote: viewerIsOwner && targetRole === "admin",
  };
}
