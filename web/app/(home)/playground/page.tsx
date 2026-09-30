import type { Metadata } from 'next';
import Link from 'next/link';
import { DecisionPlayground } from '@/components/decision-playground';
import { LightBackdrop, SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { playgroundConfig } from '@/lib/playground-server';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'fez — playground',
  description: 'Try the decisions a Fez model is built for: model routing, tool selection, and escalation. Inspect the probability of every option.',
  alternates: { canonical: 'https://fez.chat/playground' },
};

export default function PlaygroundPage() {
  return <div className="min-h-screen bg-white font-sans text-neutral-950 antialiased selection:bg-[#FF6A00] selection:text-black">
    <div className="relative overflow-hidden">
      <LightBackdrop />
      <div className="relative mx-auto max-w-6xl px-6 sm:px-8"><SiteHeader tone="light" current="playground" /></div>
      <header className="relative mx-auto max-w-6xl px-6 pb-10 pt-8 sm:px-8 sm:pt-12">
        <p className="flex items-center gap-2 text-[12px] font-medium"><span aria-hidden="true" className="text-base">✳</span> Playground · Experimental</p>
        <h1 className="mt-5 max-w-[18ch] text-[clamp(2.5rem,6vw,4.4rem)] font-semibold leading-[0.98] tracking-[-0.06em]">Ask for a decision. See every probability.</h1>
        <p className="mt-5 max-w-[60ch] text-lg leading-8 text-neutral-600">Try the calls a decision model is built to replace: which model to use, which tool to call, when to escalate. Context in, probabilities out. No generated prose.</p>
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href="/model#quality" className="underline decoration-neutral-300 underline-offset-4 hover:text-[#3455dc]">Model &amp; methodology</Link>
          <a href="https://github.com/ooo-hq/fez" className="underline decoration-neutral-300 underline-offset-4 hover:text-[#3455dc]">Fez on GitHub</a>
        </div>
      </header>
    </div>
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-6 pb-20 sm:px-8">
      <DecisionPlayground {...playgroundConfig()} />
      <p className="mt-10 border-t border-neutral-200 pt-6 text-xs leading-6 text-neutral-500">Playground examples are illustrative, not an evaluation benchmark. Answers come only from the connected Fez checkpoint; there is no fallback model.</p>
    </main>
    <SiteFooter />
  </div>;
}
