import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAudioPreviewPlan, AUDIO_PREVIEW_PROFILE, AUDIO_PREVIEW_LIMITS } from '../packages/contracts/src/timeline-audio-preview.ts';
import { createTimelineAudioPreviewClient, readTimelineAudioPreviewPcm, AUDIO_PREVIEW_PCM_HEADERS, AUDIO_PREVIEW_MAX_CHUNK_BYTES } from '../apps/web/src/timeline-audio-preview-client.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture({ frames = 2, second = false, dedup = false } = {}) {
  const input = { projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 0 };
  const tracks = [{ id: id(3), kind: 'audio', orderIndex: 0, muted: false, hidden: false }];
  const asset = { id: id(4), projectId: id(1), sha256: 'a'.repeat(64), sizeBytes: 1024, mimeType: 'audio/wav', duration: 20, hasAudio: true };
  const clips = [{ id: id(5), trackId: id(3), assetId: id(4), startFrame: 0, durationFrames: frames, sourceInFrame: 0, gain: 1 }];
  if (second || dedup) { tracks.push({ id: id(6), kind: 'audio', orderIndex: 1, muted: false, hidden: false }); clips.push({ ...clips[0], id: id(7), trackId: id(6), sourceInFrame: dedup ? 0 : 1 }); }
  const plan = buildAudioPreviewPlan(input, { timeline: { id: id(2), projectId: id(1), revision: 1, fps: 30, durationFrames: frames, tracks, clips }, assets: [asset] }, hash);
  const allocations = [];
  const context = { sampleRate: 48000, createBuffer(channels, length, sampleRate) {
    const data = [new Float32Array(length), new Float32Array(length)]; allocations.push(data);
    return { sampleRate, length, numberOfChannels: channels, getChannelData(channel) { return data[channel]; } };
  } };
  return { input, plan, context, allocations };
}
function headers(plan, source) {
  return { 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.pcmBytes), 'Cache-Control': 'no-store',
    [AUDIO_PREVIEW_PCM_HEADERS.profile]: AUDIO_PREVIEW_PROFILE, [AUDIO_PREVIEW_PCM_HEADERS.planHash]: plan.planHash,
    [AUDIO_PREVIEW_PCM_HEADERS.sourceHash]: source.sourceHash, [AUDIO_PREVIEW_PCM_HEADERS.clipId]: source.clipId,
    [AUDIO_PREVIEW_PCM_HEADERS.sampleFrames]: String(source.sampleFrames) };
}
function pcm(source, left = 0.25, right = -0.75) {
  const bytes = new Uint8Array(source.pcmBytes), view = new DataView(bytes.buffer);
  for (let n = 0; n < source.sampleFrames; n++) { view.setFloat32(n * 8, left, true); view.setFloat32(n * 8 + 4, right, true); }
  return bytes;
}
function response(plan, source, { bytes = pcm(source), pieces = [1, 2, 3, 5, 7, 11, 997], changeHeaders = value => value, onFinish = () => {} } = {}) {
  let offset = 0, next = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); onFinish(); return; }
    const end = Math.min(bytes.length, offset + pieces[next++ % pieces.length]); controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }), { status: 200, headers: changeHeaders(headers(plan, source)) });
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('serial complete preparation streams unaligned little-endian stereo directly into exact AudioBuffers', async () => {
  const f = fixture({ second: true }), requests = [], measures = []; let active = 0, peak = 0;
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async (url, options) => {
    active++; peak = Math.max(peak, active); requests.push({ url, options });
    const source = f.plan.sources[requests.length - 1];
    return response(f.plan, source, { onFinish: () => active-- });
  } });
  const result = await client.prepare(f.input, { context: f.context, signal: new AbortController().signal, onAllocation: value => measures.push(value) });
  assert.equal(peak, 1); assert.equal(active, 0); assert.equal(result.buffers.size, 2); assert.equal(f.allocations.length, 2);
  for (const buffer of result.buffers.values()) { assert.equal(buffer.length, 3200); assert.equal(buffer.getChannelData(0)[0], 0.25); assert.equal(buffer.getChannelData(1).at(-1), -0.75); }
  const query = new URL(requests[0].url, 'http://localhost').searchParams;
  assert.deepEqual([...query.keys()].sort(), ['clipId', 'expectedRevision', 'planHash', 'projectId', 'sourceHash', 'startFrame', 'timelineId'].sort());
  assert.equal(requests[0].options.credentials, 'same-origin'); assert.equal(requests[0].options.cache, 'no-store'); assert.equal(requests[0].options.redirect, 'error');
  assert.equal(result.allocation.retainedAudioBufferBytes, f.plan.memory.retainedPcmBytes);
  assert.equal(result.allocation.conservativeBytes, f.plan.memory.admittedBytes);
  assert.ok(measures.every(item => item.conservativeBytes <= AUDIO_PREVIEW_LIMITS.memoryBytes));
  assert.ok(result.allocation.transportChunkBytes <= 997);
});

