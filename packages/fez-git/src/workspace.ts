import { execFile } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * An agent's working copy — the disposable half of an agent.
 *
 * Buzz states the rule this is built on: "workspace files, checkouts,
 * and session-local state are part of the BODY, not the agent, and they
 * go when it goes." What makes an agent that agent is its keypair, its
 * signed history, its engrams — all on the relay. The checkout is
 * scratch, and treating it as scratch is what lets a fleet exist at all.
 *
 * So each agent gets its OWN clone rather than a shared tree:
 *
 *   - git worktrees would be cheaper on disk, but they pin every agent
 *     to one filesystem and one object store — a shared failure domain,
 *     and useless the day an agent runs somewhere else. A clone is the
 *     same code path on a laptop and in a container.
 *   - branch-per-agent means concurrent pushes never collide. Merge is
 *     the one serialization point, which is where a human wants it.
 *
 * The cost of N clones is handled by asking for less, not by sharing:
 * `--filter=blob:none` skips historical blobs, and a sparse cone limits
 * the working tree to the paths this agent was actually given. Measured
 * on a 2369-commit repo: 185M full → 127M filtered → 12M filtered+sparse.
 *
 * The sparse cone is not only a size trick. It is the agent's ASSIGNMENT
 * made physical: an agent scoped to one directory cannot edit outside it
 * by accident, because those files are not in its tree. It can widen the
 * cone deliberately (blobs back-fill on demand), which is the difference
 * between a boundary and a cage.
 */

const run = promisify(execFile);

export interface WorkspaceSpec {
  /** Repo name on the relay, as `/repo new` created it. */
  repo: string;
  /** Where the relay serves git, from its NIP-11 `fez_git.clone_base`. */
  cloneBase: string;
  /** Branch to work on. Created off the default branch if new. */
  branch: string;
  /** Directory to build the checkout in. Replaced if it already exists. */
  dir: string;
  /**
   * Sparse-checkout cone(s). Omit for the whole tree — correct for small
   * repos and for an agent whose job genuinely spans everything.
   */
  scope?: string[];
  /**
   * The LINE this work is cut from and merges back into. A new agent
   * branch starts at `origin/<base>` instead of the default branch, so
   * two sets of agents on two lines never see each other's work in
   * progress. Ignored when the agent's branch already exists on the
   * relay (resuming beats re-basing: an agent that died mid-task comes
   * back to ITS work), and when the base doesn't exist yet (the line
   * was declared but has no commits — the default branch is its
   * starting content by definition).
   */
  base?: string;
  /** Agent's secret key, hex — its git credential (see credential.ts). */
  secretKeyHex: string;
  /** Path to git-credential-fez. */
  helper: string;
  log?: (line: string) => void;
}

export interface Workspace {
  /** The checkout. Hand this to the harness as its cwd. */
  dir: string;
  /** The branch it is on. */
  branch: string;
  /** Whether the repo was empty (no commits yet) — nothing was fetched. */
  empty: boolean;
  /** Delete the checkout. The body is disposable; this is the disposal. */
  dispose(): void;
}

/**
 * Everything git needs to talk to a fez relay as this agent.
 *
 * `useHttpPath` is not optional: without it git caches one credential
 * per host, so a token minted for one repo would be replayed at another.
 */
function gitArgs(spec: WorkspaceSpec): string[] {
  return ["-c", `credential.helper=${spec.helper}`, "-c", "credential.useHttpPath=true"];
}

function gitEnv(spec: WorkspaceSpec): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FEZ_SECRET_KEY: spec.secretKeyHex,
    // Never let git stop for a human — an agent has no terminal, and a
    // prompt would hang the turn until its timeout instead of failing.
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Persist auth INTO the clone, so the agent's own `git push` works.
 *
 * prepareWorkspace passing `-c` flags per command authenticated the
 * SETUP — and nothing after it. The agent then ran `git push` from its
 * shell, found no helper, and went spelunking through Bitwarden and
 * osxkeychain looking for credentials that were never going to be there
 * (watched happen, painfully). The clone's local config is the right
 * home: it travels with the checkout, and `git -C <dir> push` works for
 * whoever holds the key in FEZ_SECRET_KEY.
 *
 * The leading EMPTY helper entry is load-bearing on macOS: the system
 * gitconfig ships credential.helper=osxkeychain, git runs every helper
 * in the list, and osxkeychain both prompts and fails to store authtype
 * credentials. An empty entry resets the inherited list (git's own
 * semantics), so ours is the only one that runs.
 */
async function persistAuth(dir: string, helper: string, git: (args: string[], cwd?: string) => Promise<unknown>): Promise<void> {
  await git(["config", "--local", "credential.helper", ""], dir);
  await git(["config", "--local", "--add", "credential.helper", helper], dir);
  await git(["config", "--local", "credential.useHttpPath", "true"], dir);
}

/** `https://relay/git` + `demo` → `https://relay/git/demo.git`. */
export const remoteFor = (cloneBase: string, repo: string): string =>
  `${cloneBase.replace(/\/+$/, "")}/${repo}.git`;

/**
 * Clone the repo and put the agent on its branch.
 *
 * Idempotent by demolition: an existing directory is removed rather than
 * reused. A half-written checkout from a crashed agent is worse than no
 * checkout — it can be on the wrong branch, hold a stale index.lock, or
 * carry edits nobody reviewed — and the whole premise here is that the
 * body is cheap to rebuild.
 */
