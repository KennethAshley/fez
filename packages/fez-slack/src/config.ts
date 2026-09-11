export interface Config {
  enabled: boolean;
  /** Each settings save revokes pending work from the preceding revision. */
  revision: string;
  teamId: string;
  channelId: string;
  allowedUsers: string[];
  fezChannel: string;
  worker: string;
}
export const EMPTY: Config = { revision: "", enabled: false, teamId: "", channelId: "", allowedUsers: [], fezChannel: "", worker: "" };
export function parseConfig(raw: unknown): Config {
  const v = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const text = (key: string) => typeof v[key] === "string" ? v[key].trim() : "";
  const config = { revision: text("revision").slice(0, 128), enabled: v.enabled === true, teamId: text("teamId"), channelId: text("channelId"), allowedUsers: Array.isArray(v.allowedUsers) ? [...new Set(v.allowedUsers.filter((id): id is string => typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id)))].sort() : [], fezChannel: text("fezChannel"), worker: text("worker") };
  config.enabled &&= /^T[A-Z0-9]+$/.test(config.teamId) && /^[CG][A-Z0-9]+$/.test(config.channelId) && config.allowedUsers.length > 0 && !!config.fezChannel && /^[a-f0-9]{64}$/.test(config.worker);
  return config;
}
export const configKey = (config: Config): string => JSON.stringify(parseConfig(config));
