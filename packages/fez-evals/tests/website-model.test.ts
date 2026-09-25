import { expect, it } from 'vitest';
import { benchmark, readComparison, percent, decimal, milliseconds, comparisonHeadline } from '../../../web/lib/model-benchmark.js';
import testnet from '../../../web/public/model/testnet-round-001.json';

it('publishes recorded testnet evidence whose chain weights match the requested allocation', () => {
  expect(testnet.data_mode).toBe('recorded-closed-testnet-rehearsal');
  expect(testnet.chain.network).toBe('test');
  expect(testnet.chain.netuid).toBe(579);
  expect(testnet.chain.weight_transaction.success).toBe(true);
  expect(testnet.chain.verification.weights_verified).toBe(true);
  expect(testnet.chain.verification.block).toBeGreaterThan(testnet.chain.verification.last_update);
  const chainTotal = testnet.miners.reduce((sum, miner) => sum + miner.on_chain_u16, 0);
  expect(testnet.miners.reduce((sum, miner) => sum + miner.requested_weight, 0)).toBeCloseTo(1, 8);
  for (const miner of testnet.miners) {
    expect(Object.entries(testnet.chain.verification.on_chain_weights)).toContainEqual([String(miner.uid), miner.on_chain_u16]);
    expect(Math.abs(miner.on_chain_u16 / chainTotal - miner.requested_weight)).toBeLessThan(2 / 65535);
    expect(miner.accuracy).toBeCloseTo(miner.correct / miner.cases, 8);
  }
});

it('preserves the public model comparison, units, and unavailable values', () => {
  const { fez, kev } = readComparison(benchmark);
  expect(percent(fez.metrics.accuracy)).toBe('63.64%');
  expect(fez.metrics.n_correct).toBe(147);
  expect(fez.metrics.confident_errors).toBe(8);
  expect(kev.metrics.confident_errors).toBe(3);
  expect(decimal(fez.metrics.brier_mean)).toBe('0.463608');
  expect(milliseconds(fez.metrics.latency.p50_s)).toBe('42.08 ms');
  expect(milliseconds(kev.metrics.latency.p95_s)).toBe('209.36 ms');
  expect(comparisonHeadline(fez, kev)).toBe('Accuracy tied; confidence quality regressed.');
  expect(percent(benchmark.published_reference.n_correct / benchmark.published_reference.n_attempted)).toBe('86.58%');
  expect(percent(0)).toBe('0.00%');
  for (const value of [null, undefined, NaN, '', '0.2']) {
    for (const format of [percent, decimal, milliseconds]) expect(format(value)).toBe('Unavailable');
  }
  expect(() => readComparison({ ...benchmark, models: [] })).toThrow('Invalid recorded benchmark');
  expect(() => readComparison({ ...benchmark, data_mode: 'live' })).toThrow('Invalid recorded benchmark');
  const inconsistent = structuredClone(benchmark);
  inconsistent.models[0].metrics.n_correct = 999;
  expect(() => readComparison(inconsistent)).toThrow('Invalid recorded benchmark');
});
