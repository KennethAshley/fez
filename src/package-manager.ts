import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import chalk from "chalk";

const FEZ_DIR = path.join(os.homedir(), ".fez");
const PACKAGES_DIR = path.join(FEZ_DIR, "packages");
const NPM_DIR = path.join(PACKAGES_DIR, "npm");
const GIT_DIR = path.join(PACKAGES_DIR, "git");
const REGISTRY_FILE = path.join(FEZ_DIR, "registry.json");

export interface FezPackage {
  name: string;
  version: string;
  source: string; // npm:@fez/claude-code or git:github.com/user/repo
  type: "integration" | "agent" | "extension" | "persona-pack";
  installedAt: string;
  config?: Record<string, unknown>;
  /** persona-pack: the persona ids this pack installed (removed on uninstall). */
  installedPersonas?: string[];
}

export interface FezManifest {
  /**
   * npm's own bin map. Honored on install: each entry is copied to
   * ~/.fez/bin, so an extension can ship executables (a git credential
   * helper, an adopt command) without being npm-installed globally.
   */
  bin?: Record<string, string>;
  fez: {
    type: "integration" | "agent" | "extension" | "persona-pack";
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
 * fez install npm:@fez/ditto
 * fez install git:github.com/user/my-agent
 * fez list
 * fez remove claude-code
 * ```
 */
export class PackageManager {
  private packages: Map<string, FezPackage> = new Map();

  async init(): Promise<void> {
    await fs.mkdir(FEZ_DIR, { recursive: true });
    await fs.mkdir(NPM_DIR, { recursive: true });
    await fs.mkdir(GIT_DIR, { recursive: true });
    await this.loadRegistry();
  }

  /**
   * Install a package.
   *
   * Resolves shorthand names to npm packages automatically:
   * - `claude-code` → `npm:@fez/claude-code`
   * - `pi` → `npm:@fez/pi`
   * - `ditto` → `npm:@fez/ditto`
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
      await this.runInstallHook(name, manifest);
    } catch (err) {
      this.packages.delete(name); // failed install leaves no registry ghost
      throw err;
    }
    await this.saveRegistry();

    console.log(chalk.green(`✅ Installed ${name}`));
    return pkg;
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
      "claude-code": "npm:@fez/claude-code",
      "claude": "npm:@fez/claude-code",
      "pi": "npm:@fez/pi",
      "ditto": "npm:@fez/ditto",
      "hindsight": "npm:@fez/hindsight",
      "echo": "npm:@fez/echo",
    };

    if (shorthandMap[source]) {
      return shorthandMap[source];
    }

    // An already-scoped name (@fez/git, @acme/thing) is a plain npm
    // package — DON'T re-scope it. `fez install @fez/kanban` was
    // becoming npm:@fez/@fez/kanban and 404ing; both the bare shorthand
    // (`kanban`) and the full scoped name must resolve to the same
    // package.
    if (source.startsWith("@")) {
      return `npm:${source}`;
    }

    // A bare name is fez-shorthand for the @fez scope.
    return `npm:@fez/${source}`;
  }

  private extractName(source: string): string {
    if (source.startsWith("npm:")) {
      const pkg = source.replace("npm:", "");
      return pkg.split("@").filter(Boolean).pop() || pkg;
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
    const installPath = path.join(NPM_DIR, pkgName.replace("@fez/", ""));

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
    const installPath = path.join(GIT_DIR, name);

    await fs.mkdir(GIT_DIR, { recursive: true });

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
    if (!manifest?.fez) return;

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
      await this.installParts(name, manifest.fez.parts);
    }
    if (manifest.bin) {
      await this.installBins(name, manifest.bin);
    }

    // Persona pack — a team bundle of persona .md files
    if (manifest.fez.personas) {
      await this.installPersonaPack(name, manifest.fez.personas);
    }

    // Agent registration
    if (manifest.fez.agent) {
      console.log(chalk.blue(`🤖 Registering agent: ${manifest.fez.agent.entry}`));
      // Could add to a local agent registry
    }
  }

  private async runUninstallHook(pkg: FezPackage): Promise<void> {
    const manifest = await this.readManifest(pkg.name);
    if (!manifest?.fez) return;

    const integrations = manifest.fez.integrations;

    if (integrations?.claudeCode) {
      await this.removeClaudeCodeIntegration(pkg.name);
    }
    if (integrations?.pi) {
      await this.removePiIntegration(pkg.name);
    }
    if (manifest.fez.extension) {
      await this.removeFezExtension(pkg.name);
    }
    if (pkg.installedPersonas?.length) {
      const personasDir = path.join(os.homedir(), ".fez", "personas");
      for (const id of pkg.installedPersonas) {
        await fs.rm(path.join(personasDir, `${id}.md`), { force: true });
        console.log(chalk.dim(`   Removed persona ${id}`));
      }
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
    const { validatePersonaFile, mergeDefaults } = await import("./personas.js");
    const { listHarnesses } = await import("./harness.js");
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

    const personasDir = path.join(os.homedir(), ".fez", "personas");
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
    this.packages.get(name)!.installedPersonas = installed;
    console.log(chalk.green(`   👥 ${installed.length} persona(s) from pack "${name}" — fez agent <name> to run one`));
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
    const home = os.homedir();
    const extensionsDir = path.join(home, ".fez", "extensions");
    await fs.mkdir(extensionsDir, { recursive: true });

    const pkgDir = this.getContentDir(this.packages.get(name)!);

    if (config.entry) {
      // Preserve the entry's real extension — a bundled package ships a .js
      // entry that plain `node` can import; renaming it .ts would misstate
      // what it is (loadExtensions accepts .ts/.js/.mjs either way).
      const ext = path.extname(config.entry) || ".js";
      const src = path.join(pkgDir, config.entry);
      const dest = path.join(extensionsDir, `${name}${ext}`);
      await fs.copyFile(src, dest);
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
    const pkgDir = this.getContentDir(pkg);
    const binDir = path.join(os.homedir(), ".fez", "bin");
    await fs.mkdir(binDir, { recursive: true });
    for (const [cmd, rel] of Object.entries(bin)) {
      const target = path.join(binDir, cmd);
      await fs.copyFile(path.join(pkgDir, rel), target);
      await fs.chmod(target, 0o755);
      console.log(chalk.dim(`   Installed ~/.fez/bin/${cmd}`));
    }
    if (!(process.env.PATH ?? "").split(":").includes(path.join(os.homedir(), ".fez", "bin"))) {
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
    }
  ): Promise<void> {
    const pkgDir = this.getContentDir(this.packages.get(name)!);
    if (parts.headless) {
      await this.installFezExtension(name, { entry: parts.headless });
    }
    if (parts.gui) {
      const guiDir = path.join(os.homedir(), ".fez", "gui-extensions");
      await fs.mkdir(guiDir, { recursive: true });
      await fs.copyFile(path.join(pkgDir, parts.gui), path.join(guiDir, `${name}.js`));
      console.log(chalk.dim(`   Created ~/.fez/gui-extensions/${name}.js`));
    }
    if (parts.relay) {
      // A fourth place, same shape as the others. It only does anything
      // on a machine that RUNS a relay, and only when that relay is
      // started with --extensions: this is code inside the process
      // holding everyone's events, so installing it and enabling it are
      // deliberately two acts.
      const relayDir = path.join(os.homedir(), ".fez", "relay-extensions");
      await fs.mkdir(relayDir, { recursive: true });
      await fs.copyFile(path.join(pkgDir, parts.relay), path.join(relayDir, `${name}.js`));
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
      const wsDir = path.join(os.homedir(), ".fez", "workspace-providers");
      await fs.mkdir(wsDir, { recursive: true });
      await fs.copyFile(path.join(pkgDir, parts.workspace), path.join(wsDir, `${name}.js`));
      console.log(chalk.dim(`   Created ~/.fez/workspace-providers/${name}.js`));
      console.log(chalk.dim("   Personas can now set `repo:` to work from a checkout."));
    }
    if (parts.background) {
      const { loadSettings, saveSettings } = await import("./settings.js");
      const settings = loadSettings() as { backgroundExtensions?: string[] };
      const list = new Set(settings.backgroundExtensions ?? []);
      list.add(name);
      saveSettings({ backgroundExtensions: [...list] } as never);
      console.log(chalk.dim(`   Background tasks enabled (restart the sentinel to run them)`));
    }
    if (parts.skill) {
      const { loadSettings, saveSettings } = await import("./settings.js");
      const settings = loadSettings() as { mcpServers?: Record<string, { env?: Record<string, string> }> };
      // keep env VALUES the user already filled in; the package supplies names
      const mergedEnv = { ...(parts.skill.env ?? {}), ...(settings.mcpServers?.[name]?.env ?? {}) };
      saveSettings({
        mcpServers: {
          ...settings.mcpServers,
          [name]: { ...parts.skill, ...(Object.keys(mergedEnv).length ? { env: mergedEnv } : {}) },
        },
      } as never);
      console.log(chalk.dim(`   Defined skill "${name}" in ~/.fez/settings.json`));
    }
  }

  private async removeParts(name: string): Promise<void> {
    await fs.rm(path.join(os.homedir(), ".fez", "gui-extensions", `${name}.js`), { force: true });
    const { loadSettings, saveSettings } = await import("./settings.js");
    const settings = loadSettings() as { backgroundExtensions?: string[] };
    if (settings.backgroundExtensions?.includes(name)) {
      saveSettings({ backgroundExtensions: settings.backgroundExtensions.filter((n) => n !== name) } as never);
    }
    // the skill definition stays: the user may have filled env values and
    // personas may still declare it — removing it silently would break them
  }

  private async removeFezExtension(name: string): Promise<void> {
    const home = os.homedir();
    for (const ext of [".ts", ".js", ".mjs"]) {
      await fs.rm(path.join(home, ".fez", "extensions", `${name}${ext}`), { force: true });
    }
  }

  private getInstallDir(pkg: FezPackage): string {
    if (pkg.source.startsWith("npm:")) {
      return path.join(NPM_DIR, pkg.name);
    }
    return path.join(GIT_DIR, pkg.name);
  }

  /**
   * Where the PACKAGE'S OWN files live. npm installs wrap the real
   * package under node_modules/<npmName> (the top-level package.json is
   * fez's shim — reading it was the second dead-code bug); git clones
   * ARE the content.
   */
  private getContentDir(pkg: FezPackage): string {
    if (pkg.source.startsWith("npm:")) {
      return path.join(NPM_DIR, pkg.name, "node_modules", pkg.source.replace("npm:", ""));
    }
    return path.join(GIT_DIR, pkg.name);
  }

  private async loadRegistry(): Promise<void> {
    try {
      const content = await fs.readFile(REGISTRY_FILE, "utf-8");
      const data = JSON.parse(content);
      this.packages = new Map(Object.entries(data.packages || {}));
    } catch {
      this.packages = new Map();
    }
  }

  private async saveRegistry(): Promise<void> {
    const data = { packages: Object.fromEntries(this.packages) };
    await fs.writeFile(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf-8");
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
