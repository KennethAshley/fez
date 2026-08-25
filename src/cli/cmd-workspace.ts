/** The workspace's shape: roster invites, the relay set, and doctor. */
import type { Command } from "commander";
import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getPublicKey } from "nostr-tools";
import { fezHome } from "../shared/fez-home.js";
import { unixNow } from "../shared/time.js";

export function registerWorkspaceCommands(program: Command): void {
program
  .command("invite <pubkey> [role]")
  .description("Add a pubkey to the workspace roster (member|admin|bot) — the owner-signed 47102")
  .option("-r, --relay <url>", "Relay to publish to (default: settings/env)")
  .action(async (pubkey: string, role = "member", options: { relay?: string }) => {
    const ROLES = ["member", "admin", "bot", "owner"];
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
      console.error(`✗ "${pubkey}" is not a 64-hex pubkey`);
      process.exit(1);
    }
    if (!ROLES.includes(role)) {
      console.error(`✗ role must be one of: ${ROLES.join(", ")}`);
      process.exit(1);
    }
    const { getKey } = await import("../identity/keys.js");
    const { resolveRelays } = await import("../shared/settings.js");
    const { CapabilityClient } = await import("../protocol/client.js");
    const { RelayConnection } = await import("../protocol/relay.js");
    const { KIND_MEMBERSHIP, ROSTER_D } = await import("../protocol/kinds.js");
    const { fetchRelayInfo } = await import("../protocol/nip11.js");

    const keyHex = getKey("default");
    if (!keyHex) {
      console.error("No fez identity — run `fez keygen` first.");
      process.exit(1);
    }
    const relays = options.relay ? [options.relay] : resolveRelays();
    const client = new CapabilityClient({ relay: relays, privateKey: keyHex });
    const relay = new RelayConnection({ urls: relays, authSigner: client.authSigner });
    await relay.connect();
    const me = client.getPubkey();

    // Only the owner's roster counts, so refuse early rather than
    // publishing an event every other client will ignore.
    const info = await fetchRelayInfo(relays[0]);
    if (info?.pubkey && info.pubkey !== me) {
      console.error(`✗ only the workspace owner can invite — this relay's owner is ${info.pubkey.slice(0, 12)}…, you are ${me.slice(0, 12)}…`);
      relay.disconnect();
      process.exit(1);
    }

    // Rebuild from the CURRENT roster: 47102 is replaceable, so
    // publishing a roster of one would evict everybody else.
    const existing = await relay.query([{ kinds: [KIND_MEMBERSHIP], authors: [me], "#d": [ROSTER_D], limit: 1 }]);
    const members = new Map<string, string>();
    const latest = existing.sort((a, b) => b.created_at - a.created_at)[0];
    for (const tag of latest?.tags ?? []) if (tag[0] === "p" && tag[1]) members.set(tag[1], tag[2] || "member");
    members.set(me, "owner"); // the owner is always on their own roster

    if (members.get(pubkey) === role) {
      console.log(`✓ ${pubkey.slice(0, 12)}… is already on the roster as ${role}`);
      relay.disconnect();
      return;
    }
    const had = members.has(pubkey);
    members.set(pubkey, role);

    // created_at must beat the event being replaced, or relays keep the old one.
    const createdAt = Math.max(unixNow(), (latest?.created_at ?? 0) + 1);
    await relay.publish(
      client.signEvent({
        kind: KIND_MEMBERSHIP,
        tags: [["d", ROSTER_D], ...[...members.entries()].map(([pk, r]) => ["p", pk, r])],
        content: "",
        created_at: createdAt,
      })
    );
    console.log(`✅ ${had ? "updated" : "invited"} ${pubkey.slice(0, 12)}… as ${role} (${members.size} on the roster)`);
    relay.disconnect();
  });

// ─── doctor — is this machine ready to fez? ─────────────────────────────────

const relayCmd = program
  .command("relay")
  .description("The relay set — where your events are published and read from");

