import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LightBackdrop, SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import s from '@/components/light.module.css';
import { benchmark, readComparison, percent, decimal, milliseconds, comparisonHeadline } from '@/lib/model-benchmark';
import testnet from '@/public/model/testnet-round-001.json';

export const metadata: Metadata = {
  title: 'fez — decision model research',
  description: 'Fez’s experimental 0.8B decision model. Recorded public benchmarks, checkpoint evidence, and the current state of its training competition.',
  alternates: { canonical: 'https://fez.chat/model' },
};

const REPO = 'https://github.com/ooo-hq/fez';
const METHOD = `${REPO}/blob/main/docs/jevbench-public.md`;
const SOURCE = '/model/jevbench-public-001.json';
const TESTNET_SOURCE = '/model/testnet-round-001.json';
const LINK = 'underline decoration-neutral-300 underline-offset-4 hover:text-[#3455dc] hover:decoration-[#3455dc]';
const CELL = 'border-t border-neutral-200 px-3 py-3 text-right tabular-nums sm:px-5';
const HEAD = 'border-t border-neutral-200 px-3 py-3 text-left font-normal text-neutral-950 sm:px-5';
const CARD = 'rounded-2xl bg-white ring-1 ring-neutral-200';
const SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'quality', title: 'Model quality' },
  { id: 'training', title: 'Training & evaluation' },
  { id: 'participants', title: 'Participants' },
  { id: 'testnet', title: 'Testnet publication' },
] as const;
const PROCESS = [
  ['Train', 'Miners train compatible adapters and decision heads with a fixed one-epoch recipe and different seeds.'],
  ['Submit', 'Each miner freezes a candidate and signs its checkpoint hash for the validator.'],
  ['Evaluate', 'The validator verifies the checkpoint and runs its own evaluation of the model’s probabilities.'],
  ['Reward', 'Family-macro Brier skill determines proposed weights across eligible candidates.'],
] as const;
const RESOURCES = [
  { href: REPO, title: 'GitHub repository', description: 'Explore the training and evaluation code.', bg: 'bg-[#FF9AD5]' },
  { href: METHOD, title: 'Methodology', description: 'Read how the comparison was run and its limits.', bg: 'bg-[#6C93FF]' },
  { href: SOURCE, title: 'Source data', description: 'Inspect the exact recorded results as JSON.', bg: 'bg-[#46DFEF]' },
] as const;

function time(value: string) {
  return `${new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', hourCycle: 'h23',
  }).format(new Date(value))} UTC`;
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-16 border-t border-neutral-200 py-16 sm:py-20">
      <p className="flex items-center gap-2 text-[12px] font-medium"><span aria-hidden="true" className="text-base">✳</span> {eyebrow}</p>
      <h2 id={`${id}-heading`} className="mb-8 mt-3 text-[clamp(1.9rem,3.6vw,2.6rem)] font-semibold leading-[1.05] tracking-[-0.05em]">{title}</h2>
      {children}
    </section>
  );
}

