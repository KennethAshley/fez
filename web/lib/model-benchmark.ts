import record from '../public/model/jevbench-public-001.json';

export const benchmark = record;
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const decimal = (value: unknown) => numeric(value) ? value.toFixed(6) : 'Unavailable';
export const percent = (value: unknown) => numeric(value) ? `${(value * 100).toFixed(2)}%` : 'Unavailable';
export const milliseconds = (value: unknown) => numeric(value) ? `${(value * 1000).toFixed(2)} ms` : 'Unavailable';

export function readComparison(data: typeof record) {
  const fez = data.models.find(model => model.id === 'fez');
  const kev = data.models.find(model => model.id === 'kev');
  if (data.schema_version !== 'fez.public-benchmark/v1' || data.data_mode !== 'recorded_experiment'
    || data.status !== 'completed' || !fez || !kev) throw new Error('Invalid recorded benchmark');
  for (const model of [fez, kev]) {
    const { n_attempted: total, n_correct: correct, accuracy } = model.metrics;
    if (!/^[a-f0-9]{64}$/.test(model.checkpoint_sha256) || !Number.isInteger(total) || total <= 0
      || !Number.isInteger(correct) || correct < 0 || correct > total
      || (accuracy != null && (!numeric(accuracy) || Math.abs(accuracy - correct / total) > 1e-8))) {
      throw new Error('Invalid recorded benchmark');
    }
  }
  if (fez.metrics.n_attempted !== kev.metrics.n_attempted) throw new Error('Invalid recorded benchmark');
  return { fez, kev };
}

export function comparisonHeadline(fez: typeof record.models[number], kev: typeof record.models[number]) {
  const a = fez.metrics;
  const b = kev.metrics;
  return [a.accuracy, b.accuracy, a.brier_mean, b.brier_mean, a.ece, b.ece].every(numeric)
    && a.accuracy === b.accuracy && a.brier_mean > b.brier_mean && a.ece > b.ece
    ? 'Accuracy tied; confidence quality regressed.'
    : 'Comparison recorded; review the available metrics.';
}