relayCmd
  .command("list", { isDefault: true })
  .description("Show the relay set and where it came from")
  .action(async () => {
    const { loadSettings, resolveRelays, DEFAULT_RELAY } = await import("../shared/settings.js");
    const settings = loadSettings();
    const urls = resolveRelays();
    const source = process.env.FEZ_RELAY
      ? "env FEZ_RELAY"
      : settings.relays?.length
        ? "settings.relays"
        : settings.relay
          ? "settings.relay (legacy single)"
          : `built-in default (${DEFAULT_RELAY})`;
    console.log(chalk.bold(`\nrelays (${source})`));
    for (const url of urls) console.log(`  ${chalk.cyan(url)}`);
    if (urls.length === 1) {
      console.log(
        chalk.dim("\n  One relay is one operator who can lose your history, go away, or decline to carry it.")
      );
      console.log(chalk.dim("  fez relay add wss://another.example\n"));
    } else {
      console.log(chalk.dim(`\n  Publishes fan out to all ${urls.length}; reads are the union. Any one can fail.\n`));
    }
  });

relayCmd
  .command("add <url>")
  .description("Add a relay to the set")
  .action(async (url: string) => {
    const { loadSettings, saveSettings, resolveRelays } = await import("../shared/settings.js");
    if (!/^wss?:\/\//.test(url)) {
      console.error(chalk.red(`"${url}" is not a relay URL — expected ws:// or wss://`));
      process.exit(1);
    }
    const settings = loadSettings();
    // Fold a legacy single `relay` into the list on first add rather
    // than leaving two settings that disagree about where events go.
    const current = settings.relays?.length ? settings.relays : resolveRelays();
    if (current.includes(url)) {
      console.log(chalk.dim(`${url} is already in the set`));
      return;
    }
    const next = [...current, url];
    saveSettings({ relays: next });
    console.log(chalk.green(`✓ added ${url}`));
    console.log(chalk.dim(`  set is now: ${next.join(", ")}`));
    console.log(chalk.dim("  running agents pick it up on restart"));
  });

relayCmd
  .command("remove <url>")
  .description("Remove a relay from the set")
  .action(async (url: string) => {
    const { loadSettings, saveSettings, resolveRelays } = await import("../shared/settings.js");
    const settings = loadSettings();
    const current = settings.relays?.length ? settings.relays : resolveRelays();
    const next = current.filter((entry) => entry !== url);
    if (next.length === current.length) {
      console.error(chalk.yellow(`${url} is not in the set (${current.join(", ")})`));
      process.exit(1);
    }
    if (next.length === 0) {
      console.error(chalk.red("refusing to remove the last relay — add another first"));
      process.exit(1);
    }
    saveSettings({ relays: next });
    console.log(chalk.green(`✓ removed ${url}`));
    console.log(chalk.dim(`  set is now: ${next.join(", ")}`));
  });

