import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AppError, hasRequestNotAppliedProof, isEditTaskEnvelope, isTimelineMutationResponse, isTimelineRecord, isTimelineRenderRecord} from '@mioon/contracts';
import type {EditTask} from '../packages/contracts/src/edit-tasks.ts';
import {CLIP_LAYOUT_PROFILE} from '../packages/contracts/src/timeline-clip-layout.ts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';
import {TIMELINE_CLIP_TRANSFORM_OPERATION} from '../packages/contracts/src/timeline-clip-transform-operation.ts';
import {timelineFormatResponseSchema} from '../packages/contracts/src/timeline-format.ts';
import {TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, TIMELINE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {withTaskEffectOrigin} from '../packages/business/src/agent/task-effects-v2.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {createServices} from '../packages/business/src/services.ts';
import {changeMarks, readProjectState} from './helpers/project-state.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

function timelineRecord(value: unknown, projectId: string) {
  assert.ok(isTimelineRecord(value, {projectId}));
  return value;
}

function editTaskEnvelope(value: unknown) {
  assert.ok(isEditTaskEnvelope(value));
  return value as {task: EditTask; instanceId: string; result?: unknown};
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-frame-transaction-'));
  const projectFile = path.join(root, 'project.mioon');
  const projectId = createProjectFile(projectFile);
  const locate = () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')});
  const open = (format4: boolean) => openServerTestStore({projectFile, locate, ...(format4 ? {format4: {approveUpgrade: () => true}} : {})}, path.join(root, 'app'));
  const service = (store: ReturnType<typeof open>) => createServices(store, new Map(), {env: {}});
  let store = open(false), services = service(store);
  t.after(async () => {
    try {
      if (store.db.isOpen) {
        await services.drain();
        store.close();
      }
    } finally {rmSync(root, {recursive: true, force: true});}
  });
  await services.call('project.create', {name: 'Frame transaction'});

  const call = (operation: string, input: unknown) => services.call(operation, input);
  const format = async () => timelineFormatResponseSchema.parse(await call('timeline.format.get', {projectId}));
  const formatInput = async (presetId: string) => {
    const current = await format();
    return {projectId, requestId: randomUUID(), expectedRevision: current.timelineRevision, expectedProjectRevision: current.projectRevision, presetId};
  };
  const mutation = (expectedRevision: number) => ({projectId, requestId: randomUUID(), expectedRevision});
  const timeline = async (operation = 'timeline.get', input: unknown = {projectId}) => timelineRecord(await call(operation, input), projectId);
  const versions = () => createProjectVersions(store, {assertMutationAllowed: services.assertMutationAllowed});
  const state = () => readProjectState(store.db);
  const receipts = (requestId: string) => ({
    result: store.db.prepare('SELECT * FROM main.timeline_requests WHERE requestId=?').get(requestId),
    format: store.db.prepare('SELECT * FROM main.timeline_format_requests WHERE requestId=?').get(requestId),
  });
  return {
    projectId, call, format, formatInput, mutation, timeline, versions, state, receipts,
    editTasks: () => createEditTasks({store, services}),
    get db() {return store.db;},
    async activate() {
      assert.equal(store.db.prepare('PRAGMA project.user_version').get()!.user_version, 3);
      await services.drain();
      store.close();
      store = open(true);
      services = service(store);
      assert.equal(store.db.prepare('PRAGMA project.user_version').get()!.user_version, 4);
      assert.equal(store.db.prepare('SELECT version FROM project.schema_version').get()!.version, 4);
    },
    history() {
      return store.db.prepare('SELECT * FROM main.timeline_history WHERE projectId=? ORDER BY position').all(projectId);
    },
    async addClip(current: Awaited<ReturnType<typeof timeline>>, rect = {x: 0, y: 0, width: 256, height: 256}) {
      const asset = await call('asset.import', {projectId, name: 'Frame source.png', mimeType: 'image/png',
        dataBase64: png({width: 16, height: 16, rgba: false, pixel: () => [240, 30, 20]}).toString('base64')});
      assert.ok(asset && typeof asset === 'object' && 'id' in asset && typeof asset.id === 'string');
      const track = current.tracks.find(({kind}) => kind === 'video');
      assert.ok(track);
      return timeline('timeline.clip.add', {...mutation(current.revision), assetId: asset.id, trackId: track.id, startFrame: 0, durationFrames: 90, rect});
    },
    async addAudioClip(current: Awaited<ReturnType<typeof timeline>>) {
      const withTrack = await timeline('timeline.track.add', {...mutation(current.revision), kind: 'audio'});
      const track = withTrack.tracks.find(({kind}) => kind === 'audio');
      assert.ok(track);
      const pcmBytes = 48000 * 2;
      const wave = Buffer.alloc(44 + pcmBytes);
      wave.write('RIFF'); wave.writeUInt32LE(36 + pcmBytes, 4); wave.write('WAVEfmt ', 8);
      wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
      wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
      wave.write('data', 36); wave.writeUInt32LE(pcmBytes, 40);
      const asset = await call('asset.import', {projectId, name: 'Sound.wav', mimeType: 'audio/wav', dataBase64: wave.toString('base64')});
      assert.ok(asset && typeof asset === 'object' && 'id' in asset && typeof asset.id === 'string');
      return timeline('timeline.clip.add', {...mutation(withTrack.revision), assetId: asset.id, trackId: track.id, startFrame: 0, durationFrames: 30});
    },
    async rejected(operation: string, input: Record<string, unknown>, code: string) {
      const before = state(), marks = changeMarks(store.db);
      await assert.rejects(call(operation, input), error => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, code);
        assert.equal(error.status, 409);
        assert.ok(hasRequestNotAppliedProof(error, input, {operation}));
        return true;
      });
      assert.deepEqual(state(), before);
      assert.deepEqual(changeMarks(store.db), marks);
    },
  };
}

