import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { docsContentRoute, docsHost, docsRoute } from '@/lib/shared';

/**
 * The manual has ONE address: docs.fez.chat, prefix-free.
 *
 * Every hostname points at this same app, so the docs used to answer at
 * two URLs — docs.fez.chat/docs/x and fez.chat/docs/x — with the
 * marketing home sitting on the docs subdomain's root. Now the subdomain
 * IS the manual: its root serves the index and `/getting-started` serves
 * that page, rewritten onto the internal `docsRoute` before Next routes
 * it (Fumadocs generates the prefix-free links; see lib/source.ts).
 * Every other host 308s its /docs paths to the subdomain, so links people
 * saved keep working and search engines see one home.
 *
 * Dev mirrors prod: `docs.localhost:3000` is a docs host too (browsers
 * resolve *.localhost to 127.0.0.1 with no /etc/hosts entry), and
 * localhost:3000/docs redirects there, so the same code path runs
 * locally. Preview deployments (*.vercel.app) match neither branch and
 * serve the app unchanged.
 */
const DOCS_HOSTS = new Set([docsHost, 'docs.localhost']);

/** Paths the docs host must serve as-is — framework and API surface. */
const PASSTHROUGH = ['/_next', '/api', '/og', '/llms', '/favicon', '/robots', '/sitemap'];

// Markdown negotiation (Accept: text/markdown → the page's raw source).
// Two patterns: bare paths on the docs host, /docs-prefixed elsewhere.
const bareSuffix = rewritePath(`{/*path}.md`, `${docsContentRoute}{/*path}/content.md`);
const barePage = rewritePath(`{/*path}`, `${docsContentRoute}{/*path}/content.md`);
const docsSuffix = rewritePath(`${docsRoute}{/*path}.md`, `${docsContentRoute}{/*path}/content.md`);
const docsPage = rewritePath(`${docsRoute}{/*path}`, `${docsContentRoute}{/*path}/content.md`);

export default function proxy(request: NextRequest) {
  const host = request.headers.get('host')?.split(':')[0] ?? '';
  const { pathname } = request.nextUrl;
  const onDocsHost = DOCS_HOSTS.has(host);

  const suffix = onDocsHost ? bareSuffix : docsSuffix;
  const page = onDocsHost ? barePage : docsPage;

  const asMarkdown = suffix.rewrite(pathname);
  if (asMarkdown) {
    return NextResponse.rewrite(new URL(asMarkdown, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const result = page.rewrite(pathname);
    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl), {
        // this URL has two representations, selected by `Accept`
        headers: { Vary: 'Accept' },
      });
    }
  }

  if (onDocsHost) {
    if (PASSTHROUGH.some((prefix) => pathname.startsWith(prefix))) {
      return NextResponse.next();
    }
    // A stale /docs link that reached the subdomain: strip the prefix
    // rather than serve the page at two addresses.
    if (pathname === docsRoute || pathname.startsWith(`${docsRoute}/`)) {
      const stripped = new URL(request.nextUrl);
      stripped.pathname = pathname.slice(docsRoute.length) || '/';
      return NextResponse.redirect(stripped, 308);
    }
    const target = new URL(request.nextUrl);
    target.pathname = pathname === '/' ? docsRoute : `${docsRoute}${pathname}`;
    return NextResponse.rewrite(target);
  }

  // Off the docs host, /docs belongs to the subdomain — but only when we
  // know which subdomain to send people to (a preview deployment has no
  // docs.* twin, so it keeps serving the route itself).
  if (pathname === docsRoute || pathname.startsWith(`${docsRoute}/`)) {
    const docsTwin =
      host === 'fez.chat' || host === 'www.fez.chat'
        ? docsHost
        : host === 'localhost'
          ? `docs.localhost:${request.nextUrl.port || '3000'}`
          : undefined;
    if (docsTwin) {
      const target = new URL(request.nextUrl);
      target.host = docsTwin;
      target.protocol = host === 'localhost' ? 'http:' : 'https:';
      target.pathname = pathname.slice(docsRoute.length) || '/';
      return NextResponse.redirect(target, 308);
    }
  }

  return NextResponse.next();
}
