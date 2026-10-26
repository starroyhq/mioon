import test from 'node:test';
import assert from 'node:assert/strict';
import {BACKEND_LEASE_TIMING, createBackendLease} from '../apps/desktop/src/backend-lease.ts';

type Lease = ReturnType<typeof createBackendLease>;
function fixture(options: {probe?(probeId: number, lease: Lease): void; expire?(lease: Lease): void} = {}) {
  let monotonic = 0, expired = 0;
  const probes: number[] = [];
  const lease: Lease = createBackendLease({now: () => monotonic,
    probe(probeId) {probes.push(probeId); options.probe?.(probeId, lease);},
    expire() {expired++; options.expire?.(lease);},
  });
  return {lease, probes, get expired() {return expired;}, get now() {return monotonic;},
    advance(ms: number, action: 'check' | 'ping' = 'check') {monotonic += ms; lease[action]();},
    elapse(ms: number) {monotonic += ms;},
  };
}
const check = BACKEND_LEASE_TIMING.checkIntervalMs;
const timeout = BACKEND_LEASE_TIMING.timeoutMs;

test('ordinary active execution retains the 30-second lease and a missing parent expires once', () => {
  assert.deepEqual(BACKEND_LEASE_TIMING, {timeoutMs: 30000, checkIntervalMs: 5000, pauseGapMs: 15000});
  const f = fixture();
  for (let index = 0; index < 6; index++) f.advance(check);
  assert.equal(f.expired, 0, 'The existing strict timeout boundary is retained');
  f.advance(1); assert.equal(f.expired, 1); assert.deepEqual(f.probes, []);
  f.advance(594000); f.lease.ping(); f.lease.acknowledge(1); f.lease.check();
  assert.equal(f.expired, 1); assert.deepEqual(f.probes, []);
});

for (const first of ['check', 'ping'] as const) test(`a 594-second sleep with ${first}-first requires fresh proof before normal renewal`, () => {
  const f = fixture(); f.advance(10000, 'ping');
  f.advance(594000, first); assert.deepEqual(f.probes, [1]); assert.equal(f.expired, 0);
  f.advance(check, 'ping'); f.lease.check(); assert.deepEqual(f.probes, [1]);
  f.lease.acknowledge(1);
  for (let index = 0; index < 8; index++) { f.advance(check, 'ping'); f.lease.check(); }
  assert.equal(f.expired, 0); assert.deepEqual(f.probes, [1]);
});

test('pending regular pings do not renew the proof budget or create another probe', () => {
  const f = fixture(); f.advance(594000);
  for (let index = 0; index < 5; index++) { f.advance(check, 'ping'); f.lease.check(); assert.equal(f.expired, 0); }
  f.advance(check, 'ping'); assert.equal(f.expired, 1); assert.deepEqual(f.probes, [1]);
  f.lease.acknowledge(1); f.advance(10000, 'ping'); assert.equal(f.expired, 1);
});

test('wrong or duplicate acknowledgements never prove another recovery epoch', () => {
  const f = fixture(); f.advance(594000); f.lease.acknowledge(1);
  f.advance(594000); assert.deepEqual(f.probes, [1, 2]);
  for (const id of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER, 1, 1]) f.lease.acknowledge(id);
  for (let index = 0; index < 5; index++) f.advance(check, 'ping');
  assert.equal(f.expired, 0); f.advance(check);
  assert.equal(f.expired, 1); assert.deepEqual(f.probes, [1, 2]);
});

test('a current acknowledgement at the exhausted execution budget cannot revive the lease', () => {
  const f = fixture(); f.advance(594000);
  for (let index = 0; index < 5; index++) f.advance(check);
  f.elapse(check); f.lease.acknowledge(1);
  assert.equal(f.expired, 1); f.lease.acknowledge(1); f.lease.ping(); f.lease.check();
  assert.equal(f.expired, 1); assert.deepEqual(f.probes, [1]);
});

test('an acknowledgement cannot answer a probe that its own first-gap observation has only just created', () => {
  const f = fixture(); f.elapse(594000); f.lease.acknowledge(1);
  assert.deepEqual(f.probes, [1]); assert.equal(f.expired, 0);
  for (let index = 0; index < 6; index++) f.advance(check, 'ping');
  assert.equal(f.expired, 1, 'Only an acknowledgement received after the probe was issued can renew the lease');
});

