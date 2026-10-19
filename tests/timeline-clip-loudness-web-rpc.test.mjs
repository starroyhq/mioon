import test from 'node:test';
import assert from 'node:assert/strict';
import { readTimelineClipLoudnessRpc } from '../apps/web/src/timeline-clip-loudness-rpc.ts';
import { rpc } from '../apps/web/src/api.ts';
import { input, report, deferred, id } from './helpers/timeline-clip-loudness-ui-fixture.mjs';
const wire = value => new TextEncoder().encode(JSON.stringify(value));
const response = body => new Response(wire(body), { headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('bounded browser read sends exact explicit readonly request with workspace pin and no browser credentials expansion', async () => {
  const calls = [], value = { ok: true, data: report(input()) };
  const result = await readTimelineClipLoudnessRpc(input(), { expectedWorkspaceOrigin: id(7), fetch: async (...args) => { calls.push(args); return response(value); } });
  assert.deepEqual(result.body, value); assert.equal(calls[0][0], '/api/rpc'); assert.equal(calls[0][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[0][1].body), { operation: 'timeline.clip.loudness', input: input(), expectedWorkspaceOrigin: id(7) });
  assert.equal(calls.length, 1);
});
test('complete success and error envelopes enforce declared and streamed 8KiB bounds before JSON parsing', async () => {
  for (const isError of [false, true]) for (const declared of [true, false]) {
    let cancelled = 0;
    const res = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193).fill(32)); }, cancel() { cancelled++; } }),
      { status: isError ? 503 : 200, headers: declared ? { 'Content-Length': '8193' } : {} });
    res.json = () => { assert.fail('No unbounded JSON fallback'); };
    await assert.rejects(readTimelineClipLoudnessRpc(input(), { fetch: async () => res }), { code: 'BACKEND_PROTOCOL_ERROR' });
    await tick(); assert.equal(cancelled, 1);
  }
});
test('stalled body hits one deadline, cancels its stream and yields no partial report', async () => {
  let cancelled = 0, captured;
  const res = new Response(new ReadableStream({ start(controller) { controller.enqueue(wire({ ok: true })); }, cancel() { cancelled++; } }));
  await assert.rejects(readTimelineClipLoudnessRpc(input(), { timeoutMs: 15, fetch: async (_, options) => { captured = options.signal; return res; } }), { code: 'TIMELINE_CLIP_LOUDNESS_TIMEOUT' });
  await tick(); assert.equal(cancelled, 1); assert.equal(captured.aborted, true);
});
test('external cancel and deadline finish even when fetch ignores abort and late results never surface', async () => {
  for (const manual of [true, false]) {
    const wait = deferred(), abort = new AbortController(); let called = 0;
    const work = readTimelineClipLoudnessRpc(input(), { signal: abort.signal, timeoutMs: 15, fetch: () => { called++; return wait.promise; } });
    if (manual) abort.abort();
    await assert.rejects(work, { code: manual ? 'OPERATION_CANCELLED' : 'TIMELINE_CLIP_LOUDNESS_TIMEOUT' });
    wait.resolve(response({ ok: true, data: report(input()) })); await tick(); assert.equal(called, 1);
  }
});
test('pre-abort and absent clip identity never fetch; malformed/truncated/invalid UTF8 bodies fail closed', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readTimelineClipLoudnessRpc(input(), { signal: abort.signal, fetch() { assert.fail('Pre-abort must be passive'); } }), { code: 'OPERATION_CANCELLED' });
  const missing = input(); delete missing.clipId;
  await assert.rejects(readTimelineClipLoudnessRpc(missing, { fetch() { assert.fail('Selection is required'); } }), { code: 'VALIDATION' });
  for (const bytes of ['{', '', new Uint8Array([0xff])])
    await assert.rejects(readTimelineClipLoudnessRpc(input(), { fetch: async () => new Response(bytes) }), { code: 'BACKEND_PROTOCOL_ERROR' });
});
test('actual api.js selects bounded branch, validates report and retains existing non-mix JSON path', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let jsonCalls = 0;
  globalThis.fetch = async () => { const res = response({ ok: true, data: report(input()) }); res.json = () => { jsonCalls++; assert.fail('Mix must use bounded stream'); }; return res; };
  assert.equal((await rpc('timeline.clip.loudness', input())).stage, 'isolated_clip_post_gain_fades_pre_mix'); assert.equal(jsonCalls, 0);
  globalThis.fetch = async () => response({ ok: true, data: { ...report(input()), applyAllowed: true } });
  await assert.rejects(rpc('timeline.clip.loudness', input()), { code: 'BACKEND_PROTOCOL_ERROR' });
  globalThis.fetch = async () => response({ ok: false, error: { code: 'TIMELINE_CLIP_LOUDNESS_BUSY', message: 'Busy' } });
  await assert.rejects(rpc('timeline.clip.loudness', input()), { code: 'TIMELINE_CLIP_LOUDNESS_BUSY' });
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { jsonCalls++; return { ok: true, data: { ordinary: true } }; } });
  assert.deepEqual(await rpc('project.get', { projectId: id(1) }), { ordinary: true }); assert.equal(jsonCalls, 1);
});
