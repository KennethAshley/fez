import Link from 'next/link';
import { discordUrl, docsUrl } from '@/lib/shared';

/**
 * The one header every page wears — same links in the same order, so no
 * page quietly drops the entry for itself and the nav stops feeling like
 * one place. The current page's link renders lit instead of vanishing.
 */
const LINKS = [
  { href: 'https://github.com/KennethAshley/fez', label: 'github' },
  { href: '/model', label: 'model' },
  { href: '/playground', label: 'playground' },
  { href: '/app', label: 'app' },
  // The manual lives on its own hostname — an absolute link, not a path.
  { href: docsUrl, label: 'docs' },
  { href: discordUrl, label: 'discord' },
] as const;

export function SiteHeader({ current }: { current?: string }) {
  return (
    <header className="flex flex-col items-start gap-5 py-6 text-xs sm:flex-row sm:items-center sm:justify-between sm:py-8">
      <a href="#main-content" className="sr-only z-50 bg-black px-4 py-3 text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
      <Link href="/" className="shrink-0 text-base font-bold text-white">
        fez<span className="text-[#FF6A00]">▴</span>
      </Link>
      <nav aria-label="Main navigation" className="grid grid-cols-3 gap-x-6 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-5">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current === l.label ? 'page' : undefined}
            className={
              current === l.label
                ? 'text-white'
                : 'text-neutral-400 transition-colors hover:text-white'
            }
          >
            {current === l.label && <span aria-hidden="true" className="text-[#FF6A00]">&gt;</span>}
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
