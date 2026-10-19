import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTimelineAudioContinuousServices} from '../packages/business/src/timeline-audio-continuous.ts';

interface BusinessClip {id: string; trackId: string; assetId: string; startFrame: number; durationFrames: number; sourceInFrame: number; gain: number; [key: string]: unknown}
interface BusinessTrack {id: string; orderIndex: number; kind: string; hidden: boolean; muted: boolean; [key: string]: unknown}
interface BusinessAsset {id: string; projectId: string; sha256: string; sizeBytes: number; duration: number; mimeType: string; hasAudio: boolean; relativePath: string; [key: string]: unknown}
interface BusinessSnapshot {timeline: {id: string; projectId: string; revision: number; fps: number; durationFrames: number; tracks: BusinessTrack[]; clips: BusinessClip[]; [key: string]: unknown}; assets: BusinessAsset[]}
interface BusinessInfo {dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number}
interface BusinessOpen {sourceInFrame: number; frameCount: number; trimStartFrame: number}
interface BusinessCalls {hashes: number; probes: number; opens: BusinessOpen[]; reads: number; closed: number; active: number; peak: number}
interface BusinessInput {projectId: string; timelineId: string; expectedRevision: number; startFrame: number}
interface BusinessBlock extends BusinessInput {planHash: string; sessionId: string; generation: number; sequence: number; blockStartFrame: number}
interface BusinessCursor {done: Promise<void>; read(samples: number): Promise<Buffer>; close(): Promise<void>}
interface BusinessDecoder {probe: () => Promise<{sizeBytes: number; durationSeconds: number}>; open: (...args: never[]) => BusinessCursor}
interface BusinessService {handlers: Record<string, (input: unknown) => Promise<{planHash: string; [key: string]: unknown}>>; consumeBlock(value: BusinessBlock, options: unknown): Promise<{pcm: Buffer; details: Record<string, unknown>}>; retireSessionById(id: string): Promise<void>; drain(): Promise<void>}
interface BusinessFixture {service: BusinessService; input: BusinessInput; plan: {planHash: string}; block: BusinessBlock; snapshot: BusinessSnapshot; info: BusinessInfo; calls: BusinessCalls; decoder: BusinessDecoder; consume(value?: BusinessBlock, context?: Record<string, unknown>): Promise<{pcm: Buffer; details: Record<string, unknown>}>}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const tick = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(t: TestContext, {durationFrames = 750, trackCount = 1, runtime: overrides = {}}: {durationFrames?: number; trackCount?: number; runtime?: Record<string, unknown>} = {}): Promise<BusinessFixture> {
  const db = new DatabaseSync(':memory:'), projectId = randomUUID(), timelineId = randomUUID(), assetId = randomUUID();
  const tracks: BusinessTrack[] = Array.from({length: trackCount}, (_, orderIndex) => ({id: randomUUID(), orderIndex, kind: 'audio', hidden: false, muted: false}));
  const snapshot: BusinessSnapshot = {timeline: {id: timelineId, projectId, revision: 1, fps: 30, durationFrames, tracks,
    clips: tracks.map((track, index) => ({id: randomUUID(), trackId: track.id, assetId, startFrame: 0,
      durationFrames, sourceInFrame: index, gain: 1}))},
  assets: [{id: assetId, projectId, sha256: sha('test asset'), sizeBytes: 4096, duration: 600, mimeType: 'audio/wav', hasAudio: true, relativePath: 'media/owned.wav'}]};
  if (durationFrames === 18000) for (const clip of snapshot.timeline.clips) clip.sourceInFrame = 0;
  const info: BusinessInfo = {dev: 1, ino: 2, size: 4096, mtimeMs: 3, ctimeMs: 4}, calls: BusinessCalls = {hashes: 0, probes: 0, opens: [], reads: 0, closed: 0, active: 0, peak: 0};
  const probe = {sizeBytes: info.size, durationSeconds: 600};
  const decoder: BusinessDecoder = {async probe() {calls.probes++; return probe;}, open(_file: unknown, _source: unknown, unit: BusinessOpen, options: {onDecodedBytes?: (bytes: number) => void}) {
    calls.opens.push({...unit}); calls.active++; calls.peak = Math.max(calls.peak, calls.active);
    let consumed = unit.trimStartFrame * 1600, closed = false;
    return {done: Promise.resolve(), async read(samples: number) {
      calls.reads++; options.onDecodedBytes?.(samples * 8); const pcm = Buffer.alloc(samples * 8);
      for (let index = 0; index < samples; index++) {
        const sample = ((unit.sourceInFrame * 1600 + consumed + index) % 128) / 1024;
        pcm.writeFloatLE(sample, index * 8); pcm.writeFloatLE(-sample, index * 8 + 4);
      }
      consumed += samples; return pcm;
    }, async close() {if (!closed) {closed = true; calls.closed++; calls.active--;}}};
  }};
  const service = createTimelineAudioContinuousServices({db, root: '/owned'}, {runtime: {
    assertOrdinaryWorkspace() {}, ownsLock: () => true, readSavedTimeline: () => snapshot,
    validateSource: () => ({file: '/owned/media/owned.wav', info: {...info}}),
    hash: async (_root: string, asset: BusinessAsset, options: {beforeEffect(): void; onBytes(bytes: number): void}) => {calls.hashes++; options.beforeEffect(); options.onBytes(asset.sizeBytes);
      return {file: '/owned/media/owned.wav', sha256: asset.sha256, sizeBytes: asset.sizeBytes, info: {...info}};},
    decoder, boundedShutdown: async (work: unknown) => work, ...overrides,
  } as never});
  t.after(async () => {await service.drain(); db.close();});
  const input: BusinessInput = {projectId, timelineId, expectedRevision: 1, startFrame: 0};
  const plan = await (service.handlers['timeline.audioPreview.continuousPlan'] as (value: unknown) => Promise<{planHash: string}>)(input);
  const block: BusinessBlock = { ...input, planHash: plan.planHash, sessionId: randomUUID(), generation: 1, sequence: 1, blockStartFrame: 0};
  const consume = async (value: BusinessBlock = block, context: Record<string, unknown> = {}): Promise<{pcm: Buffer; details: Record<string, unknown>}> => service.consumeBlock(value, {consume: async ({pcm}: {pcm: Buffer}, details: unknown) => ({pcm, details}), ...context} as never);
  return {service, input, plan, block, snapshot, info, calls, decoder, consume};
}

