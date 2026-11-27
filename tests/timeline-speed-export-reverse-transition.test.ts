import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {probe} from '../packages/business/src/media.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {referenceForPublishedMedia, registerProjectMediaStore} from '../packages/business/src/project-media-storage.ts';
import {freezeTimelineSnapshot, type TimelineClipRecord, type TimelineRecord} from '../packages/business/src/timeline-inputs.ts';
import {renderTimeline} from '../packages/business/src/timeline-media.ts';
import {createProcessingCache} from '../packages/business/src/timeline-processing/cache.ts';
import {createProcessingScheduler} from '../packages/business/src/timeline-processing/scheduler.ts';
import {createTimelineProcessingService} from '../packages/business/src/timeline-processing/service.ts';
import {timelineSpeedExportLayout} from '../packages/business/src/timeline-speed-export-admission.ts';
import {freezeTimelineReverseProxies} from '../packages/business/src/timeline-speed-export-proxy.ts';
import {CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {timelineSpeedExportSnapshotFields} from '../packages/contracts/src/timeline-speed-export.ts';
import {compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields,
  type TimeMapBasis, type TimeMapResult, type TimeMapSourceBoundary} from '../packages/contracts/src/timeline-time-map.ts';

const fps = 30, samplesPerFrame = 1600, sourceFrames = 44, audioPeriod = 80;
const timebase = {fpsNumerator: fps, fpsDenominator: 1};
const at = '2026-01-01T00:00:00.000Z';
const mark = (frame: number) => 18 + 5 * frame;
const amplitude = (frame: number) => 0.08 + 0.008 * frame;
const toolLimits = {timeout: 30_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024};

function value<T>(result: TimeMapResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

async function sourceFile(directory: string) {
  const video = path.join(directory, 'reverse-transition.mp4'), audio = path.join(directory, 'source.f32');
  const count = sourceFrames * samplesPerFrame;
  const pcm = Buffer.alloc(count * 8);
  for (let sample = 0; sample < count; sample++) {
    const mark = amplitude(Math.floor(sample / samplesPerFrame)) * Math.sin(2 * Math.PI * sample / audioPeriod);
    pcm.writeFloatLE(mark, sample * 8);
    pcm.writeFloatLE(-mark, sample * 8 + 4);
  }
  await writeFile(audio, pcm, {mode: 0o600});
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-filter_threads', '1', '-f', 'lavfi', '-i',
    `nullsrc=s=48x48:r=${fps},format=yuv420p,geq=lum='${mark(0)}+N*${mark(1) - mark(0)}':cb=128:cr=128`,
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
    '-frames:v', String(sourceFrames), '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-bf', '0',
    '-threads:v', '1', '-video_track_timescale', '30000', '-c:a', 'pcm_f32le', video], toolLimits);
  return video;
}

