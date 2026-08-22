import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gitRepoPath } from "./auth.js";
import { hookEnv, installHook, isPrivileged, removeHook, resolveProtect, roleOf, type RefPolicy } from "./protect.js";
import { installJournalHook, journalPath, readJournalTail } from "./journal.js";
import { serveDiff, serveMerge, serveSync } from "./ops.js";
import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * Shapes borrowed from the relay, declared rather than imported.
 *
 * This package is loaded BY a relay as an installed extension — it does
 * not depend on the relay any more than a GUI extension depends on
 * fez-desktop. Structural types keep the seam honest in both directions
 * and let this be built, tested and published on its own.
 */
export interface StoredEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
}
export interface HttpHandler {
  handle(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>;
}

/**
 * git over HTTP, served by the relay.
 *
 * The point is identity. An agent in fez is a keypair, and no third-party
 * forge has an actor type for one — so an agent that wants to change code
 * hosted elsewhere must borrow a human's credential (the history then
 * says the human wrote it) or share one bot account with every other
 * agent (twelve authors collapse into one name). Serve the repo here and
 * the agent's own key is the credential: it pushes as itself, its commits
 * carry its name, and revoking one agent revokes exactly one agent.
 *
 * fez does not implement git. `git http-backend` is the CGI that ships
 * with git and speaks the whole smart-HTTP protocol; this module decides
 * WHO is asking and WHETHER they may, then gets out of the way. That is
 * the difference between a few hundred lines and a few thousand, and it
 * means the protocol is exactly as correct as the git you have installed.
 *
 * Composed, never assumed — the same shape as policies.ts. A bare relay
 * serves no git at all; an operator passes `git: gitServer({...})` to opt
 * in, and brings their own GitAccess if the roster is not the rule they
 * want. The decentralized floor stays a dumb event store.
 */

export interface GitIdentity {
  /** Proven identity, or undefined for an anonymous request. */
  pubkey?: string;
  /** Why identification failed — surfaced to the client, never guessed at. */
  reason?: string;
}

/**
 * Who is asking. INJECTED, not imported.
 *
 * This package depends on nostr-tools and ws and nothing else — a bare
 * relay is a dumb store you can run anywhere, and reaching into
 * @fez/protocol for one verification would drag the whole CLI in behind
 * it. So the transport does not know what a nostr key is: it knows how
 * to ask someone.
 *
 * fez passes nip98Authenticator() from src/git-auth.ts. An operator
 * running a private mirror could pass one that reads an mTLS cert, or a
 * header, or nothing at all.
 */
export type GitAuthenticator = (
  req: IncomingMessage,
  /** The request reduced to its repository — what a token is scoped to. */
  repoPath: string
) => GitIdentity | Promise<GitIdentity>;

/**
 * Who may do what. Separate from the transport on purpose: "the workspace
 * roster decides" is fez's answer, not git's, and an operator running a
 * public mirror or a paid host needs to say something different without
 * touching the protocol.
 */
export interface GitAccess {
  canRead(repo: string, who: GitIdentity): boolean | Promise<boolean>;
  canWrite(repo: string, who: GitIdentity): boolean | Promise<boolean>;
  /**
   * Which refs this pusher may not move, and whether they are exempt.
   *
   * Optional, and its absence means today's behaviour: canWrite decides
   * everything and every ref is equal. Composed, never assumed — the
   * same posture as `access` itself. An operator running a mirror with
   * their own GitAccess keeps working without knowing this exists.
   *
   * Consulted per PUSH, not per ref: the refs are still inside the
   * packfile when this is called. It answers "what is the rule for this
   * person", and the pre-receive hook applies that rule to what arrives.
   */
  refPolicy?(repo: string, who: GitIdentity): RefPolicy | Promise<RefPolicy>;
  /**
   * Where this repo came from — the recorded upstream, when the access
   * model knows one (fez reads it off the repo's channel meta). Absent
   * method or undefined result both mean "no upstream": sync says so.
   */
  upstreamOf?(repo: string): string | undefined | Promise<string | undefined>;
}

export interface GitOptions {
  /** Directory holding bare repositories. Created if absent. */
  root: string;
  access: GitAccess;
  /** Identify the requester. Absent = every request is anonymous. */
  authenticate?: GitAuthenticator;
  /**
   * Create a repo the first time somebody who may write pushes to it.
   *
   * This is how git bootstraps everywhere else (`git init`, `remote add`,
   * `push -u`), and it means there is no repo-creation API to design,
   * authorize and keep in step with the thing that actually matters.
   */
  createOnPush?: boolean;
  /** Refuse a push body larger than this. Default 500MB, as Buzz uses. */
  maxBodyBytes?: number;
  /**
   * Publish credential for https upstreams (fez-sync). Operator
   * config, never client-supplied — the webview cannot read secrets by
   * design, so the mirror-push credential lives where the mirror-push
   * runs.
   */
  syncToken?: string;
  log?: (line: string) => void;
}

/** `<name>.git` under the root, and nothing that escapes it. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Parse `/git/<name>.git/<service>`.
 *
 * The name is validated against a strict pattern rather than sanitized,
 * because this becomes a filesystem path: `..%2f..%2fetc` is a request
 * to read the disk, and the only safe answer to a name that is not
 * plainly a name is no.
 */
export function parseGitPath(pathname: string): { repo: string; rest: string } | undefined {
  const match = /^\/git\/([^/]+?)\.git(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  const repo = decodeURIComponent(match[1]);
  if (!SAFE_NAME.test(repo)) return undefined;
  return { repo, rest: match[2] ?? "/" };
}

/**
 * Does this request want to WRITE?
 *
 * receive-pack is the push half. Getting this backwards would either
 * refuse every clone or let anonymous strangers push, so it is one
 * function with one job and a test of its own.
 */
export function isWrite(pathname: string, query: string): boolean {
  return pathname.endsWith("/git-receive-pack") || query.includes("service=git-receive-pack");
}

/**
 * A git server is just an HttpHandler — the relay asks it whether this
 * request is its business and it says. Nothing in the relay knows the
 * word "git"; it knows it has handlers.
 */
export type GitServer = HttpHandler;

export function gitServer(options: GitOptions): GitServer {
  const log = options.log ?? (() => {});
  const maxBody = options.maxBodyBytes ?? 500 * 1024 * 1024;
  mkdirSync(options.root, { recursive: true });

  const deny = (res: ServerResponse, code: number, why: string): true => {
    // 401 asks git to try again WITH credentials — that is what makes the
    // credential helper fire. 403 means "you, specifically, may not", and
    // git stops rather than prompting forever.
    if (code === 401) res.setHeader("WWW-Authenticate", 'Nostr realm="fez"');
    res.writeHead(code, { "content-type": "text/plain" });
    res.end(`${why}\n`);
    return true;
  };

  return {
    async handle(req, res): Promise<boolean> {
      const url = new URL(req.url ?? "/", "http://relay");
      const route = parseGitPath(url.pathname);
      if (!route) return false; // not ours — the relay carries on

      const write = isWrite(url.pathname, url.search) || route.rest === "/fez-merge" || route.rest === "/fez-sync";
      const repoDir = path.join(options.root, `${route.repo}.git`);

      // The fez-* endpoints are consumed by BROWSERS (the desktop webview's
      // lane board), not just git — and a cross-origin fetch carrying an
      // Authorization header preflights. Without these answers the browser
      // blocks the request before it is ever made, which presents as "the
      // board is empty" with the journal sitting right there (it did).
      // Wildcard origin is correct: authorization is the NIP-98 header,
      // never a cookie, so there is no ambient credential to protect.
      if (route.rest.startsWith("/fez-")) {
        res.setHeader("access-control-allow-origin", "*");
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "authorization",
            "access-control-max-age": "600",
          });
          res.end();
          return true;
        }
      }

      // Identity is scoped to the REPOSITORY, not this request: git signs
      // once per operation and reuses that token for the ref GET and the
      // pack POST, so the authenticator is handed the reduced path.
      //
      // The body is never buffered — a push is a packfile, and holding
      // one in memory would be half a gigabyte of RSS per concurrent
      // push. It streams into the subprocess below.
      const who: GitIdentity = options.authenticate
        ? await options.authenticate(req, gitRepoPath(url.pathname + url.search))
        : {};

      const allowed = write ? await options.access.canWrite(route.repo, who) : await options.access.canRead(route.repo, who);
      if (!allowed) {
        // An unidentified request gets a chance to authenticate; one that
        // DID identify and still failed is simply not allowed, and telling
        // it to retry would loop forever.
        if (!who.pubkey) return deny(res, 401, `authenticate with a nostr key (${who.reason ?? "no credentials"})`);
        log(`git: ${who.pubkey.slice(0, 8)} denied ${write ? "write" : "read"} on ${route.repo}`);
        return deny(res, 403, `not allowed to ${write ? "push to" : "read"} ${route.repo}`);
      }

      // The push journal — read-gated exactly like clone, because it
      // reveals the same facts (who moved which ref). Served before the
      // git-backend path since it is not a git protocol request.
      if (route.rest === "/fez-push-journal") {
        if (!existsSync(repoDir)) return deny(res, 404, `no such repository: ${route.repo}`);
        res.writeHead(200, { "content-type": "text/tab-separated-values" });
        res.end(readJournalTail(repoDir));
        return true;
      }

      // Review diff — read-gated like clone; the refs come from the URL
      // and are validated before they go anywhere near a subprocess.
      if (route.rest === "/fez-diff") {
        if (!existsSync(repoDir)) return deny(res, 404, `no such repository: ${route.repo}`);
        await serveDiff(repoDir, url.searchParams, res);
        return true;
      }

      // Publish a branch to the repo's upstream — the shop-window push.
      if (route.rest === "/fez-sync") {
        if (req.method !== "POST") return deny(res, 405, "fez-sync is POST");
        if (!existsSync(repoDir)) return deny(res, 404, `no such repository: ${route.repo}`);
        const policy = options.access.refPolicy ? await options.access.refPolicy(route.repo, who) : undefined;
        await serveSync(
          repoDir,
          url.searchParams,
          {
            upstream: await options.access.upstreamOf?.(route.repo),
            token: options.syncToken,
            // No composed policy = no roles to read = every writer may.
            privileged: policy ? policy.privileged : true,
          },
          res
        );
        return true;
      }

      // Fast-forward merge — a WRITE (gated above as one), with the
      // hook's own protection question asked through the same refPolicy
      // seam: one answer for pushes and merges, or the two drift.
      if (route.rest === "/fez-merge") {
        if (req.method !== "POST") return deny(res, 405, "fez-merge is POST");
        if (!existsSync(repoDir)) return deny(res, 404, `no such repository: ${route.repo}`);
        await serveMerge(
          repoDir,
          url.searchParams,
          {
            pusher: who.pubkey ?? "anonymous",
            allowed: async (ref) => {
              if (!options.access.refPolicy) return true; // no policy composed — every ref is equal
              const policy = await options.access.refPolicy(route.repo, who);
              const protectedRef = policy.protect.some((pattern) =>
                new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(ref)
              );
              return !protectedRef || policy.privileged;
            },
          },
          res
        );
        return true;
      }

      if (!existsSync(repoDir)) {
        if (!write || options.createOnPush === false) {
          return deny(res, 404, `no such repository: ${route.repo}`);
        }
        // First authorized push brings the repo into being.
        await run("git", ["init", "--bare", "--quiet", repoDir]);
        // Partial clone, on by default.
        //
        // A fleet of agents each takes its own checkout, so the cost that
        // matters is per-agent clone size, and `--filter=blob:none` is
        // what keeps it bounded — it skips every historical blob and
        // fetches only what a working tree actually opens. Measured on a
        // 2369-commit repo: 185M full, 127M filtered, 12M filtered plus a
        // sparse cone.
        //
        // Off by default in git, and the failure is quiet: the client
        // prints "filtering not recognized by server, ignoring" and
        // silently downloads everything. A default that degrades without
        // erroring is exactly the kind of thing nobody notices until the
        // disk is full, so it is set once, here, at creation.
        await run("git", ["-C", repoDir, "config", "uploadpack.allowFilter", "true"]);
        // Lets a client ask for an object by sha it learned elsewhere —
        // required for lazily back-filling blobs a partial clone skipped.
        await run("git", ["-C", repoDir, "config", "uploadpack.allowAnySHA1InWant", "true"]);
        log(`git: created ${route.repo}.git`);
      }

      // Branch protection is resolved HERE, before git runs, and handed
      // to the hook in its environment. Doing it now is what keeps the
      // hook a pure function of its inputs — it never calls back, so
      // there is no window where the policy it enforces is not the
      // policy the relay authorized.
      //
      // The hook is rewritten on every push rather than at creation:
      // repos made before this existed have none, and a protection that
      // silently skips your oldest repo is worse than no protection.
      let extraEnv: NodeJS.ProcessEnv = {};
      if (write) {
        // Recording is unconditional — the journal is what lets the
        // owner-key side post branch threads, and unlike protection it
        // is not policy anyone composes away.
        installJournalHook(repoDir);
        extraEnv = { FEZ_GIT_JOURNAL: journalPath(repoDir), FEZ_GIT_PUSHER: who.pubkey ?? "anonymous" };
        try {
          if (options.access.refPolicy) {
            const policy = await options.access.refPolicy(route.repo, who);
            installHook(repoDir);
            extraEnv = { ...extraEnv, ...hookEnv(who.pubkey, policy) };
            if (policy.protect.length > 0) {
              log(`git: ${route.repo} protects ${policy.protect.join(" ")}${policy.privileged ? "" : " (pusher may not)"}`);
            }
          } else {
            // No policy means no hook — including one WE left behind. The
            // hook fails closed on a missing policy, so an operator who
            // swaps in their own GitAccess would otherwise find every
            // push refused by a rule they never configured.
            removeHook(repoDir);
          }
        } catch (err) {
          // Could not install or resolve — refuse. An accepted push here
          // would be one the relay never checked, and it would look
          // exactly like a successful one.
          log(`git: refusing push to ${route.repo}: ${err instanceof Error ? err.message : String(err)}`);
          return deny(res, 500, "could not apply this repository's branch protection");
        }
      }

      await serveViaHttpBackend(req, res, {
        root: options.root,
        pathInfo: `/${route.repo}.git${route.rest}`,
        query: url.search.replace(/^\?/, ""),
        maxBodyBytes: maxBody,
        pubkey: who.pubkey,
        env: extraEnv,
      });
      return true;
    },
  };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

