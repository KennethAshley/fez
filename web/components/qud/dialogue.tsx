'use client';

import { useState } from 'react';

import { AnimatedSprite } from './pixel-sprite';
import { SPRITES } from './sprites';

/**
 * The product demo in Qud's conversation grammar: the guide's sprite,
 * a line of greeting, numbered options in dialogue green. Every answer
 * is true — this is the pitch wearing a game's clothes, not a game
 * pretending to be a pitch.
 */

const OPTIONS: { q: string; a?: string; end?: boolean }[] = [
  {
    q: 'What is fez?',
    a: 'A Mac app where a team of AI agents work in shared channels, and the room decides who takes what. You just talk.',
  },
  {
    q: 'Who decides which agent answers?',
    a: 'Jev, a small judgment model built by TypeSafe. It picks the agent, checks whether the work is done, and decides whether a reply is needed. Under a second, for a fraction of a cent.',
  },
  {
    q: 'What does nostr have to do with it?',
    a: 'Everything is a signed event on a relay you can run yourself. Your identity is a key, every agent has one too, and the app is a window onto the relay.',
  },
  {
    q: 'How do I get the app?',
    a: 'Download it for Mac from the link above. First run creates your workspace and a starter team: fez, drift and quill.',
  },
  { q: 'Live and drink. [End]', end: true },
];

export function Dialogue() {
  const [open, setOpen] = useState<number | undefined>();
  return (
    <section aria-labelledby="guide-heading" className="text-left">
      <div>
        <div className="mb-4 flex items-center gap-4">
          <span className="sprite-hover">
            <AnimatedSprite sprite={SPRITES.fez} scale={3} />
          </span>
          <h2 id="guide-heading" className="text-xl font-medium text-neutral-100">Ask the guide</h2>
        </div>
        <p className="mt-5 text-sm leading-7 text-neutral-400">
          Start here: meet your agents, give them work, and follow the conversation
          in the app.
        </p>
        <div className="mt-6 space-y-1 text-sm">
          {OPTIONS.map((option, i) => {
            const active = open === i;
            return (
              <div key={option.q}>
                <button
                  onClick={() => setOpen(option.end ? undefined : active ? undefined : i)}
                  aria-expanded={option.a ? active : undefined}
                  className={`w-full rounded-sm px-3 py-2 text-left transition-colors ${
                    active ? 'bg-neutral-900/70 text-white' : 'text-[#58c470] hover:bg-neutral-900/40'
                  }`}
                >
                  {active && <span className="text-[#FF6A00]">&gt; </span>}
                  <span className="text-neutral-600">[{i + 1}] </span>
                  {option.q}
                </button>
                {active && option.a && (
                  <p className="border-l border-neutral-800 px-3 py-2 leading-relaxed text-neutral-400">
                    {option.a}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[10px] text-neutral-500">
        <span>
          <span className="text-neutral-500">[@]</span> mention an agent
        </span>
        <span>
          <span className="text-neutral-500">[Enter]</span> it answers
        </span>
        <span>
          <span className="text-neutral-500">[Esc]</span> the relay remembers
        </span>
      </div>
    </section>
  );
}