const presets = {
  720: [
    ['portrait_720', 720, 1280], ['landscape_720', 1280, 720], ['square_720', 720, 720],
    ['landscape_4_3_720', 960, 720], ['portrait_3_4_720', 720, 960], ['ultrawide_720', 1680, 720],
  ],
  1080: [
    ['portrait_1080', 1080, 1920], ['landscape_1080', 1920, 1080], ['square_1080', 1080, 1080],
    ['landscape_4_3_1080', 1440, 1080], ['portrait_3_4_1080', 1080, 1440], ['ultrawide_1080', 2520, 1080],
  ],
} as const;

test('frame transactions admit all twelve presets within the existing short edge and check both revisions before writing', async t => {
  for (const short of [720, 1080] as const) await t.test(`${short}px short edge`, async t => {
    const f = await fixture(t);
    const legacy = await f.timeline('timeline.format.set', await f.formatInput(`landscape_${short}`));
    const populated = await f.addAudioClip(await f.addClip(legacy));
    await f.rejected('timeline.format.set', await f.formatInput(`portrait_${short}`), 'TIMELINE_FORMAT_LOCKED');
    await f.activate();
    assert.equal((await f.format()).eligible, true);

    const valid = await f.formatInput(`portrait_${short}`);
    await f.rejected('timeline.format.set', {...valid, expectedProjectRevision: valid.expectedProjectRevision + 1}, 'REVISION_CONFLICT');
    await f.rejected('timeline.format.set', {...valid, expectedRevision: valid.expectedRevision - 1}, 'REVISION_CONFLICT');
    await f.rejected('timeline.format.set', {...valid, presetId: `portrait_${short === 720 ? 1080 : 720}`}, 'TIMELINE_FORMAT_TIER_MISMATCH');
    await f.rejected('timeline.format.set', {...valid, presetId: `landscape_${short}`}, 'TIMELINE_FORMAT_UNCHANGED');

    let revision = populated.revision;
    for (const [presetId, width, height] of presets[short]) {
      const input = await f.formatInput(presetId), changed = await f.timeline('timeline.format.set', input);
      assert.ok(isTimelineMutationResponse('timeline.format.set', input, changed));
      assert.deepEqual([changed.width, changed.height, changed.fps, changed.revision], [width, height, 30, ++revision]);
      assert.deepEqual(changed.clips, populated.clips.map(clip => ({...clip, layout: {profileId: CLIP_LAYOUT_PROFILE, basisPresetId: `landscape_${short}`}})));
      assert.deepEqual([changed.id, changed.durationFrames, changed.tracks], [populated.id, populated.durationFrames, populated.tracks]);
      assert.equal((await f.format()).presetId, presetId);
      assert.equal(f.receipts(input.requestId).result?.response, JSON.stringify(changed));
    }
  });
});

