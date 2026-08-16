#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startRelay, type RelayOptions } from "./relay.js";
import { builtinPolicies, type RelayPolicy } from "./policies.js";

/**
 * fez-relay CLI.
 *
 *   fez-relay [--port 7777] [--store events.jsonl] [--no-verify]
 *             [--policy membership] [--policy rate-limit=300]
 *             [--config relay.config.js]
 *
 * --policy composes built-ins (membership, rate-limit, kind-whitelist;
 * value after = is the policy's argument). --config dynamic-imports a
 * module whose default export is { port?, store?, verifySignatures?,
 * policies?: RelayPolicy[] } — the operator's own policies, backed by
 * whatever storage they bring. Flags override config.
 */
async function main() {
  // Operator secrets (e.g. store credentials read by --config modules)
  // live in ./.env — same convention as the fez CLI. Absent file is the
  // common case, not an error.
  try {
    process.loadEnvFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const args = process.argv.slice(2);
  let port: number | undefined;
  let store: string | undefined;
  let verifySignatures: boolean | undefined;
  const policies: RelayPolicy[] = [];
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") port = Number(args[++i]);
    else if (arg === "--store") store = args[++i];
    else if (arg === "--no-verify") verifySignatures = false;
    else if (arg === "--config") configPath = args[++i];
    else if (arg === "--policy") {
      const spec = args[++i] ?? "";
      const [name, value] = spec.split("=", 2);
      const factory = builtinPolicies[name];
      if (!factory) {
        console.error(`Unknown policy "${name}". Built-ins: ${Object.keys(builtinPolicies).join(", ")}`);
        process.exit(1);
      }
      policies.push(factory(value));
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: fez-relay [--port N] [--store FILE] [--no-verify] [--policy NAME[=ARG]]... [--config FILE]");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  let config: Partial<RelayOptions> = {};
  if (configPath) {
    const mod = await import(pathToFileURL(path.resolve(configPath)).href);
    config = mod.default ?? {};
  }

  startRelay({
    port: port ?? config.port ?? 7777,
    store: store ?? config.store,
    eventStore: config.eventStore,
    verifySignatures: verifySignatures ?? config.verifySignatures,
    policies: [...(config.policies ?? []), ...policies],
  });
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
