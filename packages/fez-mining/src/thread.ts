export const MINING_SOURCE = "mining";
export const MINING_CHANNEL_NAME = "mining";

export const minerRootLine = (netuid: number, persona: string): string =>
  `⛏ mining · netuid ${netuid} · persona ${persona}`;

const RE = /^⛏ mining · netuid (\d+) · persona (\S+)$/;

export function parseMinerRoot(
  content: string
): { netuid: number; persona: string } | null {
  const m = RE.exec(content.trim());
  return m ? { netuid: Number(m[1]), persona: m[2] } : null;
}
