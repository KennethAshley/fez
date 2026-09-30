import Link from 'next/link';
import { discordUrl, docsUrl } from '@/lib/shared';

/**
 * The one header every page wears — same links in the same order, so no
 * page quietly drops the entry for itself and the nav stops feeling like
 * one place. The current page's link renders lit instead of vanishing.
 */
const LINKS = [
  { href: '/model', label: 'research', id: 'model' },
  { href: '/playground', label: 'playground' },
] as const;

/** Everything else lives in the footer (components/site-footer.tsx). */
export const FOOTER_LINKS = [
  { href: '/app', label: 'Mac app' },
  { href: '/cli', label: 'CLI' },
  // The manual lives on its own hostname — an absolute link, not a path.
  { href: docsUrl, label: 'Docs' },
  { href: discordUrl, label: 'Discord' },
  { href: '/model', label: 'Research' },
  { href: '/playground', label: 'Playground' },
  { href: 'https://github.com/ooo-hq/fez', label: 'Model source' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
] as const;

export function SiteHeader({ current, tone = 'dark' }: { current?: string; tone?: 'light' | 'dark' }) {
  return (
    <header className="flex flex-col items-start gap-5 py-6 text-xs sm:flex-row sm:items-center sm:justify-between sm:py-8">
      <a href="#main-content" className="sr-only z-50 bg-black px-4 py-3 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
      <Link href="/" className={`shrink-0 ${tone === 'light' ? 'text-2xl font-semibold tracking-tight text-black' : 'text-base font-bold text-white'}`}>
        fez<span className="text-[#FF6A00]">▴</span>
      </Link>
      <nav aria-label="Main navigation" className="grid grid-cols-3 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-5">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current === ('id' in l ? l.id : l.label) ? 'page' : undefined}
            className={
              current === ('id' in l ? l.id : l.label)
                ? (tone === 'light' ? 'text-black' : 'text-white')
                : (tone === 'light' ? 'text-neutral-600 transition-colors hover:text-black' : 'text-neutral-400 transition-colors hover:text-white')
            }
          >
            {current === ('id' in l ? l.id : l.label) && <span aria-hidden="true" className="text-[#FF6A00]">&gt;</span>}
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
