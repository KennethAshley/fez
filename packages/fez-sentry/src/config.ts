export const ORIGINS = ["https://sentry.io", "https://us.sentry.io", "https://de.sentry.io"] as const;
export interface Config {
  enabled: boolean;
  autoInvestigate: boolean;
  origin: typeof ORIGINS[number];
  organization: string;
  project: string;
  repo: string;
  channelId: string;
  worker: string;
  /** A settings save starts a fresh baseline, including a disable/re-enable while offline. */
  revision: string;
}
export const EMPTY: Config = { enabled: false, autoInvestigate: false, origin: ORIGINS[0], organization: "", project: "", repo: "", channelId: "", worker: "", revision: "" };

export function parseConfig(raw: unknown): Config {
  if (raw === undefined) return { ...EMPTY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid Sentry settings");
  const value = raw as Record<string, unknown>;
  const config = { ...EMPTY };
  for (const key of ["enabled", "autoInvestigate"] as const) {
    if (typeof value[key] !== "boolean") throw Error(`Invalid Sentry ${key} setting`);
    config[key] = value[key];
  }
  for (const key of ["organization", "project", "repo", "channelId", "worker", "revision"] as const) {
    if (value[key] === undefined && key === "revision") continue;
    if (typeof value[key] !== "string") throw Error(`Invalid Sentry ${key} setting`);
    config[key] = value[key].trim();
  }
  if (!ORIGINS.includes(value.origin as Config["origin"])) throw Error("Choose a supported Sentry region");
  config.origin = value.origin as Config["origin"];
  for (const key of ["organization", "project"] as const) {
    if ((config.enabled || config[key]) && !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(config[key])) throw Error(`Enter a valid Sentry ${key} slug`);
  }
  if ((config.enabled || config.repo) && !/^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/i.test(config.repo)) throw Error("Repository must be owner/name");
  if ((config.enabled || config.channelId) && !/^[a-zA-Z0-9_-]{1,128}$/.test(config.channelId)) throw Error("Choose an available destination channel");
  if ((config.enabled || config.worker) && !/^[a-f0-9]{64}$/.test(config.worker)) throw Error("Choose an investigation agent");
  if (config.revision.length > 128 || /\p{Cc}/u.test(config.revision)) throw Error("Invalid Sentry settings revision");
  return config;
}
