import { artifactKey, latestArtifacts } from "../../fez-client/src/artifacts.js";
import type { Artifact } from "../../fez-client/src/index.js";

export type ArtifactLike = Artifact;
export interface ToolScope { pubkey: string; relay: string }
export interface KeptTool extends Artifact {
  content: string;
  keptAt: number;
}

function storageKey(scope: ToolScope): string {
  if (!scope.pubkey || !scope.relay) throw new Error("Saved artifacts need an identity and workspace.");
  return `fez-tools:v2:${JSON.stringify([scope.pubkey, scope.relay])}`;
}

function isArtifact(value: unknown): value is Artifact & { content: string } {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return ["id", "channelId", "authorPk", "authorName", "type", "content"].every(k => typeof a[k] === "string")
    && !!a.id && !!a.channelId && !!a.authorPk && !!a.content
    && typeof a.ts === "number" && Number.isFinite(a.ts)
    && (a.title === undefined || typeof a.title === "string")
    && (a.url === undefined || typeof a.url === "string")
    && (a.rootId === undefined || typeof a.rootId === "string");
}

export function keptTools(scope: ToolScope): KeptTool[] {
  const raw: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) ?? "[]");
  if (!Array.isArray(raw) || !raw.every((t): t is KeptTool => isArtifact(t) && "keptAt" in t && typeof t.keptAt === "number" && Number.isFinite(t.keptAt))) {
    throw new Error("Saved artifacts could not be read. The stored data has been left unchanged.");
  }
  return raw.sort((a, b) => b.keptAt - a.keptAt);
}

function write(scope: ToolScope, tools: KeptTool[]): void {
  localStorage.setItem(storageKey(scope), JSON.stringify(tools));
  window.dispatchEvent(new CustomEvent("fez-tools-changed"));
}

export function keepTool(scope: ToolScope, artifact: Artifact): void {
  if (!isArtifact(artifact)) throw new Error("This artifact has no saved content or origin.");
  const tools = keptTools(scope);
  const existing = tools.find(t => artifactKey(t) === artifactKey(artifact));
  if (existing && existing.ts >= artifact.ts) return;
  const next = { ...artifact, keptAt: existing?.keptAt ?? Date.now() / 1000 };
  write(scope, [next, ...tools.filter(t => t !== existing)]);
}

export function unkeepTool(scope: ToolScope, id: string): void {
  write(scope, keptTools(scope).filter(t => t.id !== id));
}

/** Retain offline copies, updating only saves whose signed refinements are available. */
export function refreshTools(scope: ToolScope, artifacts: readonly Artifact[]): KeptTool[] {
  const tools = keptTools(scope);
  const latest = new Map(latestArtifacts<Artifact>([...tools, ...artifacts.filter(isArtifact)]).map(a => [artifactKey(a), a]));
  const next = tools.map(t => ({ ...t, ...latest.get(artifactKey(t)) }));
  if (next.some((t, i) => t.id !== tools[i].id)) write(scope, next);
  return next;
}

/** Legacy saves have no account/workspace. Recover only IDs confirmed in this workspace,
 * on an explicit import; leave the original store intact for other workspaces. */
export function recoverableTools(scope: ToolScope, artifacts: readonly Artifact[]): Artifact[] {
  let raw: unknown;
  try { raw = JSON.parse(localStorage.getItem("fez-tools") ?? "[]"); }
  catch { return []; } // Never rewrite legacy storage, including damaged entries.
  if (!Array.isArray(raw)) return [];
  const ids = new Set(raw.flatMap(t => t && typeof t.id === "string" ? [t.id] : []));
  const saved = new Set(keptTools(scope).map(artifactKey));
  return artifacts.filter(a => ids.has(a.id) && isArtifact(a) && !saved.has(artifactKey(a)));
}
