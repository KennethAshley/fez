import path from "node:path";
import { gitServer, rosterAccess, type StoredEvent } from "./serve.js";
import { nip98Authenticator } from "./auth.js";

/**
 * fez-git as an installed relay extension.
 *
 * `fez install @fez/git` drops this in ~/.fez/relay-extensions, and a
 * relay started with --extensions loads it. Nothing in fez-relay knows
 * what git is: it offers registerHttpHandler and this claims /git/*,
 * exactly as a GUI extension claims a settings panel.
 *
 * That is the whole reason this file exists rather than a `git?:` option
 * on the relay. A feature that requires editing the host is not an
 * extension, it is a fork with extra steps.
 */

interface RelayExtensionAPI {
  registerHttpHandler(handler: { handle(req: never, res: never): boolean | Promise<boolean> }): void;
  query(filter: Record<string, unknown>): StoredEvent[];
  dataDir(name: string): string;
  origins: readonly string[];
  log(line: string): void;
}

export default function activate(api: RelayExtensionAPI): void {
  const root = path.join(api.dataDir("fez-git"), "repos");

  if (api.origins.length === 0) {
    // Not fatal — a dev relay on localhost is a legitimate posture — but
    // it means a token signed for ANY host is accepted here, so it must
    // never pass quietly on something public.
    api.log("⚠️  no --origin given: signed requests are checked by path only. Do not do this on a public relay.");
  }

  const server = gitServer({
    root,
    authenticate: nip98Authenticator({ origins: api.origins }),
    // The workspace roster IS the repo's access control. Nothing new is
    // invented: the same 47102 that decides whether your messages are
    // delivered decides whether you may clone, and the same 30047 ban
    // takes both away at once.
    access: rosterAccess((filter) => api.query(filter)),
    log: (line) => api.log(line),
  });

  api.registerHttpHandler(server as never);
  api.log(`serving git from ${root}`);
}
