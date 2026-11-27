import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {renameSync, writeFileSync} from 'node:fs';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mediaLocatorFields, type MediaLocator} from '../packages/business/src/asset-reference-record.ts';
import {createMediaEncoderPool, type MediaEncoderSlotPool} from '../packages/business/src/media-encoder-pool.ts';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {freezeTimelineSnapshot, type TimelineClipRecord, type TimelineRecord} from '../packages/business/src/timeline-inputs.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {prepareTimelineInputs, readOwnedTimelineAsset, validatePreparedTimelineSources} from '../packages/business/src/timeline-sources.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {prepareProjectAssetFullHash} from '../packages/business/src/project-media-storage.ts';
import {createServices} from '../packages/business/src/services.ts';
import {timelineSpeedExportSnapshotFields} from '../packages/contracts/src/timeline-speed-export.ts';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields, timeMapPlanFrames,
  type CompiledTimeMap, type TimeMapBasis, type TimeMapResult,
} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import {mediaFixturePath} from './helpers/media-reference-fixtures.ts';
import type {TypedServices, TypedStore} from './helpers/strict-service-responses.ts';

const clock = {fpsNumerator: 30, fpsDenominator: 1};
const samplesPerFrame = 1600;
const marker = (frame: number): number => 32 + 5 * frame;
const toolLimits = {timeout: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024};

function unwrap<T>(result: TimeMapResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

async function sourceAsset(root: string) {
  const input = path.join(root, 'source.yuv'), file = path.join(root, 'source.mp4');
  const size = 64, frames = 40, lumaBytes = size * size, chroma = Buffer.alloc(lumaBytes / 2, 128);
  await writeFile(input, Buffer.concat(Array.from({length: frames}, (_, frame) =>
    Buffer.concat([Buffer.alloc(lumaBytes, marker(frame)), chroma]))));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'rawvideo', '-pixel_format', 'yuv420p',
    '-video_size', `${size}x${size}`, '-framerate', '30', '-i', input, '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1.333333',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-threads', '1',
    '-video_track_timescale', '30000', '-c:a', 'aac', file], toolLimits);
  const media = await probe(file);
  const bytes = await readFile(file);
  const id: string = randomUUID();
  return {id, mimeType: 'video/mp4', path: file, relativePath: path.basename(file),
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, ...media, colourProbe: media.probe};
}

function motion(sourceStart: number, sourceEnd: number, numerator: number, denominator: number): {plan: CompiledTimeMap; timing: ClipTiming} {
  const boundary = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
  const basis: TimeMapBasis = {profile: 'timeline-speed-v1', sourceFps: clock, outputFps: clock,
    sourceRange: {start: boundary(sourceStart), end: boundary(sourceEnd)}, speed: {kind: 'constant', rate: {numerator, denominator}}};
  const plan = initialTimeMap(unwrap(compileTimeMap(basis)));
  return {plan, timing: {profile: 'timeline-speed-v1', basis, pitchShift: true, interpolation: 'off',
    view: {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}, direction: 'forward'},
    outputWindow: plan.outputWindow}};
}

function fixture(asset: Awaited<ReturnType<typeof sourceAsset>> & MediaLocator, projectId: string = randomUUID()) {
  const trackId = randomUUID(), at = '2026-01-01T00:00:00.000Z';
  const freezeFrame = 34;
  const freeze = {plan: initialTimeMap(unwrap(compileFreezeTimeMap({sourceFrame: freezeFrame, durationFrames: 6}))),
    timing: {profile: 'timeline-freeze-v1', sourceFrame: freezeFrame, sourceVersionId: null, sourceSha256: asset.sha256} as const};
  const plans = [motion(0, 16, 2, 1), motion(16, 28, 3, 2), freeze, motion(30, 36, 1, 2)];
  let position = 0;
  const clips = plans.map(({plan, timing}): TimelineClipRecord => {
    const clip = {id: randomUUID(), trackId, assetId: asset.id, startFrame: position, durationFrames: plan.durationFrames,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 720}, gain: 1};
    position += plan.durationFrames;
    const projection = unwrap(projectTimeMapToCurrentClipFields(clip, plan));
    return {...clip, ...projection, timing, ...(timing.profile === 'timeline-freeze-v1' ? {muted: true} : {})};
  });
  const timeline: TimelineRecord = {id: randomUUID(), projectId, revision: 1, fps: 30, width: 720, height: 720,
    durationFrames: position, clips, tracks: [{id: trackId, kind: 'video', orderIndex: 0, hidden: false, muted: false}],
    createdAt: at, updatedAt: at};
  const assets = new Map([[asset.id, asset]]);
  const range = {startFrame: 2, endFrame: position - 2};
  const snapshot = {...freezeTimelineSnapshot(timeline, assets, undefined, {exportRange: range}),
    ...timelineSpeedExportSnapshotFields(timeline)};
  const expected = plans.flatMap(({plan}) => [...unwrap(timeMapPlanFrames(plan))]).slice(range.startFrame, range.endFrame);
  return {assets, snapshot, timeline, range, expected, freeze: clips[2]!};
}