export default function ModelPage() {
  const { fez, kev } = readComparison(benchmark);
  const f = fez.metrics;
  const k = kev.metrics;
  const reference = benchmark.published_reference;
  const rows = [
    ['Accuracy', 'Higher is better', percent(k.accuracy), percent(f.accuracy)],
    ['Correct answers', 'Same public items', `${k.n_correct} / ${k.n_attempted}`, `${f.n_correct} / ${f.n_attempted}`],
    ['Brier loss', 'Lower is better', decimal(k.brier_mean), decimal(f.brier_mean)],
    ['Calibration error (ECE)', 'Lower is better', decimal(k.ece), decimal(f.ece)],
    ['Confident mistakes', 'Wrong at ≥90% confidence', k.confident_errors, f.confident_errors],
    ['Median latency', 'Localhost HTTP', milliseconds(k.latency?.p50_s), milliseconds(f.latency?.p50_s)],
    ['p95 latency', 'Localhost HTTP', milliseconds(k.latency?.p95_s), milliseconds(f.latency?.p95_s)],
    ['Valid probability outputs', '', percent(k.schema_validity), percent(f.schema_validity)],
  ];

  return (
    <div className="min-h-screen bg-white font-sans text-neutral-950 antialiased selection:bg-[#FF6A00] selection:text-black">
      <div className="relative overflow-hidden">
        <LightBackdrop />
        <div className="relative mx-auto max-w-6xl px-6 sm:px-8"><SiteHeader tone="light" current="model" /></div>
        <header className="relative mx-auto max-w-5xl px-6 pb-16 pt-10 sm:px-8 sm:pt-16">
          <p className="flex items-center gap-2 text-[12px] font-medium"><span aria-hidden="true" className="text-base">✳</span> Research · Open about the evidence</p>
          <h1 className="mt-5 max-w-[16ch] text-[clamp(2.7rem,6.5vw,4.8rem)] font-semibold leading-[0.98] tracking-[-0.06em]">Decision model research.</h1>
          <p className="mt-6 max-w-[58ch] text-lg leading-8 text-neutral-600">Fez is an experimental 0.8B decision model for yes/no questions, choices, and scores. It returns structured probabilities without generating prose.</p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs text-neutral-600 ring-1 ring-neutral-200"><span className="size-1.5 shrink-0 rounded-full bg-[#FF6A00]" />Experimental candidate. No public model release or automatic winner promotion yet.</p>
          <a href="#testnet" className="group mt-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-neutral-950 px-5 py-4 text-sm text-white transition hover:-translate-y-0.5">
            <span className="flex items-center gap-2 font-mono text-xs text-[#9ee89e]"><span className="size-1.5 rounded-full bg-[#9ee89e]" />BITTENSOR TESTNET · SUBNET {testnet.chain.netuid}</span>
            <span className="text-neutral-300 group-hover:text-white">First training round verified on-chain <span aria-hidden="true">↓</span></span>
          </a>
          <nav aria-label="Project resources" className="mt-4 grid gap-3 sm:grid-cols-3">
            {RESOURCES.map(r => (
              <a key={r.href} href={r.href} className={`group rounded-2xl p-5 transition hover:-translate-y-0.5 ${r.bg}`}>
                <span className="flex items-center justify-between gap-4 font-semibold tracking-[-0.02em]">{r.title}<span aria-hidden="true" className="transition-transform group-hover:rotate-45">↗</span></span>
                <span className="mt-2 block text-sm leading-6 text-black/70">{r.description}</span>
              </a>
            ))}
          </nav>
        </header>
      </div>

      <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-6 sm:px-8">
        <nav aria-label="On this page" className="sticky top-0 z-10 -mx-2 flex gap-1.5 overflow-x-auto bg-white/85 px-2 py-3 backdrop-blur">
          {SECTIONS.map(section => <a key={section.id} href={`#${section.id}`} className="shrink-0 rounded-full bg-white px-4 py-1.5 text-xs text-neutral-600 ring-1 ring-neutral-200 hover:text-neutral-950">{section.title}</a>)}
        </nav>

        <Section id="overview" eyebrow="Overview" title="Probabilities. Without the prose.">
          <div className="grid gap-6 md:grid-cols-[1.2fr_1fr]">
            <p className="max-w-[58ch] text-[15px] leading-7 text-neutral-600">Fez returns structured probabilities without generating a text answer. Applications can load a selected checkpoint directly.</p>
            <div className={`${CARD} p-5`}>
              <p className="font-mono text-[10px] tracking-[0.12em] text-neutral-500">PUBLIC BENCHMARK CANDIDATE</p>
              <code className="mt-3 block break-all font-mono text-xs leading-6 text-neutral-800">{fez.checkpoint_sha256}</code>
            </div>
          </div>
        </Section>

        <Section id="quality" eyebrow="Model quality" title={comparisonHeadline(fez, kev)}>
          <div className={`relative mb-6 overflow-hidden rounded-2xl bg-[#0c0f0c] p-6 font-mono sm:p-8 ${s.tube}`}>
            <span aria-hidden="true" className={`pointer-events-none absolute inset-0 ${s.scanlinesDark}`} />
            <div className={`relative grid gap-6 text-[#9ee89e] sm:grid-cols-3 ${s.phosphor}`}>
              {[
                ['FEZ ACCURACY', percent(f.accuracy), `${f.n_correct} of ${f.n_attempted} public items correct`],
                ['FEZ BRIER LOSS', decimal(f.brier_mean), 'Probability error. Lower is better.'],
                ['FEZ CONFIDENT MISTAKES', String(f.confident_errors), 'Wrong at ≥90% confidence.'],
              ].map(([label, value, note]) => (
                <div key={label}><p className="text-[10px] tracking-[0.14em] text-[#9ee89e]/60">{label}</p><p className="mt-2 text-4xl tracking-[-0.04em]">{value}</p><p className="mt-2 text-[11px] text-[#9ee89e]/70">{note}</p></div>
              ))}
            </div>
            <p className="relative mt-6 border-t border-[#9ee89e]/15 pt-4 text-xs text-[#c9f5c9]/80">Fez corrected {benchmark.paired_outcomes.fez_corrected} reference-model errors and introduced {benchmark.paired_outcomes.fez_regressed}. No general improvement is established.</p>
          </div>

          <div className={CARD}>
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-5 sm:px-5">
              <div><h3 className="font-semibold tracking-[-0.02em]">{benchmark.benchmark.name} public comparison</h3><p className="mt-1 text-xs text-neutral-500">{benchmark.benchmark.subset}</p></div>
              <a href={SOURCE} className="inline-flex min-h-10 items-center gap-3 rounded-md bg-neutral-950 px-4 py-2 text-xs font-medium text-white hover:bg-[#3455dc]">Source data (JSON)<span aria-hidden="true">↗</span></a>
            </div>
            <div role="region" aria-label="Overall model comparison" tabIndex={0} className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[320px] border-collapse text-sm">
                <caption className="sr-only">Recorded Fez and published Kev results on the same public items</caption>
                <thead className="bg-neutral-50 text-xs text-neutral-600"><tr><th scope="col" className={HEAD}>Metric</th><th scope="col" className={`${CELL} text-[#E05E00]`}>Fez candidate<span className="mt-1 block font-normal text-neutral-500">Experimental checkpoint</span></th><th scope="col" className={CELL}>Published Kev 0.8B<span className="mt-1 block font-normal text-neutral-500">Comparison baseline</span></th></tr></thead>
                <tbody>{rows.map(([name, hint, baseline, candidate]) => <tr key={name} className="hover:bg-neutral-50"><th scope="row" className={HEAD}>{name}<span className="mt-1 block text-xs text-neutral-500">{hint}</span></th><td className={`${CELL} font-medium`}>{candidate ?? 'Unavailable'}</td><td className={`${CELL} text-neutral-600`}>{baseline ?? 'Unavailable'}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="border-t border-neutral-200 px-4 py-4 text-xs leading-6 text-neutral-500 sm:px-5">Brier loss measures probability error; ECE measures the gap between confidence and observed accuracy. Lower is better for both. Timing is {benchmark.runtime.measurement}, on {benchmark.runtime.hardware}, via localhost HTTP. This does not establish a reliable speedup or production SLA.</p>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-[1.3fr_1fr]">
            <div className={`min-w-0 ${CARD}`}>
              <h3 className="px-4 py-4 font-semibold tracking-[-0.02em] sm:px-5">Accuracy by difficulty</h3>
              <div role="region" aria-label="Accuracy by difficulty" tabIndex={0} className="overflow-x-auto overscroll-x-contain">
                <table className="w-full min-w-[310px] border-collapse text-sm">
                  <caption className="sr-only">Correct and total counts, with accuracy, for each public subset</caption>
                  <thead className="bg-neutral-50 text-xs text-neutral-600"><tr><th scope="col" className={HEAD}>Subset</th><th scope="col" className={`${CELL} text-[#E05E00]`}>Fez</th><th scope="col" className={CELL}>Kev baseline</th></tr></thead>
                  <tbody>{(['easy', 'original', 'hard'] as const).map(name => <tr key={name}><th scope="row" className={`${HEAD} capitalize`}>{name}</th>{[fez, kev].map(model => <td key={model.id} className={CELL}>{model.slices[name]?.n_correct ?? 'Unavailable'} / {model.slices[name]?.n_scorable ?? 'Unavailable'}<span className="block text-xs text-neutral-500">{percent(model.slices[name]?.accuracy)}</span></td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
            <aside className="rounded-2xl bg-[#6C93FF] p-6" aria-label="Published external reference">
              <p className="font-mono text-[10px] tracking-[0.12em] text-black/60">PUBLISHED REFERENCE</p><h3 className="mt-2 text-lg font-semibold tracking-[-0.02em]">{reference.name}</h3>
              <p className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{percent(reference.n_correct / reference.n_attempted)}</p><p className="mt-1 text-xs text-black/70">{reference.n_correct} / {reference.n_attempted} correct</p>
              <p className="mt-4 text-xs leading-6 text-black/75">{reference.scope} Not run on this comparison’s hardware.</p><a href={reference.source_url} className="mt-4 inline-block text-xs font-medium underline underline-offset-4">View upstream outcomes ↗</a>
            </aside>
          </div>

          <dl className="my-8 grid gap-5 text-xs sm:grid-cols-3">
            <div><dt className="text-neutral-500">Data mode</dt><dd className="mt-1 break-words font-mono">{benchmark.data_mode}</dd><dd className="mt-1 text-neutral-500">Completed, recorded experiment</dd></div>
            <div><dt className="text-neutral-500">Verified at</dt><dd className="mt-1 font-mono"><time dateTime={benchmark.verified_at}>{time(benchmark.verified_at)}</time></dd><dd className="mt-1 text-neutral-500">Evidence time; not page-refresh time</dd></div>
            <div><dt className="text-neutral-500">Hardware / precision</dt><dd className="mt-1 font-mono">{benchmark.runtime.hardware}</dd><dd className="mt-1 text-neutral-500">{benchmark.runtime.precision.toUpperCase()}. Same runtime for both models.</dd></div>
          </dl>

          <details className="rounded-2xl bg-neutral-100 px-5 py-4 text-sm">
            <summary className="cursor-pointer font-medium marker:text-[#FF6A00] hover:text-[#3455dc]">Method, checkpoint identities & limitations</summary>
            <div className="mt-5 space-y-5 text-sm leading-7 text-neutral-700">
              <p>Fez fine-tunes a published Kev 0.8B checkpoint built on Qwen3.5-0.8B-Base. The unchanged published checkpoint is the baseline in this comparison.</p>
              <p>No official JevBench rank or composite score is available: private and sealed tests were not run. Hosted cost was not measured. Other experiment suites are documented separately and cannot form an improvement line with this comparison.</p>
              <dl className="space-y-4 text-xs">
                <div><dt className="font-medium text-neutral-950">Experiment / collection started</dt><dd>{benchmark.id} / <time dateTime={benchmark.started_at}>{time(benchmark.started_at)}</time></dd></div>
                {[['Fez checkpoint SHA-256', fez.checkpoint_sha256], ['Published Kev checkpoint SHA-256', kev.checkpoint_sha256], ['Public dataset SHA-256', benchmark.benchmark.dataset_sha256], ['Harness revision', benchmark.benchmark.harness_commit]].map(([label, hash]) => <div key={label}><dt className="font-medium text-neutral-950">{label}</dt><dd><code className="break-all font-mono">{hash}</code></dd></div>)}
                <div><dt className="font-medium text-neutral-950">Latency scope</dt><dd>{benchmark.runtime.latency_scope}.</dd></div>
                <div><dt className="font-medium text-neutral-950">Saved temperatures</dt><dd>Fez: {decimal(fez.temperature)}. Kev: {decimal(kev.temperature)}.</dd></div>
              </dl>
              <ul className="list-disc space-y-2 pl-5">{benchmark.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
              <p>The experimental Fez checkpoint is not distributed, so the full comparison cannot be reproduced from the checkout alone.</p>
              <div className="flex flex-wrap gap-x-6 gap-y-3"><a href={METHOD} className={LINK}>Full methodology</a><a href={benchmark.benchmark.upstream_url} className={LINK}>Pinned benchmark harness</a><a href={`${REPO}/blob/main/docs/experiments.md`} className={LINK}>Other experiment suites</a></div>
            </div>
          </details>
        </Section>

        <Section id="training" eyebrow="Training & evaluation" title="Train. Submit. Evaluate. Reward.">
          <ol className="grid gap-px overflow-hidden rounded-2xl bg-neutral-200 ring-1 ring-neutral-200 sm:grid-cols-2 lg:grid-cols-4">{PROCESS.map(([title, description], index) => <li key={title} className="bg-white p-6"><span className="font-mono text-xs text-[#FF6A00]">0{index + 1}</span><h3 className="mt-4 font-semibold tracking-[-0.02em]">{title}</h3><p className="mt-2 text-[13px] leading-6 text-neutral-600">{description}</p></li>)}</ol>
          <div className="mt-6 rounded-2xl border border-dashed border-neutral-300 p-6"><h3 className="font-semibold tracking-[-0.02em]">One testnet round completed</h3><p className="mt-2 text-sm leading-6 text-neutral-600">Training, signed submissions, evaluation, and revealed chain weights are recorded below. A live submission queue and round feed are not connected.</p><a href="#testnet" className={`${LINK} mt-3 inline-block text-sm`}>View the verified round</a></div>
          <p className="mt-5 max-w-[70ch] text-sm leading-7 text-neutral-600">The local loop works on Apple Silicon and an RTX 4090. Accuracy and latency are diagnostics, not separate reward components. The subnet’s family-macro Brier and JevBench Brier use different aggregation rules.</p>
          <a href={`${REPO}/blob/main/docs/evaluation.md`} className={`${LINK} mt-4 inline-block text-sm`}>Evaluation contract</a>
        </Section>

        <Section id="participants" eyebrow="Participants" title="Three miners. One validator. One host.">
          <p className="mb-5 text-sm text-neutral-600">Three registered miners and one validator completed the recorded subnet {testnet.chain.netuid} rehearsal.</p>
          <dl className={`divide-y divide-neutral-200 ${CARD}`}>{[['Miners · UIDs 1–3', 'Trained and submitted three distinct checkpoints'], ['Validator · UID 0', 'Evaluated the checkpoints and published weights']].map(([role, description]) => <div key={role} className="grid gap-x-4 gap-y-1 p-5 sm:grid-cols-[1fr_auto]"><dt className="font-medium">{role}</dt><dd className="text-xs text-neutral-600 sm:col-start-1">{description}</dd><dd className="mt-2 font-mono text-[10px] tracking-[0.1em] text-neutral-500 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:self-center">RECORDED PARTICIPATION</dd></div>)}</dl>
          <p className="mt-4 text-xs leading-6 text-neutral-500">One operator ran all four processes on one host. Services exited after the round; these counts do not indicate current availability or independent operators.</p>
          <a href={`${REPO}/blob/main/docs/mining.md`} className={`${LINK} mt-4 inline-block text-sm`}>Miner guide</a>
        </Section>

        <Section id="testnet" eyebrow="Testnet publication" title={`Bittensor testnet · Subnet ${testnet.chain.netuid}`}>
          <div className={CARD}>
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <p className="flex items-center gap-2 text-sm"><span className="size-1.5 rounded-full bg-emerald-500" />First training-to-chain round completed. Revealed weights verified.</p>
              <a href={TESTNET_SOURCE} className={`${LINK} text-sm`}>Round evidence (JSON) ↗</a>
            </div>
            <dl className="grid gap-6 border-t border-neutral-200 p-5 text-xs sm:grid-cols-2 lg:grid-cols-4">{[['Network', 'Bittensor testnet'], ['Publication receipt', testnet.chain.weight_transaction.extrinsic_id], ['Verified at block', testnet.chain.verification.block.toLocaleString('en-US')], ['Round status', 'Completed · recorded rehearsal']].map(([label, value]) => <div key={label}><dt className="text-neutral-500">{label}</dt><dd className="mt-2 font-mono">{value}</dd></div>)}</dl>
            <div role="region" aria-label="Recorded testnet miner weights" tabIndex={0} className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <caption className="sr-only">Three evaluated miners and their verified testnet weight allocation</caption>
                <thead className="bg-neutral-50 text-xs text-neutral-600"><tr><th scope="col" className={HEAD}>Miner UID</th><th scope="col" className={CELL}>Correct / 224</th><th scope="col" className={CELL}>Requested weight</th><th scope="col" className={CELL}>On-chain value</th></tr></thead>
                <tbody>{testnet.miners.map(miner => <tr key={miner.uid} className="hover:bg-neutral-50"><th scope="row" className={HEAD}>{miner.uid}</th><td className={CELL}>{miner.correct} / {miner.cases}</td><td className={`${CELL} font-medium`}>{percent(miner.requested_weight)}</td><td className={`${CELL} font-mono`}>{miner.on_chain_u16.toLocaleString('en-US')}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="border-t border-neutral-200 p-5 text-xs leading-6 text-neutral-500">Weights are based on family-macro Brier skill. The chain stores maximum-scaled integers; their normalized proportions matched the requested allocation within quantization tolerance. Verified <time dateTime={testnet.verified_at}>{time(testnet.verified_at)}</time>. This is the observation time, not a live refresh.</p>
          </div>
          <p className="mt-4 text-xs leading-6 text-neutral-600">Each 0.8B checkpoint trained for one epoch on 224 examples, calibrated on 112 questions, and was evaluated on the same 224 test questions. This reused synthetic development benchmark is separate from the public JevBench comparison above. All compute ran on one Apple M4 Pro with 24 GiB memory, with GPU jobs serialized.</p>
          <p className="mt-3 text-xs leading-6 text-neutral-600">This closed rehearsal demonstrates the training-to-chain path. It does not establish mainnet deployment, miner earnings, open competition, or automatic model promotion.</p>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-sm"><a href={TESTNET_SOURCE} className={LINK}>Scores, methodology & chain evidence</a><a href={`${REPO}/blob/main/docs/testnet.md`} className={LINK}>Testnet guide</a><a href={`${REPO}/blob/main/docs/roadmap.md`} className={LINK}>Roadmap</a></div>
        </Section>
        <p className="border-t border-neutral-200 py-8 text-xs text-neutral-500">Fez decision model. Public evidence, read-only access.</p>
      </main>
      <SiteFooter />
    </div>
  );
}
