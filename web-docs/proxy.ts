import { NextRequest, NextResponse } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';
import { docsContentRoute } from '@/lib/shared';

/**
 * This app's only proxy job is markdown negotiation: `Accept:
 * text/markdown` (or a `.md` suffix) gets a page's raw source instead
 * of its rendered HTML. No host-sniffing, no /docs prefix — this app's
 * root IS the manual, so there's exactly one pattern pair.
 */
const asSuffix = rewritePath(`{/*path}.md`, `${docsContentRoute}{/*path}/content.md`);
const asPage = rewritePath(`{/*path}`, `${docsContentRoute}{/*path}/content.md`);

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const asMarkdown = asSuffix.rewrite(pathname);
  if (asMarkdown) {
    return NextResponse.rewrite(new URL(asMarkdown, request.nextUrl));
  }

  if (isMarkdownPreferred(request)) {
    const result = asPage.rewrite(pathname);
    if (result) {
      return NextResponse.rewrite(new URL(result, request.nextUrl), {
        // this URL has two representations, selected by `Accept`
        headers: { Vary: 'Accept' },
      });
    }
  }

  return NextResponse.next();
}