export async function prepareWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
  const log = spec.log ?? (() => {});
  const remote = remoteFor(spec.cloneBase, spec.repo);
  const git = (args: string[], cwd?: string) =>
    run("git", [...gitArgs(spec), ...args], { cwd, env: gitEnv(spec), maxBuffer: 64 * 1024 * 1024 });

  if (existsSync(spec.dir)) rmSync(spec.dir, { recursive: true, force: true });
  mkdirSync(path.dirname(spec.dir), { recursive: true });

  // --no-checkout so the cone is set BEFORE any files land. Cloning
  // normally and narrowing afterwards would materialize the entire tree
  // first, which is the cost this exists to avoid.
  const clone = ["clone", "--filter=blob:none", "--sparse", "--no-checkout", "--quiet", remote, spec.dir];
  try {
    await git(clone);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A repo whose CHANNEL exists but that nobody has pushed to yet is
    // not clonable — on the relay the bare repository is created by the
    // first authorized push (createOnPush), so "not found" here is the
    // agent-first starting state, not an error: init locally, point at
    // the remote, and this agent's first push brings it into being.
    // Anything else (403, network, TLS) stays fatal and loud.
    if (/not found|no such repository/i.test(message)) {
      log(`${spec.repo}: not on the relay yet — this clone's first push creates it`);
      mkdirSync(spec.dir, { recursive: true });
      await git(["init", "--quiet", spec.dir]);
      await git(["remote", "add", "origin", remote], spec.dir);
      await persistAuth(spec.dir, spec.helper, git);
      await git(["checkout", "--quiet", "-b", spec.branch], spec.dir);
      return { dir: spec.dir, branch: spec.branch, empty: true, dispose: () => rmSync(spec.dir, { recursive: true, force: true }) };
    }
    throw new Error(`could not clone ${remote}: ${message}`, { cause: err });
  }

  await persistAuth(spec.dir, spec.helper, git);

  // A repo created by `/repo new` and never pushed to has no commits, so
  // there is no branch to check out and no tree to scope. That is a
  // legitimate starting state — the agent makes the first commit — and
  // it must not read as a failure.
  const empty = await git(["rev-parse", "--verify", "HEAD"], spec.dir).then(() => false).catch(() => true);

  if (spec.scope?.length) {
    await git(["sparse-checkout", "set", ...spec.scope], spec.dir);
    log(`scope: ${spec.scope.join(", ")}`);
  } else {
    // An explicit full cone, rather than leaving the repo in whatever
    // state --sparse defaulted to.
    await git(["sparse-checkout", "disable"], spec.dir);
  }

  if (empty) {
    // Name the branch anyway, so the first commit lands where the fleet
    // model expects instead of on whatever git's default happens to be.
    await git(["checkout", "-b", spec.branch], spec.dir);
    log(`${spec.repo}: empty repo, starting ${spec.branch}`);
    return { dir: spec.dir, branch: spec.branch, empty: true, dispose: () => rmSync(spec.dir, { recursive: true, force: true }) };
  }

  // Resume the branch if it already exists on the relay (an agent that
  // died mid-task comes back to its own work), otherwise start it.
  const exists = await git(["ls-remote", "--exit-code", "--heads", "origin", spec.branch], spec.dir)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    await git(["checkout", "--quiet", "-B", spec.branch, `origin/${spec.branch}`], spec.dir).catch(async () => {
      await git(["fetch", "--quiet", "origin", spec.branch], spec.dir);
      await git(["checkout", "--quiet", "-B", spec.branch, "FETCH_HEAD"], spec.dir);
    });
    log(`${spec.repo}: resumed ${spec.branch}`);
  } else {
    // Cut from the line when one is named and it exists; otherwise the
    // default branch. Checked, not assumed — a declared-but-unpushed
    // line legitimately has no ref yet.
    // FULLY QUALIFIED pattern, non-negotiably: ls-remote patterns match
    // the TAIL of a ref, so a bare "feature" matches a sibling agent's
    // "researcher/feature" — which made an unborn line look born the
    // moment the FIRST agent pushed to it, and killed the SECOND agent's
    // spawn on a fetch of a ref that never existed. The exact scenario
    // is a lane joining a line that already has lanes — i.e. the normal
    // case, discovered the hard way.
    const baseRef =
      spec.base &&
      (await git(["ls-remote", "--exit-code", "origin", `refs/heads/${spec.base}`], spec.dir).then(() => true).catch(() => false))
        ? `origin/${spec.base}`
        : undefined;
    if (baseRef) {
      // No extra fetch: the clone already fetched every head, so the
      // remote-tracking ref for a base that truly exists is present.
      await git(["checkout", "--quiet", "-b", spec.branch, baseRef], spec.dir);
      log(`${spec.repo}: started ${spec.branch} from ${baseRef}`);
    } else {
      await git(["checkout", "--quiet", "-b", spec.branch], spec.dir);
      log(`${spec.repo}: started ${spec.branch}${spec.base ? ` (line ${spec.base} has no commits yet — cut from the default branch)` : ""}`);
    }
  }

  return {
    dir: spec.dir,
    branch: spec.branch,
    empty: false,
    dispose: () => rmSync(spec.dir, { recursive: true, force: true }),
  };
}

/**
 * A branch name for an agent working a task.
 *
 * Namespaced by agent so two agents never contend for one ref, which is
 * what makes the fleet safe to run concurrently. Slugged because a task
 * description arrives as prose and git refs reject most of it.
 */
export function branchFor(agent: string, task?: string): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const who = slug(agent) || "agent";
  const what = task ? slug(task) : "";
  return what ? `${who}/${what}` : `${who}/work`;
}