test('frame history crosses old geometry, preserves layouts and receipts, and survives branching and version restoration', async t => {
  const f = await fixture(t);
  const legacyFormatInput = await f.formatInput('landscape_1080');
  const legacyFormat = await f.timeline('timeline.format.set', legacyFormatInput);
  const rect = {x: 1200, y: 100, width: 600, height: 400};
  const populated = await f.addClip(legacyFormat, rect), clipId = populated.clips[0]!.id;
  const transform = {profileId: CLIP_TRANSFORM_PROFILE, keyframes: [{frame: 0, x: 1500, y: -240, scale: 0.85}, {frame: 65, x: -80, y: 220, scale: 1.4}],
    rotation: 17, crop: {left: 0.125, top: 0, right: 0, bottom: 0.125}};
  const transformInput = {...f.mutation(populated.revision), clipId, transform};
  const transformAck = await f.call(TIMELINE_CLIP_TRANSFORM_OPERATION, transformInput);
  assert.ok(transformAck && typeof transformAck === 'object' && 'timeline' in transformAck);
  const withTransform = timelineRecord(transformAck.timeline, f.projectId);
  const legacy = await f.timeline('timeline.subtitle.add', {...f.mutation(withTransform.revision), text: '原画框字幕', startFrame: 5, durationFrames: 40});
  assert.ok(legacy.subtitles && typeof legacy.subtitles === 'object' && 'cues' in legacy.subtitles && 'profileId' in legacy.subtitles);
  assert.equal(legacy.subtitles.profileId, TIMELINE_SUBTITLE_PROFILE_ID);
  const saved = f.versions().save({projectId: f.projectId, requestId: randomUUID(), name: 'Landscape before frame changes'});
  const renderInput = {...f.mutation(legacy.revision), purpose: 'preview'};
  const render = await f.call('timeline.render', renderInput);
  assert.ok(isTimelineRenderRecord(render, renderInput));
  const oldHistory = f.history();
  assert.ok(oldHistory.length > 0);
  for (const row of oldHistory) assert.equal(Object.hasOwn(JSON.parse(String(row.afterSnapshot)), 'format'), false);
  const oldRequests = [legacyFormatInput, transformInput, renderInput].map(input => f.receipts(input.requestId));
  const oldBlob = () => f.db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=(SELECT blobHash FROM main.project_versions WHERE id=?)').get(saved.version.id);
  const originalBlob = oldBlob();
  assert.ok(originalBlob);

  await f.activate();
  assert.deepEqual(await f.timeline(), legacy);
  assert.deepEqual(f.history(), oldHistory);
  const portraitInput = await f.formatInput('portrait_1080');
  const portrait = await f.timeline('timeline.format.set', portraitInput);
  const portraitReceipt = f.receipts(portraitInput.requestId);
  assert.deepEqual(portrait.clips, [{...legacy.clips[0], layout: {profileId: CLIP_LAYOUT_PROFILE, basisPresetId: 'landscape_1080'}}]);
  assert.deepEqual(portrait.subtitles, {profileId: TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID, basisPresetId: 'landscape_1080', cues: legacy.subtitles.cues});
  const history = f.history();
  assert.equal(history.length, oldHistory.length + 1);
  assert.deepEqual(history.slice(0, oldHistory.length), oldHistory);
  const entry = history.at(-1)!;
  assert.equal(entry.operation, 'timeline.format.set');
  assert.deepEqual(JSON.parse(String(entry.beforeSnapshot)).format, {fps: 30, width: 1920, height: 1080});
  assert.deepEqual(JSON.parse(String(entry.afterSnapshot)).format, {fps: 30, width: 1080, height: 1920});

  await f.rejected('timeline.clip.update', {...f.mutation(portrait.revision), clipId, patch: {rect: {x: 4, y: 8, width: 600, height: 400}}}, 'CLIP_LAYOUT_RECT_READ_ONLY');
  const transformUpdated = {...transform, rotation: 24};
  const updatedInput = {...f.mutation(portrait.revision), clipId, transform: transformUpdated};
  const updatedAck = await f.call(TIMELINE_CLIP_TRANSFORM_OPERATION, updatedInput);
  assert.ok(updatedAck && typeof updatedAck === 'object' && 'timeline' in updatedAck);
  const updated = timelineRecord(updatedAck.timeline, f.projectId);
  assert.deepEqual(updated.clips, [{...portrait.clips[0], transform: transformUpdated}]);
  const squareInput = await f.formatInput('square_1080');
  const square = await f.timeline('timeline.format.set', squareInput);
  const squareReceipt = f.receipts(squareInput.requestId);
  assert.deepEqual([square.clips, square.subtitles], [updated.clips, portrait.subtitles]);

  const editable = ({width, height, clips, tracks, subtitles, durationFrames}: typeof legacy) => ({width, height, clips, tracks, subtitles, durationFrames});
  let current = square;
  for (const expected of [updated, portrait, legacy, withTransform]) {
    current = await f.timeline('timeline.undo', f.mutation(current.revision));
    assert.deepEqual(editable(current), editable(expected));
    assert.equal((await f.format()).eligible, true);
  }
  for (const expected of [legacy, portrait, updated, square]) {
    current = await f.timeline('timeline.redo', f.mutation(current.revision));
    assert.deepEqual(editable(current), editable(expected));
  }
  current = await f.timeline('timeline.undo', f.mutation(current.revision));
  const branch = await f.timeline('timeline.format.set', await f.formatInput('ultrawide_1080'));
  await assert.rejects(f.call('timeline.redo', f.mutation(branch.revision)), {code: 'NOTHING_TO_REDO'});
  assert.deepEqual(f.history().slice(0, oldHistory.length), oldHistory);

  const versions = f.versions();
  const preview = versions.preview({projectId: f.projectId, versionId: saved.version.id});
  assert.equal(preview.restoreAvailable, true);
  versions.restore({projectId: f.projectId, versionId: saved.version.id, requestId: randomUUID(),
    expectedContentSequence: preview.contentSequence, expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest});
  const restored = await f.timeline();
  assert.deepEqual(editable(restored), editable(legacy));
  assert.deepEqual(oldBlob(), originalBlob);
  current = await f.timeline('timeline.undo', f.mutation(restored.revision));
  assert.deepEqual(editable(current), editable(branch));
  current = await f.timeline('timeline.redo', f.mutation(current.revision));
  assert.deepEqual(editable(current), editable(legacy));

  const beforeReplay = f.state(), marks = changeMarks(f.db);
  for (const [operation, input, response, receipt] of [
    ['timeline.format.set', legacyFormatInput, legacyFormat, oldRequests[0]],
    [TIMELINE_CLIP_TRANSFORM_OPERATION, transformInput, transformAck, oldRequests[1]],
    ['timeline.render', renderInput, render, oldRequests[2]],
    ['timeline.format.set', portraitInput, portrait, portraitReceipt],
    ['timeline.format.set', squareInput, square, squareReceipt],
  ] as const) {
    assert.equal(JSON.stringify(await f.call(operation, input)), JSON.stringify(response));
    assert.deepEqual(f.receipts(input.requestId), receipt);
  }
  assert.deepEqual(f.state(), beforeReplay);
  assert.deepEqual(changeMarks(f.db), marks);
});

