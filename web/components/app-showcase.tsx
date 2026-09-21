'use client';

import Image from 'next/image';
import { useState } from 'react';

/**
 * The tour, embedded. The poster is the same frame the README uses; the
 * YouTube iframe only loads once someone presses play, so the front page
 * costs no third-party requests until asked.
 */
const VIDEO_ID = 'eyirodwkW1Y';
const TITLE = 'Two agents, two models, two keys, one thread. A 7-minute tour of Fez.';

const CALLS = [
  { q: 'Who takes it?', a: 'The room reads the message and picks the agent, or nobody.', score: '0.95' },
  { q: 'Is it done?', a: 'It checks the answer against what you asked and signs off, silently.', score: '0.94' },
  { q: 'Does it need a reply?', a: 'A thanks gets a reaction, not a paragraph. No turn, no cost.', score: '0.08' },
];

export function AppShowcase() {
  const [playing, setPlaying] = useState(false);
  return (
    <section aria-label="See Fez in action" className="pb-12 md:pb-16">
      <figure>
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-neutral-900 bg-black">
          {playing ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${VIDEO_ID}?autoplay=1`}
              title={TITLE}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              aria-label={`Play: ${TITLE}`}
              className="group absolute inset-0 h-full w-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#FF6A00]"
            >
              <Image src="/fez-tour.jpg" alt="" fill sizes="(min-width: 1024px) 1024px, 100vw" priority className="object-cover" />
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="flex h-16 w-16 items-center justify-center rounded-full border border-neutral-700 bg-black/70 text-[#FF6A00] transition-colors group-hover:border-[#FF6A00]">
                  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>
                </span>
              </span>
            </button>
          )}
        </div>
        <figcaption className="mx-auto mt-4 max-w-5xl text-xs leading-5 text-neutral-500">
          Two agents, two models, two keys, one thread. Seven minutes, recorded live.
        </figcaption>
      </figure>

      <ol aria-label="The three calls the room makes" className="mx-auto mt-10 grid max-w-5xl gap-7 sm:grid-cols-3 sm:gap-10 md:mt-14">
        {CALLS.map((c) => (
          <li key={c.q}>
            <h2 className="text-base font-medium text-neutral-100">
              {c.q} <span className="ml-2 text-sm text-[#FF6A00]">{c.score}</span>
            </h2>
            <p className="mt-2 text-sm leading-6 text-neutral-400">{c.a}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
