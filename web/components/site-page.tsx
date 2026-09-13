import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';

export function SitePage({ current, title, description, note, children }: {
  current: string;
  title: string;
  description: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400">
      <div className="mx-auto w-full max-w-5xl px-6 pb-24 sm:px-8">
        <SiteHeader current={current} />
        <main id="main-content" tabIndex={-1} className="pt-10 sm:pt-16">
          <div className="mb-12 max-w-3xl sm:mb-16">
            <h1 className="max-w-[20ch] text-balance text-[clamp(2rem,5vw,3.5rem)] font-medium leading-[1.12] tracking-tight text-white">{title}</h1>
            <p className="mt-6 max-w-[58ch] font-sans text-lg leading-relaxed text-neutral-300">{description}</p>
            {note && <p className="mt-5 font-sans text-sm text-neutral-400">{note}</p>}
          </div>
          <div className="font-sans text-base leading-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function ArticleContents({ items }: { items: readonly { id: string; title: string }[] }) {
  return (
    <nav aria-label="On this page" className="mb-10 lg:sticky lg:top-8 lg:mb-0 lg:self-start">
      <p className="mb-3 text-sm font-medium text-white">On this page</p>
      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm leading-6 lg:flex-col">
        {items.map(({ id, title }) => <li key={id}><a href={`#${id}`} className="underline decoration-neutral-700 underline-offset-4 hover:text-white">{title}</a></li>)}
      </ol>
    </nav>
  );
}

export function PageSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="mb-5 font-mono text-xl font-medium leading-snug tracking-tight text-white sm:text-2xl">{title}</h2>
      {children}
    </section>
  );
}
