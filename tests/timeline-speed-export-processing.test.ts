import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {run, runStreaming} from '../packages/business/src/media-runtime.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {REVERSE_PROXY_PROFILE} from '../packages/business/src/timeline-processing/reverse.ts';
import {processingApplication} from '../packages/business/src/timeline-processing/scheduler.ts';
import {createClient} from '../packages/client/src/index.ts';
import {assetMediaDtoSchema, assetMediaPrepareResponseSchema} from '../packages/contracts/src/asset-media.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {projectMediaPath} from '../packages/contracts/src/project-file.ts';
import {PROJECT_OUTPUT_FOLDERS} from '../packages/contracts/src/project-output-publication.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import {compileClipTimeMap} from '../packages/contracts/src/timeline-clip-timing.ts';
import {SPEED_PROCESSING_NOT_READY, timelineSpeedExportSnapshotSchema} from '../packages/contracts/src/timeline-speed-export.ts';
import type {SpeedProcessingItem} from '../packages/contracts/src/timeline-speed.ts';
import {timeMapPlanFrames} from '../packages/contracts/src/timeline-time-map.ts';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS} from '../packages/contracts/src/index.ts';
import {projectDirFor} from './helpers/project-database.ts';
import {startServer, type InspectApplication, type InspectProject} from './helpers/test-server.ts';

const frames = 68, size = 32;
const luma = (frame: number) => 25 + 3 * frame;
const limits = {timeout: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 65_536};

async function source(root: string) {
  const raw = path.join(root, 'markers.yuv'), file = path.join(root, 'source.mp4');
  const chroma = Buffer.alloc(size * size / 2, 128);
  await writeFile(raw, Buffer.concat(Array.from({length: frames}, (_, frame) =>
    Buffer.concat([Buffer.alloc(size * size, luma(frame)), chroma]))));
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-video_size', `${size}x${size}`, '-framerate', '30', '-i', raw, '-f', 'lavfi', '-i',
    "aevalsrc=exprs='0.15*sin(2*PI*if(lt(t,1.133333),370,930)*t)':s=44100:d=2.266667",
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-threads:v', '1',
    '-video_track_timescale', '30000', '-c:a', 'aac', file], limits);
  return readFile(file);
}

async function capture(file: string, args: string[], maxStdoutBytes: number) {
  const chunks: Buffer[] = [];
  await runStreaming('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, ...args, 'pipe:1'],
    {...limits, maxStdoutBytes, onStdout(chunk) { chunks.push(chunk); }});
  return Buffer.concat(chunks);
}

function frequency(pcm: Buffer, from: number, to: number) {
  let last = 0, rising = 0;
  for (let sample = from * 48_000; sample < to * 48_000; sample++) {
    const value = pcm.readFloatLE(sample * 8);
    if (value > 0 && last <= 0) rising++;
    last = value;
  }
  return rising / (to - from);
}

