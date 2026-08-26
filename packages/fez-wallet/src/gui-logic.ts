/** Pure logic for the wallet gui part — node-testable, no React. */

export function parseConsentRequest(
  content: string
): { persona: string; amount: string; to: string; memo?: string } | undefined {
  const lines = content.split("\n");
  if (lines.length < 3) return undefined;
  const head = /^💸 \*\*(.+)\*\* wants to send \*\*(.+)\*\*$/.exec(lines[0]);
  const dest = /^to `([^`]+)`(?: — (.+))?$/.exec(lines[1]);
  if (!head || !dest || !lines[2].startsWith("react ✅")) return undefined;
  return { persona: head[1], amount: head[2], to: dest[1], ...(dest[2] ? { memo: dest[2] } : {}) };
}

const APPROVE = new Set(["✅", "+"]);
const DECLINE = new Set(["❌", "-"]);
const WINDOW_S = 600;

export function requestStatus(
  reactions: { content: string; authorPk: string }[],
  ownerPk: string,
  msgTs: number,
  now: number
): "pending" | "approved" | "declined" | "expired" {
  for (const r of reactions) {
    if (r.authorPk !== ownerPk) continue;
    if (APPROVE.has(r.content.trim())) return "approved";
    if (DECLINE.has(r.content.trim())) return "declined";
  }
  return now - msgTs > WINDOW_S ? "expired" : "pending";
}
