import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CONTINUOUS_AUDIO_PROFILE, CONTINUOUS_AUDIO_HEADERS as H, CONTINUOUS_AUDIO_LIMITS as L,
  continuousAudioPlanSchema, continuousAudioBlockInputSchema, continuousAudioPlanDigestMaterial, continuousAudioQuery,
  isContinuousAudioPlan} from '../packages/contracts/src/timeline-audio-continuous.ts';
import {createContinuousAudioPreviewClient, readContinuousAudioBlock} from '../apps/web/src/timeline-audio-continuous-client.ts';
import {parse, operationEffect, schemas} from '@mioon/contracts';

type Plan = {schemaVersion: number; status: string; profileId: string; projectId: string; timelineId: string; timelineRevision: number; startFrame: number; durationFrames: number; blockFrames: number; sampleRate: number; channels: number; admittedBytes: number; snapshotHash: string; planHash: string; [key: string]: unknown};
type BlockRequest = {projectId: string; timelineId: string; expectedRevision: number; startFrame: number; planHash: string; sessionId: string; generation: number; sequence: number; blockStartFrame: number; [key: string]: unknown};
interface AudioBufferLike {length: number; numberOfChannels: number; sampleRate: number; getChannelData(channel: number): Float32Array}
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = {projectId: id(1), timelineId: id(2), expectedRevision: 1, startFrame: 0};
function manifest(overrides: Record<string, unknown> = {}): Plan {
  const plan: Plan = {schemaVersion: 2, status: 'planned', profileId: CONTINUOUS_AUDIO_PROFILE, projectId: input.projectId,
    timelineId: input.timelineId, timelineRevision: 1, startFrame: 0, durationFrames: 750, blockFrames: 60,
    sampleRate: 48000, channels: 2, admittedBytes: L.memoryBytes, snapshotHash: 'a'.repeat(64), planHash: '0'.repeat(64), ...overrides};
  plan.planHash = createHash('sha256').update(continuousAudioPlanDigestMaterial(plan as never)).digest('hex'); return plan;
}
const request = (plan: Plan = manifest(), overrides: Record<string, unknown> = {}): BlockRequest => ({...input, planHash: plan.planHash, sessionId: id(3), generation: 1, sequence: 1, blockStartFrame: 0, ...overrides} as BlockRequest);
function audioContext(): {sampleRate: number; createBuffer(channels: number, length: number, rate: number): AudioBufferLike} {
  return {sampleRate: 48000, createBuffer(channels: number, length: number, rate: number): AudioBufferLike {
    const data = Array.from({length: channels}, () => new Float32Array(length));
    return {length, numberOfChannels: channels, sampleRate: rate, getChannelData: (channel: number) => data[channel]};
  }};
}
function response(plan: Plan, req: BlockRequest, {extra = 0, truncate = 0, corrupt = false, headers = {}, cancel = () => {}, chunkSize = 32771}: {extra?: number; truncate?: number; corrupt?: boolean; headers?: Record<string, string>; cancel?: () => void; chunkSize?: number} = {}): Response {
  const end = Math.min(req.blockStartFrame + 60, plan.durationFrames), samples = (end - req.blockStartFrame) * 1600;
  const bytes = new Uint8Array(samples * 8 + extra - truncate), data = new DataView(bytes.buffer);
  for (let offset = 0; offset + 8 <= bytes.length; offset += 8) { data.setFloat32(offset, .25, true); data.setFloat32(offset + 4, -.125, true); }
  if (corrupt) data.setFloat32(0, NaN, true);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({pull(controller: {enqueue(value: Uint8Array): void; close(): void;}) {
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
  const block = await readContinuousAudioBlock(response(plan, req), req as never, plan as never, audioContext() as never, new AbortController().signal);
  assert.equal(block.startFrame, 740); assert.equal(block.endFrame, 750); assert.equal(block.buffer.length, 16000);
  assert.ok(block.buffer.getChannelData(0).every(value => value === .25));
  assert.ok(block.buffer.getChannelData(1).every(value => value === -.125));
});

const invalidCases: Array<[string, {truncate?: number; extra?: number; corrupt?: boolean; headers?: Record<string, string>; chunkSize?: number}]> = [['truncated', {truncate: 1}], ['extra', {extra: 8}], ['nonfinite', {corrupt: true}],
  ['identity', {headers: {[H.session]: id(99)}}], ['encoding', {headers: {'Content-Encoding': 'gzip'}}], ['oversizedBacking', {chunkSize: 2 * 1024 * 1024}]];
  for (const [name, opts] of invalidCases) {
  test(`incomplete or invalid ${name} mixed block never publishes`, async () => {
    const plan = manifest(), req = request(plan);
    // The largest valid block is smaller than the reader cap. Use an actual
    // oversized backing allocation to cover the hostile stream branch.
    const res = name === 'oversizedBacking' ? new Response(new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array(new ArrayBuffer(2 * 1024 * 1024), 0, 8)); controller.close();
    }}), {headers: response(plan, req).headers}) : response(plan, req, opts);
    await assert.rejects(readContinuousAudioBlock(res, req as never, plan as never, audioContext() as never, new AbortController().signal), {code: 'AUDIO_PREVIEW_PROTOCOL'});
  });
}

