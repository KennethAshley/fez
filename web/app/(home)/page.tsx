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
