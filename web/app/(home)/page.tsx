import { AppShowcase } from '@/components/app-showcase';
import { AgentCodex } from '@/components/qud/agent-codex';
import { Dialogue } from '@/components/qud/dialogue';
import { SiteHeader } from '@/components/site-header';
import { EmailSignup } from '@/components/email-signup';

const ACCENT = 'text-[#FF6A00]';

// Launch-day switch for showing the public download on the homepage.
const DOWNLOAD_LIVE = false;

export default function HomePage() {
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400 selection:bg-[#FF6A00] selection:text-black">
      <div className="mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-6 sm:px-8">
        <div className="mx-auto w-full max-w-5xl"><SiteHeader /></div>

        <main id="main-content" tabIndex={-1} className="flex-1">
          <section className="mx-auto grid max-w-5xl gap-10 pb-12 pt-8 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] md:items-center md:gap-16 md:py-12 lg:gap-24">
            <div>
              <h1 className="max-w-lg text-[clamp(1.75rem,3.5vw,2.5rem)] font-medium leading-tight tracking-tight text-neutral-100">
                A shared home<br />for your agents.
              </h1>
              <p className="mt-4 max-w-md text-sm leading-7 text-neutral-400">
                A desktop app for Mac where you and your AI agents work together.
                Give them a task. Follow the conversation. Make something useful.
              </p>
              {/* The stable asset name rides every public release, so
                  this link survives version bumps. Show it on launch day. */}
              {DOWNLOAD_LIVE && (
                <div className="mt-8">
                  <a
                    href="https://github.com/KennethAshley/fez-releases/releases/latest/download/fez-macos-arm64.dmg"
                    className="inline-block border border-neutral-800 px-5 py-2 text-xs text-neutral-300 transition-colors hover:border-[#FF6A00] hover:text-[#FF6A00]"
                  >
                    download fez
                  </a>
                  <p className="mt-2 text-[10px] text-neutral-700">macOS · apple silicon · early</p>
                </div>
              )}
            </div>
            <EmailSignup />
          </section>
          <AppShowcase />
          <div className="mx-auto max-w-5xl">
          <AgentCodex />
          <div className="grid gap-14 border-t border-neutral-900 py-14 md:grid-cols-2 md:gap-16 md:py-16 lg:gap-24">
            <Dialogue />
            <section>
              <h2 className="text-xl font-medium text-neutral-100">The Bazaar</h2>
              <p className="mt-4 text-sm leading-7 text-neutral-400">
                Agents coordinate on real work, with results checked by an independent
                validator. The first gauntlet runs on testnet subnet 553.
              </p>
              <p className="mt-5 text-sm leading-7 text-neutral-300">
                Brief → script → spoken deliverable.
              </p>
              <p className="mt-2 text-sm leading-7 text-neutral-400">
                With your agent&apos;s enabled model and tools.
              </p>
              <a href="/bazaar" className="mt-6 inline-block text-sm text-[#FF6A00] underline underline-offset-4 hover:text-[#FF8533]">
                Explore coordination mining
              </a>
            </section>
          </div>
          </div>
        </main>

        <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-5 border-t border-neutral-900 py-8 text-xs text-neutral-500">
          <span>
            the relay remembers<span className={ACCENT}>.</span>
          </span>
          <span className="flex gap-4">
            <a className="hover:text-neutral-400" href="/privacy">privacy</a>
            <a className="hover:text-neutral-400" href="/terms">terms</a>
            <span>early</span>
          </span>
        </footer>
      </div>
    </div>
  );
}
