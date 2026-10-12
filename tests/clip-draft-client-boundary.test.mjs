import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipDraftClient, clipDraftFailure } from '../apps/web/src/clip-draft-client.ts';
import { LOCAL_DRAFT_LIMITS, clipDraftEnvelopeSchema, clipDraftSlotSchema } from '../packages/contracts/src/local-drafts.ts';

const id = n => `db000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = { projectId: id(1), timelineId: id(2), clipId: id(3) };
const authority = { workspaceScope: 'a'.repeat(64), instanceId: id(4) };
const source = { assetId: id(5), assetSha256: 'b'.repeat(64) };
const raw = { name: 'Local clip', trackId: id(6), startFrame: '001', durationFrames: 120, sourceInFrame: '', rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: '0.50' };
const input = { ...key, ...authority, expectedRevision: 7, baseRevision: 11, source, raw };
const removal = { ...key, ...authority, expectedRevision: 7 };
const envelope = (patch = {}) => ({ supported: true, ...authority, key, revision: 8, targetStatus: 'matching', draft: { baseRevision: 11, source, raw, updatedAt: '2026-10-12T16:00:00.000Z' }, ...patch });
const ack = data => JSON.stringify({ ok: true, data });
const refusal = code => ({ ok: false, error: { code, message: 'Opaque service evidence', details: {}, retryable: false } });
const invoke = (client, method) => method === 'GET' ? client.get(key) : method === 'PUT' ? client.put(input) : client.remove(removal);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = () => new Promise(resolve => setImmediate(resolve));
function observe(promise) {
  const outcome = { status: 'pending' };
  void promise.then(value => Object.assign(outcome, { status: 'fulfilled', value }), error => Object.assign(outcome, { status: 'rejected', error }));
  return outcome;
}
const timeoutFailure = { code: 'LOCAL_DRAFT_TIMEOUT_UNKNOWN', status: null, kind: 'unknown' };
const protocolFailure = status => ({ code: 'LOCAL_DRAFT_PROTOCOL_UNKNOWN', status, kind: 'unknown' });
function assertFailure(outcome, expected) {
  assert.equal(outcome.status, 'rejected', 'request must settle without waiting for the transport');
  assert.deepEqual(clipDraftFailure(outcome.error), expected);
}
function mockTime(t) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() }); }

for (const method of ['GET', 'PUT', 'DELETE']) {
  test(`${method} has a whole-request deadline while response headers hang`, async t => {
    mockTime(t);
    const gate = deferred(); let signal, calls = 0, cancelled = 0;
    t.after(() => gate.resolve(new Response(ack(envelope()))));
    const client = createClipDraftClient((_url, init) => { calls++; signal = init.signal; return gate.promise; }, { timeoutMs: 25 });
    const outcome = observe(invoke(client, method));
    await drain(); t.mock.timers.tick(24); await drain(); assert.equal(outcome.status, 'pending');
    t.mock.timers.tick(1); await drain(); assertFailure(outcome, timeoutFailure); assert.equal(signal.aborted, true);
    gate.resolve(new Response(new ReadableStream({ cancel() { cancelled++; return Promise.reject(Error('late cancel failed')); } })));
    await drain(); assert.equal(cancelled, 1, 'late response is cancelled even when the fetcher ignores AbortSignal');
    assertFailure(outcome, timeoutFailure); assert.equal(calls, 1, 'deadline never retries GET, PUT or DELETE');
  });

  test(`${method} has a whole-request deadline while the response body hangs`, async t => {
    mockTime(t);
    let signal, cancelled = 0, stream;
    const response = new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode('{"ok":true,')); }, cancel() { cancelled++; return Promise.reject(Error('body cancel failed')); } }));
    t.after(() => { try { stream.close(); } catch {} });
    const client = createClipDraftClient(async (_url, init) => { signal = init.signal; return response; }, { timeoutMs: 25 });
    const outcome = observe(invoke(client, method));
    await drain(); t.mock.timers.tick(25); await drain(); assertFailure(outcome, timeoutFailure);
    assert.equal(signal.aborted, true); assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
  });
}

test('deadline defaults to 10s, clamps to 60s, and remains finite for invalid options', async t => {
  for (const [timeoutMs, deadline] of [[undefined, 10000], [NaN, 10000], [Infinity, 10000], [120000, 60000], [0, 1], [-1, 1]]) {
    await t.test(`timeoutMs=${String(timeoutMs)} uses ${deadline}ms`, async t => {
      mockTime(t); const gate = deferred(); let signal;
      t.after(() => gate.resolve(new Response(ack(envelope()))));
      const client = createClipDraftClient((_url, init) => { signal = init.signal; return gate.promise; }, timeoutMs === undefined ? undefined : { timeoutMs });
      const outcome = observe(client.get(key)); await drain();
      t.mock.timers.tick(deadline - 1); await drain(); assert.equal(outcome.status, 'pending');
      t.mock.timers.tick(1); await drain(); assertFailure(outcome, timeoutFailure); assert.equal(signal.aborted, true);
    });
  }
});

test('expired PUT cannot accept a late ACK, alter its CAS, or issue another PUT', async t => {
  mockTime(t); const gate = deferred(), calls = []; let cancelled = 0;
  t.after(() => gate.resolve(new Response(ack(envelope()))));
  const client = createClipDraftClient((url, init) => { calls.push({ url, init }); return gate.promise; }, { timeoutMs: 10 });
  const outcome = observe(client.put(input)); await drain(); t.mock.timers.tick(10); await drain(); assertFailure(outcome, timeoutFailure);
  const bytes = new TextEncoder().encode(ack(envelope()));
  gate.resolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled++; } })));
  await drain(); t.mock.timers.tick(60000); await drain();
  assert.equal(cancelled, 1); assertFailure(outcome, timeoutFailure); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/local-drafts/clip'); assert.equal(calls[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].init.body), input, 'original authority, exact expected revision and raw remain intact');
});

test('late fetch rejection is consumed after the deadline', async t => {
  mockTime(t); const gate = deferred(); t.after(() => gate.reject(Error('late network failure')));
  const client = createClipDraftClient(() => gate.promise, { timeoutMs: 10 });
  const outcome = observe(client.put(input)); await drain(); t.mock.timers.tick(10); await drain(); assertFailure(outcome, timeoutFailure);
  gate.reject(Error('late network failure')); await drain(); assertFailure(outcome, timeoutFailure);
});

test('declared oversized and malformed lengths are rejected before waiting for any body bytes', async t => {
  for (const declared of [String(LOCAL_DRAFT_LIMITS.httpBytes + 1), '9007199254740992', '-1', '+1', '1.5', '01']) {
    await t.test(`Content-Length ${declared}`, async t => {
      let cancelled = 0, stream;
      const response = new Response(new ReadableStream({ start(controller) { stream = controller; }, cancel() { cancelled++; } }), { headers: { 'Content-Length': declared } });
      t.after(() => { try { stream.close(); } catch {} });
      const client = createClipDraftClient(async () => response);
      const outcome = observe(client.get(key)); await drain(); assertFailure(outcome, protocolFailure(200));
      assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
    });
  }
});

test('actual streamed bytes are bounded even with absent or misleading Content-Length', async t => {
  for (const declared of [undefined, '1']) {
    await t.test(`Content-Length ${String(declared)}`, async t => {
      let cancelled = 0, stream;
      // Valid JSON plus whitespace ensures a json() implementation would accept it.
      const bytes = new TextEncoder().encode(ack(envelope()).padEnd(LOCAL_DRAFT_LIMITS.httpBytes + 1, ' '));
      const response = new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(bytes.subarray(0, LOCAL_DRAFT_LIMITS.httpBytes)); controller.enqueue(bytes.subarray(LOCAL_DRAFT_LIMITS.httpBytes)); }, cancel() { cancelled++; } }), declared === undefined ? {} : { headers: { 'Content-Length': declared } });
      t.after(() => { try { stream.close(); } catch {} });
      const client = createClipDraftClient(async () => response);
      const outcome = observe(client.get(key)); await drain(); assertFailure(outcome, protocolFailure(200)); assert.equal(cancelled, 1);
    });
  }
});

test('the maximum legal stored row and success-envelope overhead fit the actual HTTP budget', async () => {
  const escaped = '\u0000'.repeat(48);
  const maximumRaw = { name: '\u0000'.repeat(200), trackId: id(6), startFrame: escaped, durationFrames: escaped, sourceInFrame: escaped, rect: { x: escaped, y: escaped, width: escaped, height: escaped }, gain: escaped, fadeInFrames: escaped, fadeOutFrames: escaped };
  const value = envelope({ revision: Number.MAX_SAFE_INTEGER, targetStatus: 'changed', draft: { baseRevision: Number.MAX_SAFE_INTEGER, source: { ...source, versionId: id(7), shotId: id(8), jobId: id(9) }, raw: maximumRaw, updatedAt: '2026-10-12T16:00:00.000Z' } });
  const slot = { ...key, revision: value.revision, draft: value.draft };
  // Stored ISO timestamps allow fractional precision. Fill the legal persisted row
  // exactly to its byte cap, exercising more than current Date.toISOString output.
  const spare = LOCAL_DRAFT_LIMITS.rowBytes - Buffer.byteLength(JSON.stringify(slot));
  assert.ok(spare >= 0); value.draft.updatedAt = `2026-10-12T16:00:00.${'0'.repeat(3 + spare)}Z`;
  assert.equal(clipDraftSlotSchema.safeParse(slot).success, true);
  assert.equal(Buffer.byteLength(JSON.stringify(slot)), LOCAL_DRAFT_LIMITS.rowBytes);
  assert.equal(clipDraftEnvelopeSchema.safeParse(value).success, true);
  const serialized = ack(value); assert.ok(Buffer.byteLength(serialized) < LOCAL_DRAFT_LIMITS.httpBytes);
  const bytes = new TextEncoder().encode(serialized.padEnd(LOCAL_DRAFT_LIMITS.httpBytes, ' '));
  assert.equal(bytes.byteLength, LOCAL_DRAFT_LIMITS.httpBytes, 'the inclusive limit accepts a legal full-size response');
  const client = createClipDraftClient(async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 97) controller.enqueue(bytes.subarray(i, i + 97)); controller.close(); } }), { headers: { 'Content-Length': String(bytes.length) } }));
  assert.deepEqual(await client.get(key), value);
});

test('UTF-8 sequences split across chunks survive strict decoding', async () => {
  const value = envelope({ draft: { ...envelope().draft, raw: { ...raw, name: '中文片段 🎬 café' } } });
  const bytes = new TextEncoder().encode(ack(value));
  const client = createClipDraftClient(async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } })));
  assert.deepEqual(await client.get(key), value);
});

test('invalid UTF-8 inside otherwise valid JSON never becomes replacement-character success', async () => {
  const prefix = new TextEncoder().encode('{"ok":true,"data":' + JSON.stringify(envelope()).replace('Local clip', 'SPLIT').split('SPLIT')[0]);
  const suffix = new TextEncoder().encode(JSON.stringify(envelope()).replace('Local clip', 'SPLIT').split('SPLIT')[1] + '}');
  for (const invalid of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xff], [0xe2, 0x82]]) {
    const bytes = new Uint8Array([...prefix, ...invalid, ...suffix]);
    const client = createClipDraftClient(async () => new Response(bytes));
    await assert.rejects(client.get(key), error => { assert.deepEqual(clipDraftFailure(error), protocolFailure(200)); return true; });
  }
});

test('successful acknowledgements require status 200 and exactly own ok/data keys', async () => {
  for (const [status, body] of [[202, { ok: true, data: envelope() }], [201, { ok: true, data: envelope() }], [200, { ok: true, data: envelope(), extra: true }], [200, { ok: true, data: envelope(), error: {} }], [200, { ok: true }], [500, { ok: true, data: envelope() }]]) {
    const client = createClipDraftClient(async () => new Response(JSON.stringify(body), { status }));
    await assert.rejects(client.get(key), error => { assert.deepEqual(clipDraftFailure(error), protocolFailure(status)); return true; });
  }
});

test('error evidence requires exactly the outer and four inner keys', async () => {
  const proper = refusal('LOCAL_DRAFT_CONFLICT');
  for (const body of [{ ...proper, extra: true }, { ...proper, error: { ...proper.error, extra: true } }, { ...proper, error: { code: proper.error.code, message: proper.error.message, retryable: false } }, { ...proper, error: { ...proper.error, details: { revision: 7 } } }, { ...proper, error: { ...proper.error, retryable: true } }, { ...proper, error: { ...proper.error, code: 'local_draft_conflict' } }, { ...proper, error: { ...proper.error, message: '' } }, { ...proper, error: { ...proper.error, message: 'x'.repeat(1001) } }]) {
    const client = createClipDraftClient(async () => new Response(JSON.stringify(body), { status: 409 }));
    await assert.rejects(client.put(input), error => { assert.deepEqual(clipDraftFailure(error), protocolFailure(409)); return true; });
  }
  const client = createClipDraftClient(async () => new Response(JSON.stringify(proper), { status: 200 }));
  await assert.rejects(client.put(input), error => { assert.deepEqual(clipDraftFailure(error), protocolFailure(200)); return true; });
});

test('only exact code/status evidence distinguishes refused, conflict and unknown', async () => {
  const cases = [
    ['LOCAL_DRAFT_VALIDATION', 400, 'refused'], ['LOCAL_DRAFT_OWNER_REQUIRED', 403, 'refused'], ['LOCAL_DRAFT_NOT_FOUND', 404, 'refused'], ['LOCAL_DRAFT_LIMIT', 413, 'refused'], ['LOCAL_DRAFT_CAPACITY', 507, 'refused'],
    ['LOCAL_DRAFT_CONFLICT', 409, 'conflict'], ['LOCAL_DRAFT_STALE_INSTANCE', 409, 'conflict'], ['LOCAL_DRAFT_SCOPE_MISMATCH', 409, 'conflict'],
    ['LOCAL_DRAFT_CONFLICT', 400, 'unknown'], ['LOCAL_DRAFT_VALIDATION', 409, 'unknown'], ['LOCAL_DRAFT_SAVE_UNCERTAIN', 503, 'unknown'], ['LOCAL_DRAFT_STORAGE_UNAVAILABLE', 503, 'unknown'], ['SOME_NEW_CODE', 409, 'unknown'],
  ];
  for (const [code, status, kind] of cases) {
    const client = createClipDraftClient(async () => new Response(JSON.stringify(refusal(code)), { status }));
    await assert.rejects(client.put(input), error => { assert.deepEqual(clipDraftFailure(error), { code, status, kind }); return true; });
  }
  const client = createClipDraftClient(async () => { throw Error('LOCAL_DRAFT_CONFLICT'); });
  await assert.rejects(client.put(input), error => { assert.deepEqual(clipDraftFailure(error), { code: 'LOCAL_DRAFT_NETWORK_UNKNOWN', status: null, kind: 'unknown' }); return true; });
});

test('existing fetcher-only calling convention preserves endpoints, request bodies and unsupported handling', async () => {
  const calls = [], client = createClipDraftClient(async (url, init) => { calls.push({ url, init }); return new Response(ack(envelope())); });
  for (const method of ['GET', 'PUT', 'DELETE']) assert.deepEqual(await invoke(client, method), envelope());
  assert.equal(calls[0].url, `/api/local-drafts/clip?${new URLSearchParams(key)}`);
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), input); assert.deepEqual(JSON.parse(calls[2].init.body), removal);
  for (const { init } of calls) { assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); }
  const unsupported = { supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED' };
  const restored = createClipDraftClient(async () => new Response(ack(unsupported)));
  assert.deepEqual(await restored.get(key), unsupported);
  for (const method of ['PUT', 'DELETE']) await assert.rejects(invoke(restored, method), { code: 'LOCAL_DRAFT_WRITE_UNSUPPORTED', kind: 'unknown' });
});
