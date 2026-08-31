import { fezHomeAt } from "../shared/fez-home.js";
import { loadSettings, saveSettings } from "../shared/settings.js";
import { execSync } from "child_process";
import fs from "fs/promises";
import fsSync, { existsSync } from "fs";
import path from "path";
import os from "os";
import chalk from "chalk";
import { type SkillEntry, type SkillSpec } from "./skill-source.js";

/**
 * Where settings reads/writes go. Injectable so the install/remove/update
 * lifecycle is testable against an in-memory store instead of the real
 * ~/.fez/settings.json (which the module-level SETTINGS_FILE pins to the
 * real home).
 */
export interface SettingsStore {
  load(): Record<string, unknown>;
  save(patch: Record<string, unknown>): unknown;
}

export interface FezPackage {
  name: string;
  version: string;
  source: string; // npm:@fezchat/claude-code or git:github.com/user/repo
  type: "integration" | "agent" | "extension" | "persona-pack";
  installedAt: string;
  config?: Record<string, unknown>;
  /** persona-pack: the persona ids this pack installed (removed on uninstall). */
  installedPersonas?: string[];
}

export interface FezManifest {
  /** package.json's own name/description — used to record skill provenance. */
  name?: string;
  description?: string;
  /**
   * npm's own bin map. Honored on install: each entry is copied to
   * ~/.fez/bin, so an extension can ship executables (a git credential
   * helper, an adopt command) without being npm-installed globally.
   */
  bin?: Record<string, string>;
  fez: {
    type: "integration" | "agent" | "extension" | "persona-pack";
    /** What this package says it needs — see extension-permissions.ts. Recorded at install. */
    permissions?: string[];
    /**
     * Oldest fez this package works on (x.y.z) — checked at install and
     * link against FEZ_VERSION, refused loudly on an older host. Absent
     * means no claim: packages predating the field keep installing.
     */
    minFezVersion?: string;
    /**
     * External binaries this package shells out to — `["gh"]`, `["uvx"]`.
     *
     * Declared rather than discovered, so "needs gh" is data that can be
     * checked at install, at startup, and on a second machine — instead
     * of a warning line in a log nobody reads. The failure this prevents
     * is the quiet one: an extension that loads, registers, runs, and
     * silently does nothing because a tool isn't there.
     *
     * fez never installs these. It reports them.
     */
    requires?: string[];
    /**
     * Persona packs: a directory of persona .md files installed into
     * ~/.fez/personas as a team bundle. Every persona is VALIDATED before
     * anything installs (one bad file rejects the pack); `defaults` merge
     * under each persona's frontmatter, persona keys winning (Buzz's pack
     * merge policy) — a pack can pin `harness: pi` once instead of per file.
     */
    personas?: {
      dir?: string; // default "personas"
      defaults?: Record<string, string>;
    };
    /**
     * Skill packages: a directory of SKILL.md files, installed AS-IS into
     * this package's own dir (packages/<base>/<dir>/*.md) — never
     * ~/.fez/skills/ (no legacy flat dir, no symlink index). Discovery
     * reads them straight from there; see skills-md.ts.
     */
    skills?: {
      dir?: string; // default "skills"
    };
    // For integrations: config files to install
    integrations?: {
      claudeCode?: { commands?: string; evals?: string };
      pi?: { extensions?: string };
    };
    /** Multi-part packages: skill (MCP def → machine catalog), headless
     * (→ ~/.fez/extensions, all clients), gui (→ ~/.fez/gui-extensions,
     * fez-desktop). One install, three attachment points. */
    parts?: {
      skill?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
      headless?: string;
      gui?: string;
      /** → ~/.fez/relay-extensions; loaded only by a relay started with --extensions */
      relay?: string;
      /** → ~/.fez/workspace-providers; gives a `repo:` persona a checkout to work in */
      workspace?: string;
      /** opt in to running scheduled tasks inside the always-on sentinel */
      background?: boolean;
    };
    // For agents: entry point
    agent?: {
      entry: string;
      supportedTasks: string[];
    };
    // For extensions: entry file copied to ~/.fez/extensions/<name>.ts,
    // loaded by loadExtensions() (extensions.ts) same as a hand-written one.
    // Same shape as integrations.pi.extensions below — one file, one
    // destination — deliberately not a list: a package wanting multiple
    // entry points can just have its one entry file import the rest.
    extension?: {
      entry?: string;
    };
  };
}

/**
 * Fez Package Manager.
 *
 * Install packages from npm or git, track them, and manage integrations.
 *
 * ```bash
 * fez install claude-code
 * fez install npm:@fezchat/ditto
 * fez install git:github.com/user/my-agent
 * fez list
 * fez remove claude-code
 * ```
 */
/**
 * The ONE name an npm package goes by everywhere: registry key, install
 * dir under ~/.fez/packages/npm, extension filename. Store-scope packages
 * lose the scope (`@fezchat/loom` → `loom`, matching the `fez install
 * loom` shorthand); foreign scopes keep theirs as a prefix so `@acme/x`
 * can't collide with `@fezchat/x`. Never contains a path separator.
 * Exported so tests can pin it — three sites deriving this independently
 * is exactly the bug that made scoped installs silently skip every hook.
 */
export function npmPackageName(source: string): string {
  const pkg = source.replace(/^npm:/, "");
  if (pkg.startsWith("@fezchat/")) return pkg.slice("@fezchat/".length);
  if (pkg.startsWith("@")) return pkg.slice(1).replace("/", "-");
  return pkg;
}

