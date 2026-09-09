import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { docsContentRoute, docsRoute } from '@/lib/shared';

const { rewrite: rewriteDocs } = rewritePath(
  `${docsRoute}{/*path}`,
  `${docsContentRoute}{/*path}/content.md`,
);
const { rewrite: rewriteSuffix } = rewritePath(
  `${docsRoute}{/*path}.md`,
  `${docsContentRoute}{/*path}/content.md`,
);

/**
 * The manual has ONE address: docs.fez.chat.
 *
 * Both hostnames point at this same app, so the docs used to answer at
 * two URLs (docs.fez.chat/docs and fez.chat/docs) with the marketing
 * home sitting on the docs subdomain's root — two front doors, neither
 * canonical. Now the subdomain IS the manual (its root serves the docs
 * index) and the apex redirects its /docs paths there, so links people
 * saved keep working and search engines see one home.
 *
 * Paths already under /docs pass through untouched on the docs host:
 * fumadocs generates its links with that prefix, and rewriting them
 * would double it (/docs/docs/...).
 */
const DOCS_HOST = 'docs.fez.chat';

function docsHostRouting(request: NextRequest): NextResponse | undefined {
  const host = request.headers.get('host')?.split(':')[0];
  const { pathname } = request.nextUrl;

  if (host === DOCS_HOST) {
    if (pathname === '/') {
      return NextResponse.rewrite(new URL(docsRoute, request.nextUrl));
    }
    return undefined; // /docs/* and every asset path serve as-is
  }

  // The apex keeps its own site; only its docs paths move.
  if (pathname === docsRoute || pathname.startsWith(`${docsRoute}/`)) {
    const target = new URL(request.nextUrl);
    target.host = DOCS_HOST;
    target.port = '';
    target.protocol = 'https:';
    return NextResponse.redirect(target, 308);
  }

  return undefined;
}

export default function proxy(request: NextRequest) {
  const result = rewriteSuffix(request.nextUrl.pathname);
  if (result) {
    return NextResponse.rewrite(new URL(result, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const result = rewriteDocs(request.nextUrl.pathname);

    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl), {
        // this URL has two representations, selected by `Accept`
        headers: { Vary: 'Accept' },
      });
    }
  }

  // Host routing runs last: the markdown-negotiation rewrites above are
  // content negotiation on a path, and they must win on either host.
  // Localhost and preview deployments match neither branch, so `next dev`
  // and *.vercel.app keep serving both the site and /docs as before.
  return docsHostRouting(request) ?? NextResponse.next();
}
