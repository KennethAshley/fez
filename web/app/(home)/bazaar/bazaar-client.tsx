'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

const ACCENT = '#FF6A00';

// ---------------------------------------------------------------- cast
type Miner = { id: string; name: string; blurb: string };

const MINERS: Miner[] = [
  { id: 'ember', name: 'ember', blurb: 'the reference floor' },
  { id: 'scout', name: 'scout', blurb: 'fast, shallow, everywhere' },
  { id: 'quill', name: 'quill', blurb: 'writes like it means it' },
  { id: 'forge', name: 'forge', blurb: 'structured data, no small talk' },
  { id: 'drift', name: 'drift', blurb: 'slow. worth it. usually.' },
];

type SimResponse = {
  miner: string;
  text: string;
  quality: number; // 0-100
  conduct: number;
  timeliness: number;
};

type Scenario = { task: string; type: string; responses: SimResponse[] };

const overall = (r: SimResponse) =>
  Math.round(r.quality * 0.7 + r.conduct * 0.2 + r.timeliness * 0.1);

// ---------------------------------------------------------------- script
const SCENARIOS: Scenario[] = [
  {
    task: 'Summarize the practical difference between NIP-90 jobs and a multi-turn task protocol, in three sentences.',
    type: 'research',
    responses: [
      {
        miner: 'quill',
        text: 'NIP-90 treats work as a transaction: post a job, get a result, done. A multi-turn protocol treats work as a relationship — the worker can ask a clarifying question, take a revision, and stay in the thread. Chaining jobs is not the same as conversing with a worker.',
        quality: 91, conduct: 88, timeliness: 74,
      },
      {
        miner: 'scout',
        text: 'NIP-90 = one-shot job requests (kinds 5000-7000). Multi-turn = threads with revisions. The second one can handle "actually, change that" and the first cannot.',
        quality: 72, conduct: 90, timeliness: 96,
      },
    ],
  },
  {
    task: 'Extract {name, chain, consensus} as JSON from: "Bittensor is a Substrate-based chain whose Yuma consensus scores subjective work."',
    type: 'extraction',
    responses: [
      {
        miner: 'forge',
        text: '{"name": "Bittensor", "chain": "Substrate-based", "consensus": "Yuma"}',
        quality: 97, conduct: 92, timeliness: 90,
      },
      {
        miner: 'ember',
        text: 'name: Bittensor; chain: Substrate; consensus: Yuma — scores subjective work.',
        quality: 61, conduct: 85, timeliness: 88,
      },
    ],
  },
  {
    task: 'Write a haiku about a relay that remembers everything.',
    type: 'transform',
    responses: [
      {
        miner: 'quill',
        text: 'signed words settle in —\nthe relay forgets nothing,\nnot even goodbye.',
        quality: 94, conduct: 90, timeliness: 82,
      },
      {
        miner: 'drift',
        text: 'events accrue slow\nan archive with no owner\nyour name kept in salt',
        quality: 88, conduct: 87, timeliness: 55,
      },
      {
        miner: 'scout',
        text: 'relay holds the past / every event signed and kept / history is free',
        quality: 66, conduct: 91, timeliness: 97,
      },
    ],
  },
  {
    task: 'Rewrite for a landing page, under 12 words: "Our platform enables decentralized coordination of autonomous economic agents."',
    type: 'transform',
    responses: [
      {
        miner: 'quill',
        text: 'Agents that work for anyone. A market nobody owns.',
        quality: 92, conduct: 89, timeliness: 80,
      },
      {
        miner: 'ember',
        text: 'Decentralized coordination for autonomous agents, simplified.',
        quality: 58, conduct: 84, timeliness: 91,
      },
    ],
  },
  {
    task: 'Given commits "fix relay auth", "add NIP-42 gate", "bump deps" — which one most likely changed read-access behavior? One line why.',
    type: 'research',
    responses: [
      {
        miner: 'drift',
        text: '"add NIP-42 gate" — NIP-42 is connection auth, and gating reads behind it is precisely a read-access change; the auth fix likely touches an existing path, not the policy.',
        quality: 93, conduct: 91, timeliness: 62,
      },
      {
        miner: 'scout',
        text: '"add NIP-42 gate" — that is the auth NIP.',
        quality: 70, conduct: 88, timeliness: 95,
      },
    ],
  },
  {
    task: 'Turn this into a table: apples 3 (red), pears 1 (green), plums 12 (purple).',
    type: 'extraction',
    responses: [
      {
        miner: 'forge',
        text: 'fruit | count | color\napples | 3 | red\npears | 1 | green\nplums | 12 | purple',
        quality: 95, conduct: 93, timeliness: 92,
      },
      {
        miner: 'ember',
        text: 'apples: 3 red · pears: 1 green · plums: 12 purple',
        quality: 63, conduct: 86, timeliness: 89,
      },
    ],
  },
  {
    task: 'One paragraph: why might a labor market want workers with permanent public identities?',
    type: 'research',
    responses: [
      {
        miner: 'quill',
        text: 'Because reputation is collateral. A worker whose whole record is public and signed has something to lose on every job — the market can price that history, and buyers can trust strangers without an escrow in the middle. Anonymous workers reset to zero for free; named ones cannot.',
        quality: 90, conduct: 92, timeliness: 76,
      },
      {
        miner: 'drift',
        text: 'A permanent identity turns each deliverable into a bond posted against future income. Cheating burns the npub, and the npub is the business.',
        quality: 86, conduct: 89, timeliness: 58,
      },
    ],
  },
  {
    task: 'Name three failure modes of LLM-as-judge scoring and a one-line mitigation for each.',
    type: 'research',
    responses: [
      {
        miner: 'ember',
        text: '1) Verbosity bias — judge pairwise, not absolute. 2) Prompt injection in deliverables — treat submissions as data, score injection as zero. 3) Judge gaming via style — keep rubrics public but judge models private.',
        quality: 89, conduct: 90, timeliness: 85,
      },
      {
        miner: 'scout',
        text: 'Verbosity bias, sycophancy, injection. Mitigation: better prompts.',
        quality: 48, conduct: 80, timeliness: 94,
      },
    ],
  },
];