/**
 * A manifest's skill part speaks in package-relative paths ("dist/mcp.js")
 * because a package can't know where it will land; settings.json speaks to
 * a spawner that carries no cwd. Bridge at write time: any arg that names
 * an existing file inside the package resolves to its absolute path; flags
 * and non-file values pass through untouched. Found live: fez-wallet's
 * skill was uncallable by every agent — `node dist/mcp.js` from nowhere.
 * Shared with `fez link`, which writes the same entry from the source dir.
 */
export function resolveSkillArgs<T extends { args?: string[] }>(skill: T, pkgDir: string): T {
  if (!skill.args?.length) return skill;
  const root = path.resolve(pkgDir);
  const args = skill.args.map((arg) => {
    if (path.isAbsolute(arg)) return arg;
    const abs = path.resolve(root, arg);
    return abs.startsWith(root + path.sep) && existsSync(abs) ? abs : arg;
  });
  return { ...skill, args };
}

/**
 * The one place that decides what an install writes into
 * settings.json's mcpServers. Provenance is what makes a persona
 * portable: `package` is the canonical id (identical on every machine
 * however the package arrived), `source` is the spec that refetches it,
 * `description` is what a picker renders.
 *
 * Every field is omitted rather than written empty — a hand-rolled
 * skill's entry must stay exactly as small as it was.
 */
