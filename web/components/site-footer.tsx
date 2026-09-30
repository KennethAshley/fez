import Link from 'next/link';
import { FOOTER_LINKS } from '@/components/site-header';
import s from '@/components/light.module.css';

/** The one footer: app, CLI, docs and Discord live here, not in the header. */
export function SiteFooter({ tone = 'light' }: { tone?: 'light' | 'dark' }) {
  if (tone === 'dark') {
    return (
      <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-5 border-t border-neutral-900 px-6 py-8 font-mono text-xs text-neutral-500 sm:px-8">
        <Link href="/" className="text-neutral-300">fez<span className="text-[#FF6A00]">▴</span></Link>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          {FOOTER_LINKS.map((l) => <Link key={l.href + l.label} href={l.href} className="hover:text-neutral-200">{l.label}</Link>)}
        </nav>
      </footer>
    );
  }
  return (
    <footer className="overflow-hidden border-t border-neutral-200 bg-white text-neutral-950">
      <div className="mx-auto grid max-w-5xl gap-10 px-6 pt-14 sm:px-8 md:grid-cols-[1fr_auto]">
        <div>
          <Link href="/" className="text-2xl font-semibold tracking-tight">fez<span className="text-[#FF6A00]">▴</span></Link>
          <p className="mt-3 text-sm text-neutral-600">Specialized models.<br />Decisions that are yours.</p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-12 gap-y-1.5 text-sm sm:grid-cols-3">
          {FOOTER_LINKS.map((l) => <Link key={l.href + l.label} href={l.href} className="hover:text-[#3455dc]">{l.label}</Link>)}
        </nav>
      </div>
      <div className="mx-auto mt-10 flex max-w-5xl justify-between gap-4 px-6 font-mono text-[10px] tracking-[0.1em] text-neutral-500 sm:px-8">
        <span>YOUR DATA. YOUR DECISION MODEL.</span>
        <span>FEZ.CHAT / EARLY ACCESS</span>
      </div>
      <p aria-hidden="true" className="mx-auto mt-6 max-w-6xl select-none px-4 text-[clamp(8rem,34vw,26rem)] font-semibold leading-[0.72] tracking-[-0.08em]">
        fez<span className="text-[#FF6A00]">▴</span>
      </p>
    </footer>
  );
}

/** Drifting pastel light + grain + scanlines behind a light page's top. */
export function LightBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <div className={`absolute -right-40 -top-48 size-[720px] rounded-full bg-[radial-gradient(circle,#a9c9ff_0%,transparent_60%)] blur-2xl ${s.drift}`} />
      <div className={`absolute -right-10 top-32 size-[520px] rounded-full bg-[radial-gradient(circle,#f3c3f0_0%,transparent_60%)] blur-2xl ${s.driftSlow}`} />
      <div className={`absolute right-[38%] -top-20 size-[420px] rounded-full bg-[radial-gradient(circle,#bdf1f8_0%,transparent_62%)] blur-2xl ${s.drift}`} />
      <div className={`absolute -left-48 top-[480px] size-[520px] rounded-full bg-[radial-gradient(circle,#ffd9bd_0%,transparent_60%)] blur-2xl ${s.driftSlow}`} />
      <div className={`absolute inset-0 ${s.grain}`} />
      <div className={`absolute inset-0 ${s.scanlines}`} />
    </div>
  );
}
