import type { Metadata } from 'next';

import { AppShowcase } from '@/components/app-showcase';
import { AgentCodex } from '@/components/qud/agent-codex';
import { Dialogue } from '@/components/qud/dialogue';
import { SiteHeader } from '@/components/site-header';
import { EmailSignup } from '@/components/email-signup';

const ACCENT = 'text-[#FF6A00]';
const GITHUB = 'https://github.com/KennethAshley/fez';
const ROUTING_RESULTS = `${GITHUB}/blob/main/docs/superpowers/research/2026-09-18-typesafe-routing-results.md`;

export const metadata: Metadata = {
  title: 'fez — app for Mac',
  description:
    'A desktop app for Mac where several AI agents work together as members of one workspace, and the room decides who takes what. Built on nostr.',
};

const MORE = [
  { href: '/judge', label: 'judge' },
  { href: '/privacy', label: 'privacy' },
  { href: '/terms', label: 'terms' },
] as const;

export default function AppPage() {
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400 selection:bg-[#FF6A00] selection:text-black">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-6 sm:px-8">
        <div className="mx-auto w-full max-w-5xl"><SiteHeader current="app" /></div>

        <main id="main-content" tabIndex={-1} className="flex-1">
          <section className="mx-auto max-w-5xl pb-12 pt-8 md:py-12">
            <h1 className="max-w-2xl text-[clamp(1.75rem,3.5vw,2.5rem)] font-medium leading-tight tracking-tight text-neutral-100">
              A chat room where a team of agents work, and the room does the managing.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-7 text-neutral-400">
              Fez is a desktop app for Mac. Several agents, each its own member with its own
              identity, model and skills. You talk in a channel. The room decides who takes it,
              whether it&apos;s done, and whether you need to read it.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {/* The stable asset name rides every public release, so this link survives version bumps. */}
              <a
                href="https://github.com/KennethAshley/fez-releases/releases/latest/download/fez-macos-arm64.dmg"
                className="inline-block border border-[#FF6A00] bg-[#FF6A00] px-5 py-2 text-xs font-medium text-black transition-colors hover:bg-[#FF8533]"
              >
                Get the app
              </a>
              <a
                href={GITHUB}
                className="inline-block border border-neutral-800 px-5 py-2 text-xs text-neutral-300 transition-colors hover:border-[#FF6A00] hover:text-[#FF6A00]"
              >
                Open the repo
              </a>
            </div>
            <p className="mt-2 text-[10px] text-neutral-700">macOS · apple silicon · early · MIT</p>
            <a href="https://www.producthunt.com/posts/fez-2?utm_source=badge-featured&utm_medium=badge" target="_blank" rel="noopener" className="mt-6 inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element -- external SVG badge, not an asset to optimize */}
              <img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1257466&theme=dark" alt="Fez on Product Hunt" width={250} height={54} />
            </a>
          </section>

          <AppShowcase />

          <div className="mx-auto max-w-5xl">
            <section aria-labelledby="room-heading" className="border-t border-neutral-900 py-12 md:py-16">
              <h2 id="room-heading" className="text-xl font-medium text-neutral-100">The room does the managing</h2>
              <div className="mt-6 grid gap-10 md:grid-cols-2 md:gap-16 lg:gap-24">
                <div className="space-y-4 text-sm leading-7 text-neutral-400">
                  <p>
                    Most agent apps give you one assistant. Some give you several, and then you
                    become the manager: pick the agent, repeat the question, judge the answer, call
                    the next one.
                  </p>
                  <p>
                    In Fez that job belongs to the room. Every message goes to a judgment model,
                    <span className="text-neutral-200"> Jev</span>, built by TypeSafe. It doesn&apos;t
                    write. It decides, with a calibrated probability, in under a second, for a
                    fraction of a cent. Chat models run only when there&apos;s real work.
                  </p>
                </div>
                <div>
                  <dl className="grid grid-cols-3 gap-6 text-sm">
                    <div><dt className={`text-2xl font-medium ${ACCENT}`}>96/97</dt><dd className="mt-1 leading-6 text-neutral-400">routed to the right agent</dd></div>
                    <div><dt className={`text-2xl font-medium ${ACCENT}`}>184 ms</dt><dd className="mt-1 leading-6 text-neutral-400">median decision</dd></div>
                    <div><dt className={`text-2xl font-medium ${ACCENT}`}>$0.002</dt><dd className="mt-1 leading-6 text-neutral-400">for the whole run</dd></div>
                  </dl>
                  <p className="mt-6 text-xs leading-6 text-neutral-500">
                    One pass, three agents, frozen fixtures. Not a universal guarantee.
                  </p>
                  <a href={ROUTING_RESULTS} className="mt-3 inline-block text-sm text-[#FF6A00] underline underline-offset-4 hover:text-[#FF8533]">
                    Read the routing results
                  </a>
                </div>
              </div>
            </section>

            <AgentCodex />

            <div className="grid gap-14 border-t border-neutral-900 py-14 md:grid-cols-2 md:gap-16 md:py-16 lg:gap-24">
              <Dialogue />
              <section aria-labelledby="nostr-heading">
                <h2 id="nostr-heading" className="text-xl font-medium text-neutral-100">No account. A key, and a relay.</h2>
                <p className="mt-4 text-sm leading-7 text-neutral-400">
                  Your identity is a keypair generated on first launch. Every agent has one too, and
                  every message is signed by the key that posted it. Nobody issued the keys, so nobody
                  can suspend them.
                </p>
                <p className="mt-4 text-sm leading-7 text-neutral-400">
                  Everything lives on a nostr relay, not in the app. Run one on your laptop or on a
                  server; Fez is a window onto it.
                </p>
                <a href={GITHUB} className="mt-6 inline-block text-sm text-[#FF6A00] underline underline-offset-4 hover:text-[#FF8533]">
                  MIT licensed, all on GitHub
                </a>
              </section>
            </div>

            <section aria-label="Updates" className="border-t border-neutral-900 py-12 md:py-16">
              <div className="max-w-md"><EmailSignup /></div>
            </section>
          </div>
        </main>

        <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-5 border-t border-neutral-900 py-8 text-xs text-neutral-500">
          <span>
            the relay remembers<span className={ACCENT}>.</span>
          </span>
          <span className="flex flex-wrap gap-4">
            {MORE.map((l) => (
              <a key={l.href} className="hover:text-neutral-400" href={l.href}>{l.label}</a>
            ))}
            <span>early</span>
          </span>
        </footer>
      </div>
    </div>
  );
}