test('each completed sleep recovery permits a later fresh epoch without accepting its old proof', () => {
  const f = fixture();
  for (let epoch = 1; epoch <= 3; epoch++) {
    f.advance(594000); assert.equal(f.probes.at(-1), epoch);
    if (epoch > 1) f.lease.acknowledge(epoch - 1);
    f.advance(check, 'ping'); assert.equal(f.expired, 0);
    f.lease.acknowledge(epoch);
    for (let index = 0; index < 8; index++) f.advance(check, 'ping');
    assert.equal(f.expired, 0);
  }
  assert.deepEqual(f.probes, [1, 2, 3]);
});

test('20 seconds of DarkWake followed by another sleep retains only the remaining proof budget', () => {
  const f = fixture(); f.advance(594000);
  for (let index = 0; index < 4; index++) f.advance(check);
  f.advance(819000); assert.equal(f.expired, 0); assert.deepEqual(f.probes, [1]);
  f.advance(check); assert.equal(f.expired, 1, 'The second sleep charges one quantum instead of reopening 30 seconds');
});

test('fresh proof within the remaining DarkWake recovery budget restores the ordinary lease', () => {
  const f = fixture(); f.advance(594000);
  for (let index = 0; index < 4; index++) f.advance(check);
  f.elapse(819000); f.lease.acknowledge(1);
  assert.equal(f.expired, 0);
  for (let index = 0; index < 8; index++) f.advance(check, 'ping');
  assert.equal(f.expired, 0); assert.deepEqual(f.probes, [1]);
});

test('six further long gaps exhaust the single pending budget even when ordinary pings arrive first', () => {
  const f = fixture(); f.advance(594000);
  for (let index = 0; index < 5; index++) { f.advance(594000, 'ping'); assert.equal(f.expired, 0); }
  f.advance(594000, 'ping'); assert.equal(f.expired, 1); assert.deepEqual(f.probes, [1]);
  f.lease.acknowledge(1); f.advance(594000); assert.equal(f.expired, 1);
});

test('wall-clock changes do not create a pause or renew an expired monotonic lease', t => {
  let wall = 1000000;
  t.mock.method(Date, 'now', () => wall);
  const f = fixture();
  for (let index = 0; index < 6; index++) { wall += index % 2 ? -86400000 : 86400000; f.advance(check); }
  assert.equal(f.expired, 0); assert.deepEqual(f.probes, []);
  wall -= 86400000; f.advance(1); assert.equal(f.expired, 1); assert.deepEqual(f.probes, []);
});

test('close is terminal both before and during recovery, and expiry callbacks are not reentrant', () => {
  for (const pending of [false, true]) {
    const f = fixture(); if (pending) f.advance(594000);
    f.lease.close(); f.lease.close(); f.advance(594000); f.lease.ping(); f.lease.acknowledge(1);
    assert.equal(f.expired, 0); assert.equal(f.probes.length, pending ? 1 : 0);
  }
  const f = fixture({expire(lease) {lease.check(); lease.ping(); lease.acknowledge(1); lease.close();}});
  for (let index = 0; index < 6; index++) f.advance(check);
  f.advance(1); assert.equal(f.expired, 1);
});

test('a failed proof send expires once instead of granting a silent recovery renewal', () => {
  const f = fixture({probe() {throw Error('synthetic closed parent port');}});
  f.advance(594000); assert.equal(f.expired, 1); assert.deepEqual(f.probes, [1]);
  f.lease.ping(); f.lease.acknowledge(1); f.advance(594000); assert.equal(f.expired, 1);
});

test('a synchronous current-parent reply proves the installed recovery epoch safely', () => {
  const f = fixture({probe(id, lease) {lease.acknowledge(id);}});
  f.advance(594000); assert.equal(f.expired, 0);
  for (let index = 0; index < 8; index++) f.advance(check, 'ping');
  assert.equal(f.expired, 0); assert.deepEqual(f.probes, [1]);
  f.advance(594000); assert.deepEqual(f.probes, [1, 2]); assert.equal(f.expired, 0);
});
