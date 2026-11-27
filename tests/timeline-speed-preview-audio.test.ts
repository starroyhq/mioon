import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, open, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {
  compileTimeMap, initialTimeMap, instantiateSpeedPreset, projectTimeMapToCurrentClipFields, timeMapPlanInfo, type TimeMapSpeed,
} from '../packages/contracts/src/timeline-time-map.ts';
import {AUDIO_PREVIEW_LIMITS, audioPreviewPlanSchema} from '../packages/contracts/src/timeline-audio-preview.ts';
import {continuousAudioPlanSchema} from '../packages/contracts/src/timeline-audio-continuous.ts';
import {timelineProcessingResponseSchemas} from '../packages/contracts/src/timeline-processing.ts';
import {processingApplication} from '../packages/business/src/timeline-processing/scheduler.ts';
import {speedExportClipPlan} from '../packages/business/src/timeline-speed-export-plan.ts';
import {prepareTimelineSpeedAudio, timelineReverseAudioClock, type TimelineSpeedAudioSource} from '../packages/business/src/timeline-speed-export-audio.ts';
import {withTimelineReverseAudio, type TimelineReverseProxyPort} from '../packages/business/src/timeline-speed-export-proxy.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import {mediaMtimeMs, sampleRanges} from '../packages/business/src/media-reference/fingerprint.ts';