function trackingPool() {
  const inner = createMediaEncoderPool(4);
  let active = 0, peak = 0;
  const pool: MediaEncoderSlotPool = {
    limit: inner.limit,
    async acquire(signal, owner) {
      const release = await inner.acquire(signal, owner);
      active++;
      peak = Math.max(active, peak);
      return () => { active--; release(); };
    },
    stats: () => inner.stats(),
  };
  return {pool, peak: () => peak};
}

async function readMedia(file: string, frames: number) {
  const capture = async (args: string[], maximumBytes: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    await runStreaming('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, ...args, 'pipe:1'],
      {...toolLimits, maxStdoutBytes: maximumBytes, onStdout(chunk) { chunks.push(chunk); }});
    return Buffer.concat(chunks);
  };
  const data = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=time_base:packet=pts', '-of', 'json', file], toolLimits));
  assert.equal(data.streams[0]?.time_base, '1/30000');
  const pts = data.packets.map((packet: {pts: number}) => packet.pts);
  const yuv = await capture(['-an', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2', '-threads', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo'], frames * 6);
  assert.equal(yuv.length, frames * 6);
  const luma = Array.from({length: frames}, (_, frame) => yuv.readUInt8(frame * 6));
  const pcm = await capture(['-vn', '-c:a', 'pcm_f32le', '-f', 'f32le'], (frames * samplesPerFrame + 1024) * 8);
  assert.ok(pcm.length >= frames * samplesPerFrame * 8);
  return {pts, luma, pcm};
}

function rms(pcm: Buffer, from: number, to: number): number {
  let energy = 0;
  for (let sample = from; sample < to; sample++) energy += pcm.readFloatLE(sample * 8) ** 2;
  return Math.sqrt(energy / (to - from));
}

function assertMarkers(luma: readonly number[], frames: readonly number[]): void {
  assert.equal(luma.length, frames.length);
  // Luma markers are five codes apart; a two-code H.264 difference cannot
  // make a wrongly selected source frame pass.
  for (const [index, frame] of frames.entries()) {
    assert.ok(Math.abs(luma[index]! - marker(frame)) <= 2, `output frame ${index} must show source frame ${frame}`);
  }
}

test('selected speed export preserves mapped frames and exact PTS with one and four segment encoders', {timeout: 120_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-speed-render-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const asset = await sourceAsset(root);
  const {assets, snapshot, range, expected, freeze} = fixture(asset);
  const outputs = [];
  for (const workers of [1, 4]) {
    const output = path.join(root, `range-${workers}.mp4`), encoder = trackingPool();
    await renderTimeline(snapshot, assets, output, {segmentConcurrency: workers, encoderPool: encoder.pool});
    assert.equal(encoder.peak(), workers);
    const observed = await readMedia(output, expected.length);
    assert.deepEqual(observed.pts, expected.map((_, index) => index * 1000));
    assertMarkers(observed.luma, expected);
    const freezeFrom = (freeze.startFrame - range.startFrame) * samplesPerFrame;
    const freezeTo = freezeFrom + freeze.durationFrames * samplesPerFrame;
    assert.ok(rms(observed.pcm, freezeFrom - 3200, freezeFrom - 1600) > 0.03, 'motion before freeze remains audible');
    assert.ok(rms(observed.pcm, freezeFrom + 3200, freezeTo - 3200) < 1e-5, 'freeze has no audio');
    assert.ok(rms(observed.pcm, freezeTo + 1600, freezeTo + 3200) > 0.03, 'motion after freeze remains audible');
    outputs.push(observed);
  }
  assert.deepEqual(outputs[1], outputs[0]);
  assert.equal((await readdir(root)).some(name => name.startsWith('.timeline-render-')), false);
});