function reverseClip(trackId: string, assetId: string, startFrame: number, sourceStart: number, sourceEnd: number, rate: number) {
  const boundary = (frame: number): TimeMapSourceBoundary => ({kind: 'rational', numerator: String(frame), denominator: '1'});
  const basis: TimeMapBasis = {profile: 'timeline-speed-v1', sourceFps: timebase, outputFps: timebase,
    sourceRange: {start: boundary(sourceStart), end: boundary(sourceEnd)}, speed: {kind: 'constant', rate: {numerator: rate, denominator: 1}}};
  const plan = initialTimeMap(value(compileTimeMap(basis)), 'reverse');
  const timing: ClipTiming = {profile: 'timeline-speed-v1', basis, pitchShift: true, interpolation: 'off',
    view: {direction: 'reverse', loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
    outputWindow: plan.outputWindow};
  const clip = {id: randomUUID(), name: `Reverse ${rate}×`, trackId, assetId, startFrame, durationFrames: plan.durationFrames,
    sourceInFrame: sourceStart, rect: {x: 0, y: 0, width: 720, height: 720}, gain: 1, timing} satisfies TimelineClipRecord;
  return {...clip, ...value(projectTimeMapToCurrentClipFields(clip, plan)), sourceState: 'ready' as const, anchor: null};
}

async function capture(file: string, args: string[], maxStdoutBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await runStreaming('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, ...args, 'pipe:1'],
    {...toolLimits, maxStdoutBytes, onStdout: chunk => {chunks.push(chunk);}});
  return Buffer.concat(chunks);
}

async function assertMedia(file: string, selected: {startFrame: number; endFrame: number}) {
  const {startFrame, endFrame} = selected, frames = endFrame - startFrame;
  const clock = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries',
    'stream=time_base,duration_ts:packet=stream_index,pts', '-of', 'json', file], toolLimits)) as {
      streams: {time_base: string; duration_ts: number}[];
      packets: {stream_index: number; pts: number}[];
    };
  assert.equal(clock.streams[0]?.time_base, '1/30000');
  assert.deepEqual(clock.packets.filter(packet => packet.stream_index === 0)
    .map(packet => packet.pts), Array.from({length: frames}, (_, index) => index * 1000));
  assert.equal(clock.streams[1]?.time_base, '1/48000');
  assert.equal(clock.streams[1]?.duration_ts, frames * samplesPerFrame);

  const rawPicture = await capture(file, ['-an', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2',
    '-threads:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo'], frames * 6);
  assert.equal(rawPicture.length, frames * 6);
  // At the cut, the outgoing tail must show 25/23 and the incoming lead-in
  // must show 17/16. These are outside each reverse clip's visible window.
  const markers = [41, 39, 37, 35, 33, 31, 29, 0.75 * 27 + 0.25 * 16, 0.5 * 25 + 0.5 * 15,
    0.25 * 23 + 0.75 * 14, 13, 12, 11, 10, 9, 8];
  for (let frame = startFrame; frame < endFrame; frame++) {
    const actual = rawPicture[(frame - startFrame) * 6]!;
    assert.ok(Math.abs(actual - mark(markers[frame]!)) <= 3, `picture frame ${frame}: ${actual} vs ${mark(markers[frame]!)}`);
  }

  const rawAudio = await capture(file, ['-vn', '-c:a', 'pcm_f32le', '-f', 'f32le'], (frames * samplesPerFrame + 1024) * 8);
  assert.ok(rawAudio.length >= frames * samplesPerFrame * 8);
  for (let frame = startFrame; frame < endFrame; frame++) {
    const index = (frame - startFrame) * samplesPerFrame;
    const from = index + 320, to = index + 1280;
    let energy = 0, crossings = 0, previous = rawAudio.readFloatLE(from * 8);
    for (let sample = from; sample < to; sample++) {
      const left = rawAudio.readFloatLE(sample * 8);
      crossings += Number(left * previous < 0);
      energy += left ** 2;
      previous = left;
    }
    // The picture handles do not extend the audio cut. Interior samples in
    // the outgoing 2× clip traverse two source amplitudes and double pitch.
    const first = frame < 8 ? 41 - 2 * frame : 23 - frame;
    const second = frame < 8 ? first - 1 : first;
    const expectedRms = Math.sqrt((amplitude(first) ** 2 + amplitude(second) ** 2) / 4);
    const expectedCrossings = frame < 8 ? 48 : 24;
    assert.ok(Math.abs(crossings - expectedCrossings) <= 3, `audio frame ${frame}: ${crossings} zero crossings`);
    assert.ok(Math.abs(Math.sqrt(energy / (to - from)) - expectedRms) <= 0.023,
      `audio frame ${frame}: wrong source amplitude ${Math.sqrt(energy / (to - from))} vs ${expectedRms}`);
  }
}