test('exact identical prepared source is retained once for multiple saved voices', async () => {
  const f = fixture({ dedup: true }); let fetches = 0;
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => { fetches++; return response(f.plan, f.plan.sources[0]); } });
  const result = await client.prepare(f.input, { context: f.context, signal: new AbortController().signal });
  assert.equal(result.plan.voices.length, 2); assert.equal(fetches, 1); assert.equal(f.allocations.length, 1); assert.equal(result.buffers.size, 1);
});

test('retained verified plan rejects mutation of original decode segments and work accounting', async () => {
  const f = fixture();
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => response(f.plan, f.plan.sources[0]) });
  const result = await client.prepare(f.input, { context: f.context, signal: new AbortController().signal });
  const before = JSON.stringify(result.plan), source = result.plan.sources[0], segment = source.decodeSegments[0];
  for (const mutate of [() => { segment.frameCount++; }, () => { segment.trimStartFrame++; },
    () => { segment.outputFrames++; }, () => { segment.sourceInFrame++; },
    () => { source.decodeSegments.push({ ...segment }); }, () => { source.decodeSegments[0] = { ...segment }; },
    () => { result.plan.work.decodedSourceFrames++; }, () => { result.plan.work.decodeSegments++; }]) assert.throws(mutate, TypeError);
  assert.equal(JSON.stringify(result.plan), before);
  assert.equal(Object.isFrozen(source.decodeSegments), true); assert.equal(Object.isFrozen(segment), true); assert.equal(Object.isFrozen(result.plan.work), true);
});

for (const malformed of ['truncated', 'extra', 'nonfinite-left', 'nonfinite-right', 'wrong-length', 'wrong-plan', 'wrong-source', 'wrong-clip', 'wrong-profile', 'wrong-frames', 'cacheable', 'compressed']) {
  test(`PCM fails closed for ${malformed}`, async () => {
    const f = fixture(), source = f.plan.sources[0]; let bytes = pcm(source);
    if (malformed === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
    if (malformed === 'extra') { const extra = new Uint8Array(bytes.length + 1); extra.set(bytes); bytes = extra; }
    if (malformed.startsWith('nonfinite')) new DataView(bytes.buffer).setFloat32(malformed.endsWith('left') ? 0 : 4, Infinity, true);
    const replacements = { 'wrong-length': ['Content-Length', String(source.pcmBytes + 8)], 'wrong-plan': [AUDIO_PREVIEW_PCM_HEADERS.planHash, 'f'.repeat(64)],
      'wrong-source': [AUDIO_PREVIEW_PCM_HEADERS.sourceHash, 'f'.repeat(64)], 'wrong-clip': [AUDIO_PREVIEW_PCM_HEADERS.clipId, id(99)],
      'wrong-profile': [AUDIO_PREVIEW_PCM_HEADERS.profile, 'other'], 'wrong-frames': [AUDIO_PREVIEW_PCM_HEADERS.sampleFrames, '1'],
      cacheable: ['Cache-Control', 'max-age=60'], compressed: ['Content-Encoding', 'gzip'] };
    const res = response(f.plan, source, { bytes, changeHeaders: values => { if (replacements[malformed]) values[replacements[malformed][0]] = replacements[malformed][1]; return values; } });
    await assert.rejects(readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}), { code: 'AUDIO_PREVIEW_PROTOCOL' });
  });
}