interface BackendOptions {
  root: string;
  pathInfo: string;
  query: string;
  maxBodyBytes: number;
  pubkey?: string;
  /** Handed through to receive-pack's hooks. See protect.ts. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Hand the request to `git http-backend` and stream its CGI reply back.
 *
 * CGI means the child writes headers, a blank line, then the body — so
 * the split has to happen on the first \r\n\r\n and everything after it
 * is bytes, not text. Decoding the whole thing as a string would corrupt
 * packfiles in a way that only shows up on large clones.
 */
function serveViaHttpBackend(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BackendOptions
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        // Before GIT_PROJECT_ROOT and friends: http-backend execs
        // receive-pack, which execs the hook, and the whole chain
        // inherits this. Policy vars can never shadow the CGI ones.
        ...opts.env,
        GIT_PROJECT_ROOT: opts.root,
        GIT_HTTP_EXPORT_ALL: "1", // authorization already happened, above
        PATH_INFO: opts.pathInfo,
        QUERY_STRING: opts.query,
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: req.headers["content-length"] ?? "",
        // Who the commits' RECEIVER thinks is pushing. Not authorship —
        // that rides in the commit objects — but it is what a hook or a
        // reflog will show, and it should say which key did this.
        REMOTE_USER: opts.pubkey ?? "anonymous",
      },
    });

    // Stream the request in, counting as it goes: a cap enforced by
    // reading the whole body first is not a cap, it is the thing the cap
    // was meant to prevent.
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > opts.maxBodyBytes) {
        req.destroy();
        child.kill();
      }
    });
    req.pipe(child.stdin);
    child.stdin.on("error", () => { /* client hung up mid-push */ });

    const chunks: Buffer[] = [];
    let headersSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      const split = buffered.indexOf("\r\n\r\n");
      if (split === -1) return; // headers still arriving
      for (const line of buffered.subarray(0, split).toString("utf-8").split("\r\n")) {
        const at = line.indexOf(":");
        if (at > 0) res.setHeader(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      headersSent = true;
      res.writeHead(res.getHeader("status") ? Number(String(res.getHeader("status")).slice(0, 3)) : 200);
      res.write(buffered.subarray(split + 4));
    });

    child.on("error", () => {
      if (!headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("git http-backend is not available on this relay\n");
      resolve();
    });
    child.on("close", () => {
      if (!headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end();
      resolve();
    });
  });
}

