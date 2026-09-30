'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import s from '@/components/light.module.css';

// Illustrative decisions matching the homepage's three use cases. These
// are not model outputs; the instrument says so on its face.
const DECISIONS = [
  {
    task: 'CHOOSE THE RIGHT MODEL',
    context: 'Extract the total and due date from this invoice as JSON.',
    options: ['small model', 'large model'],
    p: [0.86, 0.14],
  },
  {
    task: 'SELECT THE NEXT TOOL',
    context: 'Customer: “Where is my order #4412? It said Tuesday.”',
    options: ['order_lookup', 'search_docs', 'handoff'],
    p: [0.78, 0.15, 0.07],
  },
  {
    task: 'KNOW WHEN TO ESCALATE',
    context: 'Agent retried twice. Tests still fail on the same assertion.',
    options: ['continue', 'retry', 'ask for review'],
    p: [0.09, 0.21, 0.7],
  },
] as const;

const TICK_MS = 40;
const CYCLE = 150; // ticks per decision (6s)
const CELLS = 22;

/**
 * A retro instrument panel: context types in, probabilities jitter and
 * settle, the argmax gets stamped. Driven by one tick counter so every
 * frame is a pure function of time.
 */
export function DecisionInstrument() {
  const reduced = useReducedMotion();
  // Start on the settled first frame: identical on server and client, and
  // the whole story for no-JS and reduced-motion visitors.
  const [tick, setTick] = useState(CYCLE - 1);

  useEffect(() => {
    if (reduced !== false) return;
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, [reduced]);

  const d = DECISIONS[Math.floor(tick / CYCLE) % DECISIONS.length];
  const local = tick % CYCLE;
  const typed = Math.min(d.context.length, local * 2);
  const barStart = Math.ceil(d.context.length / 2) + 6;
  const settle = Math.min(Math.max((local - barStart) / 34, 0), 1);
  const stamped = settle >= 1;
  const probs: readonly number[] = d.p;
  const best = probs.indexOf(Math.max(...probs));

  return (
    <div className="relative mx-auto w-full max-w-xl rounded-[22px] border border-black/10 bg-white/60 p-2.5 shadow-[0_30px_80px_-30px_rgba(40,60,120,0.45)] backdrop-blur-md">
      <div className="flex items-center justify-between px-3 pb-2 pt-1 font-mono text-[10px] tracking-[0.14em] text-neutral-500">
        <span>FEZ · DECISION INSTRUMENT</span>
        <span className="flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${stamped ? 'bg-emerald-500' : 'bg-[#FF6A00]'}`} />
          ILLUSTRATIVE
        </span>
      </div>
      <div className={`relative overflow-hidden rounded-2xl bg-[#0c0f0c] px-5 py-5 text-left font-mono text-[12.5px] leading-6 sm:px-6 ${s.tube}`}>
        <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${s.scanlinesDark}`} />
        <div className={`relative ${s.phosphor}`}>
          <p className="text-[10px] tracking-[0.16em] text-[#8fd18f]/60">{d.task}</p>
          <p className="mt-2 min-h-12 text-[#c9f5c9]">
            <span className="text-[#8fd18f]/50">context › </span>
            {d.context.slice(0, typed)}
            {typed < d.context.length && <span className={`ml-0.5 inline-block h-3.5 w-2 translate-y-0.5 bg-[#c9f5c9] ${s.cursor}`} />}
          </p>
          <div className="mt-4 space-y-1.5" role="img" aria-label={`Probabilities: ${d.options.map((o, i) => `${o} ${d.p[i]}`).join(', ')}`}>
            {d.options.map((opt, i) => {
              const noise = local > barStart ? (1 - settle) * 0.25 * Math.sin(tick * 0.9 + i * 2.1) : 0;
              const v = local > barStart ? Math.min(Math.max(d.p[i] * settle + noise * (1 - settle) + 0.15 * (1 - settle), 0), 1) : 0;
              const filled = Math.round(v * CELLS);
              const lit = stamped && i === best;
              return (
                <div key={opt} className={`grid grid-cols-[6.25rem_1fr_2.5rem] items-center gap-2 sm:grid-cols-[7.5rem_1fr_3rem] sm:gap-3 ${lit ? 'text-[#FFB070]' : 'text-[#9ee89e]'}`}>
                  <span className="truncate">{opt}</span>
                  <span aria-hidden="true" className="overflow-hidden whitespace-nowrap tracking-[-0.05em]">
                    {'█'.repeat(filled)}
                    <span className="opacity-25">{'░'.repeat(CELLS - filled)}</span>
                  </span>
                  <span className="text-right tabular-nums">{v.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex h-6 items-center justify-between border-t border-[#8fd18f]/15 pt-3 text-[11px]">
            <span className="text-[#8fd18f]/50">probabilities out · no text generated</span>
            {stamped && (
              <span key={tick - local} className={`rounded-sm border border-[#FFB070]/60 px-2 text-[#FFB070] ${s.stamp}`}>
                → {d.options[best]}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export type ReplayTab = { tab: string; lines: readonly (readonly [tone: 'c' | 'o' | 'k' | 'a', text: string])[] };

const TONE = { c: 'text-neutral-500', o: 'text-neutral-300', k: 'text-[#7cc4ff]', a: 'text-[#9ee89e]' } as const;

/** Typewriter replay of the recorded round. Lines are built server-side from the JSON record. */
export function RoundReplay({ tabs, caption }: { tabs: readonly ReplayTab[]; caption: string }) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(0);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lines = tabs[i].lines;

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.3 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const instant = reduced !== false;
    const id = setInterval(() => setShown((n) => (instant ? lines.length : Math.min(n + 1, lines.length))), instant ? 0 : 260);
    return () => clearInterval(id);
  }, [visible, lines, reduced]);

  return (
    <div ref={ref}>
      <div role="tablist" className="flex flex-wrap gap-1.5">
        {tabs.map((t, n) => (
          <button
            key={t.tab}
            role="tab"
            type="button"
            aria-selected={n === i}
            onClick={() => {
              setShown(0);
              setI(n);
            }}
            className={
              n === i
                ? 'rounded-full bg-neutral-950 px-4 py-1.5 text-xs font-medium text-white'
                : 'rounded-full bg-white px-4 py-1.5 text-xs text-neutral-600 ring-1 ring-black/10 transition-colors hover:text-neutral-950'
            }
          >
            {t.tab}
          </button>
        ))}
      </div>
      <div className="mt-5 overflow-hidden rounded-2xl bg-[#0b0b0c] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.5)] ring-1 ring-black/10">
        <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.03] px-5 py-3">
          <span className="font-mono text-xs text-neutral-300">fez · recorded round replay</span>
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </span>
        </div>
        <pre className={`relative min-h-[320px] overflow-x-auto px-6 py-5 font-mono text-[12.5px] leading-7 ${s.phosphor}`}>
          <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${s.scanlinesDark}`} />
          {lines.slice(0, shown).map(([tone, text], n) => (
            <div key={`${i}-${n}`} className={`${s.lineIn} ${TONE[tone]}`}>
              {text}
            </div>
          ))}
          <span className={`inline-block h-4 w-2 translate-y-0.5 bg-[#FF6A00] ${s.cursor}`} />
        </pre>
      </div>
      <p className="mt-3 font-mono text-[10px] leading-5 text-neutral-500">{caption}</p>
    </div>
  );
}
