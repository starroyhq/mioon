import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTINUOUS_AUDIO_PROFILE, CONTINUOUS_AUDIO_HEADERS as H, CONTINUOUS_AUDIO_LIMITS as L,
  continuousAudioPlanSchema, continuousAudioBlockInputSchema, continuousAudioPlanDigestMaterial, continuousAudioQuery,
  isContinuousAudioPlan} from '../packages/contracts/src/timeline-audio-continuous.ts';
import {createContinuousAudioPreviewClient, readContinuousAudioBlock} from '../apps/web/src/timeline-audio-continuous-client.ts';
import {parse, operationEffect, schemas} from '@mioon/contracts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = {projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 0};
function manifest(overrides = {}) {
  const plan = {schemaVersion: 2, status: 'planned', profileId: CONTINUOUS_AUDIO_PROFILE, projectId: input.projectId,
    timelineId: input.timelineId, timelineRevision: 1, startFrame: 0, durationFrames: 750, blockFrames: 60,
    sampleRate: 48000, channels: 2, admittedBytes: L.memoryBytes, snapshotHash: 'a'.repeat(64), planHash: '0'.repeat(64), ...overrides};
  plan.planHash = createHash('sha256').update(continuousAudioPlanDigestMaterial(plan)).digest('hex'); return plan;
}
const request = (plan = manifest(), overrides = {}) => ({...input, planHash: plan.planHash, sessionId: id(3), generation: 1, sequence: 1, blockStartFrame: 0, ...overrides});
function audioContext() {
  return {sampleRate: 48000, createBuffer(channels, length, rate) {
    const data = Array.from({length: channels}, () => new Float32Array(length));
    return {length, numberOfChannels: channels, sampleRate: rate, getChannelData: channel => data[channel]};
  }};
}
function response(plan, req, {extra = 0, truncate = 0, corrupt = false, headers = {}, cancel = () => {}, chunkSize = 32771} = {}) {
  const end = Math.min(req.blockStartFrame + 60, plan.durationFrames), samples = (end - req.blockStartFrame) * 1600;
  const bytes = new Uint8Array(samples * 8 + extra - truncate), data = new DataView(bytes.buffer);
  for (let offset = 0; offset + 8 <= bytes.length; offset += 8) { data.setFloat32(offset, .25, true); data.setFloat32(offset + 4, -.125, true); }
  if (corrupt) data.setFloat32(0, NaN, true);
  let offset = 0;
  return new Response(new ReadableStream({pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + chunkSize))); offset = Math.min(bytes.length, offset + chunkSize);
  }, cancel}), {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(samples * 8), 'Cache-Control': 'no-store',
    [H.profile]: CONTINUOUS_AUDIO_PROFILE, [H.planHash]: plan.planHash, [H.session]: req.sessionId, [H.generation]: String(req.generation),
    [H.sequence]: String(req.sequence), [H.startFrame]: String(req.blockStartFrame), [H.endFrame]: String(end), [H.sampleFrames]: String(samples), ...headers}});
}

test('continuous metadata and fixed pull inputs are strict and versioned without weakening V1', () => {
  const plan = manifest(); assert.equal(isContinuousAudioPlan(plan, input), true);
  for (const patch of [{schemaVersion: 1}, {blockFrames: 600}, {admittedBytes: L.memoryBytes + 1}, {durationFrames: 18001}, {sampleRate: 44100}, {path: '/private'}])
    assert.equal(continuousAudioPlanSchema.safeParse({...plan, ...patch}).success, false);
  for (const patch of [{generation: 0}, {generation: 257}, {sequence: 10001}, {blockStartFrame: 18000}, {sourcePath: '/private'}])
    assert.equal(continuousAudioBlockInputSchema.safeParse({...request(plan), ...patch}).success, false);
  assert.equal(isContinuousAudioPlan(plan, {...input, expectedRevision: 2}), false);
  const op = 'timeline.audioPreview.continuousPlan'; assert.deepEqual(parse(op, input), input); assert.ok(schemas[op]);
  assert.equal(operationEffect(op).databaseWrite, false); assert.equal(operationEffect(op).fileWrite, false); assert.equal(operationEffect(op).localProcess, false);
  assert.match(continuousAudioQuery(request(plan)), /^projectId=.*&timelineId=.*&expectedRevision=1&startFrame=0&planHash=.*&sessionId=.*&generation=1&sequence=1&blockStartFrame=0$/u);
});

