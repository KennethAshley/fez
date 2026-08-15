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
  type: "integration" | "agent" | "extension";
  installedAt: string;
  config?: Record<string, unknown>;
}

export interface FezManifest {
  fez: {
    type: "integration" | "agent" | "extension";
    // For integrations: config files to install
    integrations?: {
      claudeCode?: { commands?: string; evals?: string };
      pi?: { extensions?: string };
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

    // Read manifest and run install hook
    const manifest = await this.readManifest(name);
    await this.runInstallHook(name, manifest);

    const pkg: FezPackage = {
      name,
      version: options.version || "latest",
      source: resolved,
      type: manifest?.fez?.type || "extension",
      installedAt: new Date().toISOString(),
      config: manifest?.fez,
    };

    this.packages.set(name, pkg);
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

    // Default to npm if no prefix
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
    const target = version ? `${pkgName}@${version}` : pkgName;
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

    const installDir = this.getInstallDir(pkg);
    const manifestPath = path.join(installDir, "package.json");

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
  }

  private async installClaudeCodeIntegration(name: string, config: { commands?: string; evals?: string }): Promise<void> {
    const home = os.homedir();
    const claudeDir = path.join(home, ".claude");
    const commandsDir = path.join(claudeDir, "commands");
    const evalsDir = path.join(claudeDir, "evals");

    await fs.mkdir(commandsDir, { recursive: true });
    await fs.mkdir(evalsDir, { recursive: true });

    const pkgDir = this.getInstallDir(this.packages.get(name)!);

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

    const pkgDir = this.getInstallDir(this.packages.get(name)!);

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

    const pkgDir = this.getInstallDir(this.packages.get(name)!);

    if (config.entry) {
      const src = path.join(pkgDir, config.entry);
      const dest = path.join(extensionsDir, `${name}.ts`);
      await fs.copyFile(src, dest);
      console.log(chalk.dim(`   Created ~/.fez/extensions/${name}.ts`));
    }
  }

  private async removeFezExtension(name: string): Promise<void> {
    const home = os.homedir();
    await fs.rm(path.join(home, ".fez", "extensions", `${name}.ts`), { force: true });
  }

  private getInstallDir(pkg: FezPackage): string {
    if (pkg.source.startsWith("npm:")) {
      return path.join(NPM_DIR, pkg.name);
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
