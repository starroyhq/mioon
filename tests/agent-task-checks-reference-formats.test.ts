import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readAgentTaskChecks} from '../packages/business/src/agent/task-checks-v2.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {applyFormat5ConversionInside} from '../packages/business/src/project-file/format5-conversion-store.ts';
import {prepareTrustedFormat5Conversion} from '../packages/business/src/project-file/format5-upgrade.ts';
import * as projectFormats from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {referenceForPublishedMedia} from '../packages/business/src/project-media-storage.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {AgentTaskCheck, AgentTaskGoalCondition} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {SequenceEditEnvelope} from '../packages/contracts/src/sequence-edit.ts';
import {mp4HeaderFixture} from './helpers/media-reference-fixtures.ts';
import {beginFixtureToolStep, mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

interface Timeline {
  id: string; revision: number; durationFrames: number; tracks: {id: string}[];
  clips: {id: string; assetId: string | null; sourceState?: string}[];
}

for (const format of [3, 4, 5, 6] as const) test(`Mio checks count saved material references in format ${format}`, {
  skip: format === 6 && !('FORMAT6_PROJECT_SCHEMA_VERSION' in projectFormats) ? 'Format 6 is not in this release branch' : false,
}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-checks-references-'));
  let close = async () => {};
  t.after(async () => {try {await close();} finally {await rm(root, {recursive: true, force: true});}});
  const native = format >= 5;
  const store = createProjectStore({projectFile: path.join(root, 'project.mioon'),
    targetFormat: format === 3 ? projectFormats.PROJECT_FILE_SCHEMA_VERSION : projectFormats.FORMAT4_PROJECT_SCHEMA_VERSION,
    ...(format >= 4 ? {format4: {}} : {}),
    locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const library = openAppLibrary({dataDir: path.join(root, 'app')});
  let services: ReturnType<typeof createServices> | undefined;
  close = async () => {try {await services?.drain();} finally {store.close(); library.close();}};
  const projectId = store.projectId;
  store.put('projects', {id: projectId, name: 'Synthetic task checks', description: '', revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
  if (native) {
    const conversion = prepareTrustedFormat5Conversion(store);
    // Follow hosted project creation. The format-6 upgrader is available on SP-D.
    const upgradeModule = '../packages/business/src/project-file/schema/format6-upgrade.ts';
    const upgrade = format === 6 ? (await import(upgradeModule)).upgradeProject5To6Inside as
      (db: typeof store.db, schema: 'project') => void : undefined;
    store.tx(() => {applyFormat5ConversionInside(store, conversion); upgrade?.(store.db, 'project');});
  }
  assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version, format);
  const projectServices = createServices(store, new Map(), {application: createProjectServiceApplication(library, undefined, {})});
  services = projectServices;
  const call = (operation: string, input: Record<string, unknown> = {}) => projectServices.call(operation, {projectId, ...input});
  const timeline = async () => native ? (await call('project.get') as {timeline: Timeline}).timeline : await call('timeline.get') as Timeline;

  const media = path.join(root, 'media');
  await mkdir(media, {mode: 0o700});
  async function addAsset(name: string, mimeType: string, bytes: Buffer) {
    const id = randomUUID(), file = path.join(media, name);
    await writeFile(file, bytes, {mode: 0o600});
    const evidence = await referenceForPublishedMedia(store, file);
    store.put('assets', {id, projectId, name, mimeType, ...evidence, width: 64, height: 64, duration: 2,
      provenance: 'user-import', createdAt: new Date().toISOString(), url: `/media/${id}`});
    return id;
  }
  // Task references validate published metadata. The explicit native preflight
  // below stops at the real placeholder blocker before it needs a decoder.
  const pngId = await addAsset('still.png', 'image/png', png({width: 64, height: 64}));
  const videoId = await addAsset('source.mp4', 'video/mp4', mp4HeaderFixture('Synthetic reference only'));
  if (native) {
    async function apply(operation: string, intent: Record<string, unknown>) {
      const {envelope, planDigest} = await call(operation, intent) as {envelope: SequenceEditEnvelope; planDigest: string};
      const receipt = await call('sequence.action.commit', {envelope, expectedPlanDigest: planDigest}) as {status: string};
      assert.equal(receipt.status, 'applied');
    }
    await apply('sequence.board.edit', {kind: 'board-root-create', name: 'Synthetic sequence', position: {x: 0, y: 0}});
    await apply('sequence.board.edit', {kind: 'board-shot-append', name: 'Ungenerated shot'});
    const before = await timeline();
    await apply('sequence.timeline.edit', {kind: 'insert-asset', assetId: pngId, trackId: null, startFrame: before.durationFrames});
    const withStill = await timeline();
    await apply('sequence.timeline.edit', {kind: 'insert-asset', assetId: videoId, trackId: null, startFrame: withStill.durationFrames});
    const video = (await timeline()).clips.find(clip => clip.assetId === videoId);
    assert.ok(video);
    await apply('sequence.action.edit', {kind: 'split', clipId: video.id, offsetFrames: 30});
    await apply('sequence.timeline.edit', {kind: 'subtitles', edits: [{kind: 'add', cue: {text: 'Synthetic caption', startFrame: 0, durationFrames: 5}}]});
  } else {
    const before = await timeline();
    const withStill = await call('timeline.clip.add', {requestId: randomUUID(), expectedRevision: before.revision,
      trackId: before.tracks[0]!.id, assetId: pngId, startFrame: 0, durationFrames: 30}) as Timeline;
    const withVideo = await call('timeline.clip.add', {requestId: randomUUID(), expectedRevision: withStill.revision,
      trackId: withStill.tracks[0]!.id, assetId: videoId, startFrame: 30, durationFrames: 60}) as Timeline;
    const video = withVideo.clips.find(clip => clip.assetId === videoId);
    assert.ok(video);
    await call('timeline.clip.split', {requestId: randomUUID(), expectedRevision: withVideo.revision, clipId: video.id, atFrame: 60});
  }

  const saved = await timeline();
  const countClips = native ? 4 : 3;
  assert.equal(saved.clips.length, countClips);
  assert.equal(saved.clips.filter(clip => clip.assetId === videoId).length, 2);
  if (native) {
    assert.ok(saved.clips.some(clip => clip.sourceState === 'placeholder' && clip.assetId === null));
    assert.equal(store.db.prepare("SELECT json_type(data,'$.clips') AS clips FROM project.timelines WHERE id=?").get(saved.id)?.clips, null);
  }

  const journal = createAgentTaskJournal(store, {policyStore: library.agentPolicy});
  const run = journal.create({projectId, requestId: randomUUID(), text: 'Synthetic timeline checks', configuration: mioFixtureConfiguration}).run;
  const edit = beginFixtureToolStep(journal, run.id, {toolCall: {id: 'saved_edit', name: 'mioon_timeline_clip_add', arguments: {}}});
  journal.markDispatch(run.id, edit.id);
  journal.completeStep(run.id, edit.id, {result: {id: saved.id, revision: saved.revision}, change: {
    projectId, operation: 'timeline.clip.add', targets: [{kind: 'timeline', id: saved.id, revision: saved.revision}], before: null, after: null, reversible: false,
  }});
  const conditions: AgentTaskGoalCondition[] = [
    {type: 'clip_count', min: countClips, max: countClips}, {type: 'subtitle_count', min: native ? 1 : 0, max: native ? 1 : 0},
  ];
  const goals = beginFixtureToolStep(journal, run.id, {toolCall: {id: 'goals', name: 'mioon_goal_set', arguments: {conditions}}});
  journal.markDispatch(run.id, goals.id);
  journal.completeStep(run.id, goals.id, {result: {conditions}});
  const snapshot = journal.snapshot(run.id);
  const read = (preflight?: (input: {projectId: string; expectedRevision: number}) => Promise<unknown>) =>
    readAgentTaskChecks(store, snapshot, {preflight, includePreflight: preflight !== undefined});
  function item(result: Awaited<ReturnType<typeof read>>, type: AgentTaskCheck['type']) {
    const observed = result.groups.flatMap(group => group.items).find(check => check.type === type);
    assert.ok(observed);
    return observed;
  }
  const writes = () => store.db.prepare('SELECT total_changes() AS writes').get()?.writes;
  const before = writes(), first = await read();
  const references = item(first, 'timeline_references');
  assert.equal(references.status, 'passed');
  assert.deepEqual(references.current, {referenceCount: 3, missingCount: 0});
  assert.deepEqual(references.basis.filter(entry => entry.kind === 'asset').map(entry => entry.id).sort(), [pngId, videoId].sort());
  assert.ok(references.basis.some(entry => entry.kind === 'timeline' && entry.id === saved.id && entry.revision === saved.revision));
  assert.equal(item(first, 'timeline_preflight').reason?.code, 'PREFLIGHT_NOT_REQUESTED');
  assert.deepEqual(first.requirements?.map(({status, current}) => ({status, current})), [
    {status: 'passed', current: {count: countClips}}, {status: 'passed', current: {count: native ? 1 : 0}},
  ]);
  assert.equal(writes(), before);

  if (native) {
    const preflight = (input: {projectId: string; expectedRevision: number}) => projectServices.call('timeline.export.preflight', input);
    const blocked = item(await read(preflight), 'timeline_preflight');
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.reason?.code, 'PREFLIGHT_BLOCKED');
    assert.deepEqual(blocked.current?.issueCodes, ['PLACEHOLDER_CLIP']);
    assert.deepEqual(blocked.basis, references.basis);
    assert.equal(writes(), before);

    const still = saved.clips.find(clip => clip.assetId === pngId);
    assert.ok(still);
    const missingAssetId = randomUUID();
    // Deliberately damage one clip row while keeping the timeline header and
    // revision intact. The real commit path protects this cross-row invariant.
    const stale = item(await read(async input => {
      const report = await preflight(input);
      store.db.prepare("UPDATE project.timeline_clips SET assetId=?,data=json_set(data,'$.assetId',?) WHERE id=?")
        .run(missingAssetId, missingAssetId, still.id);
      return report;
    }), 'timeline_preflight');
    assert.equal(stale.reason?.code, 'PREFLIGHT_STALE');
    const missing = item(await read(), 'timeline_references');
    assert.equal(missing.status, 'failed');
    assert.equal(missing.reason?.code, 'REFERENCES_UNAVAILABLE');
    assert.deepEqual(missing.current, {referenceCount: 3, missingCount: 1});
    assert.ok(missing.basis.some(entry => entry.kind === 'asset' && entry.id === missingAssetId));
  }
});
