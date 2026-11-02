import test from 'node:test';
import assert from 'node:assert/strict';
import {collectMioQuotaPerformance} from './helpers/mio-quota-performance.ts';

test('the protected-write benchmark restores occupancy and its quota guard reads only the production counter', async () => {
  const report = await collectMioQuotaPerformance({profile: 'current', points: [{label: 'empty-check', retainedBytes: 0, rowBytes: 2097152}], samples: 3, warmup: 1});
  const point = report.points[0]!;
  assert.deepEqual(point.retained, {bytes: 0, rows: 1});
  assert.deepEqual(point.counterBefore, point.retained);
  assert.deepEqual(point.counterAfter, point.retained);
  assert.equal(point.writeLogicalBytes, 200); assert.equal(point.writeContentBytes, 112);
  assert.equal(point.writesMeasured, 3); assert.equal(point.timing.samples.length, 3);
  assert.ok(point.timing.samples.every(value => Number.isFinite(value) && value >= 0));
  assert.deepEqual(point.sqlEvidence.guardReadTables, ['mio_storage_counters']);
  assert.equal(point.sqlEvidence.guardHasAggregate, false);
  assert.ok(point.sqlEvidence.guards.some(guard => guard.name === 'row_mio_blobs_insert'));
  assert.ok(point.sqlEvidence.guards.some(guard => guard.name === 'immutable_mio_blobs'));
});
