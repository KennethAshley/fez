/** Owner-signed channel metadata is the workspace-wide binding, independent of its name. */
export const MINING_WORKSPACE_META = "miningWorkspace";
export const MINING_WORKSPACE_ID = "mining-workspace";

export interface MiningChannel {
  id: string;
  name: string;
  source?: string;
  meta?: Record<string, string>;
  archived?: boolean;
  visibility?: "open" | "closed";
}

export function miningChannel(channels: MiningChannel[]): MiningChannel | undefined {
  return channels.find(c => !c.archived && c.meta?.[MINING_WORKSPACE_META] === "true");
}