test('byte-stream oversized enqueue is consumed through bounded reused BYOB storage', async () => {
  const f = fixture({ frames: 600 }), source = f.plan.sources[0];
  const res = new Response(new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(pcm(source)); controller.close(); } }), { headers: headers(f.plan, source) });
  const nativeGetReader = res.body.getReader.bind(res.body), readSizes = [], chunkSizes = []; let previousReturnedBuffer, reused = 0, byob = 0;
  res.body.getReader = options => {
    const reader = nativeGetReader(options);
    if (options?.mode !== 'byob') return reader;
    byob++;
    return { async read(view) {
      assert.ok(view.byteLength <= AUDIO_PREVIEW_MAX_CHUNK_BYTES); assert.ok(view.buffer.byteLength <= AUDIO_PREVIEW_MAX_CHUNK_BYTES);
      if (previousReturnedBuffer) { assert.equal(view.buffer, previousReturnedBuffer); reused++; }
      readSizes.push(view.byteLength);
      const next = await reader.read(view); previousReturnedBuffer = next.value?.buffer;
      if (next.value) assert.ok(next.value.buffer.byteLength <= AUDIO_PREVIEW_MAX_CHUNK_BYTES);
      return next;
    }, cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() };
  };
  const buffer = await readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}, bytes => chunkSizes.push(bytes));
  assert.equal(byob, 1); assert.ok(readSizes.length > 2); assert.ok(reused >= readSizes.length - 1);
  assert.ok(chunkSizes.every(bytes => bytes <= AUDIO_PREVIEW_MAX_CHUNK_BYTES)); assert.equal(chunkSizes.reduce((total, bytes) => total + bytes, 0), source.pcmBytes);
  assert.equal(buffer.length, 960000); assert.equal(buffer.getChannelData(0)[0], .25); assert.equal(buffer.getChannelData(1).at(-1), -.75);
});

test('fallback rejects a bounded visible chunk with an oversized backing allocation', async () => {
  const f = fixture(), source = f.plan.sources[0];
  const backing = new Uint8Array(AUDIO_PREVIEW_MAX_CHUNK_BYTES + 8); backing.set(pcm(source));
  const res = new Response(new ReadableStream({ start(controller) { controller.enqueue(backing.subarray(0, source.pcmBytes)); controller.close(); } }), { headers: headers(f.plan, source) });
  await assert.rejects(readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}), { code: 'AUDIO_PREVIEW_PROTOCOL' });
});

for (const invalid of ['empty-eof', 'partial-final-sample', 'extra-byte', 'nonfinite-left', 'nonfinite-right']) test(`BYOB stream rejects ${invalid} without returning partial audio`, async () => {
  const f = fixture(), source = f.plan.sources[0]; let bytes = pcm(source);
  if (invalid === 'empty-eof') bytes = new Uint8Array(0);
  if (invalid === 'partial-final-sample') bytes = bytes.slice(0, -1);
  if (invalid === 'extra-byte') { const extra = new Uint8Array(bytes.length + 1); extra.set(bytes); bytes = extra; }
  if (invalid.startsWith('nonfinite')) new DataView(bytes.buffer).setFloat32(invalid.endsWith('left') ? 0 : 4, NaN, true);
  const res = new Response(new ReadableStream({ type: 'bytes', start(controller) { if (bytes.byteLength) controller.enqueue(bytes); controller.close(); } }), { headers: headers(f.plan, source) });
  await assert.rejects(readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}), { code: 'AUDIO_PREVIEW_PROTOCOL' });
});

