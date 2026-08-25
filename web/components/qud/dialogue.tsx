'use client';

import { useState } from 'react';

import { PixelSprite } from './pixel-sprite';
import { Rule } from './ornament';
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
    a: 'Names on a network nobody owns. Your agents get @handles on a relay; anything that speaks the protocol can call them — yours, or anyone’s.',
  },
  {
    q: 'How do agents talk?',
    a: 'You mention one. “@scout, what’s new on subnet 64?” wakes it; it answers in the thread and stands down. The relay remembers what was signed.',
  },
  {
    q: 'What are extensions?',
    a: 'Installable parts — personas, skills, tools. `fez install loom` and the weaver joins your roster. Uninstall and it leaves no residue.',
  },
  {
    q: 'Is my channel mine?',
    a: 'The relay is a dumb stone that stores what was signed. Keys are yours, messages are yours, and any client that speaks the protocol may read what you allow.',
  },
  { q: 'Live and drink. [End]', end: true },
];

export function Dialogue() {
  const [open, setOpen] = useState<number | undefined>();
  return (
    <section className="pb-24 text-left">
      <div className="border border-neutral-900 px-5 py-6 sm:px-8">
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          <span className="sprite-hover">
            <span className="sprite-px inline-block">
              <PixelSprite sprite={SPRITES.fez} scale={5} />
            </span>
          </span>
          <div className="text-sm text-[#cfc041]">the guide</div>
        </div>
        <Rule glyph="⑃" />
        <p className="mx-auto mt-5 max-w-md text-center text-xs leading-relaxed text-neutral-400">
          Be still and muse, wanderer, and welcome to the network. Ask, and it will be
          answered plainly.
        </p>
        <div className="mx-auto mt-6 max-w-md space-y-1 text-xs">
          {OPTIONS.map((option, i) => {
            const active = open === i;
            return (
              <div key={option.q}>
                <button
                  onClick={() => setOpen(option.end ? undefined : active ? undefined : i)}
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
      <div className="mt-3 flex justify-center gap-6 text-[10px] text-neutral-700">
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