test('a failed format receipt rolls back a lazy timeline and the same key can commit through its claimed edit', async t => {
  const f = await fixture(t);
  await f.activate();
  const initial = await f.format();
  assert.equal(initial.timelineId, null);
  const input = await f.formatInput('landscape_4_3_1080');
  const before = f.state();
  f.db.exec("CREATE TEMP TRIGGER reject_frame_receipt BEFORE INSERT ON main.timeline_format_requests BEGIN SELECT RAISE(ABORT,'injected frame receipt failure');END");
  try {await assert.rejects(f.call('timeline.format.set', input), /injected frame receipt failure/);}
  finally {f.db.exec('DROP TRIGGER temp.reject_frame_receipt');}
  assert.deepEqual(f.state(), before);
  assert.deepEqual(await f.format(), initial);
  const editTasks = f.editTasks();
  const prepared = editTaskEnvelope(editTasks.prepare({projectId: f.projectId, operation: 'timeline.format.set', origin: 'new', input}));
  assert.equal(prepared.task.status, 'prepared');
  assert.deepEqual((await f.format()).blockedReasons, ['PENDING_EDIT']);
  await f.rejected('timeline.format.set', input, 'TIMELINE_FORMAT_LOCKED');
  const taskInput = {projectId: f.projectId, taskId: prepared.task.id, digest: prepared.task.digest};
  const accepted = editTaskEnvelope(await editTasks.execute({...taskInput, instanceId: prepared.instanceId}));
  assert.equal(accepted.task.status, 'applied');
  const applied = timelineRecord(accepted.result, f.projectId);
  assert.deepEqual((await f.format()).blockedReasons, ['PENDING_EDIT']);
  assert.deepEqual(await f.timeline('timeline.format.set', input), applied);
  const acknowledged = editTaskEnvelope(editTasks.acknowledge({...taskInput, expectedRevision: accepted.task.revision, status: 'applied'}));
  assert.equal(acknowledged.task.acknowledged, true);
  assert.equal((await f.format()).eligible, true);
  assert.equal(f.history().length, 1);
  const undone = await f.timeline('timeline.undo', f.mutation(applied.revision));
  assert.deepEqual([undone.id, undone.width, undone.height, undone.clips], [applied.id, initial.width, initial.height, []]);
  const redone = await f.timeline('timeline.redo', f.mutation(undone.revision));
  assert.deepEqual([redone.id, redone.width, redone.height, redone.clips], [applied.id, applied.width, applied.height, []]);
});

