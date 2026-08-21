import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  registerHttpHandler(handler: {
    handle(req: IncomingMessage, res: ServerResponse): boolean | Promise<boolean>;
  }): void;
  query(filter: Record<string, unknown>): StoredEvent[];
  dataDir(name: string): string;
  advertise(key: string, value: unknown): void;
  origins: readonly string[];
  owner?: string;
  log(line: string): void;
}

export default function activate(api: RelayExtensionAPI): void {
  const root = path.join(api.dataDir("fez-git"), "repos");

  if (!api.owner) {
    // Without an owner no roster event can be valid, so rosterAccess
    // would allow nobody — say that rather than serving 403s that look
    // like a bug in the credential helper.
    api.log("⚠️  this relay is unclaimed (--owner not set): nobody can read or write a repo here.");
  }

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
    access: rosterAccess((filter) => api.query(filter), api.owner),
    log: (line) => api.log(line),
  });

  api.registerHttpHandler(server);

  // Say where git is, rather than leaving clients to rebuild the URL from
  // the websocket address. That derivation is right on a laptop and wrong
  // behind any proxy that terminates TLS or moves git to another host —
  // and wrong silently, which is the worst way for it to be wrong. The
  // operator already stated the public origin with --origin; this just
  // publishes it. Buzz reaches the same conclusion from the other end:
  // its repo announcements carry an explicit `clone` tag.
  //
  // No origin means no advertisement. A client that finds nothing here
  // knows it cannot learn the URL, which is a better answer than a
  // confident guess it will only discover is wrong on `git push`.
  const base = api.origins[0];
  if (base) api.advertise("fez_git", { clone_base: `${base.replace(/\/+$/, "")}/git` });

  api.log(`serving git from ${root}`);
}