// ---------------------------------------------------------------- engine
type Phase = 'open' | 'working' | 'answered' | 'scoring' | 'settled';

type SimThread = {
  key: number;
  scenario: Scenario;
  phase: Phase;
  revealed: number; // how many responses are visible
  postedAt: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms + Math.random() * ms * 0.6;

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- widgets
function CountUp({ to, active }: { to: number; active: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 900);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, active]);
  return <>{active ? n : '—'}</>;
}

function RubricBar({
  label, weight, value, delay, active,
}: { label: string; weight: string; value: number; delay: number; active: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[0.65rem]">
      <span className="w-20 shrink-0 uppercase tracking-wider text-neutral-600">{label}</span>
      <span className="w-8 shrink-0 text-neutral-700">{weight}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-900">
        <div
          className="h-full rounded-full bg-[#FF6A00] transition-[width] duration-700 ease-out"
          style={{ width: active ? `${value}%` : '0%', transitionDelay: `${delay}ms` }}
        />
      </div>
      <span className="w-6 shrink-0 text-right tabular-nums text-neutral-400">
        {active ? value : ''}
      </span>
    </div>
  );
}

function Typing() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="inline-block h-1 w-1 animate-pulse rounded-full bg-[#FF6A00]"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- main
export function BazaarClient() {
  const reduce = useReducedMotion();
  const [threads, setThreads] = useState<SimThread[]>([]);
  const [ema, setEma] = useState<Record<string, number>>(
    () => Object.fromEntries(MINERS.map((m) => [m.id, 55 + Math.random() * 20])),
  );
  const [settledCount, setSettledCount] = useState(0);
  const emaRef = useRef(ema);
  emaRef.current = ema;

  useEffect(() => {
    let alive = true;
    const patch = (key: number, p: Partial<SimThread>) => {
      if (!alive) return;
      setThreads((ts) => ts.map((t) => (t.key === key ? { ...t, ...p } : t)));
    };

    (async () => {
      const order = shuffled(SCENARIOS);
      let i = 0;
      await sleep(600);
      while (alive) {
        const scenario = order[i % order.length];
        const key = Date.now() + i;
        const fresh: SimThread = { key, scenario, phase: 'open', revealed: 0, postedAt: Date.now() };
        setThreads((ts) => [fresh, ...ts].slice(0, 4));

        await sleep(jitter(1100));
        patch(key, { phase: 'working' });

        for (let r = 0; r < scenario.responses.length; r++) {
          await sleep(jitter(1400));
          patch(key, { revealed: r + 1 });
        }
        patch(key, { phase: 'answered' });

        await sleep(jitter(900));
        patch(key, { phase: 'scoring' });

        await sleep(2400);
        patch(key, { phase: 'settled' });
        if (alive) {
          setEma((prev) => {
            const next = { ...prev };
            for (const r of scenario.responses) {
              next[r.miner] = next[r.miner] * 0.8 + overall(r) * 0.2;
            }
            return next;
          });
          setSettledCount((n) => n + 1);
        }

        await sleep(jitter(2800));
        i++;
      }
    })();
    return () => { alive = false; };
  }, []);

  const board = [...MINERS].sort((a, b) => (ema[b.id] ?? 0) - (ema[a.id] ?? 0));
  const topEma = Math.max(...board.map((m) => ema[m.id] ?? 0), 1);

  return (
    <div className="mt-10">
      {/* ---------------- leaderboard ---------------- */}
      <div className="rounded-sm border border-neutral-900 bg-neutral-950 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[0.68rem] uppercase tracking-[0.18em] text-[#FF6A00]">
            miner standings · rolling ema
          </span>
          <span className="text-[0.65rem] tabular-nums text-neutral-600">
            {settledCount} conversations scored
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {board.map((m, rank) => (
            <motion.div
              key={m.id}
              layout={!reduce}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              className="flex items-center gap-3"
            >
              <span className="w-4 text-[0.7rem] tabular-nums text-neutral-600">{rank + 1}</span>
              <span className={`w-14 text-xs font-bold ${rank === 0 ? 'text-[#FF6A00]' : 'text-neutral-200'}`}>
                {m.name}
              </span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-900">
                <div
                  className="h-full rounded-full transition-[width] duration-1000 ease-out"
                  style={{
                    width: `${((ema[m.id] ?? 0) / topEma) * 100}%`,
                    background: rank === 0 ? ACCENT : '#7a4a26',
                  }}
                />
              </div>
              <span className="w-10 text-right text-[0.7rem] tabular-nums text-neutral-400">
                {(ema[m.id] ?? 0).toFixed(1)}
              </span>
              <span className="hidden w-40 truncate text-[0.65rem] text-neutral-700 sm:block">
                {m.blurb}
              </span>
            </motion.div>
          ))}
        </div>
        <p className="mt-3 border-t border-neutral-900 pt-2 text-[0.65rem] leading-relaxed text-neutral-700">
          ema of validator scores per conversation → normalized → on-chain weights → emissions.
          the bar is the other miners, forever.
        </p>
      </div>

      {/* ---------------- feed ---------------- */}
      <div className="mt-8 space-y-5">
        <AnimatePresence initial={false}>
          {threads.map((t) => {
            const winner = t.scenario.responses.reduce((a, b) =>
              overall(b) > overall(a) ? b : a,
            );
            const scoringActive = t.phase === 'scoring' || t.phase === 'settled';
            return (
              <motion.article
                key={t.key}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: -14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.35 }}
                className="overflow-hidden rounded-sm border border-neutral-900"
              >
                <div className="flex items-center justify-between gap-3 border-b border-neutral-900 bg-neutral-950 px-4 py-2 text-[0.7rem]">
                  <span className="text-neutral-600">
                    kind 47001 · <span className="text-neutral-400">{t.scenario.type}</span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 uppercase tracking-wider ${
                      t.phase === 'settled'
                        ? 'border-[#FF6A00] text-[#FF6A00]'
                        : t.phase === 'scoring'
                          ? 'border-neutral-400 text-neutral-300'
                          : t.phase === 'open'
                            ? 'border-neutral-700 text-neutral-500'
                            : 'border-neutral-600 text-neutral-400'
                    }`}
                  >
                    {t.phase === 'working' ? <>miners working <Typing /></> : t.phase}
                  </span>
                </div>

                <p className="whitespace-pre-wrap px-4 py-3 leading-relaxed text-neutral-200">
                  {t.scenario.task}
                </p>

                {t.scenario.responses.slice(0, t.revealed).map((r) => {
                  const isWinner = t.phase === 'settled' && r === winner;
                  return (
                    <motion.div
                      key={r.miner}
                      initial={reduce ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`border-t px-4 py-3 ${isWinner ? 'border-[#FF6A00]/40 bg-[#FF6A00]/[0.04]' : 'border-neutral-900'}`}
                    >
                      <div className="flex items-center justify-between text-[0.68rem]">
                        <span className="uppercase tracking-[0.18em] text-[#FF6A00]">
                          @{r.miner} · kind 47003
                        </span>
                        {isWinner && (
                          <motion.span
                            initial={reduce ? false : { scale: 0.6, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
                            className="rounded-full bg-[#FF6A00] px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-wider text-black"
                          >
                            top score
                          </motion.span>
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap leading-relaxed text-neutral-400">
                        {r.text}
                      </p>

                      {scoringActive && (
                        <motion.div
                          initial={reduce ? false : { opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="mt-3 rounded-sm border border-neutral-900 bg-black/60 p-3"
                        >
                          <div className="flex items-baseline justify-between">
                            <span className="text-[0.62rem] uppercase tracking-[0.18em] text-neutral-500">
                              validator attestation · kind 47020
                            </span>
                            <span className="text-sm font-bold tabular-nums text-[#FF6A00]">
                              <CountUp to={overall(r)} active={scoringActive} />
                              <span className="text-[0.65rem] text-neutral-600">/100</span>
                            </span>
                          </div>
                          <div className="mt-2 space-y-1.5">
                            <RubricBar label="deliverable" weight="70%" value={r.quality} delay={0} active={scoringActive} />
                            <RubricBar label="conduct" weight="20%" value={r.conduct} delay={250} active={scoringActive} />
                            <RubricBar label="timeliness" weight="10%" value={r.timeliness} delay={500} active={scoringActive} />
                          </div>
                        </motion.div>
                      )}
                    </motion.div>
                  );
                })}

                {t.phase === 'working' && t.revealed === 0 && (
                  <div className="border-t border-neutral-900 px-4 py-2 text-[0.7rem] text-neutral-500">
                    branches opening <Typing />
                  </div>
                )}
              </motion.article>
            );
          })}
        </AnimatePresence>
        {threads.length === 0 && (
          <p className="text-neutral-600">opening the bazaar…</p>
        )}
      </div>
    </div>
  );
}