test('25-second playback crosses twelve pull boundaries with one decoder and two hashes', async (t: TestContext) => {
  const f = await fixture(t); let frames = 0, sequence = 0;
  for (let blockStartFrame = 0; blockStartFrame < 750; blockStartFrame += 60) {
    const {pcm, details} = await f.consume({...f.block, sequence: ++sequence, blockStartFrame});
    assert.equal(details.startFrame, blockStartFrame); assert.equal(details.endFrame, Math.min(blockStartFrame + 60, 750));
    assert.equal(pcm.length, (details.endFrame - blockStartFrame) * 12800);
    assert.equal(pcm.readFloatLE(0), 0); assert.equal(pcm.readFloatLE(4), 0);
    frames += pcm.length / 12800;
  }
  assert.equal(frames, 750); assert.equal(f.calls.opens.length, 1); assert.equal(f.calls.hashes, 2); assert.equal(f.calls.probes, 1);
  assert.equal(f.calls.active, 0); assert.equal(f.calls.reads, 13);
});

test('ten-minute single segment is admitted, pulled in 300 bounded buffers and released', async (t: TestContext) => {
  const f = await fixture(t, {durationFrames: 18000}); let samples = 0, largest = 0;
  for (let index = 0; index < 300; index++) {
    const {pcm} = await f.consume({...f.block, sequence: index + 1, blockStartFrame: index * 60});
    samples += pcm.length / 8; largest = Math.max(largest, pcm.length);
  }
  assert.equal(samples, 28_800_000); assert.equal(largest, 768000); assert.equal(f.calls.hashes, 2);
  assert.equal(f.calls.opens.length, 1); assert.equal(f.calls.active, 0);
  t.diagnostic(JSON.stringify({sampleFrames: samples, largestMixedPcmBytes: largest, hashPasses: f.calls.hashes, decoderRuns: f.calls.opens.length}));
});

test('pause makes no source progress and seek restarts at original composition boundary', async (t: TestContext) => {
  const f = await fixture(t); await f.consume(); const reads = f.calls.reads;
  await tick(); await tick(); assert.equal(f.calls.reads, reads);
  const next = {...f.block, generation: 2, sequence: 2, blockStartFrame: 321};
  await f.consume(next);
  assert.equal(f.calls.opens.length, 2); assert.equal(f.calls.closed, 1);
  assert.deepEqual(f.calls.opens[1], {sourceInFrame: 0, frameCount: 750, trimStartFrame: 321});
  assert.equal(f.calls.hashes, 2, 'Same exact source identity reuses completed hash proof');
  await assert.rejects(f.consume({...next, sequence: 3, generation: 1, blockStartFrame: 381}), {code: 'AUDIO_PREVIEW_STALE'});
});