test('speed export keeps exact PTS and continuous PCM across sixty-four one-frame segments', {timeout: 120_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-speed-render-clock-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const asset = await sourceAsset(root), assets = new Map([[asset.id, asset]]);
  const {plan, timing} = motion(0, 32, 1, 2);
  const trackId = randomUUID(), hiddenTrackId = randomUUID(), at = '2026-01-01T00:00:00.000Z';
  const geometry = {rect: {x: 0, y: 0, width: 720, height: 720}, gain: 1};
  const timed = {id: randomUUID(), trackId, assetId: asset.id, ...geometry, startFrame: 0, sourceInFrame: 0,
    durationFrames: plan.durationFrames, timing};
  const projected = {...timed, ...unwrap(projectTimeMapToCurrentClipFields(timed, plan))};
  // The hidden lane contributes a boundary each frame without consuming media.
  // Each segment's individually rounded 33333 µs would lose 21 µs after 63 boundaries.
  const boundaryClips = Array.from({length: plan.durationFrames}, (_, startFrame) => ({id: randomUUID(),
    trackId: hiddenTrackId, assetId: asset.id, ...geometry, startFrame, sourceInFrame: 0, durationFrames: 1}));
  const timeline: TimelineRecord = {id: randomUUID(), projectId: randomUUID(), revision: 1, fps: 30,
    width: 720, height: 720, durationFrames: plan.durationFrames, clips: [projected, ...boundaryClips],
    tracks: [{id: trackId, kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: hiddenTrackId, kind: 'video', orderIndex: 1, hidden: true, muted: true}], createdAt: at, updatedAt: at};
  const snapshot = {...freezeTimelineSnapshot(timeline, assets, undefined), ...timelineSpeedExportSnapshotFields(timeline)};
  const output = path.join(root, 'long-boundaries.mp4'), plannedFrames = [...unwrap(timeMapPlanFrames(plan))];
  const progress: number[] = [];
  await renderTimeline(snapshot, assets, output, {segmentConcurrency: 4,
    onSegmentProgress(completedFrames) { progress.push(completedFrames); }});
  assert.deepEqual(progress, plannedFrames.map((_, index) => index + 1));
  const observed = await readMedia(output, plannedFrames.length);
  assert.deepEqual(observed.pts, plannedFrames.map((_, index) => index * 1000));
  assertMarkers(observed.luma, plannedFrames);
  const referenceTimeline = {...timeline, clips: [projected], tracks: timeline.tracks.slice(0, 1)};
  const reference = path.join(root, 'single-segment.mp4');
  await renderTimeline({...freezeTimelineSnapshot(referenceTimeline, assets, undefined),
    ...timelineSpeedExportSnapshotFields(referenceTimeline)}, assets, reference);
  const referencePcm = (await readMedia(reference, plannedFrames.length)).pcm;
  assert.ok(rms(referencePcm, 1600, 3200) > 0.03, 'the continuous PCM is audible');
  assert.deepEqual(observed.pcm, referencePcm);
});

