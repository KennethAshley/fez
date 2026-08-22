import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWorkspace } from "./workspace.js";
import { cloneBase } from "./headless.js";

/**
 * fez-git as an installed WORKSPACE PROVIDER.
 *
 * `fez install @fez/git` drops this in ~/.fez/workspace-providers, and
 * an agent whose persona names a `repo:` finds it there. The agent
 * runtime never learns what git is — it asks for a working directory and
 * gets one, the same way the relay asks for an HTTP handler and the TUI
 * asks for a command.
 *
 * That indirection is not ceremony. `fez agent <persona>` is launched
 * directly by people as well as by the sentinel, and only the sentinel
 * loads extensions — so a hook on the spawner would work for a fleet and
 * silently not work for anybody running an agent by hand.
 */

export interface ProvideRequest {
  /** Repo name on the relay. */
  repo: string;
  /** Branch this agent works on — one per agent, so pushes never race. */
  branch: string;
  /** Where to build the checkout. */
  dir: string;
  /** Sparse cone; omit for the whole tree. */
  scope?: string[];
  /** Line to cut the branch from (thread-scoped summons). */
  base?: string;
  /** Relay websocket URL — the provider reads its NIP-11 for the git base. */
  relayUrl: string;
  /** The agent's own key. It pushes AS ITSELF; that is the whole point. */
  secretKeyHex: string;
  log?: (line: string) => void;
}

export interface ProvidedWorkspace {
  dir: string;
  branch: string;
  empty: boolean;
}

/**
 * Where `git-credential-fez` is.
 *
 * Bundled next to this file by the installer, so prefer the sibling;
 * fall back to the bare name, which git resolves on PATH via the
 * package's `bin` entry when @fez/git is installed globally. Guessing
 * wrong here surfaces as an auth failure far from the cause, so both
 * paths are checked rather than assumed.
 */
function resolveHelper(): string {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, "credential.js"), path.join(here, "fez-git-credential.js"));
  } catch { /* not file-backed */ }
  // ~/.fez/bin is where `fez install`/`fez link` put executables — the
  // canonical home, so the helper no longer needs a copy beside the
  // provider (which the provider LOADER would try to import as one).
  candidates.push(path.join(os.homedir(), ".fez", "bin", "git-credential-fez"));
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "fez";
}

/**
 * Returns undefined when this provider does not apply, so the runtime can
 * try the next one. An ERROR means "this is mine and it failed", which is
 * a different thing and must not be swallowed into a silent fallback to
 * an empty scratch directory — an agent quietly working in the wrong
 * place would commit nothing and report success.
 */
export default async function provide(req: ProvideRequest): Promise<ProvidedWorkspace | undefined> {
  if (!req.repo) return undefined;
  const log = req.log ?? (() => {});

  const http = req.relayUrl.replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
  let info: Record<string, unknown> | undefined;
  try {
    const res = await fetch(http, { headers: { Accept: "application/nostr+json" } });
    if (res.ok) info = (await res.json()) as Record<string, unknown>;
  } catch { /* unreachable relay is reported below, with the reason */ }

  const base = cloneBase(info);
  if (!base) {
    throw new Error(
      `${req.relayUrl} does not advertise a git server, so there is nowhere to clone "${req.repo}" from. ` +
        `Install @fez/git on the relay and start it with --extensions --origin <public-url>.`
    );
  }

  const ws = await prepareWorkspace({
    repo: req.repo,
    cloneBase: base,
    branch: req.branch,
    dir: req.dir,
    scope: req.scope,
    base: req.base,
    secretKeyHex: req.secretKeyHex,
    helper: resolveHelper(),
    log,
  });
  return { dir: ws.dir, branch: ws.branch, empty: ws.empty };
}
