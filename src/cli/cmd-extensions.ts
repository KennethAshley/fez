/** Running and managing packages: run, discover, install/create/link/list/remove. */
import type { Command } from "commander";
import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import { CapabilityClient } from "../protocol/client.js";
import { PackageManager, npmPackageName, resolveSkillArgs } from "../extensions/package-manager.js";
import { fezHome, fezHomeAt } from "../shared/fez-home.js";
import nodeFs from "node:fs";

/**
 * `fez create <name>` routes to the on-brand @fezchat/ui scaffold
 * (Task 7's `./scaffold.js`) only when GUI is the ONLY surface asked
 * for — the one invocation shape that unambiguously means "just a GUI
 * extension." Every other combination, including the no-flags default
 * (`["headless","gui"]`), keeps going through the older multi-surface
 * scaffolder (`../extensions/scaffold.js`). Extracted so the routing
 * rule has its own test independent of the CLI action/commander.
 */
export function isGuiOnlyCreate(picked: readonly string[]): boolean {
  return picked.length === 1 && picked[0] === "gui";
}

/**
 * Materialize a linked package's gui part into ~/.fez/packages/<name>/ —
 * the same shape `fez install` produces (the desktop's loader reads
 * packages/<name>/package.json + fez.parts.gui; it stopped reading the
 * flat gui-extensions/<name>.js entirely, see package-manager.ts
 * installParts). Without this, `fez link`'s inner dev loop built a gui
 * part the loader could never find. `base` is a test-only ~/.fez override,
 * mirroring PackageManager's `base` option — production callers omit it.
 */
export function placeLinkedGuiPart(
  pkgDir: string,
  manifest: { fez?: { parts?: { gui?: string } } },
  name: string,
  base?: string
): string {
  const guiRel = manifest.fez?.parts?.gui;
  if (!guiRel) throw new Error(`${name} declares no fez.parts.gui`);
  // Mirror the install side's write-time guard (package_install.rs
  // materialize / gui_parts): a manifest gui rel must stay inside the
  // package dir — an absolute path or a `..` segment is refused before
  // any write, not silently joined outside packages/<name>/.
  if (path.isAbsolute(guiRel) || guiRel.split(/[\\/]/).includes("..")) {
    throw new Error(`${name} gui rel ${guiRel} escapes the package — refusing`);
  }
  const dir = fezHomeAt(base, "packages", name);
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  const dest = path.join(dir, guiRel);
  nodeFs.mkdirSync(path.dirname(dest), { recursive: true });
  nodeFs.copyFileSync(path.join(pkgDir, guiRel), dest);
  // The companion stylesheet — same contract as install (Rust tarball +
  // PackageManager): the loader reads `<stem>.css` beside the gui part.
  const cssRel = guiRel.replace(/\.js$/, ".css");
  if (cssRel !== guiRel && nodeFs.existsSync(path.join(pkgDir, cssRel))) {
    nodeFs.copyFileSync(path.join(pkgDir, cssRel), path.join(dir, cssRel));
  }
  return dest;
}