program
  .command("doctor")
  .description("Check identity, relay, harness, personas — with fixes for whatever's missing")
  .action(async () => {
    const { getKey, listKeys } = await import("../identity/keys.js");
    const { detectHarnesses, listHarnesses, registerBuiltinHarnesses } = await import("../agent/harness.js");
    registerBuiltinHarnesses();
    const { listPersonas } = await import("../identity/personas.js");
    const { loadSettings, resolveRelays, DEFAULT_RELAY } = await import("../shared/settings.js");
    const ok = (s: string) => console.log(`  ${chalk.green("✓")} ${s}`);
    const warn = (s: string, fix?: string) => {
      console.log(`  ${chalk.yellow("!")} ${s}`);
      if (fix) console.log(chalk.dim(`      fix: ${fix}`));
    };
    const bad = (s: string, fix?: string) => {
      console.log(`  ${chalk.red("✗")} ${s}`);
      if (fix) console.log(chalk.dim(`      fix: ${fix}`));
      failures++;
    };
    let failures = 0;

    // identity
    const key = getKey("default");
    if (key) {
      const backends = new Set(listKeys().map((k) => k.backend));
      ok(`identity key (${listKeys().find((k) => k.name === "default")?.backend ?? "?"}${backends.has("file") ? "; some agent keys still file-backed — they migrate on next run" : ""})`);
    } else {
      warn("no identity yet — one is generated on first `fez` launch");
    }

    // relays: value + provenance + reachability, EVERY one of them.
    // Checking only the first would pass on a set whose other relays
    // have been unreachable for a month — the failure the set exists to
    // prevent, hidden by the check meant to catch it.
    const relays = resolveRelays();
    const settingsNow = loadSettings();
    const source = process.env.FEZ_RELAY
      ? "env FEZ_RELAY"
      : settingsNow.relays?.length || settingsNow.relay
        ? "~/.fez/settings.json"
        : `built-in default (${DEFAULT_RELAY})`;
    const reach = (url: string) =>
      new Promise<boolean>((resolve) => {
        void import("ws").then(({ default: WebSocket }) => {
          const socket = new WebSocket(url);
          const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 4000);
          socket.on("open", () => { clearTimeout(timer); socket.close(); resolve(true); });
          socket.on("error", () => { clearTimeout(timer); resolve(false); });
        });
      });
    const reachable = await Promise.all(relays.map(reach));
    const upCount = reachable.filter(Boolean).length;
    if (relays.length === 1) {
      if (upCount === 1) {
        ok(`relay ${relays[0]} reachable (${source})`);
        warn("only one relay — its operator can lose or withhold your history", "fez relay add wss://another.example");
      } else {
        bad(`relay ${relays[0]} unreachable (${source})`, "start one (npm run dev:relay in the fez repo) or `fez relay add <url>`");
      }
    } else if (upCount === relays.length) {
      ok(`relays: ${upCount}/${relays.length} reachable (${source})`);
    } else if (upCount > 0) {
      warn(
        `relays: ${upCount}/${relays.length} reachable (${source}) — down: ${relays.filter((_, i) => !reachable[i]).join(", ")}`,
        "publishes still land, but you are closer to a single point of failure than you think"
      );
    } else {
      bad(`no relay reachable of ${relays.length} (${source})`, "check the network, or `fez relay add <url>`");
    }

    // harness
    const harnesses = await detectHarnesses();
    if (harnesses.length > 0) ok(`harness: ${harnesses.map((h) => h.id).join(", ")}`);
    else bad(`no agent harness (checked: ${listHarnesses().map((h) => h.command).join(", ")})`, "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp");

    // harness auth. Default mode shares the user's own Claude login
    // (Buzz's model — no second session) with account connectors
    // suppressed by env; only explicit FEZ_HARNESS_ISOLATE=1 needs its
    // own clean-room login.
    if (harnesses.length > 0) {
      if (process.env.ANTHROPIC_API_KEY) {
        ok("harness auth: ANTHROPIC_API_KEY set");
      } else if (process.env.FEZ_HARNESS_ISOLATE === "1") {
        const cleanDir = fezHome("harness", "claude", "shared");
        const { createHash } = await import("node:crypto");
        const { spawnSync } = await import("node:child_process");
        const authed =
          process.platform === "darwin"
            ? spawnSync("security", ["find-generic-password", "-s", `Claude Code-credentials-${createHash("sha256").update(cleanDir).digest("hex").slice(0, 8)}`], { stdio: "ignore" }).status === 0
            : await fs.access(path.join(cleanDir, ".credentials.json")).then(() => true, () => false);
        if (authed) ok("harness auth: isolated session present (FEZ_HARNESS_ISOLATE)");
        else bad("FEZ_HARNESS_ISOLATE is set but the clean room isn't logged in", `CLAUDE_CONFIG_DIR=~/.fez/harness/claude/shared claude /login   (one time)`);
      } else {
        ok("harness auth: shared with your Claude login (connectors suppressed)");
      }
    }

    // personas
    const personas = await listPersonas();
    if (personas.length > 0) ok(`personas: ${personas.map((p) => `@${p.id}`).join(", ")}`);
    else warn("no personas — @mentions have nobody to become", "create ~/.fez/personas/<name>.md (the first-run wizard offers a starter)");

    // ── the workspace itself: reachable is not CLAIMED ───────────
    // An unclaimed relay refuses every governed event while answering
    // pings happily, so a doctor that only pinged called a broken
    // workspace healthy. The NIP-11 document is also where relay
    // extensions advertise what they serve — git, below, reads it.
    let nip11: Record<string, unknown> | undefined;
    try {
      const http = relays[0].replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
      const res = await fetch(http, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(5000) });
      if (res.ok) nip11 = (await res.json()) as Record<string, unknown>;
    } catch { /* reported below */ }
    if (!nip11) {
      warn("primary relay serves no NIP-11 document — the workspace stays unclaimed", "the relay must answer Accept: application/nostr+json on its http origin");
    } else if (typeof nip11.pubkey !== "string") {
      bad("relay serves NIP-11 but names no owner — channel/roster events will all be refused", "restart the relay with --owner <your pubkey>");
    } else if (key && getPublicKey(Uint8Array.from(Buffer.from(key, "hex"))) === nip11.pubkey) {
      ok(`workspace "${nip11.name ?? "unnamed"}" — you are the owner`);
    } else {
      ok(`workspace "${nip11.name ?? "unnamed"}" · owner ${String(nip11.pubkey).slice(0, 12)}… (not you — you cannot open channels)`);
    }
    const gitBase = (nip11?.fez_git as { clone_base?: string } | undefined)?.clone_base;
    if (gitBase) ok(`git server advertised: ${gitBase}`);

    // ── repo: personas — the whole chain each one needs at spawn ─
    // Every link here failed for real at least once: no provider (spawn
    // dies), no helper in ~/.fez/bin (the agent goes spelunking through
    // password managers for credentials that do not exist), no git
    // server on the relay (clone fails far from the reason).
    const repoPersonas = personas.filter((p) => p.extra.repo);
    if (repoPersonas.length > 0) {
      const who = repoPersonas.map((p) => `@${p.id}`).join(", ");
      const providerDir = fezHome("workspace-providers");
      const providers = (await fs.readdir(providerDir).catch(() => [] as string[])).filter((f) => f.endsWith(".js"));
      if (providers.length === 0) bad(`${who} name a repo: but no workspace provider is installed — their spawn dies`, "fez install @fezchat/git");
      else ok(`workspace provider present for ${who}`);
      const helper = fezHome("bin", "git-credential-fez");
      if (await fs.access(helper).then(() => true, () => false)) ok("git credential helper: ~/.fez/bin/git-credential-fez");
      else bad("git credential helper missing — agent pushes fail as auth errors far from the cause", "fez install @fezchat/git (fills ~/.fez/bin)");
      if (nip11 && !gitBase) bad(`${who} need git, but the relay advertises no git server`, "install @fezchat/git ON THE RELAY; start it with --extensions --origin <public url>");
    }

    // ── sentinel: not just RUNNING — on the RIGHT relay ──────────
    // A launchd env pin held the sentinel to localhost for a day after
    // the workspace moved; every existing check passed while mentions
    // vanished. The log states which relay it bound; the pidfile only
    // proves the process is alive, which was never the question.
    try {
      const pid = Number((await fs.readFile(fezHome("sentinel.pid"), "utf-8")).trim());
      process.kill(pid, 0); // throws if dead
      const log = await fs.readFile(fezHome("logs", "sentinel.log"), "utf-8").catch(() => "");
      const bound = [...log.matchAll(/sentinel on (\S+)/g)].at(-1)?.[1];
      if (bound && !relays.includes(bound)) {
        bad(`sentinel is on ${bound}, but settings say ${relays[0]} — mentions there never reach it`, "launchctl kickstart -k gui/$(id -u)/com.fez.sentinel   (or restart fez sentinel)");
      } else {
        ok(`sentinel running${bound ? ` on ${bound}` : ""} (pid ${pid})`);
      }
    } catch {
      warn("sentinel not running — nothing wakes sleeping agents on DMs/mentions", "fez sentinel   (or: fez sentinel-install)");
    }
    // Legacy relay pins: an env var in a plist outranks settings.json
    // forever, and installers used to write one. Current installers do
    // not — so finding one means it predates the fix and will bite.
    for (const label of ["com.fez.sentinel", "com.fez.orchestrator"]) {
      const plist = await fs.readFile(path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`), "utf-8").catch(() => "");
      if (plist.includes("FEZ_RELAY")) {
        warn(`${label}.plist pins FEZ_RELAY — it overrides settings.json on every start`, `re-run fez ${label.replace("com.fez.", "")}-install (current installers write no pin)`);
      }
    }

    // extensions + themes (informational)
    for (const [dir, label] of [["extensions", "extensions"], ["themes", "themes"], ["workflows", "workflows"]] as const) {
      try {
        const count = (await fs.readdir(fezHome(dir))).filter((f) => !f.startsWith(".")).length;
        if (count > 0) ok(`${label}: ${count} installed`);
      } catch { /* none — fine */ }
    }

    // orchestrator endpoint, only if configured
    const { findPersona } = await import("../identity/personas.js");
    const fezPersona = await findPersona("fez");
    const routerUrl = process.env.FEZ_ORCHESTRATOR_URL || fezPersona?.extra.url;
    if (routerUrl) {
      const key = process.env.FEZ_ORCHESTRATOR_KEY || fezPersona?.extra.key;
      const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)\b/.test(routerUrl);
      try {
        const res = await fetch(`${routerUrl.replace(/\/$/, "")}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          // A hosted router is a network round trip, not a loopback call.
          signal: AbortSignal.timeout(local ? 2500 : 8000),
        });
        const body = (await res.json()) as { data?: { id: string }[] };
        ok(`orchestrator router at ${routerUrl} (${body.data?.[0]?.id ?? "?"})`);
      } catch {
        warn(
          `orchestrator router ${routerUrl} not responding`,
          local
            ? "start it, or point fez.md at the hosted router: url: https://137-184-135-188.sslip.io/v1"
            : "check the URL, or run a local one and set url: http://127.0.0.1:8080/v1 in ~/.fez/personas/fez.md"
        );
      }
    }

    // ── external tools installed extensions declare ──────────────
    // An extension that shells out to a missing binary does not crash:
    // it loads, registers, runs on schedule, and quietly does nothing.
    // That failure only ever appeared as a warning in a log nobody
    // reads, so it belongs here, where someone is already looking.
    {
      const { adoptUserPath, whichBinary } = await import("../shared/user-path.js");
      adoptUserPath();
      const extDir = fezHome("extensions");
      const requirements = new Map<string, string[]>(); // binary → extensions wanting it
      let scanned = 0;
      for (const dir of [path.join(process.cwd(), "packages"), extDir]) {
        let entries: string[] = [];
        try { entries = await fs.readdir(dir); } catch { continue; }
        for (const entry of entries) {
          const manifest = path.join(dir, entry, "package.json");
          try {
            const pkg = JSON.parse(await fs.readFile(manifest, "utf-8")) as { fez?: { requires?: string[] } };
            const needs = pkg.fez?.requires ?? [];
            if (needs.length === 0) continue;
            scanned++;
            for (const binary of needs) {
              requirements.set(binary, [...(requirements.get(binary) ?? []), entry]);
            }
          } catch { /* not a fez package */ }
        }
      }
      for (const [binary, wanters] of requirements) {
        const found = whichBinary(binary);
        const who = wanters.join(", ");
        if (found) ok(`${binary} — ${found} (${who})`);
        else warn(`${binary} not found, needed by ${who}`, `install it, then: launchctl kickstart -k gui/$(id -u)/com.fez.sentinel`);
      }
      if (scanned === 0) ok("no extension declares an external tool");
    }

    console.log(failures === 0 ? chalk.green("\nAll clear.") : chalk.red(`\n${failures} problem(s).`));
    process.exitCode = failures === 0 ? 0 : 1;
  });
}
