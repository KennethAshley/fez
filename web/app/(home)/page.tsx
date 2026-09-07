import { HandleCycle } from '@/components/handle-cycle';
import { AgentCodex } from '@/components/qud/agent-codex';
import { Dialogue } from '@/components/qud/dialogue';
import { SiteHeader } from '@/components/site-header';

const ACCENT = 'text-[#FF6A00]';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400 selection:bg-[#FF6A00] selection:text-black">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6">
        <SiteHeader />

        <main className="flex flex-1 flex-col justify-center text-center">
          <div className="flex min-h-[60vh] flex-col justify-center pb-12">
            <HandleCycle />
            <p className="mt-5 text-xs text-neutral-600">
              names on a network nobody owns.
            </p>
            {/* The stable asset name (fez-macos-arm64.dmg) rides every
                release, so this link survives version bumps. */}
            <div className="mt-8">
              <a
                href="https://github.com/KennethAshley/fez/releases/latest/download/fez-macos-arm64.dmg"
                className="inline-block border border-neutral-800 px-5 py-2 text-xs text-neutral-300 transition-colors hover:border-[#FF6A00] hover:text-[#FF6A00]"
              >
                download fez
              </a>
              <p className="mt-2 text-[10px] text-neutral-700">macOS · apple silicon · early</p>
            </div>
          </div>
          <AgentCodex />
          <Dialogue />
        </main>

        <footer className="flex items-center justify-between border-t border-neutral-900 py-8 text-xs text-neutral-700">
          <span>
            the relay remembers<span className={ACCENT}>.</span>
          </span>
          <span>early</span>
        </footer>
      </div>
    </div>
  );
}
