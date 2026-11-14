import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {inspectCanvasDependencies} from '../packages/business/src/canvas-dependencies.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {previsOutputInputHash} from '../packages/business/src/previs-output-ownership.ts';
import {createPrevisPublicationServices} from '../packages/business/src/previs-publication.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {CanvasTarget} from '../packages/contracts/src/canvas-editing.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

const at = '2026-11-13T00:00:00.000Z';
const hash = 'a'.repeat(64);

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-canvas-dependency-'));
  const projectFile = path.join(root, 'project.mioon');
  const location = {localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')};
  const store = createProjectStore({projectFile, locate: () => location, format4: {}});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const {db, projectId} = store;
  store.put('projects', {id: projectId, name: 'Canvas', revision: 1});
  const shot = {kind: 'shot' as const, id: randomUUID()}, otherShot = {kind: 'shot' as const, id: randomUUID()};
  const node = {kind: 'node' as const, id: randomUUID()}, otherNode = {kind: 'node' as const, id: randomUUID()};
  for (const target of [shot, otherShot]) store.put('shots', {id: target.id, projectId, title: 'Shot', prompt: '', revision: 1});
  for (const target of [node, otherNode]) store.put('nodes', {id: target.id, projectId, type: 'text', label: 'Text', revision: 1});
  const inspect = (targets: readonly CanvasTarget[] = [shot, node]) => inspectCanvasDependencies(store, targets);
  return {store, db, projectId, location, shot, otherShot, node, otherNode, inspect};
}

test('the digest identifies retained versions and explicit and asset-derived clips, including hidden tracks', t => {
  const f = fixture(t), {store, projectId, shot, otherShot} = f;
  const jobId = randomUUID(), versionId = randomUUID(), assetId = randomUUID(), otherAssetId = randomUUID();
  for (const id of [assetId, otherAssetId]) store.put('assets', {id, projectId, name: 'Video', sha256: hash});
  store.put('versions', {id: versionId, projectId, jobId, shotId: shot.id, assetId, sha256: hash});
  const timelineId = randomUUID(), video = randomUUID(), hidden = randomUUID();
  const clip = (id: string, trackId: string, asset: string) => ({id, trackId, assetId: asset, name: 'Clip', startFrame: 0,
    durationFrames: 30, sourceInFrame: 0, gain: 1, rect: {x: 0, y: 0, width: 1920, height: 1080}});
  const visibleClip = {...clip(randomUUID(), video, assetId), shotId: shot.id, versionId, jobId};
  const hiddenClip = clip(randomUUID(), hidden, assetId);
  const timeline = {id: timelineId, projectId, fps: 30, width: 1920, height: 1080, revision: 1,
    tracks: [{id: video, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false},
      {id: hidden, name: 'Hidden', kind: 'video', orderIndex: 1, hidden: true, muted: false}],
    clips: [visibleClip, hiddenClip], durationFrames: 30, createdAt: at, updatedAt: at};
  store.put('timelines', timeline);
  const first = f.inspect([shot, otherShot]);
  assert.deepEqual([first.versions, first.clips, first.blocked], [1, 2, []]);
  assert.deepEqual(f.inspect([otherShot, shot]), first);
  assert.deepEqual(inspectCanvasDependencies(store, [otherShot, shot], [otherShot]).versions, 0);
  assert.deepEqual(inspectCanvasDependencies(store, [otherShot, shot], [otherShot]).clips, 0);
  const byShot = inspectCanvasDependencies(store, [shot, otherShot], [otherShot, shot], {reportShotImpacts: true});
  assert.deepEqual(byShot.shotImpacts, new Map([[shot.id, {versions: 1, clips: 2}]]), 'one clip counts once even when it names the shot, version, job and asset');
  assert.equal(byShot.digest, first.digest);

  store.put('timelines', {...timeline, revision: 2, clips: [visibleClip, {...hiddenClip, id: randomUUID()}]});
  const replaced = f.inspect([shot, otherShot]);
  assert.equal(replaced.clips, 2);
  assert.notEqual(replaced.digest, first.digest);
  store.put('timelines', {...timeline, revision: 3, clips: [visibleClip, hiddenClip, {
    ...clip(randomUUID(), video, otherAssetId), startFrame: 30}], durationFrames: 60});
  assert.deepEqual(f.inspect([shot, otherShot]), first, 'unrelated clip and aggregate revision do not invalidate the proof');
});

