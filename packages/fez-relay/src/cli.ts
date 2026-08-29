#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
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

  // --extensions takes an OPTIONAL value ("" = the default directory);
  // parseArgs has no optional-value type, so the bare form becomes
  // `--extensions=` before parsing.
  const args = process.argv
    .slice(2)
    .map((arg, i, all) => (arg === "--extensions" && (all[i + 1] ?? "--").startsWith("--") ? "--extensions=" : arg));

  let values: {
    port?: string;
    store?: string;
    "no-verify"?: boolean;
    "no-scheduler"?: boolean;
    config?: string;
    extensions?: string;
    "extensions-data"?: string;
    origin?: string[];
    owner?: string;
    name?: string;
    description?: string;
    icon?: string;
    policy?: string[];
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        port: { type: "string" },
        store: { type: "string" },
        "no-verify": { type: "boolean" },
        "no-scheduler": { type: "boolean" },
        config: { type: "string" },
        extensions: { type: "string" },
        "extensions-data": { type: "string" },
        origin: { type: "string", multiple: true },
        owner: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        icon: { type: "string" },
        policy: { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (values.help) {
    console.log(
      "Usage: fez-relay [--port N] [--store FILE] [--no-verify] [--policy NAME[=ARG]]... [--config FILE]\n" +
        "                 [--owner HEX] [--name TEXT] [--description TEXT] [--icon URL]\n" +
        "                 [--extensions [DIR]] [--extensions-data DIR] [--origin URL]... [--no-scheduler]\n\n" +
        "--extensions loads ~/.fez/relay-extensions (or DIR): code that runs INSIDE this\n" +
        "relay, installed by `fez install`. Off unless asked for — installing an\n" +
        "extension and letting it into the event store are two decisions.\n" +
        "--origin is the PUBLIC url this relay answers to; extensions that verify\n" +
        "signed requests need it, because behind a proxy the relay cannot know.\n" +
        "--no-scheduler   don't execute sealed 40006 schedule intents\n\n" +
        "A relay is a workspace. --owner is the pubkey whose signature makes a channel\n" +
        "or roster event count; it is served in the NIP-11 document and is what the\n" +
        "membership and moderation policies enforce. Without it the workspace is\n" +
        "unclaimed: it will serve, but no channel or roster can be valid on it."
    );
    process.exit(0);
  }

  const port = values.port === undefined ? undefined : Number(values.port);
  const store = values.store;
  const verifySignatures = values["no-verify"] ? false : undefined;
  const scheduler = !values["no-scheduler"];
  const configPath = values.config;
  /** undefined = don't load any; "" = the default directory; else a path. */
  const extensionsDir = values.extensions;
  const extensionsData = values["extensions-data"];
  const origins = values.origin ?? [];
  const owner = values.owner;
  const name = values.name;
  const description = values.description;
  const icon = values.icon;
  // Policies are built AFTER parsing: membership/moderation take the
  // workspace owner, and --owner may appear after --policy on the line.
  const policySpecs = (values.policy ?? []).map((spec) => {
    const [policyName, value] = spec.split("=", 2);
    if (!builtinPolicies[policyName]) {
      console.error(`Unknown policy "${policyName}". Built-ins: ${Object.keys(builtinPolicies).join(", ")}`);
      process.exit(1);
    }
    return { name: policyName, value };
  });

  let config: Partial<RelayOptions> = {};
  if (configPath) {
    const mod = await import(pathToFileURL(path.resolve(configPath)).href);
    config = mod.default ?? {};
  }

  const workspace = {
    name: name ?? config.workspace?.name,
    description: description ?? config.workspace?.description,
    owner: owner ?? config.workspace?.owner,
    icon: icon ?? config.workspace?.icon,
  };

  if (owner && !/^[0-9a-f]{64}$/i.test(owner)) {
    console.error(`--owner must be a 64-char hex pubkey (got ${owner.length} chars)`);
    process.exit(1);
  }

  // An explicit =ARG still wins, so a config can point a policy at a
  // different key than the advertised owner if it ever needs to.
  const policies: RelayPolicy[] = policySpecs.map(({ name: policyName, value }) =>
    builtinPolicies[policyName](value ?? (policyName === "membership" || policyName === "moderation" ? workspace.owner : undefined))
  );

  const governed = policySpecs.some((p) => p.name === "membership" || p.name === "moderation");
  if (governed && !workspace.owner) {
    console.error(
      "refusing to start: --policy membership/moderation with no --owner would reject every channel and roster event.\n" +
        "Pass --owner <hex>, or drop the policy to run an ungoverned store."
    );
    process.exit(1);
  }

  // Started first so extensions can read stored events (the roster is
  // how they authorize), then handed what the extensions registered.
  const handle = startRelay({
    port: port ?? config.port ?? 7777,
    store: store ?? config.store,
    eventStore: config.eventStore,
    verifySignatures: verifySignatures ?? config.verifySignatures,
    workspace,
    policies: [...(config.policies ?? []), ...policies],
    httpHandlers: config.httpHandlers ?? [],
  });

  if (extensionsDir !== undefined) {
    const { loadRelayExtensions } = await import("./extensions.js");
    const loaded = await loadRelayExtensions({
      dir: extensionsDir || undefined,
      // Where extensions keep BYTES (bare repos, caches). Defaults to
      // ~/.fez/relay-data, which is right on a laptop and wrong on a
      // server whose state — and backup job — lives elsewhere.
      dataRoot: extensionsData,
      origins,
      owner: workspace.owner,
      query: (filter) => handle.query(filter),
      advertise: (key, value) => handle.advertise(key, value),
      onEvent: (cb) => handle.onEvent(cb),
      inject: (event) => handle.inject(event),
      log: (line) => console.log(line),
    });
    // Registered AFTER start rather than passed in, because an extension
    // needs the relay's own store to decide anything — and a handler
    // list the relay reads live is the only way to add one without a
    // second construction phase.
    handle.httpHandlers.push(...loaded.httpHandlers);
    for (const policy of loaded.policies) handle.policies.push(policy);
  }

  if (scheduler) {
    const { activateScheduler } = await import("./scheduler.js");
    activateScheduler({
      query: (f) => handle.query(f as never),
      onEvent: (cb) => handle.onEvent(cb),
      inject: (e) => handle.inject(e),
      log: (line) => console.log(line),
    });
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
