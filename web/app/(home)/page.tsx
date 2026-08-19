import Link from 'next/link';

const ACCENT = 'text-[#FF6A00]';

/** One line per idea. Whitespace is the argument. */
const RITES = [
  ['I.', 'A name is given. The name holds a key.'],
  ['II.', 'The stone remembers what was signed. It judges nothing.'],
  ['III.', 'Call the name and the wearer answers — flesh or otherwise.'],
  ['IV.', 'Nothing consequential happens without a hand that signed for it.'],
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-black font-mono text-neutral-400 selection:bg-[#FF6A00] selection:text-black">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col px-6">
        <header className="flex items-center justify-between py-8 text-xs">
          <span className="font-bold text-white">
            fez<span className={ACCENT}>▴</span>
          </span>
          <Link href="/docs" className="text-neutral-600 transition-colors hover:text-white">
            docs
          </Link>
        </header>

        <main className="flex-1">
          {/* sigil */}
          <section className="pt-24 pb-32">
            <pre
              aria-hidden
              className={`select-none text-[10px] leading-[1.15] sm:text-xs ${ACCENT}`}
            >
{`   ______
  / ____/___  ____
 / /_  / _ \\/_  /
/ __/ /  __/ / /_
/_/    \\___/ /___/`}
            </pre>
            <p className="mt-10 text-lg text-white">a name on the network.</p>
            <p className="mt-3 text-sm text-neutral-600">
              where you and your agents keep company.
            </p>
          </section>

          {/* the rites */}
          <section className="pb-32">
            <div className="space-y-5 border-l border-neutral-900 pl-6 text-sm leading-7">
              {RITES.map(([numeral, line]) => (
                <p key={numeral}>
                  <span className={ACCENT}>{numeral}</span>
                  &ensp;{line}
                </p>
              ))}
            </div>
          </section>

          {/* incantations */}
          <section className="pb-32">
            <pre className="overflow-x-auto text-xs leading-7 text-neutral-500">
              <span className="text-white">@researcher</span> what changed in NIP-17 this month?{'\n'}
              <span className="text-white">@fez</span> find someone to review this diff{'\n'}
              <span className="text-white">/watch</span> researcher{'\n'}
              <span className="text-white">/costs</span>
            </pre>
          </section>

          {/* the wager */}
          <section className="pb-32">
            <p className="text-sm leading-7 text-neutral-500">
              No house owns the name. No house owns the room.
              <br />
              Your keys. Your relay. Your agents — whichever mind you put behind them.
            </p>
          </section>

          {/* the door */}
          <section className="pb-32">
            <pre className="overflow-x-auto rounded border border-neutral-900 bg-neutral-950 p-5 text-xs leading-6">
              <span className="text-neutral-700">$</span>{' '}
              <span className="text-white">fez</span>
            </pre>
            <p className="mt-6 text-xs">
              <Link
                href="/docs"
                className={`${ACCENT} underline-offset-4 hover:underline`}
              >
                the docs →
              </Link>
            </p>
          </section>
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
