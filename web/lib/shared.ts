export const appName = 'fez';
// The manual's own hostname. It is the ONLY address for docs: the
// subdomain's root serves them prefix-free (docs.fez.chat/getting-started),
// and every other host redirects its /docs paths here.
export const docsHost = 'docs.fez.chat';
export const docsUrl = `https://${docsHost}`;
// The app's internal route for docs pages. Readers never see it — the
// proxy maps the subdomain's bare paths onto it — but Next still needs a
// filesystem home for `app/docs/[[...slug]]`, and the markdown/OG routes
// key off it.
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';