const clock = {fpsNumerator: 30, fpsDenominator: 1};
const boundary = (value: number) => ({kind: 'rational' as const, numerator: String(value), denominator: '1'});
const constant = (numerator: number, denominator = 1) => ({kind: 'constant' as const, rate: {numerator, denominator}});
const samplesPerFrame = AUDIO_PREVIEW_LIMITS.samplesPerFrame;
const bytesPerFrame = samplesPerFrame * 8;
const sourceFrames = 103;
const recordedSourceFrames = 105;
const at = '2026-01-01T00:00:00.000Z';
function speedTiming(speed: TimeMapSpeed, frames = sourceFrames, direction: 'forward' | 'reverse' = 'forward') {
  const basis = {profile: 'timeline-speed-v1' as const, sourceFps: clock, outputFps: clock,
    sourceRange: {start: boundary(0), end: boundary(frames)}, speed};
  const compiled = compileTimeMap(basis); assert.ok(compiled.ok);
  const plan = initialTimeMap(compiled.value, direction);
  const timing: ClipTiming = {profile: 'timeline-speed-v1', basis,
    view: {direction, loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
    outputWindow: plan.outputWindow, pitchShift: false, interpolation: 'off'};
  return {timing, duration: plan.durationFrames};
}

async function fixture(t: test.TestContext, timelines: readonly ReturnType<typeof speedTiming>[],
  {freeze = false, reverse = false, realReverse = false, ready = true, visibleAudioOnly = false} = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-speed-preview-audio-'));
  const sourceDir = path.join(root, 'media'); await mkdir(sourceDir);
  const title = freeze ? 'source.mp4' : 'source.wav';
  const source = path.join(sourceDir, title), sourcePath = `media/${title}`;
  const signal = 'aevalsrc=0.12+0.04*sin(2*PI*440*t)|0.16+0.02*cos(2*PI*313*t):s=48000';
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  await run('ffmpeg', [...args, '-f', 'lavfi', '-i', signal,
    ...(freeze ? ['-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=30', '-map', '1:v', '-map', '0:a', '-t', (recordedSourceFrames / 30).toFixed(9),
      '-threads', '1', '-c:v', 'libx264', '-c:a', 'aac'] : ['-af', `atrim=end_sample=${recordedSourceFrames * samplesPerFrame}`, '-c:a', 'pcm_f32le']), source]);
  const bytes = await readFile(source), info = await lstat(source, {bigint: true});
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sampled = createHash('sha256');
  for (const {start, length} of sampleRanges(bytes.length)) sampled.update(bytes.subarray(start, start + length));
  const sampledSha256 = sampled.digest('hex');
  const mimeType = freeze ? 'video/mp4' : 'audio/wav';
  const taskId = randomUUID(), key = 'd'.repeat(64), proof = {taskId, sha256: key};
  let leases = 0, releases = 0;
  const audioWindows: {visibleStart: number; requiredStart: number}[] = [];
  const reversedFile = path.join(root, 'reverse.wav');
  const reverseClock = {fromSample: 0, toSample: recordedSourceFrames * samplesPerFrame};
  let port: TimelineReverseProxyPort | undefined;
  if (reverse || realReverse) {
    await run('ffmpeg', [...args, '-i', source, '-af', 'areverse', '-c:a', 'pcm_f32le', reversedFile]);
  }
  if (reverse) {
    port = {lookup: () => ({taskId, ...(ready ? {readySha256: key} : {})}), async acquire(request, frozen) {
      assert.ok(ready && request.needsAudio && request.audioWindow);
      assert.ok(request.audioWindow.fromSample >= reverseClock.fromSample && request.audioWindow.toSample <= reverseClock.toSample);
      assert.deepEqual(frozen, proof); leases++;
      const {startFrame, endFrame} = request.sourceWindow;
      const visible = {fromSample: startFrame * samplesPerFrame, toSample: endFrame * samplesPerFrame};
      audioWindows.push({visibleStart: visible.fromSample, requiredStart: request.audioWindow.fromSample});
      return {proof, audio: {file: reversedFile, clock: visibleAudioOnly ? visible : reverseClock},
        verify: () => leases > releases, release: () => {releases++;}};
    }};
  }
  const store = createProjectStore({projectId: randomUUID(), projectFile: path.join(root, 'project.mioon'),
    targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION, allowFormat6: true,
    locate: () => ({localDir: path.join(root, 'history'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const application = openAppLibrary({dataDir: path.join(root, 'app')});
  const processing = realReverse ? {enabled: true, ...processingApplication(application.db, path.join(root, 'processing'))} : undefined;
  const services = createServices(store, new Map(), {application: createProjectServiceApplication(application, undefined, {}),
    processing, reverseProxy: port});
  t.after(async () => {await services.drain(); store.close(); application.close(); await rm(root, {recursive: true, force: true});});
  const projectId = store.projectId, timelineId = randomUUID(), rootId = randomUUID(), videoTrack = randomUUID(), assetId = randomUUID();
  const inputs: readonly {readonly timing: ClipTiming; readonly duration: number}[] = freeze ? [{
    duration: 19, timing: {profile: 'timeline-freeze-v1', sourceFrame: 4, sourceVersionId: null, sourceSha256: sha256},
  }] : timelines;
  const clips = inputs.map(({timing, duration}) => {
    const frameFields = {id: randomUUID(), startFrame: 0, sourceInFrame: 0, durationFrames: duration};
    const plan = speedExportClipPlan({...frameFields, timing}, 30);
    const projected = projectTimeMapToCurrentClipFields(frameFields, plan); assert.ok(projected.ok);
    return {...frameFields, ...projected.value, trackId: randomUUID(), name: 'Synthetic clip',
      rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1, assetId, sourceState: 'ready', anchor: null, timing,
      ...(freeze ? {muted: true} : {})};
  });
  const tracks = [{id: videoTrack, name: 'Main', orderIndex: 0, kind: 'video', hidden: false, muted: false},
    ...clips.map((clip, index) => ({id: clip.trackId, name: 'Synthetic track', kind: freeze ? 'video' : 'audio',
      orderIndex: index + 1, hidden: false, muted: false}))];
  store.tx(() => {
    store.put('projects', {id: projectId, name: 'Synthetic speed audio preview', revision: 1, createdAt: at, updatedAt: at});
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Synthetic sequence', position: {x: 0, y: 0}, createdAt: at});
    store.put('assets', {id: assetId, projectId, mimeType, name: 'Synthetic source', duration: recordedSourceFrames / 30,
      hasAudio: true, hasVideo: freeze, sizeBytes: bytes.length, sha256, referenceRevision: 1,
      reference: {pathForm: 'relative', path: sourcePath, volume: null, sizeBytes: bytes.length,
        mtimeMs: mediaMtimeMs(info), sampledSha256, fullSha256: sha256}, createdAt: at});
    store.put('timelines', {id: timelineId, projectId, revision: 1, fps: 30, width: 720, height: 1280,
      mainTrack: {trackId: videoTrack, sequenceNodeId: rootId}, tracks, clips,
      durationFrames: Math.max(...clips.map(clip => clip.durationFrames)), createdAt: at, updatedAt: at});
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  if (realReverse) services.activateBackground();
  const input = {projectId, timelineId, expectedRevision: 1, startFrame: 0};
  const render = async (index = 0): Promise<Buffer> => {
    const clip = clips[index]!, plan = speedExportClipPlan(clip, 30);
    const destination = path.join(root, `export-${index}.f32le`);
    const audioSource: TimelineSpeedAudioSource = reverse || realReverse ? {file: reversedFile, streamIndex: 'a:0', reversed: reverseClock}
      : {file: source, streamIndex: 'a:0'};
    const result = await prepareTimelineSpeedAudio({timing: clip.timing, plan, source: audioSource, destination},
      {openOwnedFile: file => open(file, 'wx', 0o600)});
    if (freeze) {assert.equal(result, null); return Buffer.alloc(clip.durationFrames * bytesPerFrame);}
    assert.equal(result?.samples, clip.durationFrames * samplesPerFrame);
    return readFile(destination);
  };
  const readContinuous = async (start: number): Promise<Buffer> => {
    const request = {...input, startFrame: start};
    const plan = continuousAudioPlanSchema.parse(await services.call('timeline.audioPreview.continuousPlan', request));
    const sessionId = randomUUID(), pieces: Buffer[] = [];
    try {
      for (let blockStartFrame = start, sequence = 1; blockStartFrame < plan.durationFrames; blockStartFrame += 60, sequence++) {
        pieces.push(await services.audioPreview.consumeBlock({...request, planHash: plan.planHash, sessionId, generation: 1, sequence,
          blockStartFrame}, {consume: async ({pcm}) => pcm}));
      }
    } finally {await services.audioPreview.retireSessionById(sessionId);}
    return Buffer.concat(pieces);
  };
  const readLegacyPlan = async (start: number) => audioPreviewPlanSchema.parse(await services.call('timeline.audioPreview.plan', {...input, startFrame: start}));
  const readLegacy = async (start: number): Promise<Buffer> => {
    const plan = await readLegacyPlan(start);
    if (freeze) {
      assert.deepEqual(plan.sources, []); assert.deepEqual(plan.voices, []);
      return Buffer.alloc(plan.range.sampleFrames * 8);
    }
    const [match] = plan.sources; assert.ok(match);
    return services.audioPreview.consumeSource({...input, startFrame: start, planHash: plan.planHash,
      clipId: match.clipId, sourceHash: match.sourceHash}, {consume: async ({pcm}) => pcm});
  };
  return {render, readContinuous, readLegacyPlan, readLegacy, audioWindows, counts: () => ({leases, releases}),
    services, projectId, timelineId, assetId, sha256, clips};
}

test('preview PCM and SP-E render the same output samples through both real service lanes', async t => {
  const curve = instantiateSpeedPreset('fastToSlow', 0, sourceFrames); assert.ok(curve.ok);
  for (const [name, speed, options] of [
    ['0.1× shift', speedTiming(constant(1, 10), 13), {}],
    ['2× preserve', speedTiming(constant(2)), {}],
    ['10× shift and tail silence', speedTiming(constant(10)), {}],
    ['increasing/decreasing curve', speedTiming(curve.value), {}],
    ['reverse with a verified PCM lease', speedTiming(constant(3, 2), sourceFrames, 'reverse'), {reverse: true}],
    ['reverse curve with a verified PCM lease', speedTiming(curve.value, sourceFrames, 'reverse'), {reverse: true}],
    ['frozen frame is silent', speedTiming(constant(1)), {freeze: true}],
  ] as const) await t.test(name, async t => {
    const f = await fixture(t, [speed], options);
    const whole = await f.render(), start = 4, expected = whole.subarray(start * bytesPerFrame);
    assert.ok((await f.readLegacy(start)).equals(expected), 'The V1 PCM interval must match the staged export bytes');
    assert.ok((await f.readContinuous(start)).equals(expected), 'The V2 PCM interval must match the staged export bytes');
    if (name.startsWith('10×')) {
      const tail = Math.ceil(sourceFrames * samplesPerFrame / 10);
      assert.notEqual(whole.readFloatLE((tail - 1) * 8), 0);
      assert.ok(whole.subarray(tail * 8).every(byte => byte === 0));
    }
    if ('reverse' in options) {const {leases, releases} = f.counts(); assert.ok(leases >= 2); assert.equal(leases, releases);}
  });
});

test('the continuous mix adds same-file, same-window clips with distinct timing; V1 rejects ambiguous prepared descriptors', async t => {
  const f = await fixture(t, [speedTiming(constant(1), 32), speedTiming(constant(2), 64)]);
  const a = await f.render(0), b = await f.render(1), expected = Buffer.alloc(a.length);
  for (let offset = 0; offset < expected.length; offset += 4) expected.writeFloatLE(a.readFloatLE(offset) + b.readFloatLE(offset), offset);
  assert.ok((await f.readContinuous(0)).equals(expected), 'The mixed V2 PCM must match both staged export sources');
  await assert.rejects(() => f.readLegacyPlan(0), {code: 'AUDIO_PREVIEW_UNAVAILABLE'});
});

test('unready reverse PCM fails closed and never attempts to acquire an unverified path', async t => {
  const f = await fixture(t, [speedTiming(constant(1), sourceFrames, 'reverse')], {reverse: true, ready: false});
  await assert.rejects(() => f.readLegacy(0), {code: 'SPEED_PROCESSING_NOT_READY'});
  await assert.rejects(() => f.readContinuous(0), {code: 'SPEED_PROCESSING_NOT_READY'});
  assert.deepEqual(f.counts(), {leases: 0, releases: 0});
});

test('a trimmed 2× reverse clip requires audio preceding its visible source window', async t => {
  const {timing} = speedTiming(constant(2), sourceFrames, 'reverse');
  const clipped = {timing: {...timing, outputWindow: {fromFrame: 5, toFrame: 30}}, duration: 25};
  await t.test('the required context gives the same samples as export after seek', async t => {
    const f = await fixture(t, [clipped], {reverse: true});
    const start = 3, expected = (await f.render()).subarray(start * bytesPerFrame);
    assert.ok((await f.readLegacy(start)).equals(expected), 'V1 must keep the pre-roll context after seek');
    assert.ok((await f.readContinuous(start)).equals(expected), 'V2 must keep the pre-roll context after seek');
    assert.equal(f.audioWindows.length, 2);
    assert.ok(f.audioWindows.every(window => window.requiredStart < window.visibleStart));
    assert.deepEqual(f.counts(), {leases: 2, releases: 2});
  });
  await t.test('a lease that covers only visible samples is refused and released', async t => {
    const f = await fixture(t, [clipped], {reverse: true, visibleAudioOnly: true});
    await assert.rejects(() => f.readLegacy(3), {code: 'SPEED_PROCESSING_NOT_READY'});
    await assert.rejects(() => f.readContinuous(3), {code: 'SPEED_PROCESSING_NOT_READY'});
    assert.deepEqual(f.counts(), {leases: 2, releases: 2});
  });
  await t.test('the persisted SP-P task supplies the context to both preview lanes', async t => {
    const f = await fixture(t, [clipped], {realReverse: true});
    const {services, projectId, timelineId, assetId, sha256} = f;
    const [clip] = f.clips; assert.ok(clip);
    const {items} = timelineProcessingResponseSchemas['timeline.processing.list'].parse(
      await services.call('timeline.processing.list', {projectId}));
    const task = items.find(item => item.kind === 'reverse' && item.clipId === clip.id); assert.ok(task);
    const result = timelineProcessingResponseSchemas['timeline.processing.wait'].parse(
      await services.call('timeline.processing.wait', {projectId, taskId: task.taskId}));
    assert.equal(result.timedOut, false);
    assert.equal(result.item.status, 'ready', JSON.stringify(result.item));

    const plan = speedExportClipPlan(clip, 30), info = timeMapPlanInfo(plan);
    assert.ok(info.ok);
    const audioWindow = timelineReverseAudioClock(plan, clip.timing); assert.ok(audioWindow);
    const visibleStart = info.value.sourceWindow.startFrame * samplesPerFrame;
    assert.ok(audioWindow.fromSample < visibleStart);
    await withTimelineReverseAudio({projectId, timelineId, clipId: clip.id, assetId, sourceSha256: sha256,
      mapHash: info.value.mapHash, media: 'audio', sourceFps: clock, sourceWindow: info.value.sourceWindow,
      pictureWindows: [], needsAudio: true, audioWindow}, services.timelineProcessing?.reverseProxy, {}, async ({clock}) => {
      assert.ok(clock.fromSample <= audioWindow.fromSample && clock.toSample >= audioWindow.toSample);
    });

    const start = 3, expected = (await f.render()).subarray(start * bytesPerFrame);
    assert.ok(expected.some(byte => byte !== 0));
    assert.ok((await f.readLegacy(start)).equals(expected), 'V1 must match export PCM using the real cache');
    assert.ok((await f.readContinuous(start)).equals(expected), 'V2 must match export PCM using the real cache');
  });
});