test('Mio keeps pristine-format behavior on a format-4 project', async t => {
  const f = await fixture(t);
  await f.activate();
  const mio = <T>(requestId: string, run: () => T) => withTaskEffectOrigin({runId: randomUUID(), stepId: randomUUID(),
    projectId: f.projectId, requestId, operation: 'timeline.format.set', beforeEffect() {}, recordInside() {}, recorded: false}, run);
  const legacyInput = await f.formatInput('landscape_720');
  await f.rejected('timeline.format.set', legacyInput, 'TIMELINE_FORMAT_TIER_MISMATCH');
  const landscape = await mio(legacyInput.requestId, () => f.timeline('timeline.format.set', legacyInput));
  assert.deepEqual([landscape.width, landscape.height, landscape.clips], [1280, 720, []]);
  assert.deepEqual(f.history(), []);

  const populated = await f.addClip(landscape);
  const portraitInput = await f.formatInput('portrait_720');
  assert.equal((await f.format()).eligible, true);
  const legacyFormat = await mio(portraitInput.requestId, f.format);
  assert.equal(legacyFormat.eligible, false);
  assert.ok(legacyFormat.blockedReasons.includes('CLIPS_PRESENT'));
  await mio(portraitInput.requestId, () => f.rejected('timeline.format.set', portraitInput, 'TIMELINE_FORMAT_LOCKED'));
  const portrait = await f.timeline('timeline.format.set', portraitInput);
  assert.deepEqual([portrait.width, portrait.height, portrait.clips[0]?.id], [720, 1280, populated.clips[0]?.id]);
  assert.equal(portrait.clips[0]?.layout?.basisPresetId, 'landscape_720');
});
