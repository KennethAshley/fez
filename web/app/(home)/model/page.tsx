import type { Metadata } from 'next';
import { PageSection, SitePage } from '@/components/site-page';
import { benchmark, readComparison, percent, decimal, milliseconds, comparisonHeadline } from '@/lib/model-benchmark';
import testnet from '@/public/model/testnet-round-001.json';

export const metadata: Metadata = {
  title: 'fez — the decision model',
  description: 'Fez’s experimental 0.8B decision model. Recorded public benchmarks, checkpoint evidence, and the current state of its training competition.',
  alternates: { canonical: 'https://fez.chat/model' },
};

const REPO = 'https://github.com/ooo-hq/fez';
const METHOD = `${REPO}/blob/main/docs/jevbench-public.md`;
const SOURCE = '/model/jevbench-public-001.json';
const TESTNET_SOURCE = '/model/testnet-round-001.json';
const LINK = 'text-[#FF6A00] underline decoration-[#FF6A00]/40 underline-offset-4 hover:decoration-[#FF6A00]';
const CELL = 'border-t border-neutral-800 px-3 py-3 text-right tabular-nums sm:px-5';
const HEAD = 'border-t border-neutral-800 px-3 py-3 text-left font-normal text-neutral-200 sm:px-5';
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

function time(value: string) {
  return `${new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', hourCycle: 'h23',
  }).format(new Date(value))} UTC`;
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
    <SitePage current="model" title="Decisions, measured."
      description="Fez is an experimental 0.8B decision model for yes/no questions, choices, and scores. It returns structured probabilities without generating prose."
      note="Experimental candidate. No public model release or automatic winner promotion yet.">
      <a href="#testnet" className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-[#FF6A00]/50 bg-[#FF6A00]/5 px-5 py-4 text-sm hover:bg-[#FF6A00]/10">
        <span className="font-medium text-[#FF6A00]">Bittensor testnet · Subnet {testnet.chain.netuid}</span>
        <span className="text-neutral-300">First training round verified on-chain <span aria-hidden="true">↓</span></span>
      </a>
      <nav aria-label="Project resources" className="mb-8 grid gap-3 sm:grid-cols-3">
        {[
          { href: REPO, title: 'GitHub repository', description: 'Explore the training and evaluation code.' },
          { href: METHOD, title: 'Methodology', description: 'Read how the comparison was run and its limits.' },
          { href: SOURCE, title: 'Source data', description: 'Inspect the exact recorded results as JSON.' },
        ].map(resource => (
          <a key={resource.href} href={resource.href} className="group border border-neutral-700 bg-neutral-950 px-5 py-4 hover:border-[#FF6A00] hover:bg-[#FF6A00]/5">
            <span className="flex items-center justify-between gap-4 text-base font-medium text-[#FF6A00]">{resource.title}<span aria-hidden="true" className="text-xl">↗</span></span>
            <span className="mt-2 block text-sm leading-6 text-neutral-300">{resource.description}</span>
          </a>
        ))}
      </nav>
      <nav aria-label="On this page" className="mb-10 flex flex-wrap gap-x-6 gap-y-3 border-y border-neutral-800 py-4 text-sm">
        {SECTIONS.map(section => <a key={section.id} href={`#${section.id}`} className="text-neutral-300 hover:text-[#FF6A00]">{section.title}</a>)}
      </nav>

      <div className="space-y-14 sm:space-y-16">
        <section id="overview" aria-labelledby="overview-heading" className="scroll-mt-8">
          <div className="grid gap-8 sm:grid-cols-[1.3fr_1fr]">
            <div>
              <h2 id="overview-heading" className="font-mono text-xl text-white">Probabilities. Without the prose.</h2>
              <p className="mt-4 max-w-[62ch]">Fez returns structured probabilities without generating a text answer. Applications can load a selected checkpoint directly.</p>
            </div>
            <div className="border-l border-neutral-800 pl-6">
              <p className="text-xs text-neutral-400">Public benchmark candidate</p>
              <code className="mt-3 block break-all text-sm leading-6 text-neutral-200">{fez.checkpoint_sha256}</code>
            </div>
          </div>
        </section>

        <PageSection id="quality" title="Model quality">
          <div className="mb-6 border-l-2 border-[#FF6A00] bg-[#FF6A00]/5 px-5 py-4">
            <p className="font-medium text-neutral-100">{comparisonHeadline(fez, kev)}</p>
            <p className="mt-2 text-sm">Fez corrected {benchmark.paired_outcomes.fez_corrected} reference-model errors and introduced {benchmark.paired_outcomes.fez_regressed}. No general improvement is established.</p>
          </div>
          <dl className="mb-6 grid grid-cols-1 divide-y divide-neutral-800 border border-neutral-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <div className="p-5"><dt className="text-xs">Fez accuracy</dt><dd className="mt-2 font-mono text-3xl tracking-tight text-white">{percent(f.accuracy)}</dd><dd className="mt-2 text-xs">{f.n_correct} of {f.n_attempted} public items correct</dd></div>
            <div className="p-5"><dt className="text-xs">Fez Brier loss</dt><dd className="mt-2 font-mono text-3xl tracking-tight text-white">{decimal(f.brier_mean)}</dd><dd className="mt-2 text-xs">Probability error. Lower is better.</dd></div>
            <div className="p-5"><dt className="text-xs">Fez confident mistakes</dt><dd className="mt-2 font-mono text-3xl tracking-tight text-white">{f.confident_errors}</dd><dd className="mt-2 text-xs">Wrong at ≥90% confidence.</dd></div>
          </dl>

          <div className="border border-neutral-800">
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-5 sm:px-5">
              <div><h3 className="font-medium text-white">{benchmark.benchmark.name} public comparison</h3><p className="mt-1 text-xs">{benchmark.benchmark.subset}</p></div>
              <a href={SOURCE} className="inline-flex min-h-11 items-center gap-3 border border-[#FF6A00]/60 bg-[#FF6A00]/5 px-4 py-2 text-sm font-medium text-[#FF6A00] hover:bg-[#FF6A00]/15">Source data (JSON)<span aria-hidden="true">↗</span></a>
            </div>
            <div role="region" aria-label="Overall model comparison" tabIndex={0} className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[320px] border-collapse text-sm">
                <caption className="sr-only">Recorded Fez and published Kev results on the same public items</caption>
                <thead className="bg-neutral-950 text-xs text-neutral-300"><tr><th scope="col" className={HEAD}>Metric</th><th scope="col" className={`${CELL} text-[#FF6A00]`}>Fez candidate<span className="mt-1 block font-normal text-neutral-400">Experimental checkpoint</span></th><th scope="col" className={CELL}>Published Kev 0.8B<span className="mt-1 block font-normal text-neutral-400">Comparison baseline</span></th></tr></thead>
                <tbody>{rows.map(([name, hint, baseline, candidate]) => <tr key={name} className="hover:bg-neutral-950"><th scope="row" className={HEAD}>{name}<span className="mt-1 block text-xs text-neutral-400">{hint}</span></th><td className={`${CELL} font-medium text-neutral-100`}>{candidate ?? 'Unavailable'}</td><td className={CELL}>{baseline ?? 'Unavailable'}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="border-t border-neutral-800 px-4 py-4 text-xs leading-6 sm:px-5">Brier loss measures probability error; ECE measures the gap between confidence and observed accuracy. Lower is better for both. Timing is {benchmark.runtime.measurement}, on {benchmark.runtime.hardware}, via localhost HTTP. This does not establish a reliable speedup or production SLA.</p>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-[1.3fr_1fr]">
            <div className="min-w-0 border border-neutral-800">
              <h3 className="px-4 py-4 font-medium text-white sm:px-5">Accuracy by difficulty</h3>
              <div role="region" aria-label="Accuracy by difficulty" tabIndex={0} className="overflow-x-auto overscroll-x-contain">
                <table className="w-full min-w-[310px] border-collapse text-sm">
                  <caption className="sr-only">Correct and total counts, with accuracy, for each public subset</caption>
                  <thead className="bg-neutral-950 text-xs"><tr><th scope="col" className={HEAD}>Subset</th><th scope="col" className={`${CELL} text-[#FF6A00]`}>Fez</th><th scope="col" className={CELL}>Kev baseline</th></tr></thead>
                  <tbody>{(['easy', 'original', 'hard'] as const).map(name => <tr key={name}><th scope="row" className={`${HEAD} capitalize`}>{name}</th>{[fez, kev].map(model => <td key={model.id} className={CELL}>{model.slices[name]?.n_correct ?? 'Unavailable'} / {model.slices[name]?.n_scorable ?? 'Unavailable'}<span className="block text-xs text-neutral-400">{percent(model.slices[name]?.accuracy)}</span></td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
            <aside className="border border-neutral-800 bg-neutral-950 p-5" aria-label="Published external reference">
              <p className="text-xs text-neutral-400">Published reference</p><h3 className="mt-2 font-mono text-lg text-white">{reference.name}</h3>
              <p className="mt-3 font-mono text-3xl text-white">{percent(reference.n_correct / reference.n_attempted)}</p><p className="mt-1 text-xs">{reference.n_correct} / {reference.n_attempted} correct</p>
              <p className="mt-4 text-xs leading-6">{reference.scope} Not run on this comparison’s hardware.</p><a href={reference.source_url} className={`${LINK} mt-4 inline-block text-xs`}>View upstream outcomes</a>
            </aside>
          </div>

          <dl className="my-6 grid gap-5 text-xs sm:grid-cols-3">
            <div><dt className="text-neutral-400">Data mode</dt><dd className="mt-1 break-words text-neutral-200">{benchmark.data_mode}</dd><dd className="mt-1">Completed, recorded experiment</dd></div>
            <div><dt className="text-neutral-400">Verified at</dt><dd className="mt-1 text-neutral-200"><time dateTime={benchmark.verified_at}>{time(benchmark.verified_at)}</time></dd><dd className="mt-1">Evidence time; not page-refresh time</dd></div>
            <div><dt className="text-neutral-400">Hardware / precision</dt><dd className="mt-1 text-neutral-200">{benchmark.runtime.hardware}</dd><dd className="mt-1">{benchmark.runtime.precision.toUpperCase()}. Same runtime for both models.</dd></div>
          </dl>

          <details className="border-y border-neutral-800 py-4 text-sm">
            <summary className="cursor-pointer text-neutral-200 hover:text-[#FF6A00]">Method, checkpoint identities & limitations</summary>
            <div className="mt-5 space-y-5 text-sm leading-7">
              <p>Fez fine-tunes a published Kev 0.8B checkpoint built on Qwen3.5-0.8B-Base. The unchanged published checkpoint is the baseline in this comparison.</p>
              <p>No official JevBench rank or composite score is available: private and sealed tests were not run. Hosted cost was not measured. Other experiment suites are documented separately and cannot form an improvement line with this comparison.</p>
              <dl className="space-y-4 text-xs">
                <div><dt className="text-neutral-200">Experiment / collection started</dt><dd>{benchmark.id} / <time dateTime={benchmark.started_at}>{time(benchmark.started_at)}</time></dd></div>
                {[['Fez checkpoint SHA-256', fez.checkpoint_sha256], ['Published Kev checkpoint SHA-256', kev.checkpoint_sha256], ['Public dataset SHA-256', benchmark.benchmark.dataset_sha256], ['Harness revision', benchmark.benchmark.harness_commit]].map(([label, hash]) => <div key={label}><dt className="text-neutral-200">{label}</dt><dd><code className="break-all">{hash}</code></dd></div>)}
                <div><dt className="text-neutral-200">Latency scope</dt><dd>{benchmark.runtime.latency_scope}.</dd></div>
                <div><dt className="text-neutral-200">Saved temperatures</dt><dd>Fez: {decimal(fez.temperature)}. Kev: {decimal(kev.temperature)}.</dd></div>
              </dl>
              <ul className="list-disc space-y-2 pl-5">{benchmark.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul>
              <p>The experimental Fez checkpoint is not distributed, so the full comparison cannot be reproduced from the checkout alone.</p>
              <div className="flex flex-wrap gap-x-6 gap-y-3"><a href={METHOD} className={LINK}>Full methodology</a><a href={benchmark.benchmark.upstream_url} className={LINK}>Pinned benchmark harness</a><a href={`${REPO}/blob/main/docs/experiments.md`} className={LINK}>Other experiment suites</a></div>
            </div>
          </details>
        </PageSection>

        <PageSection id="training" title="Training & evaluation">
          <ol className="grid gap-7 sm:grid-cols-2 lg:grid-cols-4">{PROCESS.map(([title, description], index) => <li key={title}><span className="font-mono text-xs text-[#FF6A00]">0{index + 1}</span><h3 className="mt-2 font-medium text-white">{title}</h3><p className="mt-2 text-sm leading-6">{description}</p></li>)}</ol>
          <div className="mt-7 border border-dashed border-neutral-700 p-5"><h3 className="font-medium text-neutral-200">One testnet round completed</h3><p className="mt-2 text-sm">Training, signed submissions, evaluation, and revealed chain weights are recorded below. A live submission queue and round feed are not connected.</p><a href="#testnet" className={`${LINK} mt-3 inline-block text-sm`}>View the verified round</a></div>
          <p className="mt-5 text-sm leading-7">The local loop works on Apple Silicon and an RTX 4090. Accuracy and latency are diagnostics, not separate reward components. The subnet’s family-macro Brier and JevBench Brier use different aggregation rules.</p>
          <a href={`${REPO}/blob/main/docs/evaluation.md`} className={`${LINK} mt-4 inline-block text-sm`}>Evaluation contract</a>
        </PageSection>

        <PageSection id="participants" title="Participants">
          <p className="mb-5 text-sm">Three registered miners and one validator completed the recorded subnet {testnet.chain.netuid} rehearsal.</p>
          <dl className="divide-y divide-neutral-800 border border-neutral-800">{[['Miners · UIDs 1–3', 'Trained and submitted three distinct checkpoints'], ['Validator · UID 0', 'Evaluated the checkpoints and published weights']].map(([role, description]) => <div key={role} className="grid gap-x-4 gap-y-1 p-5 sm:grid-cols-[1fr_auto]"><dt className="text-neutral-200">{role}</dt><dd className="text-xs sm:col-start-1">{description}</dd><dd className="mt-2 text-xs sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:self-center">Recorded participation</dd></div>)}</dl>
          <p className="mt-4 text-xs leading-6">One operator ran all four processes on one host. Services exited after the round; these counts do not indicate current availability or independent operators.</p>
          <a href={`${REPO}/blob/main/docs/mining.md`} className={`${LINK} mt-4 inline-block text-sm`}>Miner guide</a>
        </PageSection>

        <PageSection id="testnet" title="Testnet publication">
          <div className="border border-neutral-800">
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div><h3 className="font-medium text-[#FF6A00]">Bittensor testnet · Subnet {testnet.chain.netuid}</h3><p className="mt-2 text-sm">First training-to-chain round completed. Revealed weights verified.</p></div>
              <a href={TESTNET_SOURCE} className={`${LINK} text-sm`}>Round evidence (JSON) ↗</a>
            </div>
            <dl className="grid gap-6 border-t border-neutral-800 p-5 text-xs sm:grid-cols-2 lg:grid-cols-4">{[['Network', 'Bittensor testnet'], ['Publication receipt', testnet.chain.weight_transaction.extrinsic_id], ['Verified at block', testnet.chain.verification.block.toLocaleString('en-US')], ['Round status', 'Completed · recorded rehearsal']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mt-2 text-neutral-200">{value}</dd></div>)}</dl>
            <div role="region" aria-label="Recorded testnet miner weights" tabIndex={0} className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <caption className="sr-only">Three evaluated miners and their verified testnet weight allocation</caption>
                <thead className="bg-neutral-950 text-xs"><tr><th scope="col" className={HEAD}>Miner UID</th><th scope="col" className={CELL}>Correct / 224</th><th scope="col" className={CELL}>Requested weight</th><th scope="col" className={CELL}>On-chain value</th></tr></thead>
                <tbody>{testnet.miners.map(miner => <tr key={miner.uid}><th scope="row" className={HEAD}>{miner.uid}</th><td className={CELL}>{miner.correct} / {miner.cases}</td><td className={`${CELL} text-neutral-100`}>{percent(miner.requested_weight)}</td><td className={CELL}>{miner.on_chain_u16.toLocaleString('en-US')}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="border-t border-neutral-800 p-5 text-xs leading-6">Weights are based on family-macro Brier skill. The chain stores maximum-scaled integers; their normalized proportions matched the requested allocation within quantization tolerance. Verified <time dateTime={testnet.verified_at}>{time(testnet.verified_at)}</time>. This is the observation time, not a live refresh.</p>
          </div>
          <p className="mt-4 text-xs leading-6">Each 0.8B checkpoint trained for one epoch on 224 examples, calibrated on 112 questions, and was evaluated on the same 224 test questions. This reused synthetic development benchmark is separate from the public JevBench comparison above. All compute ran on one Apple M4 Pro with 24 GiB memory, with GPU jobs serialized.</p>
          <p className="mt-3 text-xs leading-6">This closed rehearsal demonstrates the training-to-chain path. It does not establish mainnet deployment, miner earnings, open competition, or automatic model promotion.</p>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 text-sm"><a href={TESTNET_SOURCE} className={LINK}>Scores, methodology & chain evidence</a><a href={`${REPO}/blob/main/docs/testnet.md`} className={LINK}>Testnet guide</a><a href={`${REPO}/blob/main/docs/roadmap.md`} className={LINK}>Roadmap</a></div>
        </PageSection>
      </div>
      <p className="mt-14 border-t border-neutral-800 pt-6 text-xs">Fez decision model. Public evidence, read-only access.</p>
    </SitePage>
  );
}
