'use client';

import { useState } from 'react';

import { AnimatedSprite, PixelSprite } from './pixel-sprite';
import { BracketFrame } from './ornament';
import { SPRITES } from './sprites';

/**
 * Each persona gets a sprite, a name, and a short field guide. The
 * character treatment is literal: the relay summons these agents by name.
 */

interface Agent {
  id: keyof typeof SPRITES;
  name: string;
  epithet: string;
  status: [string, string]; // [disposition, temperament] — first renders green, second ember
  lore: string;
  relations: string[];
}

const AGENTS: Agent[] = [
  {
    id: 'fez',
    name: '@fez',
    epithet: 'the guide',
    status: ['Docile', 'Helpful'],
    lore: 'It knows its way around. Ask it anything and it brings in the teammate the work belongs to.',
    relations: ['Mention @fez in a channel.', 'Brings in the right teammate.', 'Ships with the app.'],
  },
  {
    id: 'drift',
    name: '@drift',
    epithet: 'the researcher',
    status: ['Curious', 'Sourced'],
    lore: 'Just passing through, always finding things. It digs into a question, checks assumptions, and comes back with sourced answers.',
    relations: ['Hands off with an @mention when the work belongs to someone else.', 'Signs every answer with its own key.'],
  },
  {
    id: 'quill',
    name: '@quill',
    epithet: 'the writer',
    status: ['Precise', 'Warm'],
    lore: "The ink's still wet. Drafts, edits, summaries, and making hard things land clearly.",
    relations: ['Wakes when a teammate says its name.', 'Any brain you give it.'],
  },
];

export function AgentCodex() {
  const [selected, setSelected] = useState(0);
  const agent = AGENTS[selected];
  return (
    <section aria-labelledby="roster-heading" className="border-t border-neutral-900 py-12 text-left md:py-16">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="roster-heading" className="text-xl font-medium text-neutral-100">The roster</h2>
        <p className="text-xs text-neutral-400">Meet the agents.</p>
      </div>

      {/* caste-select gallery */}
      <div className="mb-8 mt-8 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {AGENTS.map((a, i) => (
          <button
            key={a.id}
            onClick={() => setSelected(i)}
            aria-pressed={i === selected}
            className={`sprite-hover flex flex-col items-center justify-end gap-3 border-b px-2 py-4 transition-colors ${
              i === selected
                ? 'border-[#FF6A00]/60 text-white'
                : 'border-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
            }`}
          >
            {i === selected ? (
              <AnimatedSprite sprite={SPRITES[a.id]} scale={4} />
            ) : (
              <span className="block">
                <span className="sprite-mono">
                  <PixelSprite sprite={SPRITES[a.id]} scale={4} mono="#5d564c" />
                </span>
                <span className="sprite-lit">
                  <AnimatedSprite sprite={SPRITES[a.id]} scale={4} />
                </span>
              </span>
            )}
            <span className={`text-xs ${i === selected ? 'text-[#cfc041]' : ''}`}>
              {i === selected && <span className="text-[#FF6A00]">&gt;</span>}
              {a.name}
            </span>
          </button>
        ))}
      </div>

      {/* Selected familiar */}
      <div className="grid gap-6 pt-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-12">
        <div className="flex items-center gap-5 self-start">
          <span className="sprite-hover">
            <BracketFrame>
              <AnimatedSprite sprite={SPRITES[agent.id]} scale={6} />
            </BracketFrame>
          </span>
          <div>
            <h3 className="text-base text-[#cfc041]">{agent.name}</h3>
            <p className="mt-1 text-xs text-neutral-400">{agent.epithet}</p>
            <p className="mt-3 text-xs">
              <span className="text-[#58c470]">{agent.status[0]}</span>
              <span className="text-neutral-600">, </span>
              <span className="text-[#FF6A00]">{agent.status[1]}</span>
            </p>
          </div>
        </div>
        <div>
          <p className="text-sm leading-7 text-neutral-300">{agent.lore}</p>
          <div className="mt-4 space-y-1.5 text-xs leading-relaxed text-neutral-400">
            {agent.relations.map((r) => (
              <div key={r}>{r}</div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