for (const byteStream of [false, true]) test(`${byteStream ? 'BYOB' : 'fallback'} reader rejects forged nonempty done payload after the exact sample count`, async () => {
  const f = fixture(), source = f.plan.sources[0];
  const res = byteStream ? new Response(new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(pcm(source)); controller.close(); } }), { headers: headers(f.plan, source) }) : response(f.plan, source);
  const getReader = res.body.getReader.bind(res.body);
  res.body.getReader = options => {
    const reader = getReader(options);
    return { async read(view) { const part = options?.mode === 'byob' ? await reader.read(view) : await reader.read(); return part.done ? { done: true, value: new Uint8Array(8) } : part; },
      cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() };
  };
  await assert.rejects(readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}), { code: 'AUDIO_PREVIEW_PROTOCOL' });
});

test('zero-byte non-EOF fallback chunk fails immediately rather than spinning', async () => {
  const f = fixture(), source = f.plan.sources[0]; let reads = 0;
  const res = new Response(new ReadableStream({ pull(controller) { if (++reads > 3) controller.error(Error('Unexpected empty-chunk loop')); else controller.enqueue(new Uint8Array(0)); } }), { headers: headers(f.plan, source) });
  await assert.rejects(readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}), { code: 'AUDIO_PREVIEW_PROTOCOL' });
  assert.ok(reads <= 2);
});

for (const failed of [false, true]) test(`BYOB cancellation ${failed ? 'rejects unconfirmed cleanup' : 'waits for exact resource acknowledgment'}`, async () => {
  const f = fixture(), source = f.plan.sources[0], abort = new AbortController(); let cancelResolve, cancelReject, resources, cancelled = 0, settled = false;
  const cancellation = new Promise((resolve, reject) => { cancelResolve = resolve; cancelReject = reject; });
  const res = new Response(new ReadableStream({ type: 'bytes', start(controller) { controller.enqueue(pcm(source).slice(0, 8)); }, cancel() { cancelled++; return cancellation; } }), { headers: headers(f.plan, source) });
  let byob = 0, reads = 0, markPending; const pendingRead = new Promise(resolve => { markPending = resolve; });
  const getReader = res.body.getReader.bind(res.body);
  res.body.getReader = options => {
    if (options?.mode === 'byob') byob++;
    const reader = getReader(options);
    return { read(view) { const result = options?.mode === 'byob' ? reader.read(view) : reader.read(); if (++reads === 2) markPending(); return result; },
      cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() };
  };
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => res });
  const work = client.prepare(f.input, { context: f.context, signal: abort.signal, onResourceSettlement(value) { resources = value; value.then(() => { settled = true; }, () => { settled = true; }); } });
  let hangTimer;
  try { await Promise.race([pendingRead, work.then(() => assert.fail('Preparation completed before pending read')), new Promise((_, reject) => { hangTimer = setTimeout(() => reject(Error('Pending read was not reached within 2s')), 2000); })]); }
  catch (error) { abort.abort(); cancelResolve(); await work.catch(() => {}); throw error; }
  finally { clearTimeout(hangTimer); }
  abort.abort(); await assert.rejects(work, { code: 'AUDIO_PREVIEW_CANCELLED' }); await tick();
  assert.equal(cancelled, 1); assert.equal(settled, false);
  if (failed) { cancelReject(Error('BYOB cancellation refused')); await assert.rejects(resources, { code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED' }); }
  else { cancelResolve(); await resources; }
  assert.equal(settled, true); assert.equal(byob, 1);
});

test('transport chunk allocation cannot exceed the fixed reserve boundary', async () => {
  const f = fixture({ frames: 100 }), source = f.plan.sources[0];
  const res = response(f.plan, source, { pieces: [AUDIO_PREVIEW_MAX_CHUNK_BYTES + 1] });
  await assert.rejects(readTimelineAudioPreviewPcm(res, f.plan, source, f.context, new AbortController().signal, () => {}), { code: 'AUDIO_PREVIEW_PROTOCOL' });
});

test('a forged plan digest or over-budget plan is rejected before any source request/allocation', async () => {
  for (const change of [plan => { plan.planHash = 'b'.repeat(64); }, plan => { plan.memory.admittedBytes = AUDIO_PREVIEW_LIMITS.memoryBytes + 1; }]) {
    const f = fixture(); change(f.plan); let calls = 0;
    const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => { calls++; throw Error('Must not fetch'); } });
    await assert.rejects(client.prepare(f.input, { context: f.context, signal: new AbortController().signal }), { code: 'AUDIO_PREVIEW_PROTOCOL' });
    assert.equal(calls, 0); assert.equal(f.allocations.length, 0);
  }
});

