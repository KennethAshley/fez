/** The long-running processes: agent runtime, sentinel, @fez orchestrator, and the routing model — plus their launchd installers. */
import type { Command } from "commander";
import path from "path";
import os from "os";
import { getPublicKey } from "nostr-tools";
import { fezHome } from "../shared/fez-home.js";

const extensionNames = (value: string) => value.split(",").map(name => name.trim()).filter(Boolean);

export function registerServiceCommands(program: Command): void {
// ─── agent — run a standing channel agent (the fez-acp runtime) ─────────────

program
  .command("agent <persona>")
  .description("Run a standing channel agent for a persona (fez-acp runtime)")
  .option("-c, --channels <list>", 'channel names/ids, comma-separated; "none" = DM-only', "general")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--respond-to <policy>", "anyone | owner | allowlist:<pk,...> (default: persona frontmatter, else owner)")
  .option("--owner <pubkey>", "owner pubkey (default: your fez identity)")
  .option("--on-busy <mode>", "steer | queue", "steer")
  .option("--take-over", "supersede a live instance of this persona elsewhere (it shuts down)")
  .action(async (personaId: string, options) => {
    const { resolveRelays } = await import("../shared/settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");
    process.env.FEZ_AGENT_PERSONA = personaId;
    process.env.FEZ_AGENT_CHANNELS = options.channels === "none" ? "" : options.channels;
    if (options.respondTo) process.env.FEZ_AGENT_RESPOND_TO = options.respondTo;
    process.env.FEZ_AGENT_ON_BUSY = options.onBusy;
    if (options.takeOver) process.env.FEZ_AGENT_TAKEOVER = "1";
    // Owner defaults to the user's own identity — the observer stream
    // (/watch) and sibling gating work out of the box instead of being
    // an env var most people never discover.
    if (!process.env.FEZ_AGENT_OWNER) {
      const owner =
        options.owner ??
        (await (async () => {
          const { getKey } = await import("../identity/keys.js");
          const hex = getKey("default");
          return hex ? getPublicKey(Uint8Array.from(Buffer.from(hex, "hex"))) : undefined;
        })());
      if (owner) process.env.FEZ_AGENT_OWNER = owner;
    }
    // Runtime resolution: explicit override, then the repo/npm-link
    // layout relative to this CLI build.
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const candidates = [
      process.env.FEZ_ACP_RUNTIME,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/fez-acp/dist/agent.js"),
    ].filter((p): p is string => !!p);
    const runtime = candidates.find((p) => existsSync(p));
    if (!runtime) {
      console.error(`fez-acp runtime not found (looked at: ${candidates.join(", ")}) — build it with: npm run acp:build`);
      process.exit(1);
    }
    await import(pathToFileURL(runtime).href);
  });

program
  .command("sentinel")
  .description("Run the always-on watcher: wakes sleeping agents on DMs/mentions, delivers desktop notifications — no TUI needed")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .option("--extensions <names>", "Run only these enabled background extensions (comma-separated)",
    extensionNames)
  .action(async (options) => {
    // An explicit -r (or an inherited FEZ_RELAY) is a PIN — bake it so
    // the runtime and its children hold still. A bare `fez sentinel`
    // must NOT export one: the runtime resolves settings itself, and a
    // self-baked env read as a pin that disabled the settings watcher —
    // the sentinel could never follow a relay change without a restart.
    if (options.relay) {
      const { resolveRelays } = await import("../shared/settings.js");
      process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");
    }
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const candidates = [
      process.env.FEZ_SENTINEL_RUNTIME,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/fez-sentinel/dist/index.js"),
    ].filter((p): p is string => !!p);
    const runtime = candidates.find((p) => existsSync(p));
    if (!runtime) {
      console.error(`fez-sentinel runtime not found (looked at: ${candidates.join(", ")}) — build it in packages/fez-sentinel`);
      process.exit(1);
    }
    const { runSentinel } = await import(pathToFileURL(runtime).href);
    if (typeof runSentinel !== "function") throw new Error("Rebuild fez-sentinel: runtime has no runSentinel entry point");
    await runSentinel(options.extensions);
  });

program
  .command("sentinel-install")
  .description("Install the sentinel as a launchd agent: starts at login, restarts on crash (macOS)")
  .option("-r, --relay <url>", "Relay URL baked into the service (default: settings/env)")
  .option("--extensions <names>", "Run only these enabled background extensions (comma-separated)", extensionNames)
  .action(async (options) => {
    if (process.platform !== "darwin") {
      console.error("launchd is macOS-only — on Linux, use a systemd user unit running `fez sentinel`.");
      process.exit(1);
    }
    const { execFileSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    // The relay is NOT baked into the plist unless --relay was given.
    // An env var in a launchd plist outlives every settings change —
    // the sentinel kept watching localhost after the workspace moved,
    // because install-time state had been promoted to a permanent
    // override. Default: the service reads settings.json at start,
    // exactly like running it by hand.
    const relayPin = options.relay
      ? `\n    <key>FEZ_RELAY</key><string>${xml(options.relay)}</string>`
      : "";
    const logDir = fezHome("logs");
    fsSync.mkdirSync(logDir, { recursive: true });
    const label = "com.fez.sentinel";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli.js");
    const args = [process.execPath, cliPath, "sentinel",
      ...(options.extensions ? ["--extensions", options.extensions.join(",")] : [])];
    // launchd inherits a bare PATH; the node dir must ride explicitly, and
    // `security` (keychain) lives in /usr/bin.
    const pathEnv = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    ${args.map(value => `<string>${xml(value)}</string>`).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathEnv)}</string>${relayPin}
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Unconditional: a SIGTERM from logout/sleep teardown exits 0, and
       SuccessfulExit=false read that as "meant to stop" — leaving the
       sentinel dead until someone noticed (someone noticed). Deliberate
       stops go through launchctl unload, which KeepAlive respects. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, "sentinel.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, "sentinel.log"))}</string>
</dict>
</plist>
`;
    fsSync.mkdirSync(path.dirname(plistPath), { recursive: true });
    fsSync.writeFileSync(plistPath, plist);
    // bootout first so re-install picks up plist changes; ignore "not loaded".
    const domain = `gui/${process.getuid!()}`;
    try { execFileSync("launchctl", ["bootout", domain, plistPath], { stdio: "pipe" }); } catch { /* not loaded */ }
    execFileSync("launchctl", ["bootstrap", domain, plistPath]);
    console.log(`✅ sentinel installed as ${label} — starts at login, restarts on crash.`);
    console.log(`   plist: ${plistPath}`);
    console.log(`   logs:  ${path.join(logDir, "sentinel.log")}`);
    console.log(`   remove anytime: fez sentinel-uninstall`);
    console.log(`   stop any foreground \`fez sentinel\` before installing — run one sentinel per machine.`);
  });

