import type { Artifact } from "./index.js";

/** Live refinements belong to their author and thread, even when names collide. */
export function artifactKey(artifact: Artifact): string {
  return artifact.type === "live"
    ? JSON.stringify([artifact.channelId, artifact.rootId ?? "", artifact.authorPk, artifact.title ?? ""])
    : artifact.id;
}

export function latestArtifacts<T extends Artifact>(artifacts: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const artifact of artifacts) {
    const key = artifactKey(artifact);
    const previous = latest.get(key);
    if (!previous || artifact.ts > previous.ts) latest.set(key, artifact);
  }
  return [...latest.values()];
}