/**
 * fez's own answer to "who may": the workspace roster.
 *
 * Nothing new is invented here. Kind 47102 already says who is in this
 * workspace and 30047 already says who is banned — the same facts that
 * decide whether your messages are delivered now decide whether you can
 * clone. One membership list governs the conversation and the code,
 * which is the whole reason a repo is a channel.
 */
export function rosterAccess(query: (filter: Record<string, unknown>) => StoredEvent[], owner?: string): GitAccess {
  const latest = (filter: Record<string, unknown>): StoredEvent | undefined =>
    query(filter).sort((a, b) => b.created_at - a.created_at)[0];

  const roster = (): StoredEvent | undefined =>
    latest({ kinds: [47102], "#d": ["roster"], authors: owner ? [owner] : undefined });

  const members = (): { allowed: Set<string>; banned: Set<string> } => {
    const allowed = new Set<string>();
    const banned = new Set<string>();
    if (owner) allowed.add(owner);
    for (const tag of roster()?.tags ?? []) if (tag[0] === "p" && tag[1]) allowed.add(tag[1]);
    const bans = latest({ kinds: [30047], "#d": ["bans"], authors: owner ? [owner] : undefined });
    for (const tag of bans?.tags ?? []) if (tag[0] === "p" && tag[1]) banned.add(tag[1]);
    return { allowed, banned };
  };

  const may = (who: GitIdentity): boolean => {
    if (!who.pubkey) return false; // a private workspace has no anonymous read
    const { allowed, banned } = members();
    if (banned.has(who.pubkey)) return false;
    return allowed.has(who.pubkey);
  };

  /**
   * The repo's channel, which is where its policy lives.
   *
   * Matched on `meta.repo` rather than the channel NAME: the name is
   * lowercased for display and a repo may legitimately be `API`, so
   * name-matching would quietly fail to find the policy for exactly the
   * repos whose owner used a capital letter — and failing to FIND a
   * policy would read as "unprotected".
   */
  const repoChannel = (repo: string): { protect?: string; upstream?: string } | undefined => {
    // LATEST matching event, not first-found: channel edits are new
    // events with the same d-tag, and taking whichever the store
    // returned first served STALE policy — a protection change or a
    // recorded upstream could be silently ignored (caught by the sync
    // eval, which edits the channel and asserts the edit counts).
    let best: { created_at: number; id: string; meta: Record<string, string> } | undefined;
    for (const event of query({ kinds: [47101], authors: owner ? [owner] : undefined })) {
      try {
        const content = JSON.parse(event.content) as { source?: unknown; meta?: Record<string, string> };
        if (content.source === "fez-git" && content.meta?.repo === repo) {
          // Same resolution rule clients use for owner-signed events
          // (src/kinds.ts): highest created_at wins, ties broken by
          // lowest id — so relay and clients can never disagree about
          // which policy is current.
          const wins =
            !best ||
            event.created_at > best.created_at ||
            (event.created_at === best.created_at && event.id < best.id);
          if (wins) best = { created_at: event.created_at, id: event.id, meta: content.meta };
        }
      } catch {
        // A channel whose content is not JSON is not one of ours.
      }
    }
    return best?.meta;
  };

  // Read and write are the same rule, deliberately: fez's roster is flat
  // (on it = every channel), and inventing per-repo membership here would
  // be a second permission model competing with the one that exists.
  //
  // Ref policy is the one place the roster's ROLES start to matter, and
  // they were already there — 47102 carries ["p", pubkey, role] and this
  // code simply stopped throwing the third element away.
  return {
    canRead: (_repo, who) => may(who),
    canWrite: (_repo, who) => may(who),
    refPolicy: (repo, who) => ({
      protect: resolveProtect(repoChannel(repo)?.protect),
      privileged:
        !!who.pubkey && (who.pubkey === owner || isPrivileged(roleOf(roster()?.tags ?? [], who.pubkey))),
    }),
    // The upstream is a fact adopt recorded on the channel — the same
    // place protection lives, read the same way.
    upstreamOf: (repo) => repoChannel(repo)?.upstream,
  };
}