test('client acquires once, transfers initial ownership, sequences blocks and resets seek generation', async () => {
  const plan = manifest(), calls: Array<{req: BlockRequest; options: {headers: Record<string, string>}}> = [], reserves: unknown[] = [];
  const client = createContinuousAudioPreviewClient({readPlan: async () => plan, fetcher: (async (url: string, options: {headers: Record<string, string>}) => {
    const query = Object.fromEntries(new URL(url, 'http://fixture').searchParams);
    const req = {...query, expectedRevision: +query.expectedRevision, startFrame: +query.startFrame,
      generation: +query.generation, sequence: +query.sequence, blockStartFrame: +query.blockStartFrame};
    calls.push({req: req as BlockRequest, options}); return response(plan, req as BlockRequest);
  }) as never});
  const session = await client.prepare(input, {context: audioContext() as never, signal: new AbortController().signal, reserveNative: async (value: {planHash: string}, sessionId: string) => {
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
    const plan = manifest(), calls: string[] = [];
    const client = createContinuousAudioPreviewClient({readPlan: async () => plan, fetcher: (async (url: string, options: {method?: string}) => {
      calls.push(options.method as string); const query = Object.fromEntries(new URL(url, 'http://fixture').searchParams);
      if (options.method === 'DELETE') return new Response(null, {status: success ? 204 : 503});
      return response(plan, {...query, expectedRevision: 1, startFrame: 0, generation: 1, sequence: 1, blockStartFrame: 0} as BlockRequest);
    }) as never});
    const session = await client.prepare(input, {context: audioContext() as never, signal: new AbortController().signal}); session.takeInitialBlock();
    if (success) await session.dispose(); else await assert.rejects(session.dispose(), {code: 'AUDIO_PREVIEW_CLEANUP_UNCONFIRMED'});
    assert.deepEqual(calls, ['GET', 'DELETE']); assert.strictEqual(session.dispose(), session.dispose());
  }
});

test('plan digest mismatch fails before a PCM fetch or native reservation', async () => {
  let effects = 0; const client = createContinuousAudioPreviewClient({readPlan: async () => ({...manifest(), planHash: 'f'.repeat(64)}), fetcher: async () => { effects++; throw Error('Forbidden'); }});
  await assert.rejects(client.prepare(input as never, {context: audioContext() as never, signal: new AbortController().signal, reserveNative: async () => { effects++; throw Error('Forbidden'); }}), {code: 'AUDIO_PREVIEW_PROTOCOL'});
  assert.equal(effects, 0);
});
