/** NIP-10: parent = last reply-marked e-tag; root = root-marked ?? parent. */
export function parseThreadRef(tags: string[][]): { parentId?: string; rootId?: string } {
  const refs = tags.filter(t => t[0] === "e" && /^[0-9a-f]{64}$/i.test(t[1] ?? ""));
  const parentId = refs.filter(t => t[3] === "reply").at(-1)?.[1]?.toLowerCase();
  const rootId = refs.find(t => t[3] === "root")?.[1]?.toLowerCase() ?? parentId;
  return { parentId, rootId };
}