export function skillEntryFor(
  spec: SkillSpec & { env?: Record<string, string> },
  opts: { manifestName?: string; description?: string; source?: string }
): SkillEntry {
  return {
    ...spec,
    ...(opts.manifestName ? { package: opts.manifestName } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };
}

export class PackageManager {
  private packages: Map<string, FezPackage> = new Map();
  /** Undefined = the real home; tests inject a temp dir (fezHomeAt seam). */
  private readonly base?: string;
  private readonly settings: SettingsStore;
  private readonly npmDir: string;
  private readonly gitDir: string;
  private readonly registryFile: string;

  constructor(opts: { base?: string; settings?: SettingsStore } = {}) {
    this.base = opts.base;
    this.settings = opts.settings ?? { load: () => loadSettings() as Record<string, unknown>, save: (p) => saveSettings(p as never) };
    this.npmDir = this.home("packages", "npm");
    this.gitDir = this.home("packages", "git");
    this.registryFile = this.home("registry.json");
  }

  /** ~/.fez/<segments> under the (possibly injected) home. */
  private home(...segments: string[]): string {
    return fezHomeAt(this.base, ...segments);
  }

  /**
   * The package's canonical home: ~/.fez/packages/<base> (de-scoped —
   * `@fezchat/tidy` → `tidy`). This is separate from the npm/git
   * source-fetch dirs (getInstallDir/getContentDir) which stay put; this
   * is where the REAL files an install writes end up living, with the
   * flat dirs (extensions, bin, ...) becoming a symlink index into it.
   */
  packageDir(base: string): string {
    return this.home("packages", base);
  }

  /**
   * The package that owns a flat-dir entry (bin, extensions, ...), or
   * undefined if nobody does. Ownership is structural, never by name: a
   * symlink whose realpath resolves under packages/<name>/ is owned by
   * <name>; a regular file (the pre-package-dir layout, or a filesystem
   * that fell back to a copy) is legacy and owned by nobody, and neither
   * is a symlink that resolves somewhere else entirely. This is what lets
   * install refuse a collision and remove touch only its own — a second
   * package shipping the same command name can never overwrite or delete
   * the first's silently.
   */
  binOwner(binPath: string): string | undefined {
    let st: fsSync.Stats;
    try {
      st = fsSync.lstatSync(binPath);
    } catch {
      return undefined;
    }
    if (!st.isSymbolicLink()) return undefined;
    let real: string;
    let realPackagesDir: string;
    try {
      // Both sides realpath'd: on macOS /var is itself a symlink to
      // /private/var, so os.tmpdir()-rooted fixtures resolve their bin
      // symlink to /private/var/... while the un-realpath'd packages dir
      // still reads /var/... — a prefix check across that mismatch always
      // misses, silently treating every package as unowned.
      real = fsSync.realpathSync(binPath);
      realPackagesDir = fsSync.realpathSync(this.home("packages"));
    } catch {
      return undefined;
    }
    const packagesPrefix = realPackagesDir + path.sep;
    if (!real.startsWith(packagesPrefix)) return undefined;
    return real.slice(packagesPrefix.length).split(path.sep)[0];
  }

  /**
   * The manifest a package was installed with, read back verbatim from
   * packages/<base>/package.json — the package dir's own record, never
   * settings. Undefined when there's no package dir: a package whose
   * manifest had no `fez` key (writePackageManifest never ran), or one
   * installed before Task 1-2 and not yet migrated (Task 7).
   */
  installedManifest(base: string): (FezManifest & { name: string; version: string }) | undefined {
    try {
      const content = fsSync.readFileSync(path.join(this.packageDir(base), "package.json"), "utf-8");
      return JSON.parse(content) as FezManifest & { name: string; version: string };
    } catch {
      return undefined;
    }
  }

  /** The load index: a flat entry pointing into the package dir. Symlink
   *  first; copy when the filesystem refuses — the package dir stays the
   *  record either way. */
  private linkIndex(target: string, linkPath: string): void {
    fsSync.mkdirSync(path.dirname(linkPath), { recursive: true });
    fsSync.rmSync(linkPath, { force: true });
    try {
      fsSync.symlinkSync(target, linkPath);
    } catch {
      fsSync.copyFileSync(target, linkPath);
    }
  }

  async init(): Promise<void> {
    await fs.mkdir(this.npmDir, { recursive: true });
    await fs.mkdir(this.gitDir, { recursive: true });
    await this.loadRegistry();
  }

  /**
   * Install a package.
   *
   * Resolves shorthand names to npm packages automatically:
   * - `claude-code` → `npm:@fezchat/claude-code`
   * - `pi` → `npm:@fezchat/pi`
   * - `ditto` → `npm:@fezchat/ditto`
   * - `npm:@foo/bar` → exact npm package
   * - `git:github.com/user/repo` → git clone
   */
  async install(source: string, options: { version?: string } = {}): Promise<FezPackage> {
    const resolved = this.resolveSource(source);
    const name = this.extractName(resolved);

    // Check if already installed
    if (this.packages.has(name)) {
      console.log(chalk.yellow(`⚠️  ${name} is already installed. Use 'fez update ${name}' to update.`));
      return this.packages.get(name)!;
    }

    console.log(chalk.blue(`📦 Installing ${name} from ${resolved}...`));

    if (resolved.startsWith("npm:")) {
      await this.installNpm(resolved, options.version);
    } else if (resolved.startsWith("git:")) {
      await this.installGit(resolved);
    } else {
      throw new Error(`Unknown source format: ${resolved}. Use npm: or git:`);
    }

    // Register BEFORE the hooks run — readManifest and every install hook
    // resolve paths through this.packages.get(name). (The old order made
    // readManifest return null on first install: hooks were dead code.)
    const pkg: FezPackage = {
      name,
      version: options.version || "latest",
      source: resolved,
      type: "extension",
      installedAt: new Date().toISOString(),
    };
    this.packages.set(name, pkg);

    const manifest = await this.readManifest(name);
    pkg.type = manifest?.fez?.type || "extension";
    pkg.config = manifest?.fez;
    try {
      // Compat gate BEFORE any hook copies a part into ~/.fez — a
      // package built for a newer fez must fail here, naming versions,
      // not load and die on a missing API method mid-task.
      const { minFezVersionError } = await import("./host-compat.js");
      const compatError = minFezVersionError(manifest?.fez?.minFezVersion);
      if (compatError) throw new Error(`${name} ${compatError}`);
      await this.runInstallHook(name, manifest);
    } catch (err) {
      this.packages.delete(name); // failed install leaves no registry ghost
      throw err;
    }
    await this.recordPermissions(name, manifest);
    await this.saveRegistry();

    console.log(chalk.green(`✅ Installed ${name}`));
    return pkg;
  }

  /**
   * Update an installed package in place: refetch the source, re-run the
   * install hooks (part copies overwrite), re-record permissions. npm
   * installs get a clean fetch — the shim dir's lockfile would otherwise
   * pin the old version forever.
   */
  async update(name: string, options: { version?: string } = {}): Promise<FezPackage | undefined> {
    const pkg = this.packages.get(name);
    if (!pkg) {
      console.log(chalk.yellow(`⚠️  ${name} is not installed. Use 'fez install ${name}' first.`));
      return undefined;
    }

    console.log(chalk.blue(`🔄 Updating ${name} from ${pkg.source}...`));

    if (pkg.source.startsWith("npm:")) {
      await fs.rm(this.getInstallDir(pkg), { recursive: true, force: true });
      await this.installNpm(pkg.source, options.version);
    } else {
      await this.installGit(pkg.source);
    }

    const manifest = await this.readManifest(name);
    pkg.version = options.version || "latest";
    pkg.type = manifest?.fez?.type || "extension";
    pkg.config = manifest?.fez;
    await this.runInstallHook(name, manifest);
    await this.recordPermissions(name, manifest);
    await this.saveRegistry();

    console.log(chalk.green(`✅ Updated ${name}`));
    return pkg;
  }

  /**
   * Record the declared grant — parity with `fez link`, which has always
   * done this. Before, a CLI-installed package fell back to the legacy
   * read-only grant regardless of what it declared, so the same package
   * got MORE capability linked than installed.
   */
  private async recordPermissions(name: string, manifest: FezManifest | null): Promise<void> {
    if (!manifest?.fez) return;
    const { parsePermissions } = await import("./extension-permissions.js");
    const { granted } = parsePermissions(manifest.fez.permissions);
    const settings = this.settings.load() as { extensionPermissions?: Record<string, string[]> };
    this.settings.save({ extensionPermissions: { ...settings.extensionPermissions, [name]: granted } });
  }

  /**
   * Remove an installed package.
   */
  async remove(name: string): Promise<void> {
    const pkg = this.packages.get(name);
    if (!pkg) {
      console.log(chalk.yellow(`⚠️  ${name} is not installed.`));
      return;
    }

    console.log(chalk.blue(`🗑️  Removing ${name}...`));

    // Run uninstall hook if present
    await this.runUninstallHook(pkg);

    // Remove files
    const installDir = this.getInstallDir(pkg);
    await fs.rm(installDir, { recursive: true, force: true });

    // The storage seam's cleanup promise: the extension's state
    // namespace dies with the package.
    const { removeStorage } = await import("./extension-storage.js");
    await removeStorage(name);

    this.packages.delete(name);
    await this.saveRegistry();

    console.log(chalk.green(`✅ Removed ${name}`));
  }

  /**
   * List installed packages.
   */
  list(): FezPackage[] {
    return Array.from(this.packages.values());
  }

  /**
   * Get a specific installed package.
   */
  get(name: string): FezPackage | undefined {
    return this.packages.get(name);
  }

  // ─── Private ───────────────────────────────────────────────────────────

  private resolveSource(source: string): string {
    // Already fully qualified
    if (source.startsWith("npm:") || source.startsWith("git:")) {
      return source;
    }

    // Shorthand: resolve to @fez namespace
    const shorthandMap: Record<string, string> = {
      "claude-code": "npm:@fezchat/claude-code",
      "claude": "npm:@fezchat/claude-code",
      "pi": "npm:@fezchat/pi",
      "ditto": "npm:@fezchat/ditto",
      "hindsight": "npm:@fezchat/hindsight",
      "echo": "npm:@fezchat/echo",
    };

    if (shorthandMap[source]) {
      return shorthandMap[source];
    }

    // An already-scoped name (@fezchat/git, @acme/thing) is a plain npm
    // package — DON'T re-scope it. `fez install @fezchat/kanban` was
    // becoming npm:@fezchat/@fezchat/kanban and 404ing; both the bare shorthand
    // (`kanban`) and the full scoped name must resolve to the same
    // package.
    if (source.startsWith("@")) {
      return `npm:${source}`;
    }

    // A bare name is fez-shorthand for the @fez scope.
    return `npm:@fezchat/${source}`;
  }

  private extractName(source: string): string {
    if (source.startsWith("npm:")) {
      return npmPackageName(source);
    }
    if (source.startsWith("git:")) {
      const url = source.replace("git:", "");
      return path.basename(url, ".git");
    }
    return source;
  }

  private async installNpm(source: string, version?: string): Promise<void> {
    const pkgName = source.replace("npm:", "");
    const _target = version ? `${pkgName}@${version}` : pkgName;
    const installPath = path.join(this.npmDir, npmPackageName(source));

    await fs.mkdir(installPath, { recursive: true });

    // Create a minimal package.json and npm install
    await fs.writeFile(
      path.join(installPath, "package.json"),
      JSON.stringify({ name: "fez-temp", dependencies: { [pkgName]: version || "latest" } }),
      "utf-8"
    );

    execSync(`npm install --omit=dev`, { cwd: installPath, stdio: "inherit" });
  }

  private async installGit(source: string): Promise<void> {
    const url = source.replace("git:", "");
    const name = this.extractName(source);
    const installPath = path.join(this.gitDir, name);

    await fs.mkdir(this.gitDir, { recursive: true });

    if (await this.pathExists(installPath)) {
      // Pull latest
      execSync("git pull", { cwd: installPath, stdio: "inherit" });
    } else {
      execSync(`git clone ${url} ${installPath}`, { stdio: "inherit" });
    }

    // Install deps if package.json exists
    const pkgJsonPath = path.join(installPath, "package.json");
    if (await this.pathExists(pkgJsonPath)) {
      execSync("npm install --omit=dev", { cwd: installPath, stdio: "inherit" });
    }
  }

  private async readManifest(name: string): Promise<FezManifest | null> {
    const pkg = this.packages.get(name);
    if (!pkg) return null;

    const manifestPath = path.join(this.getContentDir(pkg), "package.json");

    try {
      const content = await fs.readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(content);
      return parsed as FezManifest;
    } catch {
      return null;
    }
  }

  private async runInstallHook(name: string, manifest: FezManifest | null): Promise<void> {
    if (!manifest || !manifest.fez) return;

    // Bin-collision check FIRST, before the package dir even exists —
    // installParts can persist a settings write on its own (parts.background:
    // true adds to backgroundExtensions), and writePackageManifest below
    // creates packages/<name>/package.json. Checking this any later let a
    // manifest combining a colliding bin name with those write settings or
    // a phantom package dir and THEN throw, leaving a half-finished trace
    // behind the refusal — installedManifest() reported it "installed"
    // while the registry never recorded it.
    if (manifest.bin) {
      const binDir = this.home("bin");
      for (const cmd of Object.keys(manifest.bin)) {
        const owner = this.binOwner(path.join(binDir, cmd));
        if (owner && owner !== name) {
          throw new Error(`bin "${cmd}" is already installed by ${owner} — refusing`);
        }
      }
    }

    // The package dir is the source of truth from here on: the manifest
    // as installed, verbatim, before anything else touches it.
    await this.writePackageManifest(name, manifest);

    const pkg = this.packages.get(name);
    const integrations = manifest.fez.integrations;

    // Claude Code integration
    if (integrations?.claudeCode) {
      await this.installClaudeCodeIntegration(name, integrations.claudeCode);
    }

    // pi integration
    if (integrations?.pi) {
      await this.installPiIntegration(name, integrations.pi);
    }

    // Fez's own extension dir — registerHarness/registerMcpServer/ui hooks
    if (manifest.fez.extension) {
      await this.installFezExtension(name, manifest.fez.extension);
    }

    // Multi-part package: skill + headless + gui from one install
    if (manifest.fez.parts) {
      await this.installParts(name, manifest.fez.parts, {
        manifestName: manifest.name,
        description: manifest.description,
        // pkg.source is the resolved spec — "npm:@fezchat/wallet". A git
        // install has no runner scheme, so it records no source and
        // resolves by package alone.
        source: pkg?.source?.startsWith("npm:") ? pkg.source : undefined,
      });
    }
    if (manifest.bin) {
      await this.installBins(name, manifest.bin);
    }

    // Persona pack — a team bundle of persona .md files
    if (manifest.fez.personas) {
      await this.installPersonaPack(name, manifest.fez.personas);
    }

    // Skill package — SKILL.md files, into this package's own dir
    if (manifest.fez.skills) {
      await this.installSkillsPart(name, manifest.fez.skills);
    }

    // Agent registration
    if (manifest.fez.agent) {
      console.log(chalk.blue(`🤖 Registering agent: ${manifest.fez.agent.entry}`));
      // Could add to a local agent registry
    }
  }

  private async runUninstallHook(pkg: FezPackage): Promise<void> {
    // Prefer the package dir's own manifest — the record of what THIS
    // install actually did — over readManifest's source-fetch copy, which
    // can be stale or already gone.
    const installed = this.installedManifest(pkg.name);
    const manifest = installed ?? (await this.readManifest(pkg.name));

    const integrations = manifest?.fez?.integrations;

    if (integrations?.claudeCode) {
      await this.removeClaudeCodeIntegration(pkg.name);
    }
    if (integrations?.pi) {
      await this.removePiIntegration(pkg.name);
    }

    if (installed) {
      // The package dir is the source of truth: delete exactly the index
      // entries ITS manifest named, each only if this package still owns
      // it (binOwner's symlink-into-own-dir rule), then drop the package
      // dir itself last.
      await this.removeOwnedIndexEntries(pkg.name, installed);
      await this.removeSettingsEntries(pkg.name);
      await fs.rm(this.packageDir(pkg.name), { recursive: true, force: true });
    } else {
      // No package dir: this install predates the packages/<name>/ +
      // symlink-index layout (Tasks 1-2) and hasn't been migrated onto it
      // yet. Fall back to the old name-guess sweep — retire this branch
      // once Task 7's migration has run against every existing install.
      await this.removeParts(pkg.name, manifest);
    }

    if (pkg.installedPersonas?.length) {
      const personasDir = this.home("personas");
      for (const id of pkg.installedPersonas) {
        await fs.rm(path.join(personasDir, `${id}.md`), { force: true });
        console.log(chalk.dim(`   Removed persona ${id}`));
      }
    }
  }

  /**
   * Delete exactly the flat-dir entries THIS package's own manifest named
   * — never guessed from its name alone — each only if the package still
   * owns it. binOwner's ownership rule (symlink whose realpath resolves
   * into packages/<name>/) isn't really bin-specific, so it doubles as
   * the check for every index dir, not just bin/.
   */
  private async removeOwnedIndexEntries(name: string, manifest: FezManifest): Promise<void> {
    const parts = manifest.fez?.parts;
    // installFezExtension writes extensions/<name><ext of its entry>, and
    // that entry is either the legacy top-level `extension.entry` or
    // `parts.headless` — same destination either way.
    const headlessEntry = manifest.fez?.extension?.entry ?? parts?.headless;
    if (headlessEntry) {
      const ext = path.extname(headlessEntry) || ".js";
      await this.removeIfOwned(name, this.home("extensions", `${name}${ext}`));
    }
    if (parts?.gui) await this.removeIfOwned(name, this.home("gui-extensions", `${name}.js`));
    if (parts?.relay) await this.removeIfOwned(name, this.home("relay-extensions", `${name}.js`));
    if (parts?.workspace) await this.removeIfOwned(name, this.home("workspace-providers", `${name}.js`));
    for (const cmd of Object.keys(manifest.bin ?? {})) {
      await this.removeIfOwned(name, this.home("bin", cmd));
    }
  }

  /** Delete an index entry iff this package still owns it; a foreign or
   *  already-absent entry is left alone. */
  private async removeIfOwned(name: string, entryPath: string): Promise<void> {
    if (this.binOwner(entryPath) === name) {
      await fs.rm(entryPath, { force: true });
    }
  }

  /**
   * The settings-side of remove: drop the backgroundExtensions membership
   * and the recorded permission grant. The mcpServers skill entry is
   * deliberately left — the user may have filled env values, and a
   * persona may still declare it.
   */
  private async removeSettingsEntries(name: string): Promise<void> {
    const settings = this.settings.load() as {
      backgroundExtensions?: string[];
      extensionPermissions?: Record<string, string[]>;
    };
    if (settings.backgroundExtensions?.includes(name)) {
      this.settings.save({ backgroundExtensions: settings.backgroundExtensions.filter((n) => n !== name) });
    }
    if (settings.extensionPermissions && name in settings.extensionPermissions) {
      const { [name]: _dropped, ...rest } = settings.extensionPermissions;
      this.settings.save({ extensionPermissions: rest });
    }
  }

  /**
   * Install a pack's personas into ~/.fez/personas. All-or-nothing on
   * validation: one broken persona rejects the pack (a half-installed
   * team is worse than none). Existing personas are never overwritten —
   * a collision skips that file loudly (hand-written personas outrank
   * pack contents). Installed ids are tracked for clean uninstall.
   */
  private async installPersonaPack(name: string, config: { dir?: string; defaults?: Record<string, string> }): Promise<void> {
    const { validatePersonaFile, mergeDefaults } = await import("../identity/personas.js");
    const { listHarnesses } = await import("../agent/harness.js");
    const pkgDir = this.getContentDir(this.packages.get(name)!);
    const sourceDir = path.resolve(pkgDir, config.dir ?? "personas");
    if (!sourceDir.startsWith(path.resolve(pkgDir))) {
      throw new Error(`persona dir escapes the package (path traversal): ${config.dir}`);
    }
    let files: string[];
    try {
      files = (await fs.readdir(sourceDir)).filter((f) => f.endsWith(".md"));
    } catch {
      throw new Error(`persona pack "${name}" has no ${config.dir ?? "personas"}/ directory`);
    }
    if (files.length === 0) throw new Error(`persona pack "${name}" contains no persona .md files`);

    const knownHarnesses = listHarnesses().map((h) => h.id);
    const prepared: { id: string; content: string }[] = [];
    let anyErrors = false;
    for (const file of files) {
      const id = path.basename(file, ".md").toLowerCase();
      const raw = await fs.readFile(path.join(sourceDir, file), "utf-8");
      const merged = config.defaults ? mergeDefaults(raw, config.defaults) : raw;
      const { errors, warnings } = validatePersonaFile(merged, id, knownHarnesses.length ? knownHarnesses : undefined);
      for (const warning of warnings) console.log(chalk.yellow(`   ⚠ ${id}: ${warning}`));
      for (const error of errors) {
        console.error(chalk.red(`   ✗ ${id}: ${error}`));
        anyErrors = true;
      }
      prepared.push({ id, content: merged });
    }
    if (anyErrors) throw new Error(`persona pack "${name}" failed validation — nothing installed`);

    const personasDir = this.home("personas");
    await fs.mkdir(personasDir, { recursive: true });
    const installed: string[] = [];
    for (const { id, content } of prepared) {
      const dest = path.join(personasDir, `${id}.md`);
      if (await this.pathExists(dest)) {
        console.log(chalk.yellow(`   ⚠ persona "${id}" already exists — kept yours, pack copy skipped`));
        continue;
      }
      await fs.writeFile(dest, content, "utf-8");
      installed.push(id);
      console.log(chalk.dim(`   Installed persona ${id}`));
    }
    // Union with any prior install (update re-runs this hook and skips
    // existing files — forgetting the originals would orphan them at uninstall).
    const prior = this.packages.get(name)!.installedPersonas ?? [];
    this.packages.get(name)!.installedPersonas = [...new Set([...prior, ...installed])];
    console.log(chalk.green(`   👥 ${installed.length} persona(s) from pack "${name}" — fez agent <name> to run one`));
  }

  /**
   * Install a package's SKILL.md files into ITS OWN package dir —
   * `<dir>/*.md` copied straight across via `materializeIntoPackage` (the
   * path-escape gate included), never ~/.fez/personas or a legacy
   * ~/.fez/skills/ flat dir. Discovery (skills-md.ts) reads them from
   * there directly, so materializing the dir is the whole install — no
   * settings write, no symlink index, no frontmatter validation here
   * (skillsInstalled skips a file missing `description:` at read time).
   * A package declaring `fez.skills` with no matching dir in its source
   * is a manifest bug, not a user-facing failure — warn and move on.
   */
  private async installSkillsPart(name: string, config: { dir?: string }): Promise<void> {
    const dir = config.dir ?? "skills";
    const pkgDir = this.getContentDir(this.packages.get(name)!);
    const sourceDir = path.resolve(pkgDir, dir);
    let files: string[];
    try {
      files = (await fs.readdir(sourceDir)).filter((f) => f.endsWith(".md"));
    } catch {
      console.log(chalk.yellow(`   ⚠ skill package "${name}" has no ${dir}/ directory — nothing installed`));
      return;
    }
    for (const file of files) {
      const dest = await this.materializeIntoPackage(name, path.join(dir, file), "skill");
      console.log(chalk.dim(`   Installed skill ${path.basename(file, ".md")} → ${dest}`));
    }
    console.log(chalk.green(`   📄 ${files.length} skill(s) from "${name}"`));
  }

  private async installClaudeCodeIntegration(name: string, config: { commands?: string; evals?: string }): Promise<void> {
    const home = os.homedir();
    const claudeDir = path.join(home, ".claude");
    const commandsDir = path.join(claudeDir, "commands");
    const evalsDir = path.join(claudeDir, "evals");

    await fs.mkdir(commandsDir, { recursive: true });
    await fs.mkdir(evalsDir, { recursive: true });

    const pkgDir = this.getContentDir(this.packages.get(name)!);

    if (config.commands) {
      const src = path.join(pkgDir, config.commands);
      const dest = path.join(commandsDir, `${name}.md`);
      await fs.copyFile(src, dest);
      console.log(chalk.dim(`   Created ~/.claude/commands/${name}.md`));
    }

    if (config.evals) {
      const src = path.join(pkgDir, config.evals);
      const dest = path.join(evalsDir, `${name}.md`);
      await fs.copyFile(src, dest);
      console.log(chalk.dim(`   Created ~/.claude/evals/${name}.md`));
    }
  }

  private async removeClaudeCodeIntegration(name: string): Promise<void> {
    const home = os.homedir();
    const claudeDir = path.join(home, ".claude");

    await fs.rm(path.join(claudeDir, "commands", `${name}.md`), { force: true });
    await fs.rm(path.join(claudeDir, "evals", `${name}.md`), { force: true });
  }

  private async installPiIntegration(name: string, config: { extensions?: string }): Promise<void> {
    const home = os.homedir();
    const piDir = path.join(home, ".pi", "agent", "extensions");
    await fs.mkdir(piDir, { recursive: true });

    const pkgDir = this.getContentDir(this.packages.get(name)!);

    if (config.extensions) {
      const src = path.join(pkgDir, config.extensions);
      const dest = path.join(piDir, `${name}.ts`);
      await fs.copyFile(src, dest);
      console.log(chalk.dim(`   Created ~/.pi/agent/extensions/${name}.ts`));
    }
  }

  private async removePiIntegration(name: string): Promise<void> {
    const home = os.homedir();
    await fs.rm(path.join(home, ".pi", "agent", "extensions", `${name}.ts`), { force: true });
  }

  private async installFezExtension(name: string, config: { entry?: string }): Promise<void> {
    const extensionsDir = this.home("extensions");
    await fs.mkdir(extensionsDir, { recursive: true });

    if (config.entry) {
      // Preserve the entry's real extension — a bundled package ships a .js
      // entry that plain `node` can import; renaming it .ts would misstate
      // what it is (loadExtensions accepts .ts/.js/.mjs either way).
      const ext = path.extname(config.entry) || ".js";
      const dest = await this.materializeIntoPackage(name, config.entry);
      const linkPath = path.join(extensionsDir, `${name}${ext}`);
      this.linkIndex(dest, linkPath);
      console.log(chalk.dim(`   Created ~/.fez/extensions/${name}${ext}`));
    }
  }

  /**
   * A package's executables, into ~/.fez/bin.
   *
   * npm's own vocabulary ("bin" in the manifest), not a fez invention —
   * an extension that ships a credential helper or a CLI declares it
   * exactly as it would for npm, and installing through fez puts it in
   * one predictable place. ~/.fez/bin is not assumed to be on PATH;
   * anything that NEEDS an executable resolves it absolutely (git
   * helpers are configured by absolute path, siblings are found beside
   * the caller), and the PATH hint is printed once rather than silently
   * required.
   */
  private async installBins(name: string, bin: Record<string, string>): Promise<void> {
    const pkg = this.packages.get(name);
    if (!pkg) return;
    const binDir = this.home("bin");
    await fs.mkdir(binDir, { recursive: true });
    // The collision check already ran at the top of runInstallHook,
    // before any part install or settings write — this loop only writes.
    for (const [cmd, rel] of Object.entries(bin)) {
      // Preserve the manifest's own relative path in the package dir, and
      // ALWAYS also land a canonical packages/<base>/bin/<cmd> copy there
      // — named after the COMMAND, never the source's own basename — one
      // predictable spot to chmod and to symlink from, whatever the
      // package called its source file (mirrors the Rust installer,
      // package_install.rs, which never special-cases a source already
      // living under bin/).
      const dest = await this.materializeIntoPackage(name, rel);
      const canonical = path.join(this.packageDir(name), "bin", cmd);
      if (dest !== canonical) await this.copyFileEnsuringDir(dest, canonical);
      await fs.chmod(canonical, 0o755); // chmod the PACKAGE file — the symlink inherits
      this.linkIndex(canonical, path.join(binDir, cmd));
      console.log(chalk.dim(`   Installed ~/.fez/bin/${cmd}`));
    }
    if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
      console.log(chalk.dim(`   (~/.fez/bin is not on your PATH — add it to call these by name)`));
    }
  }

  private async installParts(
    name: string,
    parts: {
      skill?: { command?: string; args?: string[]; env?: Record<string, string>; url?: string };
      headless?: string;
      gui?: string;
      /** Code that runs INSIDE a relay — see packages/fez-relay/src/extensions.ts. */
      relay?: string;
      workspace?: string;
      background?: boolean;
    },
    provenance: { manifestName?: string; description?: string; source?: string } = {}
  ): Promise<void> {
    if (parts.headless) {
      await this.installFezExtension(name, { entry: parts.headless });
    }
    if (parts.gui) {
      // Materialize only — no flat symlink. The webview's loader reads
      // packages/<name>/dist/gui.js straight from the manifest, so
      // gui-extensions/<name>.js is dead weight nothing loads through.
      const dest = await this.materializeIntoPackage(name, parts.gui);
      console.log(chalk.dim(`   Created ${dest}`));
    }
    if (parts.relay) {
      // A fourth place, same shape as the others. It only does anything
      // on a machine that RUNS a relay, and only when that relay is
      // started with --extensions: this is code inside the process
      // holding everyone's events, so installing it and enabling it are
      // deliberately two acts.
      const relayDir = this.home("relay-extensions");
      await fs.mkdir(relayDir, { recursive: true });
      const dest = await this.materializeIntoPackage(name, parts.relay);
      this.linkIndex(dest, path.join(relayDir, `${name}.js`));
      console.log(chalk.dim(`   Created ~/.fez/relay-extensions/${name}.js`));
      console.log(chalk.dim("   Start the relay with --extensions to load it."));
    }
    if (parts.workspace) {
      // A fifth place. This one answers "where does an agent's turn
      // actually run" for a persona that names a `repo:` — it hands back
      // a checkout instead of a scratch folder.
      //
      // It lives beside the AGENT rather than in ~/.fez/extensions
      // because `fez agent <persona>` is launched by hand as often as by
      // the sentinel, and only the sentinel loads extensions. A provider
      // that worked for a fleet and silently not for a person running
      // one agent would be the worst kind of half-working.
      const wsDir = this.home("workspace-providers");
      await fs.mkdir(wsDir, { recursive: true });
      const dest = await this.materializeIntoPackage(name, parts.workspace);
      this.linkIndex(dest, path.join(wsDir, `${name}.js`));
      console.log(chalk.dim(`   Created ~/.fez/workspace-providers/${name}.js`));
      console.log(chalk.dim("   Personas can now set `repo:` to work from a checkout."));
    }
    if (parts.background) {
      const settings = this.settings.load() as { backgroundExtensions?: string[] };
      const list = new Set(settings.backgroundExtensions ?? []);
      list.add(name);
      this.settings.save({ backgroundExtensions: [...list] });
      console.log(chalk.dim(`   Background tasks enabled (restart the sentinel to run them)`));
    }
    if (parts.skill) {
      const settings = this.settings.load() as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      // keep env VALUES the user already filled in; the package supplies names
      const mergedEnv = { ...(parts.skill.env ?? {}), ...(settings.mcpServers?.[name]?.env ?? {}) };
      const skill = await this.materializeSkillArgs(name, parts.skill);
      this.settings.save({
        mcpServers: {
          ...settings.mcpServers,
          [name]: skillEntryFor(
            { ...skill, ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) },
            provenance
          ),
        },
      });
      console.log(chalk.dim(`   Defined tool "${name}" in ~/.fez/settings.json`));
    }
  }

  /**
   * LEGACY FALLBACK — only reached when a package has no packages/<name>/
   * dir (an install that predates Tasks 1-2, not yet migrated). Guesses
   * every location from the name/extension convention instead of reading
   * what the manifest actually declared, the mirror of installParts +
   * installBins + installFezExtension. This was dead code once (defined,
   * called from nowhere), which meant `fez remove` left gui/relay/
   * workspace parts and bins behind while the desktop's uninstall cleaned
   * them; the two paths must stay equivalent. Retire this branch once
   * Task 7's migration has run against every existing install.
   */
  private async removeParts(name: string, manifest: FezManifest | null): Promise<void> {
    await this.removeFezExtension(name); // headless part / legacy extension entry
    await fs.rm(this.home("gui-extensions", `${name}.js`), { force: true });
    await fs.rm(this.home("relay-extensions", `${name}.js`), { force: true });
    await fs.rm(this.home("workspace-providers", `${name}.js`), { force: true });
    for (const cmd of Object.keys(manifest?.bin ?? {})) {
      const binPath = this.home("bin", cmd);
      // Only delete a bin this package still owns — another package may
      // have taken the name since (refused by installBins going forward,
      // but pre-existing installs predate that check), and a hand-planted
      // or foreign symlink is never this package's to remove.
      if (this.binOwner(binPath) === name) {
        await fs.rm(binPath, { force: true });
      }
    }
    await this.removeSettingsEntries(name);
    // the skill definition stays: the user may have filled env values and
    // personas may still declare it — removing it silently would break them
  }

  private async removeFezExtension(name: string): Promise<void> {
    for (const ext of [".ts", ".js", ".mjs"]) {
      await fs.rm(this.home("extensions", `${name}${ext}`), { force: true });
    }
  }

  /** Write the manifest as installed, verbatim, to packages/<base>/package.json. */
  private async writePackageManifest(name: string, manifest: FezManifest): Promise<void> {
    const dir = this.packageDir(name);
    await fs.mkdir(dir, { recursive: true });
    await this.writeAtomic(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  }

  /**
   * Write `data` to `path` so a reader only ever observes a complete file,
   * never a torn one — mirrors Rust's `write_atomic` in package_install.rs.
   * package.json's mere existence is what installedManifest()/the desktop
   * migration treat as "this package is installed"; a same-directory
   * `.tmp` sibling + rename keeps that observation atomic (and on one
   * filesystem, so the rename itself is atomic).
   */
  private async writeAtomic(filePath: string, data: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, data, "utf-8");
    await fs.rename(tmp, filePath);
  }

  /** Plain copy, creating the destination's parent dirs as needed. */
  private async copyFileEnsuringDir(src: string, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }

  /**
   * Copy a manifest-relative file (e.g. "dist/gui.js") from the fetched
   * source into the package dir, preserving that relative path. Returns
   * the absolute destination — the flat dirs symlink to this, never to
   * the source-fetch area, so the package dir is the one place a part's
   * real bytes live.
   *
   * A manifest path must stay inside the package dir: absolute paths and
   * `..` segments are refused rather than guessed at, before anything is
   * written (mirrors Rust's `materialize` in package_install.rs — a
   * hostile manifest gets a clean error, not a write outside
   * packages/<base>/).
   */
  private async materializeIntoPackage(name: string, rel: string, ctx = "part"): Promise<string> {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      throw new Error(`${ctx} path ${rel} escapes the package — refusing`);
    }
    const src = path.join(this.getContentDir(this.packages.get(name)!), rel);
    const dest = path.join(this.packageDir(name), rel);
    await this.copyFileEnsuringDir(src, dest);
    return dest;
  }

  /**
   * A skill's relative `.js` args, materialized into packages/<base>/ and
   * absolutized to that path — mirrors Rust's skill handling in
   * package_install.rs exactly, so both installers write the same
   * mcpServers arg. Before this, the CLI resolved args against the
   * source-fetch dir (getContentDir) instead: the package dir held one
   * set of files, settings.json pointed at another. Only bare relative
   * `.js` args are touched; an already-absolute arg, a bare command
   * (`node`, `npx`), or a flag passes through untouched. An arg that
   * escapes the package or is missing from the source falls back to its
   * original (unresolved) value rather than failing the whole install —
   * same as Rust's `if let Ok(dest) = materialize(...) { .. } else` fallback.
   */
  private async materializeSkillArgs<T extends { args?: string[] }>(name: string, skill: T): Promise<T> {
    if (!skill.args?.length) return skill;
    const args = await Promise.all(
      skill.args.map(async (arg) => {
        if (arg.endsWith(".js") && !path.isAbsolute(arg)) {
          try {
            return await this.materializeIntoPackage(name, arg, "skill");
          } catch {
            return arg;
          }
        }
        return arg;
      })
    );
    return { ...skill, args };
  }

  private getInstallDir(pkg: FezPackage): string {
    if (pkg.source.startsWith("npm:")) {
      return path.join(this.npmDir, pkg.name);
    }
    return path.join(this.gitDir, pkg.name);
  }

  /**
   * Where the PACKAGE'S OWN files live. npm installs wrap the real
   * package under node_modules/<npmName> (the top-level package.json is
   * fez's shim — reading it was the second dead-code bug); git clones
   * ARE the content.
   */
  private getContentDir(pkg: FezPackage): string {
    if (pkg.source.startsWith("npm:")) {
      return path.join(this.npmDir, npmPackageName(pkg.source), "node_modules", pkg.source.replace("npm:", ""));
    }
    return path.join(this.gitDir, pkg.name);
  }

  private async loadRegistry(): Promise<void> {
    try {
      const content = await fs.readFile(this.registryFile, "utf-8");
      const data = JSON.parse(content);
      this.packages = new Map(Object.entries(data.packages || {}));
    } catch {
      this.packages = new Map();
    }
  }

  private async saveRegistry(): Promise<void> {
    const data = { packages: Object.fromEntries(this.packages) };
    await fs.writeFile(this.registryFile, JSON.stringify(data, null, 2), "utf-8");
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
