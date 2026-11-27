import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {previewMioSequenceAction} from '../packages/business/src/format5-mio-sequence.ts';
import {previewSequenceSpeed} from '../packages/business/src/format5-sequence-sync.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import {projectMediaPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {sequenceEditEnvelopeSchema} from '../packages/contracts/src/sequence-edit.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import {TIMELINE_EXPORT_DEFAULT_SETTINGS} from '../packages/contracts/src/timeline-export-profile.ts';
import {compileInterpolationPhase} from '../packages/contracts/src/timeline-interpolation.ts';
import type {SequenceEditSpeedIntent, SpeedSetting} from '../packages/contracts/src/timeline-speed.ts';
import {compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields} from '../packages/contracts/src/timeline-time-map.ts';
import type {CompiledTimeMap, TimeMapSourceBoundary} from '../packages/contracts/src/timeline-time-map.ts';
import {projectDatabasePath, projectDirFor} from './helpers/project-database.ts';
import {startServer} from './helpers/test-server.ts';
import type {InspectProject} from './helpers/test-server.ts';

const cases = [
  {sourceFps: 24, eligible: 45, rejected: 22}, {sourceFps: 25, eligible: 45, rejected: 22},
  {sourceFps: 30, eligible: 27, rejected: 22}, {sourceFps: 60, eligible: 22, rejected: 5},
];
const fps = {fpsNumerator: 30, fpsDenominator: 1};
const exportSettings = {...TIMELINE_EXPORT_DEFAULT_SETTINGS, resolution: 'short_360'} as const;
const errorCode = 'INTERPOLATION_UNAVAILABLE';
const boundary = (frame: number): TimeMapSourceBoundary => ({kind: 'rational', numerator: String(frame), denominator: '1'});
type SpeedOperation = Extract<SequenceEditSpeedIntent['operation'], {kind: 'clip-speed'}>;
type Plan = {envelope: SequenceEditEnvelope; planDigest: string};
type PhaseIssue = {code: string; clipId?: string};
type ExportPreflight = {status: 'ready' | 'blocked'; snapshotHash: string; issues: PhaseIssue[]};
type Project = {projectFormatVersion: number; timeline: Format5Timeline; assets: {id: string; referenceRevision: number}[]};
type Wire<T> = {http: number} & ({ok: true; data: T} | {ok: false; error: {code: string; details?: {ids?: string[]; clipId?: string}}});
type Properties = Plan | {ok: false; code: string; ids: string[]};

async function sourceVideo(directory: string, sourceFps: number, pixel = 'yuv420p') {
  const file = path.join(directory, 'source.mp4');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-filter_threads', '1', '-noauto_conversion_filters',
    '-f', 'lavfi', '-i', `testsrc2=s=64x64:r=${sourceFps},format=${pixel}`, '-c:v', 'libx264', '-threads:v', '1',
    '-preset', 'ultrafast', '-qp', '0', '-bf', '0', '-pix_fmt', '+' + pixel, '-frames:v', String(2 * sourceFps),
    '-video_track_timescale', '30000', file]);
  const output = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_streams',
    '-show_entries', 'frame=best_effort_timestamp:stream=time_base,r_frame_rate,nb_frames,duration,pix_fmt', '-of', 'json', file]);
  const {streams: [stream], frames} = JSON.parse(output) as {
    streams: {pix_fmt: string; time_base: string; r_frame_rate: string; nb_frames: string; duration: string}[];
    frames: {best_effort_timestamp: number}[];
  };
  assert.equal(stream?.pix_fmt, pixel);
  assert.equal(stream.time_base, '1/30000');
  assert.equal(stream.r_frame_rate, `${sourceFps}/1`);
  assert.equal(Number(stream.nb_frames), 2 * sourceFps);
  assert.equal(Number(stream.duration), 2);
  assert.equal(frames.length, 2 * sourceFps);
  return {file, clock: {positions: frames.map(frame => frame.best_effort_timestamp / 1000), end: 60}};
}

