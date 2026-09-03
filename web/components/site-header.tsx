import Link from 'next/link';

/**
 * The one header every page wears — same links in the same order, so no
 * page quietly drops the entry for itself and the nav stops feeling like
 * one place. The current page's link renders lit instead of vanishing.
 */
const LINKS = [
  { href: '/bazaar', label: 'bazaar' },
  { href: '/whitepaper', label: 'whitepaper' },
  { href: '/judge', label: 'judge' },
  { href: '/roadmap', label: 'roadmap' },
  { href: '/docs', label: 'docs' },
] as const;

export function SiteHeader({ current }: { current?: string }) {
  return (
    <header className="flex items-center justify-between py-8 text-xs">
      <Link href="/" className="font-bold text-white">
        fez<span className="text-[#FF6A00]">▴</span>
      </Link>
      <nav className="flex gap-5">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={
              current === l.label
                ? 'text-[#cfc041]'
                : 'text-neutral-600 transition-colors hover:text-white'
            }
          >
            {current === l.label && <span className="text-[#FF6A00]">&gt;</span>}
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
