import type { Metadata } from 'next';
import Link from 'next/link';
import { LightBackdrop, SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { discordUrl } from '@/lib/shared';
import jevbench from '@/public/model/jevbench-public-001.json';
import round from '@/public/model/testnet-round-001.json';
import { DecisionInstrument, RoundReplay, type ReplayTab } from './live';
import { FezMark } from './mark';
import s from '@/components/light.module.css';

const TITLE = 'Your data. Your decision model.';
const DESCRIPTION = 'Train, evaluate, and deploy models for your business’s decisions.';

export const metadata: Metadata = {
  title: `fez — ${TITLE}`,
  description: `${DESCRIPTION} A trainable decision primitive for your AI stack, built around authorized labeled examples. Early access; customer delivery is planned.`,
  alternates: { canonical: 'https://fez.chat' },
  openGraph: {
    title: `fez — ${TITLE}`,
    description: `${DESCRIPTION} Early access; customer delivery is planned.`,
    url: 'https://fez.chat',
    siteName: 'Fez',
    type: 'website',
  },
  twitter: { card: 'summary', title: `fez — ${TITLE}`, description: `${DESCRIPTION} Early access; customer delivery is planned.` },
};

// ── Everything numeric below comes from the two public records. ──────────
const fez = jevbench.models.find((m) => m.id === 'fez')!.metrics;
const kev = jevbench.models.find((m) => m.id === 'kev')!.metrics;
const miners = round.miners;
const counts = round.benchmark.counts;
const onChain = round.chain.verification.on_chain_weights as Record<string, number>;

const TICKER = [
  `JEVBENCH PUBLIC · FEZ ${fez.n_correct}/${fez.n_attempted} · KEV ${kev.n_correct}/${kev.n_attempted} · TIED`,
  `CALIBRATION ECE · FEZ ${fez.ece.toFixed(3)} VS ${kev.ece.toFixed(3)} · REGRESSED`,
  `P50 LATENCY · ${Math.round(fez.latency.p50_s * 1000)} MS · LOCALHOST`,
  `TESTNET ${round.chain.netuid} · WEIGHTS VERIFIED · BLOCK ${round.chain.verification.block}`,
  ...miners.map((m) => `MINER UID ${m.uid} · ${m.correct}/${m.cases} HELD-OUT · U16 ${m.on_chain_u16}`),
  `BASE · ${round.model.base.split('/')[1].toUpperCase()}`,
  'CUSTOMER DELIVERY · PLANNED',
];

const REPLAY: ReplayTab[] = [
  {
    tab: 'Train',
    lines: [
      ['c', `# recorded round ${round.round_id.slice(0, 8)} · ${round.verified_at.slice(0, 10)}`],
      ['k', `$ base ${round.model.base} @ ${round.model.base_revision.slice(0, 7)}`],
      ['o', `  lora_rank ${round.training.lora_rank} · head_dim ${round.training.head_dim} · lr ${round.training.learning_rate} · epochs ${round.training.epochs}`],
      ['o', `  splits  train ${counts.train.cases} · calibration ${counts.calibration.cases} · test ${counts.test.cases} (held out)`],
      ['o', `  placement  ${round.hardware.participant_placement}`],
      ['o', `  device  ${round.hardware.processor} · ${round.hardware.device} · ${round.hardware.dtype}`],
      ['a', `✓ ${miners.length} candidate checkpoints trained`],
    ],
  },
  {
    tab: 'Evaluate',
    lines: [
      ['k', `$ evaluate · rubric ${round.benchmark.rubric} · ${counts.test.cases} held-out cases`],
      ...miners.map(
        (m) =>
          [
            'o',
            `  uid ${m.uid}  ${m.correct}/${m.cases}  acc ${(m.accuracy * 100).toFixed(1)}%  brier ${m.brier.toFixed(3)}  confident errors ${m.confident_errors}`,
          ] as const,
      ),
      ['c', `# uniform-guess brier would be ${miners[0].uniform_brier.toFixed(3)}; lower is better`],
      ['a', '✓ every candidate beat the uniform baseline'],
    ],
  },
  {
    tab: 'Verify',
    lines: [
      ['k', `$ set_weights · ${round.chain.network}net · netuid ${round.chain.netuid} · commit-reveal`],
      ['o', `  extrinsic ${round.chain.weight_transaction.extrinsic_id}`],
      ['o', `  on-chain u16  ${Object.entries(onChain).map(([uid, w]) => `uid${uid} ${w}`).join(' · ')}`],
      ['c', '# connection dropped during confirmation;'],
      ['c', '# inclusion recovered from the block, not resubmitted'],
      ['a', `✓ weights verified at block ${round.chain.verification.block}`],
    ],
  },
];

const USE_CASES = [
  ['Choose the right model', 'Evaluate whether a request needs a larger model or can stay on a smaller one. Reserve expensive calls for the work that needs them.', 'Request → model'],
  ['Select the next tool', 'Turn context into a choice among the tools your agent can use, without generating a full text response for every selection.', 'Context → tool'],
  ['Know when to escalate', 'Use labeled outcomes to evaluate whether an agent should continue, retry, or ask for review before the next step.', 'Agent state → next action'],
] as const;

const STEPS = [
  ['Provide labeled examples', 'One recurring decision, its possible outcomes, and data you’re authorized to train on, with a separate set held out.'],
  ['Train candidates', 'Adapt a starting model to the task. Recipes and candidate versions stay traceable.'],
  ['Evaluate against a baseline', 'Accuracy, probability quality, consequential mistakes, latency, and total cost vs. your current approach.'],
  ['Deploy a qualifying model', 'Acceptance criteria are agreed before training. Only a candidate that meets them moves on.'],
] as const;

const DELIVERABLES = [
  { title: 'A versioned model', body: 'A selected checkpoint with its identity, training configuration, and dependencies recorded.', bg: 'bg-[#FF9AD5]', art: 'rings' },
  { title: 'Evaluation evidence', body: 'Baseline comparison, dataset and rubric versions, measured tradeoffs, known limitations.', bg: 'bg-[#6C93FF]', art: 'target' },
  { title: 'A deployment plan', body: 'Self-hosting or a managed endpoint, assessed against your app, hardware, and data requirements.', bg: 'bg-[#46DFEF]', art: 'stairs' },
] as const;

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white font-sans text-neutral-950 antialiased selection:bg-[#FF6A00] selection:text-black">
      <Ticker />

      <div className="relative overflow-hidden">
        <LightBackdrop />

        <div className="relative mx-auto max-w-6xl px-6 sm:px-8">
          <SiteHeader tone="light" />
        </div>

        <main id="main-content" tabIndex={-1} className="relative">
          {/* ── Hero ─────────────────────────────────────────── */}
          <section className="mx-auto max-w-4xl px-6 pb-24 pt-8 text-center sm:px-8">
            <FezMark className="mx-auto h-32 w-auto text-[#2c3a60]" />
            <p className="mt-8 flex items-center justify-center gap-2 text-[12px] font-medium">
              <span aria-hidden="true" className="text-base">✳</span> Specialized decision models · Early access
            </p>
            <h1 className="mt-5 text-balance text-[clamp(2.9rem,7vw,5.4rem)] font-semibold leading-[0.98] tracking-[-0.06em]">
              Your data.
              <br />
              Your decision model.
            </h1>
            <p className="mx-auto mt-6 max-w-lg text-[18px] leading-7 text-neutral-600">{DESCRIPTION}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
              <a href={discordUrl} className="inline-flex items-center gap-6 rounded-md bg-neutral-950 px-5 py-3 text-[13px] font-medium text-white transition hover:-translate-y-0.5 hover:bg-[#3455dc]">
                Discuss your use case <span aria-hidden="true">↗</span>
              </a>
              <a href="#workflow" className="text-[13px] hover:text-[#3455dc]">
                See how it works ↓
              </a>
            </div>
            <p className="mt-3 text-[11px] text-neutral-500">Via the Fez Discord community. Customer delivery is planned.</p>

            <div className="mt-16">
              <DecisionInstrument />
              <p className="mt-4 font-mono text-[10px] tracking-[0.08em] text-neutral-500">
                CONTEXT IN · PROBABILITIES OUT · EXAMPLES ARE ILLUSTRATIVE, NOT MODEL OUTPUT
              </p>
            </div>
          </section>

          {/* ── Intro ────────────────────────────────────────── */}
          <section aria-labelledby="intro" className="mx-auto max-w-5xl border-t border-neutral-200 px-6 pt-20 text-center sm:px-8">
            <p className="font-mono text-[10px] tracking-[0.14em] text-neutral-500">A DECISION PRIMITIVE FOR YOUR AI STACK</p>
            <h2 id="intro" className="mt-5 text-[clamp(2.1rem,4.4vw,3.3rem)] font-semibold leading-[1.04] tracking-[-0.055em]">
              Small decisions.
              <br />A big part of your AI bill.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-[15px] leading-7 text-neutral-600">
              Model selection. Tool choice. Escalation. Fez is building a trainable decision primitive for these repeated judgments: context in, probabilities out. The goal is to replace full LLM calls where a specialized model can meet your quality bar.
            </p>
            <p className="mx-auto mt-3 max-w-md text-xs leading-5 text-neutral-500">
              Potential savings depend on call volume, serving costs, and quality. Customer cost savings have not yet been measured.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 border-y border-neutral-200 py-6 text-[11px] text-neutral-600">
              <span className="flex items-center gap-2">
                <span className="size-1.5 animate-pulse rounded-full bg-[#4869cf]" />
                Training &amp; evaluation implemented
              </span>
              <span>Customer delivery planned</span>
              <Link href="/model" className="text-neutral-950 hover:text-[#3455dc]">
                Explore the research ↗
              </Link>
            </div>
          </section>

          {/* ── Use cases ───────────────────────────────────── */}
          <section aria-labelledby="cases" className="mx-auto max-w-5xl px-6 py-24 sm:px-8">
            <Heading id="cases" eyebrow="Inside the AI stack" aside="Train on authorized labeled examples from your workflows. Evaluate against your current stack, including quality, latency, and total cost.">
              Put a decision model
              <br />
              where the calls add up.
            </Heading>
            <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-neutral-200">
              {USE_CASES.map(([title, body, io], i) => (
                <article key={title} className="group flex flex-col md:px-8 first:md:pl-0 last:md:pr-0">
                  <div className="flex items-center justify-between font-mono text-xs text-neutral-500">
                    <span>0{i + 1}</span>
                    <span className="grid size-8 place-items-center rounded-full bg-neutral-950 text-white transition-transform group-hover:rotate-45">
                      {['↗', '⌘', '✳'][i]}
                    </span>
                  </div>
                  <h3 className="mt-6 text-[22px] font-semibold tracking-[-0.035em]">{title}</h3>
                  <p className="mt-3 text-sm leading-6 text-neutral-600">{body}</p>
                  <span className="mt-6 self-start rounded-full bg-neutral-100 px-3 py-1 font-mono text-[11px] text-neutral-700">{io}</span>
                </article>
              ))}
            </div>
          </section>
        </main>
      </div>

      {/* ── Workflow + replay ──────────────────────────────── */}
      <section id="workflow" aria-labelledby="workflow-h" className="scroll-mt-8 bg-[linear-gradient(180deg,#f9d4ee_0%,#fcecf6_14%,#ffffff_42%)] px-6 py-24 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className="flex items-center justify-center gap-2 text-[12px] font-medium">
            <span aria-hidden="true" className="text-base">✳</span> Proposed customer workflow
          </p>
          <h2 id="workflow-h" className="mx-auto mt-4 max-w-2xl text-balance text-center text-[clamp(2.1rem,4.4vw,3.3rem)] font-semibold leading-[1.04] tracking-[-0.055em]">
            Good examples in.
            <br />
            Evidence behind every decision.
          </h2>
          <p className="mx-auto mt-4 max-w-md text-center text-sm leading-6 text-neutral-600">
            Customer-specific jobs and delivery are planned. Today’s research system already exercises training, checkpoint verification, and evaluation.
          </p>

          <ol className="mt-14 grid gap-px overflow-hidden rounded-2xl bg-neutral-200 ring-1 ring-neutral-200 md:grid-cols-4">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="bg-white/90 p-6">
                <span className="font-mono text-xs text-[#FF6A00]">0{i + 1}</span>
                <h3 className="mt-5 text-[15px] font-semibold tracking-[-0.02em]">{title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-neutral-600">{body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-20 grid gap-10 md:grid-cols-[0.8fr_1.2fr] md:items-start">
            <div className="md:pt-12">
              <p className="font-mono text-[10px] tracking-[0.14em] text-neutral-500">IT ALREADY RAN ONCE</p>
              <h3 className="mt-3 text-[28px] font-semibold leading-[1.08] tracking-[-0.04em]">Train. Evaluate. Verify. On the record.</h3>
              <p className="mt-4 text-sm leading-6 text-neutral-600">
                This terminal replays the recorded Bittensor testnet round, line for line, from its public JSON. Every number on it is in the file.
              </p>
              <a href="/model/testnet-round-001.json" className="mt-5 inline-block font-mono text-xs underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-950">
                testnet-round-001.json ↗
              </a>
            </div>
            <RoundReplay tabs={REPLAY} caption={round.limitations.slice(0, 2).join(' ')} />
          </div>
        </div>
      </section>

      {/* ── Deliverables ───────────────────────────────────── */}
      <section aria-labelledby="deliver" className="mx-auto max-w-5xl px-6 py-24 sm:px-8">
        <Heading id="deliver" eyebrow="Planned deliverables" aside="Know what was trained, how it was tested, and what it would take to put it to work.">
          More than a model.
          <br />A basis for confidence.
        </Heading>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {DELIVERABLES.map((d, i) => (
            <article key={d.title} className={`group relative flex h-[320px] flex-col overflow-hidden rounded-2xl p-6 ${d.bg}`}>
              <span className="font-mono text-[10px] tracking-[0.12em] text-black/60">0{i + 1} / PLANNED</span>
              <h3 className="mt-3 text-[22px] font-semibold tracking-[-0.035em]">{d.title}</h3>
              <p className="mt-2 max-w-[24ch] text-[13px] leading-5 text-black/70">{d.body}</p>
              <LineArt kind={d.art} />
            </article>
          ))}
        </div>
        <div className="mt-6 grid gap-2 rounded-2xl bg-neutral-100 p-6 text-sm md:grid-cols-[12rem_1fr]">
          <span className="font-semibold">Data, considered.</span>
          <p className="leading-6 text-neutral-600">
            Current research worker bundles include copies of training data; confidential distributed training is not supported. Data handling is part of scoping. No Fez model release is publicly available yet.
          </p>
        </div>
      </section>

      {/* ── Evidence split ─────────────────────────────────── */}
      <section aria-labelledby="evidence" className="mx-auto max-w-5xl px-6 pb-24 sm:px-8">
        <div className="grid overflow-hidden rounded-3xl md:grid-cols-2">
          <div className={`relative grid min-h-[360px] place-items-center bg-[#0c0f0c] p-10 ${s.tube}`}>
            <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${s.scanlinesDark}`} />
            <div className={`relative text-center font-mono text-[#9ee89e] ${s.phosphor}`}>
              <p className="text-[10px] tracking-[0.16em] text-[#9ee89e]/60">JEVBENCH · PUBLIC ITEMS</p>
              <p className="mt-3 text-[clamp(3.5rem,9vw,5.5rem)] leading-none tracking-[-0.04em]">
                {fez.n_correct}
                <span className="text-[#9ee89e]/40">/{fez.n_attempted}</span>
              </p>
              <p className="mt-3 text-xs text-[#9ee89e]/70">
                fez = published kev · +{jevbench.paired_outcomes.fez_corrected} / −{jevbench.paired_outcomes.fez_regressed} items
              </p>
            </div>
          </div>
          <div className="relative overflow-hidden bg-[#3455dc] p-10 text-white sm:p-12">
            <svg aria-hidden="true" className="absolute inset-0 h-full w-full opacity-25" preserveAspectRatio="none" viewBox="0 0 100 100">
              <path d="M72 0 Q60 50 82 100" stroke="white" strokeWidth="0.3" fill="none" />
              <path d="M86 0 Q74 50 96 100" stroke="white" strokeWidth="0.3" fill="none" />
            </svg>
            <div className="relative">
              <p className="flex items-center gap-2 text-[12px] font-medium">
                <span aria-hidden="true">✳</span> Open about the evidence
              </p>
              <h2 id="evidence" className="mt-5 max-w-xs text-[30px] font-semibold leading-[1.06] tracking-[-0.045em]">
                Accuracy tied. Confidence quality regressed.
              </h2>
              <p className="mt-4 max-w-sm text-sm leading-6 text-white/80">
                We publish the result as it came out, including where it got worse. This does not establish a general improvement.
              </p>
              <div className="mt-8 flex flex-col gap-2 text-sm font-medium">
                <Link href="/model#quality" className="hover:underline hover:underline-offset-4">Read the comparison &amp; limitations ↗</Link>
                <Link href="/model#testnet" className="hover:underline hover:underline-offset-4">Inspect the recorded round ↗</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────── */}
      <section aria-labelledby="cta" className="px-6 pb-24 sm:px-8">
        <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-neutral-950 px-6 py-20 text-center sm:px-12">
          <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(ellipse_at_15%_120%,rgba(52,85,220,0.55),transparent_50%),radial-gradient(ellipse_at_90%_-10%,rgba(243,195,240,0.35),transparent_50%)]" />
          <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${s.scanlinesDark}`} />
          <div className="relative">
            <FezMark className="mx-auto h-16 w-auto text-white/75" />
            <h2 id="cta" className="mt-8 text-balance text-[clamp(2.1rem,5vw,3.4rem)] font-semibold leading-[1.02] tracking-[-0.055em] text-white">
              Your next model starts
              <br />
              with a better question.
            </h2>
            <p className="mx-auto mt-5 max-w-md text-sm leading-6 text-neutral-400">
              Where do repeated decisions add up in your AI stack? Tell us about the calls, your labeled examples, and the quality bar a smaller model would need to meet.
            </p>
            <a href={discordUrl} className="mt-8 inline-flex items-center gap-6 rounded-md bg-white px-5 py-3 text-[13px] font-medium text-black transition hover:-translate-y-0.5 hover:bg-neutral-200">
              Discuss your use case <span aria-hidden="true">↗</span>
            </a>
            <p className="mt-3 text-[11px] text-neutral-500">Opens Discord. Start with a task description; don’t share private data.</p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}

function Ticker() {
  const strip = TICKER.map((t) => (
    <span key={t} className="flex shrink-0 items-center gap-2 px-6">
      <span className="text-[#FF6A00]">▴</span>
      <span>{t}</span>
    </span>
  ));
  return (
    <div className="flex items-center overflow-hidden bg-neutral-950 py-2 font-mono text-[10px] tracking-[0.06em] text-neutral-300">
      <span className="z-10 flex shrink-0 items-center gap-1.5 bg-neutral-950 px-4 text-[#9ee89e]">
        <span className="size-1.5 rounded-full bg-[#9ee89e]" />
        RECORDED
      </span>
      <div className="overflow-hidden" aria-label="Recorded results">
        <div className={`flex w-max ${s.marquee}`}>
          {strip}
          <span aria-hidden="true" className="flex">{strip}</span>
        </div>
      </div>
    </div>
  );
}

function Heading({ id, eyebrow, aside, children }: { id: string; eyebrow: string; aside: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-6 md:grid-cols-[1fr_20rem] md:items-end">
      <div>
        <p className="flex items-center gap-2 text-[12px] font-medium">
          <span aria-hidden="true" className="text-base">✳</span> {eyebrow}
        </p>
        <h2 id={id} className="mt-4 text-[clamp(2.1rem,4.4vw,3.3rem)] font-semibold leading-[1.04] tracking-[-0.055em]">
          {children}
        </h2>
      </div>
      <p className="text-sm leading-6 text-neutral-600">{aside}</p>
    </div>
  );
}

function LineArt({ kind }: { kind: (typeof DELIVERABLES)[number]['art'] }) {
  const cls = 'pointer-events-none absolute -bottom-8 -right-8 size-52 text-black/55 transition-transform duration-700 group-hover:rotate-12';
  if (kind === 'rings')
    return (
      <svg aria-hidden="true" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="0.7" className={cls}>
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={20 + i * 12} y={20 + i * 12} width="36" height="36" />
        ))}
      </svg>
    );
  if (kind === 'target')
    return (
      <svg aria-hidden="true" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="0.7" className={cls}>
        <circle cx="50" cy="50" r="16" />
        <circle cx="50" cy="50" r="32" />
        <path d="M50 0 V100 M0 50 H100" />
      </svg>
    );
  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" fill="none" stroke="currentColor" strokeWidth="0.7" className={cls}>
      <path d="M0 90 H30 V65 H55 V40 H80 V15 H100" />
      <path d="M0 100 H100" />
    </svg>
  );
}