function editSpeed(durationFrames: number, clipId: string): SpeedOperation {
  const setting: SpeedSetting = {direction: 'forward', pitchShift: false, interpolation: 'blend', speed: {
    kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'analytic-control-points', points: [
      {sourceFrame: 0, rate: {numerator: 1, denominator: 4}}, {sourceFrame: durationFrames, rate: {numerator: 2, denominator: 1}},
    ],
  }};
  return {kind: 'clip-speed', clipId, setting};
}

function phaseOf(durationFrames: number, source: Awaited<ReturnType<typeof sourceVideo>>) {
  const root = compileTimeMap({profile: 'timeline-speed-v1', sourceFps: fps, outputFps: fps,
    speed: editSpeed(durationFrames, '').setting.speed,
    sourceRange: {start: boundary(0), end: boundary(durationFrames)}});
  assert.ok(root.ok, JSON.stringify(root));
  const plan = initialTimeMap(root.value);
  const phase = compileInterpolationPhase(plan, source.clock);
  assert.ok(phase.ok, JSON.stringify(phase));
  return {plan, ...phase.value};
}

async function host(t: test.TestContext, directory: string) {
  const dataDir = path.join(directory, 'app');
  let inspect!: InspectProject;
  const start = () => startServer({dataDir, port: 0, comfyModule: 'skip', localDraftChannel: 'development', projectFormatForTest: undefined,
    inspectProject: read => {inspect = read;}});
  let server: Awaited<ReturnType<typeof start>> | undefined = await start();
  t.after(async () => {
    try {await server?.close();}
    finally {await rm(directory, {force: true, recursive: true});}
  });
  function backend() {
    assert.ok(server);
    return server;
  }
  async function wire<T>(projectId: string | null, operation: string, input: Record<string, unknown>): Promise<Wire<T>> {
    const current = backend();
    const response = await fetch(current.url + (projectId ? projectRpcPath(projectId) : '/api/rpc'), {method: 'POST',
      headers: {authorization: 'Bearer ' + current.token, 'content-type': 'application/json'}, signal: AbortSignal.timeout(35_000),
      body: JSON.stringify({operation, input})});
    return {http: response.status, ...await response.json()} as Wire<T>;
  }
  async function call<T>(projectId: string | null, operation: string, input: Record<string, unknown>): Promise<T> {
    const response = await wire<T>(projectId, operation, input);
    assert.ok(response.ok, JSON.stringify({operation, response}));
    return response.data;
  }
  return {
    call, wire,
    async offline<T>(projectId: string, work: (store: ProjectStore) => T): Promise<T> {
      const file = projectDatabasePath(projectDirFor(dataDir, projectId));
      await backend().close();
      server = undefined;
      const store = openProjectStore({projectFile: file, allowFormat6: true, locate: id => projectLocation(serverAppDirectories(dataDir), id)});
      let result: T;
      try {result = work(store);}
      finally {store.close();}
      server = await start();
      return result;
    },
    inspect<T>(projectId: string, callback: (db: DatabaseSync) => T) {return inspect(projectId, callback);},
    async media(projectId: string, assetId: string) {
      const current = backend();
      const response = await fetch(current.url + projectMediaPath(projectId, assetId),
        {headers: {authorization: 'Bearer ' + current.token}, signal: AbortSignal.timeout(25_000)});
      assert.equal(response.status, 200);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

type Host = Awaited<ReturnType<typeof host>>;
async function seeded(server: Host, file: string, durationFrames: number) {
  const {id: projectId} = await server.call<{id: string}>(null, 'project.create', {name: 'Synthetic interpolation', timelinePresetId: 'square_1080'});
  const wire = <T>(op: string, input: Record<string, unknown> = {}) => server.wire<T>(projectId, op, {projectId, ...input});
  const call = <T>(op: string, input: Record<string, unknown> = {}) => server.call<T>(projectId, op, {projectId, ...input});
  const read = () => call<Project>('project.get');
  const imported = await call<{id: string; referenceRevision: number}>('asset.import', {name: path.basename(file), mimeType: 'video/mp4',
    dataBase64: (await readFile(file)).toString('base64')});
  async function commit(op: 'sequence.commit' | 'sequence.action.commit', {envelope, planDigest}: Plan) {
    const receipt = await call<{status: string}>(op, {envelope, expectedPlanDigest: planDigest});
    assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
  }
  await commit('sequence.action.commit', await call<Plan>('sequence.board.edit', {kind: 'board-root-create', name: 'Phase', position: {x: 0, y: 0}}));
  await commit('sequence.action.commit', await call<Plan>('sequence.timeline.edit', {kind: 'insert-asset', assetId: imported.id, trackId: null, startFrame: 0}));
  const project = await read();
  assert.equal(project.projectFormatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  const clip = project.timeline.clips.find(item => item.assetId === imported.id);
  assert.ok(clip && clip.durationFrames > durationFrames);
  const clipId = clip.id;
  const trimmed = await call<Plan>('sequence.preview', {requestId: randomUUID(), intents: [{side: 'timeline',
    operation: {kind: 'track', edit: {kind: 'trim', clipId, durationFrames}}}]});
  await commit('sequence.commit', trimmed);
  assert.equal((await read()).timeline.clips[0]?.durationFrames, durationFrames);
  const prepared = await call<{assets: {hashState: string}[]}>('asset.media.prepare',
    {purpose: 'timeline', assets: [{assetId: imported.id, referenceRevision: imported.referenceRevision}]});
  assert.equal(prepared.assets[0]?.hashState, 'full', 'phase tests start after explicit source preparation');
  return {projectId, clipId, read, call, wire, commit, operation: editSpeed(durationFrames, clipId),
    async snapshot() {
      return {
        timeline: (await read()).timeline, history: await call('sequence.history.get'), tasks: await call('timeline.processing.list'),
        state: server.inspect(projectId, db => ({
          content: db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get(),
          receipts: db.prepare('SELECT count(*) AS n FROM main.editor_requests').get(),
          asset: db.prepare('SELECT data FROM project.assets WHERE id=?').get(imported.id),
          exports: db.prepare('SELECT count(*) AS n FROM main.exports').get()?.n,
        })),
      };
    }};
}

type Seed = Awaited<ReturnType<typeof seeded>>;
const propertyPreview = (project: Seed) => project.call<Properties>('sequence.preview', {requestId: randomUUID(),
  speedIntent: {side: 'timeline', operation: project.operation}});
const groupedPreview = (project: Seed) => project.wire<Plan>('sequence.timeline.edit', project.operation);

function rejected<T>(result: Wire<T>, clipId: string, code = errorCode) {
  assert.equal(result.http, 409, JSON.stringify(result));
  assert.ok(!result.ok);
  assert.equal(result.error.code, code);
  assert.ok(result.error.details?.clipId === clipId || result.error.details?.ids?.includes(clipId), JSON.stringify(result));
}

function stillAdmitted(plan: unknown): asserts plan is Plan {
  assert.ok(typeof plan === 'object' && plan !== null && 'envelope' in plan && 'planDigest' in plan, JSON.stringify(plan));
  assert.ok(sequenceEditEnvelopeSchema.safeParse(plan.envelope).success);
}

async function publishedExport(server: Host, project: Seed, directory: string, durationFrames: number) {
  const timeline = (await project.read()).timeline;
  const input = {expectedRevision: timeline.revision, exportSettings};
  const preflight = await project.call<ExportPreflight>('timeline.export.preflight', input);
  assert.equal(preflight.status, 'ready', JSON.stringify(preflight));
  const capability = await project.call<{issues?: PhaseIssue[]}>('timeline.export.capabilities', input);
  assert.ok(!capability.issues?.some(issue => issue.code === errorCode));
  const {id} = await project.call<{id: string}>('timeline.render', {...input, requestId: randomUUID(), purpose: 'export',
    preflightSnapshotHash: preflight.snapshotHash});
  let assetId: string | undefined;
  const limit = Date.now() + 45_000;
  while (Date.now() < limit) {
    const info = await server.call<{status: string; assetId?: string; error?: unknown}>(project.projectId, 'export.get', {exportId: id});
    if (info.status === 'succeeded') {assetId = info.assetId; break;}
    assert.ok(info.status === 'queued' || info.status === 'running', JSON.stringify(info));
    await delay(40);
  }
  assert.ok(assetId, 'render did not publish its MP4');
  const output = path.join(directory, 'render.mp4');
  await writeFile(output, await server.media(project.projectId, assetId));
  const result = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_streams',
    '-show_entries', 'frame=best_effort_timestamp:stream=time_base,codec_name', '-of', 'json', output])) as {
    streams: {time_base: string; codec_name: string}[]; frames: {best_effort_timestamp: number}[];
  };
  assert.equal(result.streams[0]?.codec_name, 'h264');
  assert.equal(result.streams[0]?.time_base, '1/30000');
  assert.deepEqual(result.frames.map(frame => frame.best_effort_timestamp), Array.from({length: durationFrames}, (_, index) => index * 1000));
}

function seedHistoricalTiming(store: ProjectStore, project: Seed, plan: CompiledTimeMap) {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  assert.ok(timeline);
  const clip = timeline.clips.find(item => item.id === project.clipId);
  assert.ok(clip);
  const fields = projectTimeMapToCurrentClipFields(clip, plan);
  assert.ok(fields.ok);
  const current = {
    ...clip, ...fields.value, timing: {profile: 'timeline-speed-v1', basis: {
      profile: 'timeline-speed-v1', sourceFps: fps, outputFps: fps,
      sourceRange: {start: boundary(0), end: boundary(clip.durationFrames)}, speed: project.operation.setting.speed,
    }, view: {loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}, direction: 'forward'},
    outputWindow: plan.outputWindow, pitchShift: false, interpolation: 'blend'},
  };
  // Reproduce a previously saved project without asking a checked live edit
  // to create the now-disallowed setting.
  store.tx(() => store.put('timelines', {...timeline, durationFrames: fields.value.durationFrames,
    revision: timeline.revision + 1, clips: [current]}));
}