test('a reverse dissolve uses real SP-P picture handles and the original audio cut in full and selected exports',
  {timeout: 120_000}, async t => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-reverse-transition-'));
    const projectId = randomUUID(), mainTrackId = randomUUID(), trackId = randomUUID(), rootId = randomUUID();
    const store = createProjectStore({projectId, projectFile: path.join(root, 'project.mioon'), allowFormat6: true,
      targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION, locate: () => ({localDir: path.join(root, 'local'),
        cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
    const unregister = registerProjectMediaStore(store);
    const processing = createTimelineProcessingService(store, {enabled: true, scheduler: createProcessingScheduler(),
      cache: createProcessingCache(path.join(root, 'cache')), beforeEffect: () => {}});
    t.after(async () => {await processing.close(); unregister(); store.close(); await rm(root, {recursive: true, force: true});});
    const media = path.join(root, 'media');
    await mkdir(media, {mode: 0o700});
    const source = await sourceFile(media), assetId = randomUUID();
    const evidence = await referenceForPublishedMedia(store, source);
    const asset = {...await probe(source), ...evidence, id: assetId, projectId, mimeType: 'video/mp4',
      name: path.basename(source), path: source, createdAt: at};
    const outgoing = reverseClip(trackId, assetId, 0, 26, 42, 2);
    const incoming = {...reverseClip(trackId, assetId, 8, 8, 16, 1),
      transitionIn: {profileId: CLIP_TRANSITION_PROFILE, kind: 'dissolve', durationFrames: 4} as const};
    const timeline = {id: randomUUID(), projectId, revision: 1, width: 720, height: 720, fps, durationFrames: 16,
      createdAt: at, updatedAt: at, mainTrack: {trackId: mainTrackId, sequenceNodeId: rootId},
      tracks: [{id: mainTrackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false},
        {id: trackId, name: 'V2', kind: 'video', orderIndex: 1, hidden: false, muted: false}],
      clips: [outgoing, incoming]} satisfies TimelineRecord & {mainTrack: object};
    store.tx(() => {
      store.put('projects', {id: projectId, name: 'Reverse transition', createdAt: at, updatedAt: at, revision: 1});
      store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Timeline', position: {x: 0, y: 0}, createdAt: at});
      const {path: _path, probe: _probe, ...saved} = asset;
      store.put('assets', saved);
      store.put('timelines', timeline);
      store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
        .run(timeline.id, projectId, rootId, 1, JSON.stringify({version: 1, board: [], track: []}));
    });
    processing.activate();
    await Promise.resolve(); // Activation reconciles committed demands in a microtask.
    const tasks = processing.list({projectId}).items.filter(item => item.kind === 'reverse');
    assert.equal(tasks.length, 2);
    const outcomes = await Promise.all(tasks.map(({taskId}) => processing.wait({projectId, taskId, timeoutMs: 60_000})));
    assert.ok(outcomes.every(({item}) => item.status === 'ready'), JSON.stringify(outcomes));
    const assets = new Map([[assetId, asset]]), {reverseProxy} = processing;
    const {mainTrack: _mainTrack, ...renderTimelineRecord} = timeline;
    for (const exportRange of [{startFrame: 0, endFrame: 16}, {startFrame: 4, endFrame: 12}]) {
      const base = freezeTimelineSnapshot(renderTimelineRecord, assets, undefined, {exportRange});
      const layout = timelineSpeedExportLayout({...base, ...timelineSpeedExportSnapshotFields(timeline)}, assets);
      assert.ok(layout);
      const proofs = freezeTimelineReverseProxies(base, layout, assets, reverseProxy);
      for (const task of tasks) assert.equal(proofs.get(task.clipId)?.taskId, task.taskId);
      const output = path.join(root, `output-${exportRange.startFrame}.mp4`);
      await renderTimeline({...base, ...timelineSpeedExportSnapshotFields(timeline, proofs)}, assets, output,
        {reverseProxy, segmentConcurrency: exportRange.startFrame === 0 ? 1 : 4});
      await assertMedia(output, exportRange);
    }
  });