test('a selected dissolve renders the correct motion handles on each side of the cut', {timeout: 30_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-speed-render-handles-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const {assets, timeline} = fixture(await sourceAsset(root));
  const [outgoing, incoming] = timeline.clips;
  assert.ok(outgoing && incoming);
  const right = motion(24, 36, 3, 2);
  const transitionIn = {profileId: CLIP_TRANSITION_PROFILE, kind: 'dissolve', durationFrames: 4} as const;
  const retimedIncoming = {...incoming, ...unwrap(projectTimeMapToCurrentClipFields({...incoming}, right.plan)),
    timing: right.timing, transitionIn};
  const outputTimeline: TimelineRecord = {...timeline, durationFrames: 16,
    tracks: timeline.tracks.map(track => ({...track, muted: true})),
    clips: [outgoing, retimedIncoming]};
  const snapshot = {...freezeTimelineSnapshot(outputTimeline, assets, undefined, {exportRange: {startFrame: 4, endFrame: 12}}),
    ...timelineSpeedExportSnapshotFields(outputTimeline)};
  const output = path.join(root, 'handles.mp4');
  await renderTimeline(snapshot, assets, output, {segmentConcurrency: 4});
  const observed = await readMedia(output, 8);
  assert.deepEqual(observed.pts, [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
  // Cut at frame 8: the incoming handle uses source 21 and 22, and the outgoing
  // handle uses source 16 and 18. Check the composed samples against the
  // arithmetic for the four dissolve weights (0, 1/4, 1/2, 3/4).
  const expected = [8, 10, 12, 0.75 * 14 + 0.25 * 22, 0.5 * 16 + 0.5 * 24, 0.25 * 18 + 0.75 * 25, 27, 28];
  for (const [index, sourceFrame] of expected.entries()) {
    assert.ok(Math.abs(observed.luma[index]! - marker(sourceFrame)) <= 3,
      `dissolve output frame ${index} should show source marker ${sourceFrame} (luma ${observed.luma[index]})`);
  }
});

test('cancelling a speed export before its first encoder leaves no output or staging', {timeout: 30_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-speed-render-abort-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const {assets, snapshot} = fixture(await sourceAsset(root));
  const controller = new AbortController(), output = path.join(root, 'cancelled.mp4');
  let starts = 0;
  await assert.rejects(renderTimeline(snapshot, assets, output, {signal: controller.signal,
    beforeStart() { starts++; controller.abort(); }}), {code: 'MEDIA_CANCELLED'});
  assert.equal(starts, 1);
  const files = await readdir(root);
  assert.equal(files.includes(path.basename(output)), false);
  assert.equal(files.some(name => name.startsWith('.timeline-render-')), false);
});

test('replacement of a verified speed source at staging prevents final output', {timeout: 30_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-speed-render-source-')), workspace = path.join(root, 'workspace');
  const store = openStore(workspace) as TypedStore, services = createServices(store, new Map()) as TypedServices;
  t.after(async () => { await services.drain(); store.close(); await rm(root, {recursive: true, force: true}); });
  const source = await sourceAsset(root), bytes = await readFile(source.path);
  const project = await services.call('project.create', {name: 'Speed render source race'});
  const imported = await services.call('asset.import', {projectId: project.id, name: 'Synthetic source.mp4',
    mimeType: source.mimeType, dataBase64: bytes.toString('base64')});
  await prepareProjectAssetFullHash(workspace, imported.id);
  const readAsset = (id: string) => {
    const asset = readOwnedTimelineAsset(store.db, project.id, id);
    return asset && {...asset, duration: asset.duration ?? null};
  };
  const saved = readAsset(imported.id);
  assert.ok(saved);
  assert.equal(saved.sha256, source.sha256);
  const file = mediaFixturePath(workspace, saved);
  const {snapshot} = fixture({...source, ...mediaLocatorFields(saved), id: saved.id, path: file,
    relativePath: saved.relativePath ?? source.relativePath}, project.id);
  const prepared = await prepareTimelineInputs(snapshot, {root: workspace, projectId: project.id, readAsset});
  assert.ok(prepared.get(imported.id)?.speedSourceIdentity);
  let replaced = false;
  const output = path.join(root, 'source-race.mp4');
  const beforeEffect = () => validatePreparedTimelineSources(store.db, project.id, snapshot, prepared, {root: workspace});
  await assert.rejects(renderTimeline(snapshot, prepared, output, {beforeEffect, beforeStart() {
    assert.equal(replaced, false);
    writeFileSync(file + '.replacement', bytes, {flag: 'wx', mode: 0o600});
    renameSync(file + '.replacement', file);
    replaced = true;
  }}), {code: 'TIMELINE_SOURCE_UNAVAILABLE'});
  assert.equal(replaced, true);
  const files = await readdir(root);
  assert.equal(files.includes(path.basename(output)), false);
  assert.equal(files.some(name => name.startsWith('.timeline-render-')), false);
  assert.deepEqual(await readFile(file), bytes);
});
