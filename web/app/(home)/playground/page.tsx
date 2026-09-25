import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '@/components/site-header';
import { DecisionPlayground } from '@/components/decision-playground';
import { playgroundConfig } from '@/lib/playground-server';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'fez — playground',
  description: 'Try typed decision questions and inspect the probability of every answer. Live model responses with source attribution.',
  alternates: { canonical: 'https://fez.chat/playground' },
};

export default function PlaygroundPage() {
  return <div className="min-h-screen bg-black font-mono text-neutral-400">
    <div className="mx-auto w-full max-w-[1240px] px-6 pb-20 sm:px-8">
      <SiteHeader current="playground" />
      <main id="main-content" tabIndex={-1} className="pt-8 sm:pt-12">
        <div className="mb-9">
          <h1 className="text-balance text-[clamp(1.8rem,4vw,2.75rem)] font-medium leading-tight tracking-tight text-white">Decisions, with probabilities.</h1>
          <p className="mt-4 max-w-[65ch] font-sans text-base leading-7 text-neutral-300">Give the model context and typed questions. Inspect every answer, compare the options, and use the same request in your own code.</p>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-3 font-sans text-sm">
            <Link href="/model#quality" className="underline decoration-neutral-700 underline-offset-4 hover:text-white">Model &amp; methodology</Link>
            <a href="https://github.com/ooo-hq/fez" className="underline decoration-neutral-700 underline-offset-4 hover:text-white">Fez on GitHub</a>
            <a href="https://github.com/jaredpalmer/kev/blob/main/kev/serve.py" className="underline decoration-neutral-700 underline-offset-4 hover:text-white">Kev API source</a>
          </div>
        </div>
        <DecisionPlayground {...playgroundConfig()} />
        <footer className="mt-12 border-t border-neutral-800 pt-6 font-sans text-xs leading-6 text-neutral-400">
          Inspired by <a href="https://github.com/jaredpalmer/kev/tree/main/playground" className="underline underline-offset-4">Jared Palmer’s Kev playground</a>. Fez uses Kev’s Apache-2.0 serving code. Playground examples are illustrative, not an evaluation benchmark.
        </footer>
      </main>
    </div>
  </div>;
}
