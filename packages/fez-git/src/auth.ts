import { verifyNip98Header } from "@fez/protocol";

/**
 * The URL a git request is authenticated against.
 *
 * Git asks a credential helper for a password ONCE per operation and
 * reuses it for every request in that operation — the GET that fetches
 * refs, then the POST that moves the pack. Those have different paths,
 * so if either side authenticated the literal request URL, the second
 * request would never match the first's signature and every clone would
 * fail on its second breath.
 *
 * Both sides therefore reduce the path to the REPOSITORY, and this is
 * the one place that reduction is defined. The client signs the result;
 * the server compares against the result. Two copies of this function
 * is a protocol that works until someone edits one of them — which is
 * the failure this codebase has already paid for twice (see
 * src/mentions.ts).
 *
 * Confirmed against Buzz, which strips exactly these three suffixes in
 * both its relay transport and its git-credential-nostr helper.
 */

/** `/git/foo.git/info/refs?service=…` → `/git/foo.git` */
export function gitRepoPath(pathAndQuery: string): string {
  const [path] = pathAndQuery.split("?", 1);
  const at = path.indexOf("/info/refs");
  if (at !== -1) return path.slice(0, at);
  for (const suffix of ["/git-upload-pack", "/git-receive-pack"]) {
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length);
  }
  return path;
}

/** The absolute URL to sign or verify, given what git handed us. */
export function gitAuthUrl(protocol: string, host: string, pathAndQuery: string): string {
  const path = gitRepoPath(pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`);
  return `${protocol}://${host}${path}`;
}

/**
 * fez's authenticator for the relay's git server.
 *
 * The relay package deliberately knows nothing about nostr keys — it
 * takes a function. This is that function: NIP-98 in, a pubkey out.
 * Composed by whoever starts a relay with git enabled, which keeps
 * @fez/protocol out of a dumb event store's dependency list.
 *
 * `checkMethod` is off because git signs once with GET and reuses the
 * token for the POST; the URL lock plus the 60-second window is what
 * carries the security. See src/nip98.ts for the full argument.
 */
export function nip98Authenticator(opts: { origins?: readonly string[] } = {}) {
  return (
    req: { headers: Record<string, string | string[] | undefined>; method?: string },
    repoPath: string
  ): { pubkey?: string; reason?: string } => {
    const header = req.headers["authorization"];
    const result = verifyNip98Header(typeof header === "string" ? header : undefined, {
      method: req.method ?? "GET",
      path: repoPath,
      origins: opts.origins,
      checkMethod: false,
    });
    return result.ok ? { pubkey: result.pubkey } : { reason: result.reason };
  };
}
