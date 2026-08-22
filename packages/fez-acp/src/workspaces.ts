import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Where an agent's turns actually run.
 *
 * A persona that only chats is happy with a scratch folder. A persona
 * that WORKS ON something needs that thing present — a checkout, a
 * dataset, a mounted share — and the runtime should not know which.
 *
 * So this is a lookup, not an implementation: `~/.fez/workspace-providers`
 * is a PLACE, the same way ~/.fez/extensions and ~/.fez/relay-extensions
 * are, and `fez install @fezchat/git` puts a provider in it. fez-acp asks for
 * a directory and gets one. Nothing here mentions git, and nothing here
 * should — the day somebody wants an agent working out of an S3 prefix,
 * that is a package, not a patch to this file.
 *
 * The provider contract, deliberately tiny:
 *
 *   default export (request) => Promise<{dir, branch, empty} | undefined>
 *
 * `undefined` means "not mine, try the next one". THROWING means "mine,
 * and it failed" — which must propagate, because an agent that silently
 * fell back to an empty scratch directory would run a whole turn, edit
 * nothing that matters, and report success.
 */

export interface WorkspaceRequest {
  repo: string;
  /** Line to cut the branch from — thread-scoped summons name one. */
  base?: string;
  branch: string;
  dir: string;
  scope?: string[];
  relayUrl: string;
  secretKeyHex: string;
  log?: (line: string) => void;
}

export interface ProvidedWorkspace {
  dir: string;
  branch: string;
  empty: boolean;
}

type Provider = (req: WorkspaceRequest) => Promise<ProvidedWorkspace | undefined>;

/**
 * The branch an agent works on when its persona does not name one.
 *
 * Namespaced by agent, because branch-per-agent is what lets a fleet
 * share one repo: two agents pushing different refs never race, and
 * merge becomes the single point where their work has to agree.
 *
 * A `branch:` in frontmatter overrides this — an agent can be pinned to
 * a long-lived line, which is the case that earns a channel of its own.
 */
export function defaultBranchFor(agent: string): string {
  const slug = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "agent"}/work`;
}

/** Defaults to ~/.fez/workspace-providers. */
export function providersDir(): string {
  return process.env.FEZ_WORKSPACE_PROVIDERS ?? path.join(os.homedir(), ".fez", "workspace-providers");
}

/**
 * Ask each installed provider, in name order, until one claims the
 * request. Returns undefined when nothing does — the caller then uses an
 * ordinary scratch directory, which is the right answer for a persona
 * that named no repo.
 */
export async function resolveWorkspace(req: WorkspaceRequest): Promise<ProvidedWorkspace | undefined> {
  const dir = providersDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort();
  } catch {
    return undefined; // no providers installed — the normal case
  }

  for (const entry of entries) {
    const name = entry.replace(/\.m?js$/, "");
    let provider: Provider | undefined;
    try {
      const mod = (await import(pathToFileURL(path.join(dir, entry)).href)) as {
        default?: Provider;
        provide?: Provider;
      };
      provider = mod.default ?? mod.provide;
    } catch (err) {
      // A provider that will not even load is a broken install, not a
      // refusal — say so and try the next, rather than leaving the agent
      // to wonder why its repo never appeared.
      console.warn(`⚠️  workspace provider ${name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (typeof provider !== "function") {
      console.warn(`⚠️  workspace provider ${name} exports no default function — skipped`);
      continue;
    }
    const workspace = await provider(req); // a throw here is intentional — see above
    if (workspace) return workspace;
  }
  return undefined;
}
