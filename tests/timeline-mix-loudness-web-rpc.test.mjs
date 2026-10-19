import test from 'node:test';
import assert from 'node:assert/strict';
import { readTimelineMixLoudnessRpc } from '../apps/web/src/timeline-mix-loudness-rpc.ts';
import { rpc } from '../apps/web/src/api.ts';
import { input, report, deferred, id } from './helpers/timeline-mix-loudness-ui-fixture.ts';
const wire = value => new TextEncoder().encode(JSON.stringify(value));
const response = body => new Response(wire(body), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('bounded browser read sends exact explicit readonly request with workspace pin and no browser credentials expansion', async () => {
  const calls = [], value = { ok: true, data: report(input()) };
  const result = await readTimelineMixLoudnessRpc(input(), { expectedWorkspaceOrigin: id(7), fetch: async (...args) => { calls.push(args); return response(value); } });
  assert.deepEqual(result.body, value); assert.equal(calls[0][0], '/api/rpc'); assert.equal(calls[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0][1].body), { operation: 'timeline.loudness.prepare', input: input(), expectedWorkspaceOrigin: id(7) });
  assert.equal(calls.length, 1);
});
test('complete success and error envelopes enforce declared and streamed 64KiB bounds before JSON parsing', async () => {
  for (const isError of [false, true]) for (const declared of [true, false]) {
    let cancelled = 0;
    const res = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537).fill(32)); }, cancel() { cancelled++; } }),
      { status: isError ? 503 : 200, headers: declared ? { 'Content-Length': '65537' } : {} });
    res.json = () => { assert.fail('No unbounded JSON fallback'); };
    await assert.rejects(readTimelineMixLoudnessRpc(input(), { fetch: async () => res }), { code: 'BACKEND_PROTOCOL_ERROR' });
    await tick(); assert.equal(cancelled, 1);
  }
});
test('stalled body hits one deadline, cancels its stream and yields no partial report', async () => {
  let cancelled = 0, captured;
  const res = new Response(new ReadableStream({ start(controller) { controller.enqueue(wire({ ok: true })); }, cancel() { cancelled++; } }));
  await assert.rejects(readTimelineMixLoudnessRpc(input(), { timeoutMs: 15, fetch: async (_, options) => { captured = options.signal; return res; } }), { code: 'TIMELINE_MIX_LOUDNESS_TIMEOUT' });
  await tick(); assert.equal(cancelled, 1); assert.equal(captured.aborted, true);
});
test('external cancel and deadline finish even when fetch ignores abort and late results never surface', async () => {
  for (const manual of [true, false]) {
    const wait = deferred(), abort = new AbortController(); let called = 0;
    const work = readTimelineMixLoudnessRpc(input(), { signal: abort.signal, timeoutMs: 15, fetch: () => { called++; return wait.promise; } });
    if (manual) abort.abort();
    await assert.rejects(work, { code: manual ? 'OPERATION_CANCELLED' : 'TIMELINE_MIX_LOUDNESS_TIMEOUT' });
    wait.resolve(response({ ok: true, data: report(input()) })); await tick(); assert.equal(called, 1);
  }
});
test('pre-abort and absent target never fetch; malformed/truncated/invalid UTF8 bodies fail closed', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readTimelineMixLoudnessRpc(input(), { signal: abort.signal, fetch() { assert.fail('Pre-abort must be passive'); } }), { code: 'OPERATION_CANCELLED' });
  const missing = input(); delete missing.target;
  await assert.rejects(readTimelineMixLoudnessRpc(missing, { fetch() { assert.fail('Targets are required'); } }), { code: 'VALIDATION' });
  for (const bytes of ['{', '', new Uint8Array([0xff])])
    await assert.rejects(readTimelineMixLoudnessRpc(input(), { fetch: async () => new Response(bytes) }), { code: 'BACKEND_PROTOCOL_ERROR' });
});
test('actual api.ts selects bounded branch, validates report and retains existing non-mix JSON path', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let jsonCalls = 0;
  globalThis.fetch = async () => { const res = response({ ok: true, data: report(input()) }); res.json = () => { jsonCalls++; assert.fail('Mix must use bounded stream'); }; return res; };
  assert.equal((await rpc('timeline.loudness.prepare', input())).stage, 'preencode_float_mix'); assert.equal(jsonCalls, 0);
  globalThis.fetch = async () => response({ ok: true, data: { ...report(input()), applyAllowed: true } });
  await assert.rejects(rpc('timeline.loudness.prepare', input()), { code: 'BACKEND_PROTOCOL_ERROR' });
  globalThis.fetch = async () => response({ ok: false, error: { code: 'TIMELINE_MIX_LOUDNESS_BUSY', message: 'Busy' } });
  await assert.rejects(rpc('timeline.loudness.prepare', input()), { code: 'TIMELINE_MIX_LOUDNESS_BUSY' });
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { jsonCalls++; return { ok: true, data: { ordinary: true } }; } });
  assert.deepEqual(await rpc('project.get', { projectId: id(1) }), { ordinary: true }); assert.equal(jsonCalls, 1);
});
