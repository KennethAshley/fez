'use client';

import { useState } from 'react';

import { AnimatedSprite, PixelSprite } from './pixel-sprite';
import { BracketFrame, Rule } from './ornament';
import { SPRITES } from './sprites';

/**
 * The roster, presented the way Caves of Qud presents a creature: a
 * sprite in a specimen frame, a name in gold, an epithet, a status
 * line, two sentences of lore, then the facts as relation lines. The
 * conceit is honest — these ARE characters. Each one is a persona a
 * relay will summon by name.
 */

interface Agent {
  id: keyof typeof SPRITES;
  name: string;
  epithet: string;
  status: [string, string]; // [disposition, temperament] — first renders green, second ember
  lore: string;
  relations: string[];
  install?: string;
}

const AGENTS: Agent[] = [
  {
    id: 'fez',
    name: '@fez',
    epithet: 'the guide',
    status: ['Docile', 'Helpful'],
    lore: 'It has read the protocol, and the protocol has read it back. Ask it anything; it will answer, or fetch the one who can.',
    relations: ['Summoned by mention, anywhere.', 'Knows the store. Installs on your word.', 'Ships with the app.'],
  },
  {
    id: 'scout',
    name: '@scout',
    epithet: 'subnet cartographer',
    status: ['Curious', 'Chain-fluent'],
    lore: 'It walks the subnets of the chain and writes down what lives there. It has counted 129 and expects more.',
    relations: ['Speaks to Finney directly. No middleman.', 'Discovery only; it spends nothing.'],
    install: 'fez install bittensor',
  },
  {
    id: 'loom',
    name: '@loom',
    epithet: 'weaver of living tools',
    status: ['Docile', 'Industrious'],
    lore: 'Describe a thing you wish existed over your data, and it weaves the thing while you watch. The good ones are kept, and the kept ones are shared.',
    relations: ['Its tools read freely; every write asks you first.', 'What it weaves is yours to keep.'],
    install: 'fez install loom',
  },
  {
    id: 'vault',
    name: '@vault',
    epithet: 'keeper of the deep',
    status: ['Guarded', 'Reliable'],
    lore: 'Holds what you hand it on a chain of strangers, and hands it back whole. It does not ask what the files are.',
    relations: ['Decentralized storage on subnet 75.', 'Scoped keys; the master stays home.'],
    install: 'fez install hippius',
  },
  {
    id: 'chip',
    name: '@chip',
    epithet: 'inference familiar',
    status: ['Eager', 'Rented'],
    lore: 'Runs hot thoughts on rented silicon and returns them cooled. Pay for what burns; nothing idles.',
    relations: ['Serverless inference by Chutes.', 'Any model the market serves.'],
    install: 'fez install chutes',
  },
  {
    id: 'score',
    name: '@score',
    epithet: 'the appraising eye',
    status: ['Exacting', 'Evidence-bound'],
    lore: 'It will not praise what it cannot measure. Bring it a vision pipeline and it brings you the numbers, or the reasons there are none.',
    relations: ['Computer-vision architect.', 'Every claim gated on evidence.'],
    install: 'fez install score-studio',
  },
];

export function AgentCodex() {
  const [selected, setSelected] = useState(0);
  const agent = AGENTS[selected];
  return (
    <section className="pb-20 text-left">
      <div className="mb-1 text-center text-sm font-bold lowercase tracking-widest text-[#cfc041]">
        the roster
      </div>
      <div className="mb-6 text-center text-xs text-neutral-600">:choose your familiar:</div>

      {/* caste-select gallery */}
      <div className="mb-8 flex flex-wrap items-end justify-center gap-1">
        {AGENTS.map((a, i) => (
          <button
            key={a.id}
            onClick={() => setSelected(i)}
            className={`sprite-hover flex w-[84px] flex-col items-center gap-2 rounded-sm border border-dotted px-2 pb-2 pt-3 transition-colors ${
              i === selected
                ? 'border-[#FF6A00]/60 text-white'
                : 'border-transparent text-neutral-600 hover:border-neutral-800 hover:text-neutral-400'
            }`}
          >
            {i === selected ? (
              <AnimatedSprite sprite={SPRITES[a.id]} scale={4} />
            ) : (
              <span>
                <span className="sprite-mono">
                  <PixelSprite sprite={SPRITES[a.id]} scale={4} mono="#5d564c" />
                </span>
                <span className="sprite-lit">
                  <AnimatedSprite sprite={SPRITES[a.id]} scale={4} />
                </span>
              </span>
            )}
            <span className={`text-[10px] ${i === selected ? 'text-[#cfc041]' : ''}`}>
              {i === selected && <span className="text-[#FF6A00]">&gt;</span>}
              {a.name}
            </span>
          </button>
        ))}
      </div>

      {/* the look-card */}
      <div className="border border-neutral-900 px-5 py-6 sm:px-8">
        <Rule />
        <div className="my-5 flex flex-col items-center gap-2 text-center">
          <span className="sprite-hover">
            <BracketFrame>
              <AnimatedSprite sprite={SPRITES[agent.id]} scale={6} />
            </BracketFrame>
          </span>
          <div className="mt-2 text-sm text-[#cfc041]">
            {agent.name}, {agent.epithet}
          </div>
          <div className="text-xs">
            <span className="text-[#58c470]">{agent.status[0]}</span>
            <span className="text-neutral-700">, </span>
            <span className="text-[#FF6A00]">{agent.status[1]}</span>
          </div>
        </div>
        <Rule glyph="⑃" />
        <p className="mx-auto mt-5 max-w-md text-center text-xs leading-relaxed text-neutral-400">
          {agent.lore}
        </p>
        <div className="mx-auto mt-5 max-w-md space-y-1.5 text-center text-xs text-neutral-600">
          {agent.relations.map((r) => (
            <div key={r}>{r}</div>
          ))}
          {agent.install && (
            <div className="pt-2 text-neutral-500">
              <span className="text-neutral-700">$ </span>
              <span className="text-[#FF6A00]">{agent.install}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