test('properties, grouped edits and export share native timestamp interpolation admission', {timeout: 180_000}, async t => {
  const flag = process.env.MIOON_FORMAT6_DEV;
  process.env.MIOON_FORMAT6_DEV = '1';
  t.after(() => {
    if (flag === undefined) delete process.env.MIOON_FORMAT6_DEV;
    else process.env.MIOON_FORMAT6_DEV = flag;
  });
  for (const {sourceFps, eligible, rejected: overLimit} of cases) await t.test(`${sourceFps} fps`, async t => {
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-interpolation-admission-'));
    const server = await host(t, directory);
    const source = await sourceVideo(directory, sourceFps);
    const acceptedPhase = phaseOf(eligible, source), refusedPhase = phaseOf(overLimit, source);
    assert.equal(acceptedPhase.available, true);
    assert.ok(acceptedPhase.maxPhaseErrorFrames <= 0.01);
    assert.equal(refusedPhase.available, false);
    assert.ok(refusedPhase.maxPhaseErrorFrames > 0.01);

    const properties = await seeded(server, source.file, eligible);
    const propertyBefore = await properties.snapshot();
    const frontPlan = await propertyPreview(properties);
    stillAdmitted(frontPlan);
    assert.deepEqual(await properties.snapshot(), propertyBefore, 'properties preview is read-only');
    await properties.commit('sequence.commit', frontPlan);
    const propertyClip = (await properties.read()).timeline.clips[0];
    assert.equal(propertyClip?.durationFrames, acceptedPhase.plan.durationFrames);
    assert.equal(propertyClip.timing?.profile === 'timeline-speed-v1' && propertyClip.timing.interpolation, 'blend');

    const group = await seeded(server, source.file, eligible);
    const groupBefore = await group.snapshot();
    const grouped = await groupedPreview(group);
    assert.ok(grouped.ok, JSON.stringify(grouped));
    stillAdmitted(grouped.data);
    assert.deepEqual(await group.snapshot(), groupBefore, 'group preview is read-only');
    await group.commit('sequence.action.commit', grouped.data);
    const applied = await group.snapshot();
    await group.commit('sequence.action.commit', grouped.data);
    assert.deepEqual(await group.snapshot(), applied, 'an applied request replays without editing again');
    const retimed = (await group.read()).timeline.clips[0];
    assert.equal(retimed?.durationFrames, acceptedPhase.plan.durationFrames);
    assert.equal(retimed.timing?.profile === 'timeline-speed-v1' && retimed.timing.interpolation, 'blend');
    await publishedExport(server, group, directory, acceptedPhase.plan.durationFrames);

    const invalid = await seeded(server, source.file, overLimit);
    const before = await invalid.snapshot();
    assert.deepEqual(await propertyPreview(invalid), {ok: false, code: errorCode, ids: [invalid.clipId]});
    rejected(await groupedPreview(invalid), invalid.clipId);
    assert.deepEqual(await invalid.snapshot(), before, 'both refused previews leave state unchanged');

    const plans = await server.offline(invalid.projectId, store => {
      const properties = previewSequenceSpeed(store, {requestId: randomUUID(), origin: 'user',
        speedIntent: {side: 'timeline', operation: invalid.operation}});
      stillAdmitted(properties);
      const grouped = previewMioSequenceAction(store, invalid.projectId, randomUUID(), invalid.operation, {origin: 'user'});
      return [['sequence.commit', properties], ['sequence.action.commit', grouped]] as const;
    });
    for (const [op, {envelope, planDigest}] of plans) {
      rejected(await invalid.wire(op, {envelope, expectedPlanDigest: planDigest}), invalid.clipId);
      assert.deepEqual(await invalid.snapshot(), before, 'validly formed but over-bound commit leaves state unchanged');
    }

    await server.offline(invalid.projectId, store => seedHistoricalTiming(store, invalid, refusedPhase.plan));
    const current = (await invalid.read()).timeline;
    assert.equal(current.durationFrames, refusedPhase.plan.durationFrames);
    const input = {expectedRevision: current.revision, exportSettings};
    const preflight = await invalid.call<ExportPreflight>('timeline.export.preflight', input);
    assert.equal(preflight.status, 'blocked');
    assert.equal(preflight.issues[0]?.code, errorCode);
    assert.equal(preflight.issues[0]?.clipId, invalid.clipId);
    const caps = await invalid.call<{issues: PhaseIssue[]}>('timeline.export.capabilities', input);
    assert.ok(caps.issues.some(issue => issue.code === errorCode && issue.clipId === invalid.clipId), JSON.stringify(caps));
    rejected(await invalid.wire('timeline.render', {...input, requestId: randomUUID(), purpose: 'export'}), invalid.clipId);
    if (sourceFps === 30) {
      const tail = {startFrame: current.durationFrames - 2, endFrame: current.durationFrames};
      rejected(await invalid.wire('timeline.render', {...input, exportRange: tail, requestId: randomUUID(), purpose: 'export'}), invalid.clipId);
    }
    assert.equal((await invalid.snapshot()).state.exports, 0);
    t.diagnostic(`native phase ${acceptedPhase.maxPhaseErrorFrames.toFixed(9)} / ${refusedPhase.maxPhaseErrorFrames.toFixed(9)} frames`);
  });
  await t.test('an otherwise eligible 10-bit source is refused by both preview surfaces', async t => {
    const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-interpolation-admission-'));
    const server = await host(t, directory);
    const source = await sourceVideo(directory, 30, 'yuv420p10le');
    const project = await seeded(server, source.file, 45);
    assert.equal(phaseOf(45, source).available, true);
    const before = await project.snapshot();
    assert.deepEqual(await propertyPreview(project), {ok: false, code: 'UNSUPPORTED_FORMAT', ids: [project.clipId]});
    rejected(await groupedPreview(project), project.clipId, 'UNSUPPORTED_FORMAT');
    assert.deepEqual(await project.snapshot(), before);
  });
});
