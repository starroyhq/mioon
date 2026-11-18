import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SEGMENT_ENCODERS, createMediaEncoderPool, encoderMemorySlots, encoderPoolLimits,
  globalMediaEncoderPool, segmentEncoderConcurrency, withMediaEncoderSlot,
} from '../packages/business/src/media-encoder-pool.ts';

const GiB = 1024 ** 3;

test('the per-render segment formula is the whole-application ceiling', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 2], [8, 3], [10, 4], [16, 4], [64, 4]] as const) {
    assert.equal(segmentEncoderConcurrency(cores), expected, `${cores} cores`);
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '4', null]) assert.throws(() => segmentEncoderConcurrency(invalid as never), RangeError);
  assert.equal(MAX_SEGMENT_ENCODERS, 4);
});

test('the memory form admits one encoder per 512 MiB above the measured reserve', () => {
  for (const [bytes, expected] of [[2 * GiB, 1], [3 * GiB, 1], [3 * GiB + 512 * 1024 * 1024, 1], [4 * GiB, 2], [8 * GiB, 4], [128 * GiB, 4]] as const) {
    assert.equal(encoderMemorySlots(bytes), expected, `${bytes} bytes`);
  }
  for (const invalid of [0, -1, NaN, Infinity, '8', null]) assert.throws(() => encoderMemorySlots(invalid as never), RangeError);
});

test('the pool takes the smaller of the core and memory forms', () => {
  assert.deepEqual({ ...encoderPoolLimits({ parallelism: 16, totalMemoryBytes: 8 * GiB }) },
    { slots: 4, coreSlots: 4, memorySlots: 4, residentBytes: 512 * 1024 * 1024, reserveBytes: 3 * GiB });
  assert.deepEqual({ ...encoderPoolLimits({ parallelism: 3, totalMemoryBytes: 7 * GiB }) },
    { slots: 1, coreSlots: 1, memorySlots: 4, residentBytes: 512 * 1024 * 1024, reserveBytes: 3 * GiB });
  const small = encoderPoolLimits({ parallelism: 8, totalMemoryBytes: 4 * GiB });
  assert.equal(small.coreSlots, 3);
  assert.equal(small.memorySlots, 2);
  assert.equal(small.slots, 2);
});

test('the application-wide pool is one lazily created instance at the computed limit', () => {
  const pool = globalMediaEncoderPool();
  assert.equal(pool, globalMediaEncoderPool());
  assert.equal(pool.limit, encoderPoolLimits().slots);
  assert.ok(pool.limit >= 1 && pool.limit <= MAX_SEGMENT_ENCODERS);
});

test('queued owners are served round-robin, not head-of-line by one owner', async () => {
  const pool = createMediaEncoderPool(1), a = {}, b = {};
  const active = await pool.acquire(undefined, a);
  assert.deepEqual(pool.stats(), { limit: 1, active: 1, waiting: 0, owners: 0 });
  // A already holds the slot and asks for two more; B then asks for two.
  // A's own queue must not keep B waiting behind both of A's requests.
  const grants: string[] = [];
  const grant = (owner: object, name: string) => pool.acquire(undefined, owner).then(release => { grants.push(name); return release; });
  const a2 = grant(a, 'a'), a3 = grant(a, 'a'), b1 = grant(b, 'b'), b2 = grant(b, 'b');
  assert.deepEqual(pool.stats(), { limit: 1, active: 1, waiting: 4, owners: 2 });
  active();
  const rb1 = await b1;
  assert.deepEqual(grants, ['b']);
  rb1();
  const ra2 = await a2;
  assert.deepEqual(grants, ['b', 'a']);
  ra2();
  const rb2 = await b2;
  assert.deepEqual(grants, ['b', 'a', 'b']);
  rb2();
  const ra3 = await a3;
  assert.deepEqual(grants, ['b', 'a', 'b', 'a']);
  ra3();
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
});

test('aborting a queued request returns nothing and leaves the slot with its holder', async () => {
  const pool = createMediaEncoderPool(1), holder = await pool.acquire();
  const controller = new AbortController(), queued = pool.acquire(controller.signal, {});
  assert.deepEqual(pool.stats(), { limit: 1, active: 1, waiting: 1, owners: 1 });
  controller.abort();
  await assert.rejects(queued, { code: 'MEDIA_CANCELLED' });
  assert.deepEqual(pool.stats(), { limit: 1, active: 1, waiting: 0, owners: 0 });
  holder();
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
  await assert.rejects(pool.acquire(AbortSignal.abort()), { code: 'MEDIA_CANCELLED' });
});

test('a release is idempotent', async () => {
  const pool = createMediaEncoderPool(1), release = await pool.acquire();
  release();
  release();
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
  (await pool.acquire())();
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
});

test('withMediaEncoderSlot always returns the slot, including on failure', async () => {
  const pool = createMediaEncoderPool(1);
  const failure = await withMediaEncoderSlot(pool, undefined, () => { throw Object.assign(new Error('operation failed'), { code: 'OPERATION_FAILED' }); })
    .catch(error => error);
  assert.equal((failure as { code?: string }).code, 'OPERATION_FAILED');
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
  let observed = 0;
  await withMediaEncoderSlot(pool, undefined, async () => { observed = pool.stats().active; });
  assert.equal(observed, 1);
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
  const holder = await pool.acquire(), controller = new AbortController();
  const queued = withMediaEncoderSlot(pool, controller.signal, () => assert.fail('an aborted queued operation must not run'));
  controller.abort();
  await assert.rejects(queued, { code: 'MEDIA_CANCELLED' });
  holder();
  assert.deepEqual(pool.stats(), { limit: 1, active: 0, waiting: 0, owners: 0 });
});

test('pool size and owner arguments are validated', () => {
  for (const invalid of [0, -1, 1.5, 5, NaN, Infinity, '4', null, undefined]) assert.throws(() => createMediaEncoderPool(invalid as never), RangeError);
  for (const limit of [1, 2, 3, 4]) assert.equal(createMediaEncoderPool(limit).limit, limit);
});