test('cancel and deadline reject ignored late plan acknowledgments without allocating or fetching', async () => {
  for (const kind of ['cancel', 'timeout']) {
    const f = fixture(), pending = deferred(), abort = new AbortController(); let calls = 0;
    const client = createTimelineAudioPreviewClient({ readPlan: () => pending.promise, timeoutMs: kind === 'timeout' ? 10 : 120000,
      fetcher: async () => { calls++; throw Error('Late fetch forbidden'); } });
    const work = client.prepare(f.input, { context: f.context, signal: abort.signal });
    if (kind === 'cancel') abort.abort();
    await assert.rejects(work, { code: kind === 'cancel' ? 'AUDIO_PREVIEW_CANCELLED' : 'AUDIO_PREVIEW_TIMEOUT' });
    pending.resolve(f.plan); await tick(); assert.equal(calls, 0); assert.equal(f.allocations.length, 0);
  }
});

test('failure in a later serial source rejects the entire interval with no playable partial result', async () => {
  const f = fixture({ second: true }); let calls = 0;
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => {
    const source = f.plan.sources[calls++]; return response(f.plan, source, calls === 2 ? { bytes: pcm(source).subarray(0, 1) } : {});
  } });
  await assert.rejects(client.prepare(f.input, { context: f.context, signal: new AbortController().signal }), { code: 'AUDIO_PREVIEW_PROTOCOL' });
  assert.equal(calls, 2);
});


test('bounded source failure carries only its safe code and never creates a PCM buffer', async () => {
  const f = fixture();
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => new Response(JSON.stringify({ ok: false,
    error: { code: 'AUDIO_PREVIEW_BUSY', message: '/private/source/path must not be displayed', details: {}, retryable: false } }),
    { status: 409, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }) });
  await assert.rejects(client.prepare(f.input, { context: f.context, signal: new AbortController().signal }), error => {
    assert.equal(error.code, 'AUDIO_PREVIEW_BUSY'); assert.doesNotMatch(error.message, /private|source\/path/); return true;
  });
  assert.equal(f.allocations.length, 0);
});


for (const failed of [false, true]) test(`resource acknowledgment ${failed ? 'fails closed' : 'waits'} when stream cancellation is not yet confirmed`, async () => {
  const f = fixture(), abort = new AbortController(); let cancelResolve, cancelReject, settlement, canceled = 0, settled = false;
  const cancellation = new Promise((resolve, reject) => { cancelResolve = resolve; cancelReject = reject; });
  const source = f.plan.sources[0];
  const client = createTimelineAudioPreviewClient({ readPlan: async () => f.plan, fetcher: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(pcm(source).subarray(0, 8)); },
    cancel() { canceled++; return cancellation; },
  }), { headers: headers(f.plan, source) }) });
  const result = client.prepare(f.input, { context: f.context, signal: abort.signal, onResourceSettlement(value) { settlement = value; value.then(() => { settled = true; }, () => { settled = true; }); } });
  while (!f.allocations.length) await tick();
  abort.abort(); await assert.rejects(result, { code: 'AUDIO_PREVIEW_CANCELLED' }); await tick();
  assert.equal(canceled, 1); assert.equal(settled, false);
  if (failed) { cancelReject(Error('Transport cancellation was refused')); await assert.rejects(settlement, { code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED' }); }
  else { cancelResolve(); await settlement; }
  assert.equal(settled, true);
});
