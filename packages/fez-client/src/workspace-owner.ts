/** A relay's path and query are case-sensitive; only URL-defined aliases share a pin. */
export function normalizeWorkspaceRelay(relay: string): string {
  const url = new URL(relay.trim());
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Workspace relay must be a ws/wss URL without credentials or fragment");
  }
  return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
}

function ownerKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Workspace owner must be a 64-character hex pubkey");
  }
  return value.toLowerCase();
}

/** Discovery may establish initial trust, but neither discovery nor an invite may rotate a pin. */
export function resolveWorkspaceOwner(pinned: string | undefined, advertised: string | undefined, expected?: string): string | undefined {
  pinned = ownerKey(pinned);
  advertised = ownerKey(advertised);
  expected = ownerKey(expected);
  if (pinned && expected && pinned !== expected) throw new Error("Workspace owner mismatch: expected owner differs from pinned owner");
  const trusted = pinned ?? expected;
  if (trusted && advertised && trusted !== advertised) throw new Error("Workspace owner mismatch: relay advertised a different owner");
  return trusted ?? advertised;
}