export function registerExtensionCommands(program: Command): void {
// ─── run ────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description("Run an agent from a file")
  .argument("<file>", "Path to agent script (.ts or .js)")
  .option("-r, --relay <url>", "Relay URL (default: FEZ_RELAY env, else your saved relays, else the fez default)")
  .option("-k, --key <file>", "Private key file (hex)")
  .action(async (file, options) => {
    // Agent scripts are self-contained: they call Agent.create() and
    // agent.start() themselves (see examples/echo-agent.ts). `fez run`
    // doesn't construct the Agent — it just passes the relay/key through
    // as env vars, which scripts read the same way the TUI does.
    // Explicit -r wins; otherwise an inherited FEZ_RELAY stands (a
    // supervisor like herdr sets it on the launched process — a baked-in
    // commander default silently clobbered it), then the user's saved
    // settings, then the public default.
    const { resolveRelays } = await import("../shared/settings.js");
    process.env.FEZ_RELAY = resolveRelays(options.relay).join(",");

    if (options.key) {
      process.env.FEZ_PRIVATE_KEY = (await fs.readFile(options.key, "utf-8")).trim();
    } else if (!process.env.FEZ_PRIVATE_KEY) {
      const { getKey } = await import("../identity/keys.js");
      const stored = getKey("default"); // keychain custody; migrates a legacy plaintext file
      if (stored) process.env.FEZ_PRIVATE_KEY = stored;
      // else: script will auto-generate a key if FEZ_PRIVATE_KEY is unset
    }

    await import(path.resolve(file));
  });

// ─── discover ─────────────────────────────────────────────────────────────

program
  .command("discover")
  .description("List the agents announced on your relay set")
  .option("-r, --relay <url>", "Relay URL (default: your configured relay set)")
  .option("-n, --name <name>", "Filter by agent name")
  .action(async (options) => {
    // No baked-in default: this used to hardcode wss://relay.damus.io and
    // ignore FEZ_RELAY and settings.json entirely — the one command where
    // "the relay set" story was false.
    const { resolveRelays } = await import("../shared/settings.js");
    const relays = resolveRelays(options.relay);
    const client = new CapabilityClient({ relay: relays });
    await client.connect();

    console.log(chalk.blue(`🔍 Agents on ${relays.join(", ")}...\n`));

    const agents = await client.findAgentsByName(options.name ?? "");
    agents.forEach((agent) => {
      console.log(`  ${chalk.green(agent.name)}`);
      console.log(`    Pubkey: ${chalk.dim(agent.pubkey)}`);
      console.log(`    Tasks: ${agent.supportedTasks.join(", ")}`);
      console.log();
    });
    if (agents.length === 0) console.log(chalk.dim("  none yet — run one with: fez agent <persona>\n"));

    client.disconnect();
  });


// ─── install / list / remove ───────────────────────────────────────────────

program
  .command("install <source>")
  .description("Install a fez package (agent, integration, or extension)")
  .option("-v, --version <version>", "Pin to a specific version")
  .action(async (source: string, options) => {
    const pm = new PackageManager();
    await pm.init();
    await pm.install(source, { version: options.version });
  });

program
  .command("update <name>")
  .description("Update an installed fez package: refetch the source and re-run the install hooks")
  .option("-v, --version <version>", "Pin to a specific version")
  .action(async (name: string, options) => {
    const pm = new PackageManager();
    await pm.init();
    await pm.update(name, { version: options.version });
  });

program
  .command("create <name>")
  .description("Scaffold a new fez extension package (headless + gui by default), typed against @fezchat/extension-api")
  .option("--headless", "Include a headless part (slash commands, scheduled tasks — TUI + sentinel)")
  .option("--gui", "Include a desktop GUI part (alone: isolated React navigation view)")
  .option("--relay", "Include a relay part (HTTP + NIP-11, loaded by a --extensions relay)")
  .option("--workspace", "Include a workspace provider (gives a repo: persona a checkout)")
  .option("-d, --dir <path>", "Output directory (default ./<name>)")
  .action(async (name: string, options) => {
    const picked = (["headless", "gui", "relay", "workspace"] as const).filter((s) => options[s]);
    // A GUI-only request ("fez create <name> --gui", nothing else) gets the
    // isolated @fezchat/ui recipe — mount model and fez-* utilities —
    // instead of the older multi-part
    // scaffolder's raw h()-factory gui starter. Any other combination
    // (default headless+gui, or a relay/workspace part) still goes through
    // the general multi-surface scaffolder below; those parts have no
    // @fezchat/ui equivalent yet.
    if (isGuiOnlyCreate(picked)) {
      const { scaffold: scaffoldGui } = await import("./scaffold.js");
      // Same `--dir` semantics as the other branch below: an exact output
      // dir when given, else `./<name>` — never a parent to append <name> to.
      const dir = options.dir ?? path.join(process.cwd(), name);
      await scaffoldGui(name, dir);
      console.log(chalk.green(`✅ ${name} — isolated gui (built from @fezchat/ui)`));
      console.log(chalk.dim(`   ${path.relative(process.cwd(), dir) || "."}/`));
      console.log();
      console.log(chalk.bold("Next:"));
      console.log(`  cd ${path.relative(process.cwd(), dir) || "."}`);
      console.log(`  npm install && npm run check && npm run build`);
      console.log(`  npx fez link .`);
      console.log(chalk.dim("  Quit and reopen the packaged macOS Fez app to load the view."));
      return;
    }
    const { scaffold, baseName } = await import("../extensions/scaffold.js");
    const surfaces = picked.length ? picked : (["headless", "gui"] as const);
    const dir = options.dir ?? path.join(process.cwd(), baseName(name));
    try {
      const result = scaffold({ name, dir, surfaces: [...surfaces], apiVersion: "^0.2.0" });
      console.log(chalk.green(`✅ ${result.pkgName} — ${result.surfaces.join(" + ")}`));
      console.log(chalk.dim(`   ${path.relative(process.cwd(), result.dir) || "."}/`));
      for (const f of result.files) console.log(chalk.dim(`     ${f}`));
      console.log();
      console.log(chalk.bold("Next:"));
      console.log(`  cd ${path.relative(process.cwd(), result.dir) || "."}`);
      console.log(`  npm install && npm run build`);
      console.log(`  fez link .            ${chalk.dim("# build, copy parts into ~/.fez, smoke-import")}`);
    } catch (err) {
      console.error(chalk.red(`❌ ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  });

program
  .command("link <dir>")
  .description("Dev-install a local extension package: build, copy its entry to ~/.fez/extensions, smoke-import the result")
  .option("--no-build", "Skip the package's npm build script")
  .option("-w, --watch", "Stay resident: rebuild and re-link when src/ changes")
  .action(async (dir: string, options) => {
    const { execSync } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const fsSync = await import("node:fs");
    const pkgDir = path.resolve(dir);
    let manifest: {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
      /** npm's bin map — honored like install: copied to ~/.fez/bin. */
      bin?: Record<string, string>;
      fez?: {
        extension?: { entry?: string };
        /** What this package says it needs — see extension-permissions.ts. */
        permissions?: string[];
        /** Oldest fez this package works on — see host-compat.ts. */
        minFezVersion?: string;
        /** Multi-part packages: one install, three attachment points. */
        parts?: {
          skill?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
          headless?: string;
          gui?: string;
          /** → ~/.fez/relay-extensions; loaded only by a relay started with --extensions */
          relay?: string;
          /** → ~/.fez/workspace-providers; gives a `repo:` persona a checkout to work in */
          workspace?: string;
          /** → ~/.fez/miners; the descriptor realpaths import.meta.url for sibling dist files */
          miner?: string;
          /** opt in to running scheduled tasks inside the always-on sentinel */
          background?: boolean;
        };
      };
    };
    try {
      manifest = JSON.parse(fsSync.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
    } catch {
      console.error(chalk.red(`No readable package.json in ${pkgDir}`));
      process.exit(1);
    }
    // A checkout folder is not an extension identity: fez-wallet and
    // wallet must overwrite the same install and keep the same tool grants.
    const name = npmPackageName(manifest.name ?? path.basename(pkgDir));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error(`invalid package name: ${manifest.name ?? name}`);
    }
    new PackageManager().assertPackageIdentity(name, manifest.name);
    // ── compat gate: same check `fez install` runs, before anything is
    // built or copied — a package built for a newer fez refuses here.
    {
      const { minFezVersionError } = await import("../extensions/host-compat.js");
      const compatError = minFezVersionError(manifest.fez?.minFezVersion);
      if (compatError) {
        console.error(chalk.red(`✗ ${manifest.name ?? path.basename(pkgDir)} ${compatError}`));
        process.exit(1);
      }
    }
    // ── permissions: shown BEFORE anything is copied, recorded on grant.
    const { consentLines, parsePermissions } = await import("../extensions/extension-permissions.js");
    const declared = manifest.fez?.permissions;
    const lines = consentLines(declared);
    if (lines.length > 0) {
      console.log(chalk.bold(`\n${manifest.name ?? path.basename(pkgDir)} asks for:`));
      for (const line of lines) {
        console.log(`  ${line.sensitive ? chalk.yellow("\u26a0") : chalk.dim("\u00b7")} ${line.description} ${chalk.dim(`(${line.id})`)}`);
      }
      const { unknown } = parsePermissions(declared);
      if (unknown.length > 0) console.log(chalk.yellow(`  \u26a0 unrecognized: ${unknown.join(", ")} — these grant nothing`));
      console.log(chalk.dim("  (linking a local package grants these)\n"));
    } else {
      console.log(chalk.dim(`${manifest.name ?? "package"} declares no permissions — legacy read-only grant.\n`));
    }

    const parts = manifest.fez?.parts;
    const entry = parts?.headless ?? manifest.fez?.extension?.entry;
    if (!entry && !parts?.gui && !parts?.skill && !parts?.miner && !parts?.relay && !parts?.workspace) {
      console.error(chalk.red(`${manifest.name ?? pkgDir} declares no fez.parts (or fez.extension.entry) — nothing to link.`));
      process.exit(1);
    }
    if (options.build !== false && manifest.scripts?.build) {
      // cwd pinned to the package — the copy-from-the-wrong-directory
      // foot-gun is the reason this command exists.
      execSync("npm run build", { cwd: pkgDir, stdio: "inherit" });
    }
    // ── skill part: merge the MCP definition into the machine catalog.
    // Existing env VALUES the user filled in are kept; the package only
    // supplies names/defaults.
    if (parts?.skill) {
      const { loadSettings, saveSettings } = await import("../shared/settings.js");
      const settings = loadSettings() as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      const existing = settings.mcpServers?.[name];
      const mergedEnv = { ...(parts.skill.env ?? {}), ...(existing?.env ?? {}) };
      const { skillEntryFor } = await import("../extensions/package-manager.js");
      saveSettings({
        mcpServers: {
          ...settings.mcpServers,
          // Relative args ("dist/mcp.js") resolve against the LINKED dir —
          // same rule as install, or the spawner has no way to find them.
          // No `source`: a linked directory is not a spec anyone can fetch.
          [name]: skillEntryFor(
            { ...resolveSkillArgs(parts.skill, pkgDir), ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) },
            { manifestName: manifest.name, description: manifest.description }
          ),
        },
      } as never);
      console.log(chalk.green(`✓ tool "${name}" defined — personas declaring mcpServers: [${name}] get it on next spawn`));
    }

    // ── background part: the sentinel only loads extensions that ASKED
    // for background life, so a TUI extension never starts doing its
    // foreground job a second time inside the always-on process.
    {
      const { loadSettings, saveSettings } = await import("../shared/settings.js");
      const { granted } = parsePermissions(declared);
      const settings = loadSettings() as { extensionPermissions?: Record<string, string[]> };
      saveSettings({ extensionPermissions: { ...settings.extensionPermissions, [name]: granted } } as never);
    }

    if (parts?.background) {
      const { loadSettings, saveSettings } = await import("../shared/settings.js");
      const settings = loadSettings() as { backgroundExtensions?: string[] };
      const list = new Set(settings.backgroundExtensions ?? []);
      list.add(name);
      saveSettings({ backgroundExtensions: [...list] } as never);
      console.log(chalk.green(`✓ background tasks enabled — restart the sentinel to run them`));
    }

    // ── the built file parts, extracted so --watch can re-run exactly
    // what a one-shot link does. `fatal` is the difference between the
    // two callers: a first link that can't import its bundle should
    // stop the command; a watch rebuild should report and keep watching.
    const copyBuiltParts = async (fatal: boolean): Promise<void> => {
      // gui: materialized into the package dir for fez-desktop's loader
      // (webview code — no node smoke-import possible here). No flat
      // gui-extensions/<name>.js — the loader stopped reading that.
      if (parts?.gui) {
        const dest = placeLinkedGuiPart(pkgDir, manifest, name);
        console.log(chalk.green(`✓ gui part → ${dest} (loads on next fez-desktop launch)`));
      }

      // relay + workspace: link matches install exactly. It did not
      // always — link predates multi-part packages, and a linked
      // package that silently dropped its workspace provider meant a
      // `repo:` persona failed loudly (fatal, by design) while the
      // person who "installed" the package stared at a link that said ✓.
      if (parts?.relay) {
        const relayDir = fezHome("relay-extensions");
        fsSync.mkdirSync(relayDir, { recursive: true });
        fsSync.copyFileSync(path.join(pkgDir, parts.relay), path.join(relayDir, `${name}.js`));
        console.log(chalk.green(`✓ relay part → ~/.fez/relay-extensions/${name}.js (a relay started with --extensions loads it)`));
      }
      if (parts?.workspace) {
        const wsDir = fezHome("workspace-providers");
        fsSync.mkdirSync(wsDir, { recursive: true });
        fsSync.copyFileSync(path.join(pkgDir, parts.workspace), path.join(wsDir, `${name}.js`));
        console.log(chalk.green(`✓ workspace provider → ~/.fez/workspace-providers/${name}.js (personas with repo: use it)`));
      }
      if (parts?.miner) {
        // Symlink, not copy: the descriptor realpaths import.meta.url to
        // find sibling dist files in its package, and a symlink keeps a
        // linked dev repo's rebuilds live (same reason gui parts point at
        // the package dir). Replace any stale entry.
        const minersDir = fezHome("miners");
        fsSync.mkdirSync(minersDir, { recursive: true });
        const dest = path.join(minersDir, `${name}.js`);
        fsSync.rmSync(dest, { force: true });
        fsSync.symlinkSync(path.join(pkgDir, parts.miner), dest);
        console.log(chalk.green(`✓ miner part → ~/.fez/miners/${name}.js (the mining harness loads it)`));
      }

      // bins: symlink like install does. The executable realpaths
      // node_modules through the link, so external deps (fez-mine →
      // @fezchat/bittensor) resolve from the package's own node_modules.
      // A symlink also keeps a linked dev repo's rebuilds live.
      if (manifest.bin) {
        const binDir = fezHome("bin");
        fsSync.mkdirSync(binDir, { recursive: true });
        for (const [cmd, rel] of Object.entries(manifest.bin)) {
          const target = path.join(binDir, cmd);
          const source = path.join(pkgDir, rel);
          fsSync.rmSync(target, { force: true });
          fsSync.symlinkSync(source, target);
          fsSync.chmodSync(source, 0o755);
          console.log(chalk.green(`✓ bin → ~/.fez/bin/${cmd}`));
        }
        if (!(process.env.PATH ?? "").split(":").includes(fezHome("bin"))) {
          console.log(chalk.dim(`  (~/.fez/bin is not on your PATH — add it to call these by name)`));
        }
      }

      if (!entry) {
        console.log(chalk.green(`✓ linked ${name} (no headless part)`));
        return;
      }
      const ext = path.extname(entry) || ".js";
      const extensionsDir = fezHome("extensions");
      fsSync.mkdirSync(extensionsDir, { recursive: true });
      // Stage next to the destination (same dir, so the {"type":"module"}
      // marker applies), smoke-import, and only then replace the installed
      // bundle — a broken build must never clobber a working extension.
      const staged = path.join(extensionsDir, `.staged-${name}${ext}`);
      fsSync.copyFileSync(path.join(pkgDir, entry), staged);
      if (ext === ".js" || ext === ".mjs") {
        try {
          // Cache-buster: node caches modules by URL, so a watch rebuild
          // re-importing the same staged path would get the FIRST build
          // back and pass its smoke test on stale code.
          await import(`${pathToFileURL(staged).href}?t=${Date.now()}`);
        } catch (err) {
          fsSync.rmSync(staged, { force: true });
          console.error(chalk.red(`✗ built bundle fails to import — not installed: ${err instanceof Error ? err.message : err}`));
          if (fatal) process.exit(1);
          return;
        }
      }
      const dest = path.join(extensionsDir, `${name}${ext}`);
      fsSync.renameSync(staged, dest);
      console.log(chalk.green(`✓ linked ${name}${ext} (${(fsSync.statSync(dest).size / 1024).toFixed(1)}kb) → ~/.fez/extensions/`));
    };

    await copyBuiltParts(true);

    // ── --watch: stay resident, rebuild + re-copy on source changes.
    // The dev loop becomes save → restart the surface; without this it
    // was save → npm run build → fez link . → restart. No hot reload —
    // the running TUI/sentinel still loads extensions once at startup.
    if (options.watch) {
      const srcDir = fsSync.existsSync(path.join(pkgDir, "src")) ? path.join(pkgDir, "src") : pkgDir;
      console.log(chalk.dim(`\n👀 watching ${path.relative(process.cwd(), srcDir) || "."}/ — Ctrl-C to stop; restart the TUI/sentinel to pick changes up`));
      let timer: ReturnType<typeof setTimeout> | undefined;
      let running = false;
      fsSync.watch(srcDir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (running) return; // a save mid-rebuild is covered by the next event
          running = true;
          try {
            if (options.build !== false && manifest.scripts?.build) {
              execSync("npm run build", { cwd: pkgDir, stdio: "inherit" });
            }
            await copyBuiltParts(false);
          } catch (err) {
            console.error(chalk.red(`✗ rebuild failed: ${err instanceof Error ? err.message : err}`));
          } finally {
            running = false;
          }
        }, 300);
      });
      await new Promise(() => {}); // resident until Ctrl-C
    }
  });

program
  .command("pack")
  .description("Build this GUI extension: src/view.tsx → dist/view.js (and a hashed CSS module if present)")
  .action(async () => {
    const { packExtension } = await import("./pack.js");
    const out = await packExtension(process.cwd());
    console.log(`packed ${out.js}${out.css ? ` + ${out.css}` : ""}`);
  });

program
  .command("list")
  .description("List installed fez packages")
  .action(async () => {
    const pm = new PackageManager();
    await pm.init();
    const packages = pm.list();

    if (packages.length === 0) {
      console.log(chalk.yellow("No packages installed."));
      console.log(chalk.dim("Try: fez install claude-code"));
      return;
    }

    console.log(chalk.blue(`📦 Installed packages:\n`));
    for (const pkg of packages) {
      console.log(`  ${chalk.green(pkg.name)} ${chalk.dim(pkg.version)}`);
      console.log(`    Type: ${pkg.type}`);
      console.log(`    Source: ${pkg.source}`);
      console.log(`    Installed: ${new Date(pkg.installedAt).toLocaleDateString()}`);
      console.log();
    }
  });

program
  .command("remove <name>")
  .description("Remove an installed fez package")
  .action(async (name: string) => {
    const pm = new PackageManager();
    await pm.init();
    await pm.remove(name);
  });
}