test('hosted reverse export keeps the original task and consumes its published video and PCM after reopen',
  {timeout: 120_000}, async t => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-reverse-export-'));
    const dataDir = path.join(root, 'app'), cacheDir = path.join(root, 'cache');
    const priorFlag = process.env.MIOON_FORMAT6_DEV;
    process.env.MIOON_FORMAT6_DEV = '1';
    const hold = Promise.withResolvers<void>(), occupied = Promise.withResolvers<void>();
    let blocker: Promise<void> | undefined, backend: Awaited<ReturnType<typeof startServer>> | undefined;
    let inspectApp!: InspectApplication, inspectProject!: InspectProject;
    t.after(async () => {
      hold.resolve(); await blocker;
      try { await backend?.close(); }
      finally {
        if (priorFlag === undefined) delete process.env.MIOON_FORMAT6_DEV;
        else process.env.MIOON_FORMAT6_DEV = priorFlag;
        await rm(root, {recursive: true, force: true});
      }
    });
    async function open() {
      backend = await startServer({dataDir, cacheDir, port: 0, comfyModule: 'skip', localDraftChannel: 'development',
        projectFormatForTest: undefined, inspectApplication: read => { inspectApp = read; },
        inspectProject: read => { inspectProject = read; }});
      return createClient({env: {MIOON_BASE_URL: backend.url, MIOON_TOKEN: backend.token}}).rpc;
    }
    const input = await source(root);
    let rpc = await open();
    const {id: projectId} = await rpc<{id: string}>('project.create', {name: 'Synthetic reverse export'});
    const project = async () => rpc<{projectFormatVersion: number; timeline: Format5Timeline}>('project.get', {projectId});
    assert.equal((await project()).projectFormatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
    const imported = assetMediaDtoSchema.parse(await rpc('asset.import', {projectId,
      name: 'Synthetic source.mp4', mimeType: 'video/mp4', dataBase64: input.toString('base64')}));
    const assetId = imported.id;
    // Timeline placement prepares its media identity before editing the clip.
    const prepared = assetMediaPrepareResponseSchema.parse(await rpc('asset.media.prepare', {projectId, purpose: 'timeline',
      assets: [{assetId, referenceRevision: imported.referenceRevision}]}));
    assert.equal(prepared.assets[0]?.hashState, 'full');
    async function apply(operation: string, intent: Record<string, unknown>) {
      const plan = await rpc<{envelope: SequenceEditEnvelope; planDigest: string}>(operation, {projectId, ...intent});
      const receipt = await rpc<{status: string}>('sequence.action.commit', {
        projectId, envelope: plan.envelope, expectedPlanDigest: plan.planDigest,
      });
      assert.equal(receipt.status, 'applied');
    }
    await apply('sequence.board.edit', {kind: 'board-root-create', name: 'Synthetic sequence', position: {x: 0, y: 0}});
    await apply('sequence.timeline.edit', {kind: 'insert-asset', assetId, trackId: null, startFrame: 0});
    const placed = (await project()).timeline.clips[0];
    assert.equal(placed?.durationFrames, frames);
    const clipId = placed!.id;

    // Occupy the production scheduler slot so querying the real task cannot race its producer.
    const scheduler = inspectApp(db => processingApplication(db, cacheDir).scheduler);
    blocker = scheduler.schedule(new AbortController().signal, async () => { occupied.resolve(); await hold.promise; });
    await occupied.promise;
    await apply('sequence.timeline.edit', {kind: 'clip-speed', clipId, setting: {
      speed: {kind: 'constant', rate: {numerator: 2, denominator: 1}}, direction: 'reverse', pitchShift: false, interpolation: 'off',
    }});
    const {timeline} = await project(), clip = timeline.clips[0]!;
    const map = compileClipTimeMap(clip, timeline);
    assert.ok(map.ok);
    const compiled = timeMapPlanFrames(map.value);
    assert.ok(compiled.ok);
    const expected = Array.from(compiled.value);
    assert.deepEqual(expected, Array.from({length: frames / 2}, (_, output) => frames - 1 - 2 * output));
    const {items} = await rpc<{items: SpeedProcessingItem[]}>('timeline.processing.list', {projectId});
    assert.equal(items.length, 1);
    const task = items[0]!;
    assert.deepEqual({clipId: task.clipId, status: task.status, kind: task.kind}, {clipId, status: 'queued', kind: 'reverse'});
    const base = {projectId, expectedRevision: timeline.revision,
      exportSettings: {...TIMELINE_EXPORT_DEFAULT_SETTINGS, resolution: 'short_360'}};
    const render = {...base, requestId: randomUUID(), purpose: 'export'};
    const projectDir = projectDirFor(dataDir, projectId);
    const pending = await rpc<{status: string; issues: {code: string; clipId?: string; taskId?: string}[]}>('timeline.export.preflight', base);
    assert.equal(pending.status, 'blocked');
    assert.equal(pending.issues.length, 1);
    assert.equal(pending.issues[0]?.code, SPEED_PROCESSING_NOT_READY, JSON.stringify(pending));
    assert.equal(pending.issues[0]?.clipId, clipId);
    assert.equal(pending.issues[0]?.taskId, task.taskId);
    await assert.rejects(rpc('timeline.render', render), error => {
      assert.ok(error instanceof Error && 'code' in error && 'details' in error);
      assert.equal(error.code, SPEED_PROCESSING_NOT_READY);
      assert.equal((error.details as {taskId?: string}).taskId, task.taskId);
      return true;
    });
    assert.equal(inspectProject(projectId, db => db.prepare('SELECT count(*) AS n FROM exports').get()?.n), 0);
    const outputFiles = (await readdir(projectDir, {recursive: true}))
      .filter(name => name.startsWith(PROJECT_OUTPUT_FOLDERS.exports + path.sep));
    assert.deepEqual(outputFiles, []);

    hold.resolve(); await blocker;
    const finished = await rpc<{item: SpeedProcessingItem; timedOut: boolean}>('timeline.processing.wait',
      {projectId, taskId: task.taskId, timeoutMs: 30_000});
    assert.equal(finished.timedOut, false);
    assert.deepEqual(finished.item, {...task, status: 'ready'});
    await backend!.close();
    backend = undefined;
    rpc = await open();
    const reopened = await rpc<{items: SpeedProcessingItem[]}>('timeline.processing.list', {projectId});
    assert.deepEqual(reopened.items, [finished.item]);
    const taskResult = inspectProject(projectId, db =>
      db.prepare('SELECT result FROM main.timeline_processing_tasks WHERE id=?').get(task.taskId)?.result);
    assert.equal(typeof taskResult, 'string');
    const {cacheKey} = JSON.parse(String(taskResult)) as {cacheKey: string};
    const entry = inspectApp(db => processingApplication(db, cacheDir).cache.lookupWithClock(projectId, cacheKey, REVERSE_PROXY_PROFILE));
    assert.ok(entry);
    assert.equal(entry.entry.result.frameCount, expected[0]! - expected.at(-1)! + 1);
    assert.ok(entry.entry.result.files.some(file => file.fileName === 'proxy.mkv'));

    const checked = await rpc<{status: string; snapshotHash: string}>('timeline.export.preflight', base);
    assert.equal(checked.status, 'ready', JSON.stringify(checked));
    const queued = await rpc<{id: string; status: string}>('timeline.render',
      {...render, requestId: randomUUID(), preflightSnapshotHash: checked.snapshotHash});
    assert.equal(queued.status, 'queued');
    const snapshot = inspectProject(projectId, db => db.prepare('SELECT data FROM exports WHERE id=?').get(queued.id)?.data);
    assert.equal(typeof snapshot, 'string');
    const proof = timelineSpeedExportSnapshotSchema.parse(JSON.parse(String(snapshot)).snapshot.speedExport);
    assert.deepEqual(proof.clips, [{clipId, mapHash: map.value.root.mapHash, proxy: {taskId: task.taskId, sha256: entry.digest}}]);
    let record: {status: string; assetId?: string; error?: unknown} | undefined;
    const end = Date.now() + 40_000;
    while (Date.now() < end) {
      record = await rpc('export.get', {exportId: queued.id}, {projectId});
      if (record?.status === 'succeeded' || record?.status === 'failed') break;
      await delay(40);
    }
    assert.equal(record?.status, 'succeeded', JSON.stringify(record?.error));
    assert.ok(record?.assetId);
    const response = await fetch(backend!.url + projectMediaPath(projectId, record.assetId), {
      headers: {authorization: `Bearer ${backend!.token}`}, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const output = path.join(root, 'delivery.mp4');
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    const video = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=time_base:packet=pts', '-of', 'json', output], limits)) as {streams: {time_base: string}[]; packets: {pts: number}[]};
    assert.equal(video.streams[0]?.time_base, '1/30000');
    assert.deepEqual(video.packets.map(item => item.pts).sort((a, b) => a - b), expected.map((_, frame) => frame * 1000));
    const pixels = await capture(output, ['-an', '-vf', 'crop=2:2:(iw-2)/2:(ih-2)/2', '-threads', '1',
      '-pix_fmt', 'yuv420p', '-f', 'rawvideo'], expected.length * 6);
    assert.equal(pixels.length, expected.length * 6);
    for (const [index, frame] of expected.entries()) {
      assert.ok(Math.abs(pixels.readUInt8(index * 6) - luma(frame)) <= 2, `frame ${index} must show source ${frame}`);
    }
    const audio = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
      'stream=sample_rate,time_base,duration_ts,channels', '-of', 'json', output], limits)) as {streams: unknown[]};
    const samples = expected.length * 1600;
    assert.deepEqual(audio.streams, [{sample_rate: '48000', channels: 2, time_base: '1/48000', duration_ts: samples}]);
    const pcm = await capture(output, ['-vn', '-c:a', 'pcm_f32le', '-f', 'f32le'], (samples + 1024) * 8);
    const firstTone = frequency(pcm, 0.2, 0.4), lastTone = frequency(pcm, 0.7, 0.9);
    assert.ok(Math.abs(firstTone - 930) < 15, 'the source tail plays first at its original pitch');
    assert.ok(Math.abs(lastTone - 370) < 15, 'the source head plays last at its original pitch');
    t.diagnostic(`${entry.entry.result.frameCount} proxy frames, ${expected.length} exact output ordinals/PTS, ${samples} output samples, ${firstTone.toFixed(1)} Hz → ${lastTone.toFixed(1)} Hz`);
  });