test('all matching owners, unresolved generation and persisted drafts are blockers', t => {
  const f = fixture(t), {store, db, projectId, shot, otherShot, node} = f;
  const activeJob = randomUUID(), otherJob = randomUUID(), terminalJob = randomUUID();
  store.put('jobs', {id: activeJob, projectId, shotId: otherShot.id, revision: 2, status: 'cancelled', cancelScope: 'local_only',
    submissionCount: 1, snapshot: {shotId: otherShot.id, referenceConnections: [{edgeId: randomUUID(), sourceNodeId: node.id}]}});
  store.put('jobs', {id: otherJob, projectId, shotId: otherShot.id, revision: 2, status: 'queued', snapshot: {shotId: otherShot.id}});
  store.put('jobs', {id: terminalJob, projectId, shotId: shot.id, revision: 2, status: 'failed', snapshot: {shotId: shot.id}});
  const records = createMioRecords(store);
  const [firstClaim, secondClaim] = store.tx(() => (['active', 'uncertain'] as const).map(state =>
    records.saveClaim({id: randomUUID(), ownerId: randomUUID(), kind: 'shot', targetId: shot.id, state, revision: 1, createdAt: at, updatedAt: at})));
  assert.ok(firstClaim && secondClaim);
  db.prepare("INSERT INTO main.local_draft_states(kind,workspaceScope) VALUES ('shot-text',?)").run(hash);
  db.prepare(`INSERT INTO main.local_shot_text_drafts(projectId,shotId,draftRevision,intentRevision,data,ordinal)
    VALUES(?,?,1,0,?,1)`).run(projectId, shot.id, JSON.stringify({projectId, shotId: shot.id, draftRevision: 1, intentRevision: 0, draft: {}, intent: null}));
  const first = f.inspect();
  assert.deepEqual(new Map(first.blocked.map(blocker => [blocker.id, blocker.reason])), new Map([
    [activeJob, 'GENERATION_OUTCOME_UNKNOWN'], [firstClaim.id, 'EDIT_CLAIM_ACTIVE'], [secondClaim.id, 'EDIT_CLAIM_UNCERTAIN'], [shot.id, 'SHOT_TEXT_DRAFT'],
  ]));
  assert.equal(inspectCanvasDependencies(store, [shot, node], []).blocked.length, first.blocked.length);
  const {projectId: _owner, ...claim} = firstClaim;
  store.tx(() => records.saveClaim({...claim, updatedAt: '2026-11-13T00:01:00.000Z'}));
  assert.deepEqual(f.inspect(), first);
  store.tx(() => records.removeClaim(secondClaim.id, secondClaim.ownerId));
  assert.notEqual(f.inspect().digest, first.digest);
});

test('a dispatched or unknown Mio tool blocks related targets while a proposal only awaiting approval does not', t => {
  const f = fixture(t), {store, db, projectId, shot, otherShot} = f;
  const journal = createMioJournal(store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY)});
  const run = journal.create({requestId: randomUUID(), projectId, text: 'Synthetic canvas work',
    configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
  const insert = db.prepare(`INSERT INTO main.mio_steps(id,runId,projectId,position,kind,status,tier,createdAt,updatedAt,data)
    VALUES(?,?,?,?,'tool',?,'local_reversible',?,?,?)`);
  const step = (position: number, status: string, targetId: string) => {
    const id = randomUUID();
    insert.run(id, run.id, projectId, position, status, at, at, JSON.stringify({data: {referencedTargets: [{kind: 'shot', id: targetId, revision: 1}]}}));
    return id;
  };
  step(1, 'awaiting_approval', shot.id);
  step(2, 'dispatch_started', otherShot.id);
  const unknown = step(3, 'unknown', shot.id);
  const before = db.prepare('SELECT total_changes() AS changes').get()!.changes;
  assert.deepEqual(f.inspect([shot]).blocked, [{kind: 'mio-step', id: unknown, reason: 'MIO_STEP_OUTCOME_UNKNOWN'}]);
  assert.equal(db.prepare('SELECT total_changes() AS changes').get()!.changes, before);
});

