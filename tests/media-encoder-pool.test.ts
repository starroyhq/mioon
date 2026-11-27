import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ENCODER_POOL_SLOTS, MAX_SEGMENT_ENCODERS, coreEncoderSlots, createMediaEncoderPool, memoryEncoderSlots,
  encoderPoolLimits, globalMediaEncoderPool, segmentConcurrencyFor, withMediaEncoderSlot,
  ENCODER_MEMORY_RESERVE_BYTES, ENCODER_RESIDENT_BYTES, encoderMemoryAllows, encoderResidentBytesForOutput,
} from '../packages/business/src/media-encoder-pool.ts';

const GiB = 1024 ** 3;

test('the global core form is not capped at the per-export four', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 2], [8, 3], [10, 4], [16, 7], [64, 31], [128, 63]] as const) {
    assert.equal(coreEncoderSlots(cores), expected, `${cores} cores`);
  }
  for (const invalid of [0, -1, 1.5, NaN, Infinity, '4', null]) assert.throws(() => coreEncoderSlots(invalid as never), RangeError);
  assert.equal(MAX_SEGMENT_ENCODERS, 4);
  assert.equal(segmentConcurrencyFor(7), 4);
  assert.equal(segmentConcurrencyFor(3), 3);
  assert.equal(segmentConcurrencyFor(1), 1);
  assert.throws(() => segmentConcurrencyFor(0), RangeError);
});

test('the memory form admits one global encoder per 512 MiB above the measured reserve', () => {
  for (const [bytes, expected] of [[2 * GiB, 1], [3 * GiB, 1], [3 * GiB + 512 * 1024 * 1024, 1], [4 * GiB, 2], [8 * GiB, 10], [128 * GiB, 250]] as const) {
    assert.equal(memoryEncoderSlots(bytes), expected, `${bytes} bytes`);
  }
  for (const invalid of [0, -1, NaN, Infinity, '8', null]) assert.throws(() => memoryEncoderSlots(invalid as never), RangeError);
});

test('the global pool takes the smaller of the core and memory forms', () => {
  assert.deepEqual({ ...encoderPoolLimits({ parallelism: 16, totalMemoryBytes: 128 * GiB }) },
    { slots: 7, coreSlots: 7, memorySlots: 250, residentBytes: 512 * 1024 * 1024, reserveBytes: 3 * GiB });
  assert.deepEqual({ ...encoderPoolLimits({ parallelism: 3, totalMemoryBytes: 7 * GiB }) },
    { slots: 1, coreSlots: 1, memorySlots: 8, residentBytes: 512 * 1024 * 1024, reserveBytes: 3 * GiB });
  const small = encoderPoolLimits({ parallelism: 8, totalMemoryBytes: 4 * GiB });
  assert.equal(small.coreSlots, 3);
  assert.equal(small.memorySlots, 2);
  assert.equal(small.slots, 2);
});

test('simulated 8-core 8 GiB and 16-core 128 GiB machines get three and seven slots', () => {
  // Synthetic inputs keep the formula assertions independent of this runner.
  assert.equal(encoderPoolLimits({ parallelism: 8, totalMemoryBytes: 8 * GiB }).slots, 3);
  assert.equal(encoderPoolLimits({ parallelism: 16, totalMemoryBytes: 128 * GiB }).slots, 7);
  // Two simultaneous exports may use all seven encoders, not 2 x 4.
  const pool = createMediaEncoderPool(encoderPoolLimits({ parallelism: 16, totalMemoryBytes: 128 * GiB }).slots);
  assert.equal(pool.limit, 7);
});

test('the application-wide pool is one lazily created instance at the computed limit', () => {
  const pool = globalMediaEncoderPool();
  assert.equal(pool, globalMediaEncoderPool());
  assert.equal(pool.limit, encoderPoolLimits().slots);
  assert.ok(pool.limit >= 1 && pool.limit <= MAX_ENCODER_POOL_SLOTS);
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

test('4K charges actual frame bytes and reserves room across export owners', async () => {
  const uhd = encoderResidentBytesForOutput(3840, 2160);
  const wide = encoderResidentBytesForOutput(4096, 1756);
  assert.equal(uhd, encoderResidentBytesForOutput(2160, 3840));
  assert.equal(encoderResidentBytesForOutput(1920, 1080), ENCODER_RESIDENT_BYTES);
  assert.ok(wide > 2 * ENCODER_RESIDENT_BYTES);
  assert.ok(uhd > wide && uhd < 3 * ENCODER_RESIDENT_BYTES);
  assert.ok(encoderMemoryAllows(uhd, ENCODER_MEMORY_RESERVE_BYTES + uhd));
  assert.equal(encoderMemoryAllows(uhd, ENCODER_MEMORY_RESERVE_BYTES + uhd - 1), false);

  const pool = createMediaEncoderPool(4);
  const first = await pool.acquire(undefined, {}, uhd);
  const normal = await pool.acquire();
  const next = pool.acquire(undefined, {}, uhd);
  assert.deepEqual(pool.stats(), { limit: 4, active: 2, waiting: 1, owners: 1 });
  normal();
  assert.equal(pool.stats().waiting, 1);
  first();
  (await next)();
  assert.equal(pool.stats().active, 0);
});

test('a queued 4K request can accumulate slots and cancelling it admits the next owner', async () => {
  const pool = createMediaEncoderPool(3);
  const holder = await pool.acquire();
  const cancel = new AbortController();
  const uhd = pool.acquire(cancel.signal, {}, encoderResidentBytesForOutput(3840, 2160));
  const other = pool.acquire();
  assert.equal(pool.stats().waiting, 2);
  cancel.abort();
  await assert.rejects(uhd, { code: 'MEDIA_CANCELLED' });
  (await other)();
  holder();
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

test('pool size is validated and admits the global slot count', () => {
  for (const invalid of [0, -1, 1.5, MAX_ENCODER_POOL_SLOTS + 1, NaN, Infinity, '4', null, undefined]) assert.throws(() => createMediaEncoderPool(invalid as never), RangeError);
  for (const limit of [1, 2, 3, 4, 7, 31, MAX_ENCODER_POOL_SLOTS]) assert.equal(createMediaEncoderPool(limit).limit, limit);
});