test('all muted/image edges remain decoder restart boundaries and fades retain the clip clock', async (t: TestContext) => {
  const f = await fixture(t, {durationFrames: 150, trackCount: 2});
  f.snapshot.timeline.tracks[1].muted = true;
  Object.assign(f.snapshot.timeline.clips[0], {fadeInFrames: 90, fadeOutFrames: 60, gain: 2});
  Object.assign(f.snapshot.timeline.clips[1], {startFrame: 45, durationFrames: 30});
  const plan = await f.service.handlers['timeline.audioPreview.continuousPlan'](f.input);
  const first = await f.consume({...f.block, planHash: plan.planHash});
  assert.equal(f.calls.opens.length, 2);
  assert.deepEqual(f.calls.opens.slice(0, 2), [{sourceInFrame: 0, frameCount: 45, trimStartFrame: 0}, {sourceInFrame: 45, frameCount: 30, trimStartFrame: 0}]);
  const sample = 59 * 1600 + 13, value = (sample % 128) / 1024;
  assert.ok(Math.abs(first.pcm.readFloatLE(sample * 8) - value * 2 * sample / (90 * 1600)) < 2e-7);
  await f.consume({...f.block, planHash: plan.planHash, sequence: 2, blockStartFrame: 60});
  assert.deepEqual(f.calls.opens.at(-1), {sourceInFrame: 75, frameCount: 75, trimStartFrame: 0});
});

