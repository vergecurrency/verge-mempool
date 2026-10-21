import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observedVergeFeeStatistics } from '../../api/verge/mempool-stats';

test('a small Verge mempool reports observed paid fees rather than unused Bitcoin block space', () => {
  const stats = observedVergeFeeStatistics([{ fee: 100000, weight: 1012 }]);
  assert.equal(stats.medianFee, 100000 / 253);
  assert.ok(stats.feeRange.every(rate => rate === stats.medianFee));
});
test('Verge fee quantiles retain zero-fee transactions and weight by bytes', () => {
  const stats = observedVergeFeeStatistics([{ fee: 0, weight: 400 }, { fee: 1000, weight: 3600 }]);
  assert.equal(stats.feeRange[0], 0);
  assert.equal(stats.medianFee, 1000 / 900);
  assert.equal(stats.feeRange[6], 1000 / 900);
});
test('invalid monetary and size values fail explicitly; an empty pool is valid', () => {
  assert.deepEqual(observedVergeFeeStatistics([]).feeRange, [0, 0, 0, 0, 0, 0, 0]);
  for (const tx of [{ fee: Number.MAX_SAFE_INTEGER + 1, weight: 400 }, { fee: -1, weight: 400 }, { fee: 1000, weight: 0 }]) {
    assert.throws(() => observedVergeFeeStatistics([tx]));
  }
});