test('an unacknowledged reference edit retains its own pending state without an edit owner', t => {
  const f = fixture(t), {projectId, db, shot, node, otherShot} = f;
  const id = randomUUID(), requestId = randomUUID();
  const input = {projectId, requestId, sourceNodeId: node.id, targetShotId: shot.id,
    expectedSourceRevision: 1, expectedShotRevision: 1, role: 'first_frame'};
  db.prepare(`INSERT INTO main.edit_tasks(id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,createdAt,updatedAt,bytes)
    VALUES(?,?,'reference.attach',?,?,?,'reference:mutation','legacy_session','unknown',1,0,?,?,16384)`)
    .run(id, projectId, JSON.stringify(input), requestId, hash, at, at);
  assert.deepEqual(f.inspect([shot, node]).blocked, [{kind: 'edit-task', id, reason: 'EDIT_OUTCOME_UNKNOWN'}]);
  assert.deepEqual(f.inspect([otherShot]).blocked, []);
});

test('a persisted unfinished previs publication blocks only the affected node', t => {
  const f = fixture(t), directory = path.join(f.location.tempDir, 'previs-publications');
  mkdirSync(directory, {mode: 0o700});
  const identity = {projectId: f.projectId, nodeId: f.node.id, keyframeId: 'k1', sceneRevision: 1,
    requestId: randomUUID(), name: 'Preview', sha256: hash, width: 120, height: 120};
  const file = path.join(directory, createHash('sha256').update(identity.requestId).digest('hex') + '.json');
  writeFileSync(file, JSON.stringify({version: 1, identity, assetId: randomUUID(), publicationId: randomUUID(),
    inputHash: previsOutputInputHash(identity), createdAt: at}), {mode: 0o600});
  assert.deepEqual(f.inspect([f.node]).blocked, [{kind: 'previs', id: f.node.id, reason: 'PREVIS_OUTCOME_UNKNOWN'}]);
  assert.deepEqual(f.inspect([f.otherNode]).blocked, []);
  writeFileSync(file, '{');
  assert.deepEqual(f.inspect([f.otherNode]).blocked, [{kind: 'previs', id: f.projectId, reason: 'CANVAS_DEPENDENCY_UNVERIFIED'}]);
});

test('an in-flight PNG publication blocks even before its manifest exists, then retains a completed asset', async t => {
  const f = fixture(t), {store, projectId, node} = f;
  const scene = defaultPrevisScene();
  const previs = {kind: 'node' as const, id: randomUUID()};
  store.put('nodes', {id: previs.id, projectId, type: 'previs', label: 'Camera', text: '', position: {x: 0, y: 0}, revision: 2, createdAt: at,
    sceneRevision: 2, scene: {...scene, keyframes: [{id: 'k1', name: '', camera: scene.camera, exports: []}], activeKeyframeId: 'k1'}});
  const bytes = png({width: 64, height: 96, rgba: false});
  const input = {projectId, nodeId: previs.id, keyframeId: 'k1', sceneRevision: 2, requestId: randomUUID(), name: 'Camera.png',
    sha256: createHash('sha256').update(bytes).digest('hex'), width: 64, height: 96, dataBase64: bytes.toString('base64')};
  const {handlers} = createPrevisPublicationServices(store);
  const publication = handlers['previs.output.publish'](input);
  try {
    assert.deepEqual(f.inspect([previs]).blocked, [{kind: 'previs', id: previs.id, reason: 'PREVIS_RUNNING'}]);
    assert.deepEqual(f.inspect([node]).blocked, []);
  } finally { await publication; }
  const result = await publication;
  assert.ok(store.get('assets', result.asset.id));
  assert.deepEqual(f.inspect([previs]).blocked, []);
});