test('reverse clip UUIDs at a same-track boundary never replace an unconsumed cursor or repeat a segment', async (t: TestContext) => {
  const f = await fixture(t, {durationFrames: 150}), first = f.snapshot.timeline.clips[0];
  Object.assign(first, {id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', durationFrames: 75});
  f.snapshot.timeline.clips.push({...first, id: '00000000-0000-4000-8000-000000000001', startFrame: 75, gain: 0.5});
  const plan = await f.service.handlers['timeline.audioPreview.continuousPlan'](f.input);
  for (let index = 0; index < 3; index++) {
    const startFrame = index * 60, {pcm, details} = await f.consume({...f.block, planHash: plan.planHash,
      sequence: index + 1, blockStartFrame: startFrame});
    for (let at = 0; at < pcm.length / 8; at++) {
      const globalSample = startFrame * 1600 + at, second = globalSample >= 75 * 1600;
      const sourceSample = second ? globalSample - 75 * 1600 : globalSample;
      const expected = (sourceSample % 128) / 1024 * (second ? 0.5 : 1);
      assert.equal(pcm.readFloatLE(at * 8), expected);
      assert.equal(pcm.readFloatLE(at * 8 + 4), expected === 0 ? 0 : -expected);
    }
    assert.equal(details.endFrame, Math.min(startFrame + 60, 150));
  }
  assert.deepEqual(f.calls.opens, [
    {sourceInFrame: 0, frameCount: 75, trimStartFrame: 0},
    {sourceInFrame: 0, frameCount: 75, trimStartFrame: 0},
  ], 'Each saved original segment opens once, including the block spanning frame75');
  assert.equal(f.calls.hashes, 2); assert.equal(f.calls.probes, 1); assert.equal(f.calls.active, 0); assert.equal(f.calls.peak, 1);
});

test('twelve simultaneous voices use at most twelve cursors and preserve over-full floating mix', async (t: TestContext) => {
  const f = await fixture(t, {trackCount: 12});
  const {pcm} = await f.consume();
  assert.equal(f.calls.peak, 12); assert.equal(f.calls.hashes, 2); assert.equal(pcm.length, 768000);
  const at = 127; let expected = 0;
  for (let voice = 0; voice < 12; voice++) expected += ((voice * 1600 + at) % 128) / 1024;
  assert.ok(Math.abs(pcm.readFloatLE(at * 8) - expected) < 2e-6);
  await f.service.retireSessionById(f.block.sessionId); assert.equal(f.calls.active, 0);
  await assert.rejects(f.consume(), {code: 'AUDIO_PREVIEW_STALE'});
});

test('saved revision and exact source stat changes reject publication without stale mix', async (t: TestContext) => {
  for (const change of ['revision', 'stat']) {
    const f = await fixture(t); await f.consume();
    if (change === 'revision') f.snapshot.timeline.revision++; else f.info.ctimeMs++;
    let published = false;
    await assert.rejects(f.consume({...f.block, sequence: 2, blockStartFrame: 60}, {consume: async () => {published = true;}}),
      (error: unknown) => ['AUDIO_PREVIEW_REVISION_CONFLICT', 'AUDIO_PREVIEW_STALE'].includes((error as {code?: string}).code as string));
    assert.equal(published, false);
  }
});

test('sequence replay rejects while forward and initial gaps tolerate pre-send cancellation', async (t: TestContext) => {
  const f = await fixture(t);
  await f.consume(); const opens = f.calls.opens.length;
  await assert.rejects(f.consume(), {code: 'AUDIO_PREVIEW_STALE'});
  await f.consume({...f.block, sequence: 3, blockStartFrame: 60});
  assert.equal(f.calls.opens.length, opens);
  const delayed = await fixture(t);
  await delayed.consume({...delayed.block, generation: 3, sequence: 5, blockStartFrame: 120});
  assert.equal(delayed.calls.opens[0].trimStartFrame, 120);
});

test('abort retains the active resource until consumer settles; next generation waits exact cleanup', async (t: TestContext) => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>();
  let resources: Promise<void> | undefined, consumerSignal: AbortSignal | undefined;
  const first = f.consume(f.block, {onResourceSettlement: (value: Promise<void>) => {resources = value;}, consume: async (_pcm: unknown, context: {signal: AbortSignal; beforeEffect(): void}) => {
    consumerSignal = context.signal; entered.resolve(undefined); await closing.promise; context.beforeEffect();
  }});
  const rejected = assert.rejects(first); await entered.promise;
  let settled = false; resources!.then(() => {settled = true;});
  const next = f.consume({...f.block, generation: 2, sequence: 2, blockStartFrame: 321});
  await tick(); assert.equal(consumerSignal!.aborted, true); assert.equal(settled, false); assert.equal(f.calls.opens.length, 1);
  closing.resolve(undefined); await rejected; await next;
  assert.equal(settled, true); assert.equal(f.calls.opens.length, 2); assert.equal(f.calls.closed, 1);
});

test('rapid seeks retain one active consumer and only the latest pending intent', async (t: TestContext) => {
  const f = await fixture(t), entered = Promise.withResolvers<void>(), closing = Promise.withResolvers<void>();
  const first = f.consume(f.block, {consume: async (_pcm: unknown, context: {beforeEffect(): void}) => {entered.resolve(undefined); await closing.promise; context.beforeEffect();}});
  const firstRejected = assert.rejects(first); await entered.promise;
  const second = f.consume({...f.block, generation: 2, sequence: 2, blockStartFrame: 120});
  const secondRejected = assert.rejects(second, {code: 'OPERATION_CANCELLED'});
  const third = f.consume({...f.block, generation: 3, sequence: 3, blockStartFrame: 240});
  const thirdRejected = assert.rejects(third, {code: 'OPERATION_CANCELLED'});
  const latest = f.consume({...f.block, generation: 4, sequence: 4, blockStartFrame: 360});
  await secondRejected; await thirdRejected;
  assert.equal(f.calls.opens.length, 1, 'No pending seek has acquired source PCM/process capacity');
  closing.resolve(undefined); await firstRejected; const result = await latest;
  assert.equal(result.details.startFrame, 360); assert.equal(f.calls.opens.length, 2); assert.equal(f.calls.peak, 1);
});

test('seek generations cannot reset the cumulative actually decoded prefix work budget', async (t: TestContext) => {
  const f = await fixture(t, {durationFrames: 18000});
  for (let generation = 1; generation <= 48; generation++)
    await f.consume({...f.block, generation, sequence: generation, blockStartFrame: 17900});
  await assert.rejects(f.consume({...f.block, generation: 49, sequence: 49, blockStartFrame: 17900}), {code: 'AUDIO_PREVIEW_BUDGET'});
  assert.equal(f.calls.opens.length, 48); assert.equal(f.calls.active, 0);
});

test('fifty pause cancellations during active prefetch remain bounded and can resume a ten-minute source', async (t: TestContext) => {
  const f = await fixture(t, {durationFrames: 18000}); await f.consume();
  const original = f.decoder.open;
  let reading: {promise: Promise<void>; resolve: (value?: void) => void} | undefined, cancelPrefetch = true;
  f.decoder.open = ((...args: never[]) => {
    const cursor = original(...args), cancelled = Promise.withResolvers<void>();
    return {...cursor, async read(samples: number) {
      const pcm = await cursor.read(samples);
      if (!cancelPrefetch) return pcm;
      reading!.resolve(undefined); await cancelled.promise; throw Object.assign(Error('cancelled'), {code: 'OPERATION_CANCELLED'});
    }, async close() {cancelled.resolve(undefined); await cursor.close();}};
  }) as never;
  // Replace the already-open initial cursor on the first explicit generation.
  for (let index = 0; index < 50; index++) {
    reading = Promise.withResolvers<void>(); const abort = new AbortController();
    const pending = f.consume({...f.block, generation: index + 2, sequence: index + 2, blockStartFrame: 60}, {signal: abort.signal});
    const rejected = assert.rejects(pending, {code: 'OPERATION_CANCELLED'});
    await reading!.promise; abort.abort(); await rejected;
    assert.equal(f.calls.active, 0, 'Cancelled cursor closed before another prefetch');
  }
  cancelPrefetch = false;
  const resumed = await f.consume({...f.block, generation: 52, sequence: 52, blockStartFrame: 60});
  assert.equal(resumed.details.startFrame, 60); assert.equal(f.calls.peak, 1); assert.equal(f.calls.hashes, 2);
});

test('a pre-try saved-snapshot failure cannot leave a settled active slot blocking later generations', async (t: TestContext) => {
  const f = await fixture(t); await f.consume(); f.snapshot.timeline.revision = 2;
  const failed = f.consume({...f.block, generation: 1, sequence: 2, blockStartFrame: 60});
  const failedExpected = assert.rejects(failed, {code: 'AUDIO_PREVIEW_REVISION_CONFLICT'});
  const abort = new AbortController();
  const cancelled = f.consume({...f.block, generation: 2, sequence: 3, blockStartFrame: 120}, {signal: abort.signal});
  const cancelledExpected = assert.rejects(cancelled); abort.abort(); await failedExpected; await cancelledExpected;
  f.snapshot.timeline.revision = 1;
  const result = await f.consume({...f.block, generation: 3, sequence: 4, blockStartFrame: 180});
  assert.equal(result.details.startFrame, 180);
});

test('source/hash admission and restored rejection happen before any source I/O or payload getters', async (t: TestContext) => {
  const f = await fixture(t); f.snapshot.assets[0].sizeBytes = 512 * 1024 * 1024 + 1;
  await assert.rejects(f.service.handlers['timeline.audioPreview.continuousPlan'](f.input), {code: 'AUDIO_PREVIEW_SOURCE_LIMIT'});
  assert.equal(f.calls.hashes, 0); assert.equal(f.calls.opens.length, 0);
  const db = new DatabaseSync(':memory:'); let accessed = false;
  const forbidden = createTimelineAudioContinuousServices({db, root: '/restored'}, {runtime: {
    assertOrdinaryWorkspace() {throw Object.assign(Error('restored'), {code: 'RESTORE_OPERATION_UNAVAILABLE'});},
  } as never});
  await assert.rejects(forbidden.handlers['timeline.audioPreview.continuousPlan']({get projectId(): string {accessed = true; return randomUUID();}}), {code: 'RESTORE_OPERATION_UNAVAILABLE'});
  assert.equal(accessed, false); db.close();
});

test('native resource registration precedes all source effects and failed registration starts no work', async (t: TestContext) => {
  const f = await fixture(t), registrationFailure = Error('Synthetic registration rejected');
  await assert.rejects(f.consume(f.block, {onResourceSettlement() {
    assert.equal(f.calls.hashes, 0); assert.equal(f.calls.opens.length, 0); throw registrationFailure;
  }}), (error: unknown) => error === registrationFailure);
  assert.equal(f.calls.hashes, 0); assert.equal(f.calls.opens.length, 0);
  let resource: Promise<void> | undefined;
  await f.consume(f.block, {onResourceSettlement(value: Promise<void>) {assert.equal(f.calls.hashes, 0); resource = value;}});
  await resource; assert.equal(f.calls.hashes, 2);
});