test('bounded interleaved byte reads preserve stereo samples across unaligned chunks and the exact tail', async () => {
  const plan = manifest(), req = request(plan, {blockStartFrame: 740});
  const block = await readContinuousAudioBlock(response(plan, req), req, plan, audioContext(), new AbortController().signal);
  assert.equal(block.startFrame, 740); assert.equal(block.endFrame, 750); assert.equal(block.buffer.length, 16000);
  assert.ok(block.buffer.getChannelData(0).every(value => value === .25));
  assert.ok(block.buffer.getChannelData(1).every(value => value === -.125));
});

for (const [name, opts] of Object.entries({truncated: {truncate: 1}, extra: {extra: 8}, nonfinite: {corrupt: true},
  identity: {headers: {[H.session]: id(99)}}, encoding: {headers: {'Content-Encoding': 'gzip'}}, oversizedBacking: {chunkSize: 2 * 1024 * 1024}})) {
  test(`incomplete or invalid ${name} mixed block never publishes`, async () => {
    const plan = manifest(), req = request(plan);
    // The largest valid block is smaller than the reader cap. Use an actual
    // oversized backing allocation to cover the hostile stream branch.
    const res = name === 'oversizedBacking' ? new Response(new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array(new ArrayBuffer(2 * 1024 * 1024), 0, 8)); controller.close();
    }}), {headers: response(plan, req).headers}) : response(plan, req, opts);
    await assert.rejects(readContinuousAudioBlock(res, req, plan, audioContext(), new AbortController().signal), {code: 'AUDIO_PREVIEW_PROTOCOL'});
  });
}

test('client acquires once, transfers initial ownership, sequences blocks and resets seek generation', async () => {
  const plan = manifest(), calls = [], reserves = [];
  const client = createContinuousAudioPreviewClient({readPlan: async () => plan, fetcher: async (url, options) => {
    const query = Object.fromEntries(new URL(url, 'http://fixture').searchParams);
    const req = {...query, expectedRevision: +query.expectedRevision, startFrame: +query.startFrame,
      generation: +query.generation, sequence: +query.sequence, blockStartFrame: +query.blockStartFrame};
    calls.push({req, options}); return response(plan, req);
  }});
  const session = await client.prepare(input, {context: audioContext(), signal: new AbortController().signal, reserveNative: async (value, sessionId) => {
    reserves.push(value); return {leaseId: id(4), planHash: value.planHash, sessionId, admittedBytes: L.memoryBytes};
  }});
  assert.equal(session.takeInitialBlock().startFrame, 0); assert.throws(() => session.takeInitialBlock(), {code: 'AUDIO_PREVIEW_PROTOCOL'});
  await session.loadBlock(60, new AbortController().signal); await session.reset(500, new AbortController().signal);
  await session.loadBlock(500, new AbortController().signal); await session.dispose();
  assert.equal(reserves.length, 1); assert.deepEqual(calls.map(call => [call.req.generation, call.req.sequence, call.req.blockStartFrame]), [[1, 1, 0], [1, 2, 60], [2, 3, 500]]);
  assert.equal(new Set(calls.map(call => call.req.sessionId)).size, 1); assert.ok(calls.every(call => call.options.headers['X-Mioon-Audio-Lease'] === id(4)));
});

test('Web disposal confirms fixed DELETE and a failed retirement stays failed', async () => {
  for (const success of [true, false]) {
    const plan = manifest(), calls = [];
    const client = createContinuousAudioPreviewClient({readPlan: async () => plan, fetcher: async (url, options) => {
      calls.push(options.method); const query = Object.fromEntries(new URL(url, 'http://fixture').searchParams);
      if (options.method === 'DELETE') return new Response(null, {status: success ? 204 : 503});
      return response(plan, {...query, expectedRevision: 1, startFrame: 0, generation: 1, sequence: 1, blockStartFrame: 0});
    }});
    const session = await client.prepare(input, {context: audioContext(), signal: new AbortController().signal}); session.takeInitialBlock();
    if (success) await session.dispose(); else await assert.rejects(session.dispose(), {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'});
    assert.deepEqual(calls, ['GET', 'DELETE']); assert.strictEqual(session.dispose(), session.dispose());
  }
});

test('plan digest mismatch fails before a PCM fetch or native reservation', async () => {
  let effects = 0; const client = createContinuousAudioPreviewClient({readPlan: async () => ({...manifest(), planHash: 'f'.repeat(64)}), fetcher: async () => { effects++; throw Error('Forbidden'); }});
  await assert.rejects(client.prepare(input, {context: audioContext(), signal: new AbortController().signal, reserveNative: async () => { effects++; throw Error('Forbidden'); }}), {code: 'AUDIO_PREVIEW_PROTOCOL'});
  assert.equal(effects, 0);
});