program
  .command("sentinel-uninstall")
  .description("Remove the launchd sentinel service")
  .action(async () => {
    const { execFileSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.fez.sentinel.plist");
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plistPath], { stdio: "pipe" }); } catch { /* not loaded */ }
    fsSync.rmSync(plistPath, { force: true });
    console.log("✅ sentinel launchd service removed (any running instance was stopped).");
  });

program
  .command("orchestrator")
  .description("Run @fez, the routing agent: mentions of @fez get routed to the best agent for the task")
  .option("-r, --relay <url>", "Relay URL (default: settings/env)")
  .action(async (options) => {
    const { resolveRelays } = await import("../shared/settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");
    const { fileURLToPath, pathToFileURL } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const candidates = [
      process.env.FEZ_ORCHESTRATOR_RUNTIME,
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/fez-orchestrator/dist/orchestrator.js"),
    ].filter((p): p is string => !!p);
    const runtime = candidates.find((p) => existsSync(p));
    if (!runtime) {
      console.error(`fez-orchestrator runtime not found (looked at: ${candidates.join(", ")}) — build it in packages/fez-orchestrator`);
      process.exit(1);
    }
    await import(pathToFileURL(runtime).href);
  });

program
  .command("orchestrator-install")
  .description("Install @fez as a launchd agent: starts at login, always restarted (macOS)")
  .option("-r, --relay <url>", "Relay URL baked into the service (default: settings/env)")
  .action(async (options) => {
    if (process.platform !== "darwin") {
      console.error("launchd is macOS-only — on Linux, use a systemd user unit running `fez orchestrator`.");
      process.exit(1);
    }
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    // The relay is NOT baked into the plist unless --relay was given.
    // An env var in a launchd plist outlives every settings change —
    // the sentinel kept watching localhost after the workspace moved,
    // because install-time state had been promoted to a permanent
    // override. Default: the service reads settings.json at start,
    // exactly like running it by hand.
    const relayPin = options.relay
      ? `\n    <key>FEZ_RELAY</key><string>${options.relay}</string>`
      : "";
    const logDir = fezHome("logs");
    fsSync.mkdirSync(logDir, { recursive: true });
    const label = "com.fez.orchestrator";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const cliPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../cli.js");
    const pathEnv = `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>orchestrator</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv}</string>${relayPin}
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${path.join(logDir, "orchestrator.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "orchestrator.log")}</string>
</dict>
</plist>
`;
    fsSync.writeFileSync(plistPath, plist);
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`);
    console.log(`✅ @fez installed as ${label} — starts at login, always restarted.`);
    console.log(`   plist: ${plistPath}`);
    console.log(`   logs:  ${path.join(logDir, "orchestrator.log")}`);
    console.log(`   remove anytime: fez orchestrator-uninstall`);
  });

program
  .command("orchestrator-uninstall")
  .description("Remove the launchd @fez service")
  .action(async () => {
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.fez.orchestrator.plist");
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    fsSync.rmSync(plistPath, { force: true });
    console.log("✅ @fez launchd service removed (any running instance was stopped).");
  });

const router = program.command("router").description("Where @fez routes — the `url:` in ~/.fez/personas/fez.md");

router
  .command("show")
  .description("Which endpoint @fez uses, and whether it answers")
  .action(async () => {
    const { findPersona } = await import("../identity/personas.js");
    const { HOSTED_ROUTER } = await import("../shared/settings.js");
    const persona = await findPersona("fez");
    if (!persona) {
      console.log("No @fez persona — run `fez setup` to create one.");
      return;
    }
    // Same precedence the runtime uses, so this reports what would
    // actually happen rather than what the file says.
    const env = process.env.FEZ_ORCHESTRATOR_URL;
    const url = (env || persona.extra.url || "http://127.0.0.1:8080/v1").replace(/\/$/, "");
    const from = env ? "FEZ_ORCHESTRATOR_URL" : persona.extra.url ? "persona" : "default";
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)\b/.test(url);
    console.log(`${url}  (${from}${url === HOSTED_ROUTER ? ", hosted" : local ? ", local" : ""})`);
    try {
      const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(local ? 2500 : 8000) });
      const body = (await res.json()) as { data?: { id: string }[] };
      console.log(`  ✓ answering — model ${body.data?.[0]?.id ?? "?"}`);
    } catch {
      console.log("  ✗ not answering");
    }
  });

router
  .command("set <url>")
  .description("Point @fez at an endpoint (any OpenAI-compatible /v1 base)")
  .action(async (url: string) => {
    const fsSync = await import("node:fs");
    if (!/^https?:\/\//i.test(url)) {
      console.error(`✗ "${url}" is not an http(s) URL`);
      process.exit(1);
    }
    const personaFile = fezHome("personas", "fez.md");
    if (!fsSync.existsSync(personaFile)) {
      console.error("No ~/.fez/personas/fez.md — run `fez setup` first.");
      process.exit(1);
    }
    const clean = url.replace(/\/$/, "");
    const before = fsSync.readFileSync(personaFile, "utf-8");
    const after = /^url:.*$/m.test(before)
      ? before.replace(/^url:.*$/m, `url: ${clean}`)
      : before.replace(/^---\n/, `---\nurl: ${clean}\n`);
    fsSync.writeFileSync(personaFile, after, "utf-8");
    console.log(`✅ @fez → ${clean}`);
    if (process.env.FEZ_ORCHESTRATOR_URL) {
      console.log(`   ⚠️  FEZ_ORCHESTRATOR_URL=${process.env.FEZ_ORCHESTRATOR_URL} is set and WINS over this.`);
    }
    console.log("   Restart @fez to pick it up.");
  });

program
  .command("router-install")
  .description("Run @fez's routing model on this machine (launchd) and point fez.md at it")
  .requiredOption("-m, --model <path>", "GGUF model file (Qwen3-0.6B q4 is what the bench is tuned against)")
  .option("-s, --server <path>", "llama-server binary", fezHome("bin", "llama-server"))
  .option("-p, --port <port>", "Port to serve on", "8080")
  .action(async (options) => {
    if (process.platform !== "darwin") {
      console.error("launchd is macOS-only — on Linux, run llama-server under a systemd user unit and set `url:` in ~/.fez/personas/fez.md.");
      process.exit(1);
    }
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const model = path.resolve(options.model);
    const server = path.resolve(options.server);
    for (const [what, p] of [["model", model], ["llama-server", server]] as const) {
      if (!fsSync.existsSync(p)) {
        console.error(`✗ no ${what} at ${p}`);
        console.error("  Get a build from https://github.com/ggml-org/llama.cpp/releases and a Qwen3-0.6B GGUF from Hugging Face.");
        process.exit(1);
      }
    }
    const logDir = fezHome("logs");
    fsSync.mkdirSync(logDir, { recursive: true });
    const label = "com.fez.router";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const arg = (s: string) => `    <string>${s}</string>`;
    // --alias fez-router is cosmetic now: the orchestrator uses the
    // standard `tools` request shape (tool_choice required) for any
    // capable model — what makes a general chat model emit a routing
    // call instead of prose — and only a restricted tiny router opts
    // into the bare shape.
    // --predict 96 caps the prose preamble; measured identical to 512.
    // --parallel 1 keeps ONE KV cache, so the repeated roster prefix
    // stays cached: a warm route is ~90ms instead of ~230ms.
    const args = [
      server, "-m", model,
      "--host", "127.0.0.1", "--port", String(options.port),
      "-c", "8192", "--jinja", "--reasoning", "off",
      "--alias", "fez-router", "--no-webui",
      "--parallel", "1", "--predict", "96",
    ];
    fsSync.writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${os.homedir()}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${path.join(logDir, "router.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, "router.log")}</string>
</dict>
</plist>
`
    );
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`);

    // The switch itself is one line of frontmatter. Rewritten rather
    // than appended so re-running this is idempotent, and left alone if
    // the persona already points somewhere local — someone who chose a
    // port or a second machine should keep it.
    const url = `http://127.0.0.1:${options.port}/v1`;
    const personaFile = fezHome("personas", "fez.md");
    if (fsSync.existsSync(personaFile)) {
      const before = fsSync.readFileSync(personaFile, "utf-8");
      const after = /^url:.*$/m.test(before)
        ? before.replace(/^url:.*$/m, `url: ${url}`)
        : before.replace(/^---\n/, `---\nurl: ${url}\n`);
      if (after !== before) {
        fsSync.writeFileSync(personaFile, after, "utf-8");
        console.log(`✅ @fez now routes via ${url}`);
      } else {
        console.log(`✅ router installed; @fez already points at ${url}`);
      }
    } else {
      console.log(`✅ router installed at ${url}`);
      console.log("   No ~/.fez/personas/fez.md yet — run `fez setup` to create @fez.");
    }
    console.log(`   plist: ${plistPath}`);
    console.log(`   logs:  ${path.join(logDir, "router.log")}`);
    console.log("   Restart @fez to pick it up: fez orchestrator-install (or restart the service).");
    console.log("   remove anytime: fez router-uninstall");
  });

program
  .command("router-uninstall")
  .description("Stop the local routing model and send @fez back to the hosted router")
  .action(async () => {
    const { execSync } = await import("node:child_process");
    const fsSync = await import("node:fs");
    const { HOSTED_ROUTER } = await import("../shared/settings.js");
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.fez.router.plist");
    try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    fsSync.rmSync(plistPath, { force: true });
    const personaFile = fezHome("personas", "fez.md");
    if (fsSync.existsSync(personaFile)) {
      const before = fsSync.readFileSync(personaFile, "utf-8");
      // Only reclaim a LOCAL url — a deliberate third-party endpoint is
      // not ours to overwrite on the way out.
      const after = before.replace(/^url:\s*https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)\b.*$/m, `url: ${HOSTED_ROUTER}`);
      if (after !== before) {
        fsSync.writeFileSync(personaFile, after, "utf-8");
        console.log(`✅ local router removed — @fez back on ${HOSTED_ROUTER}`);
      } else {
        console.log("✅ local router removed — @fez's url: was not local, left as-is.");
      }
    } else {
      console.log("✅ local router removed.");
    }
  });
}
