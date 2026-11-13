import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {createCanvasEditing} from '../packages/business/src/canvas-editing.ts';
import {CANVAS_ARCHIVE_ORDER_FIELD} from '../packages/business/src/canvas-patch.ts';
import {canvasEditingResponses, createCanvasRequestId} from '../packages/contracts/src/canvas-editing.ts';
import {readMioTargetRevision} from '../packages/business/src/agent/mio-target-revisions.ts';
import {readMioProjectImportDependencies, readMioProjectImportDependenciesInside,
  MIO_PROJECT_IMPORT_DEPENDENCY_LIMITS as LIMITS} from '../packages/business/src/agent/mio-project-import-dependencies.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import {captureProjectDocumentInside, canonicalJson} from '../packages/business/src/project-versions/document.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {storeManualVersionInside, storeProjectVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {copyProjectVersionsInside} from '../packages/business/src/project-versions/copy.ts';
import {FRAME_PROFILE, FRAME_PROFILE_ID, FRAME_SELECTION_RULE} from '../packages/contracts/src/frame-extraction.ts';
import {IMAGE_FIXED_OPTIONS, imageVersionResponseSchema} from '../packages/contracts/src/images.ts';
import {IMAGE_REVIEW_POLICY, imageReviewIntentSchema} from '../packages/contracts/src/image-reviews.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {clipDraftSlotSchema, type ClipDraftSlot} from '../packages/contracts/src/local-drafts.ts';
import {createLocalDeliverySchemas} from '../packages/contracts/src/local-delivery.ts';
import {createLocalShotTextSchemas} from '../packages/contracts/src/local-shot-text.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';

const now = '2026-11-04T00:00:00.000Z', hash = 'a'.repeat(64);
function fixture(t: TestContext, createAsset = true, ownedProjectId?: string, candidate = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-import-dependencies-')), projectDir = path.join(root, 'project');
  mkdirSync(projectDir);
  const store = createProjectStore({projectFile: path.join(projectDir, 'Film.mioon'), ...(ownedProjectId ? {projectId: ownedProjectId} : {}), ...(candidate ? {format4: {}} : {}),
    locate: () => ({localDir: path.join(root, 'local'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')})});
  const projectId = store.projectId, assetId = randomUUID();
  store.put('projects', {id: projectId, name: 'Dependencies', description: '', revision: 1, createdAt: now, updatedAt: now});
  const asset = {id: assetId, projectId, name: 'Missing source.png', mimeType: 'image/png', sizeBytes: 100,
    reference: {pathForm: 'relative', path: 'never-created.png', volume: null, sizeBytes: 100, mtimeMs: 1, sampledSha256: hash, fullSha256: hash},
    referenceRevision: 1, sha256: hash, width: 1024, height: 1024, provenance: 'user-import', createdAt: now};
  if (createAsset) store.put('assets', asset);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const changes = () => store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const read = () => {const before = changes(), result = readMioProjectImportDependencies(store, assetId); assert.equal(changes(), before); return result;};
  return {root, store, projectId, assetId, asset, changes, read};
}
type Fixture = ReturnType<typeof fixture>;
function shot(f: Fixture, references: string[] = []) {
  return {id: randomUUID(), projectId: f.projectId, title: 'Shot', prompt: '', referenceAssetIds: references, aspectRatio: '9:16', duration: 5,
    parameters: {}, position: {x: 0, y: 0}, orderIndex: 0, revision: 1, selectedVersionId: null, createdAt: now, updatedAt: now};
}
function snapshot(f: Fixture, patch: Record<string, unknown> = {}) {
  return {shotId: randomUUID(), shotRevision: 1, title: 'Frozen', prompt: '', referenceAssetIds: [], referenceAssets: [], referenceConnections: [],
    aspectRatio: '9:16', duration: 5, providerId: 'mock', model: 'mock-v1', parameters: {}, ...patch};
}
function job(f: Fixture, frozen: Record<string, unknown>) {
  f.store.put('jobs', {id: randomUUID(), projectId: f.projectId, shotId: frozen.shotId, requestId: randomUUID(), requestHash: hash,
    providerId: 'mock', model: 'mock-v1', revision: 1, status: 'failed', phase: 'failed', progress: 0, snapshot: frozen,
    providerJobId: null, submissionCount: 0, error: null, createdAt: now, updatedAt: now, versionId: null});
}
function timeline(f: Fixture, useAsset = false) {
  const result = newTimelineRecord(f.projectId, {fps: 30, width: 1080, height: 1920}, () => now);
  if (useAsset) {
    result.clips = [{id: randomUUID(), trackId: result.tracks[0]!.id, assetId: f.assetId, name: 'Clip', startFrame: 0, durationFrames: 30,
      sourceInFrame: 0, rect: {x: 0, y: 0, width: 1080, height: 1920}, gain: 1}];
    result.durationFrames = 30;
  }
  return result;
}
function mioAudit(f: Fixture) {
  const db = f.store.db, run = randomUUID(), conversation = randomUUID(), step = randomUUID();
  db.prepare('INSERT INTO main.mio_conversations(id,projectId,createdAt,updatedAt) VALUES(?,?,?,?)').run(conversation, f.projectId, now, now);
  db.prepare(`INSERT INTO main.mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,createdAt,updatedAt)
    VALUES(?,?,?,?,?,'completed',1,10,10,1,'en',?,?)`).run(run, f.projectId, conversation, randomUUID(), hash, now, now);
  db.prepare(`INSERT INTO main.mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt,data)
    VALUES(?,?,?,1,'tool','completed',?,?,?)`).run(step, run, f.projectId, now, now, JSON.stringify({assetId: f.assetId}));
  const id = randomUUID(), entry = {kind: 'asset', id: f.assetId, table: 'assets', value: f.asset, revision: 1};
  db.prepare('INSERT INTO main.mio_changes(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)')
    .run(id, run, step, f.projectId, JSON.stringify({id, runId: run, stepId: step, projectId: f.projectId,
      operation: 'asset.importProjectFile', targets: [{kind: 'asset', id: f.assetId, revision: 1}], before: [null], after: [entry],
      undo: [{after: entry, projectImport: {assetId: f.assetId}}], reversible: true, status: 'applied', createdAt: now}));
  return {run, step};
}

test('empty dependency proof is pure DB metadata and leaves source, receipt, audit and revision tombstone alone', t => {
  const f = fixture(t), receipt = path.join(f.store.tempDir, 'kept-receipt.json');
  writeFileSync(receipt, '{deliberately unreadable receipt shape}');
  mioAudit(f);
  f.store.db.prepare("INSERT INTO main.idempotency(scope,requestId,requestHash,resourceId) VALUES('asset',?,?,?)").run(randomUUID(), hash, f.assetId);
  const before = readFileSync(receipt), files = readdirSync(f.store.tempDir), revision = f.store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind='asset' AND targetId=?").get(f.assetId);
  assert.deepEqual(f.read(), {status: 'clear'});
  assert.deepEqual(readFileSync(receipt), before); assert.deepEqual(readdirSync(f.store.tempDir), files);
  assert.deepEqual(f.store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind='asset' AND targetId=?").get(f.assetId), revision);
  assert.equal(f.store.db.isTransaction, false);
});

test('preview reuses outer transaction and inside refuses copied or nontransactional owners', t => {
  const f = fixture(t);
  assert.throws(() => readMioProjectImportDependenciesInside(f.store, f.assetId), /transaction/);
  assert.throws(() => readMioProjectImportDependencies({...f.store}, f.assetId), {code: 'PROJECT_STORE_UNVERIFIED'});
  f.store.tx(() => {assert.deepEqual(f.read(), {status: 'clear'}); assert.equal(f.store.db.isTransaction, true);});
  assert.throws(() => readMioProjectImportDependencies(f.store, 'bad'), /identity/);
  assert.equal(f.store.db.isTransaction, false);
});

test('arbitrary text equal to the ID is not a consumer', t => {
  const f = fixture(t);
  f.store.put('shots', {...shot(f), title: f.assetId, prompt: f.assetId});
  f.store.put('nodes', {id: randomUUID(), projectId: f.projectId, type: 'text', text: f.assetId, label: f.assetId, position: {x: 0, y: 0}, revision: 1, createdAt: now});
  assert.deepEqual(f.read(), {status: 'clear'});
});

function clipDraft(f: Fixture, sourceAssetId = f.assetId): ClipDraftSlot {
  return {projectId: f.projectId, timelineId: randomUUID(), clipId: randomUUID(), revision: 1,
    draft: {baseRevision: 1, source: {assetId: sourceAssetId, assetSha256: hash}, updatedAt: now,
      raw: {name: f.assetId, trackId: randomUUID(), startFrame: '', durationFrames: '9e', sourceInFrame: 0,
        rect: {x: 0, y: 0, width: 1024, height: 1024}, gain: '0.',
        volumeEnvelope: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: '', multiplier: '1e'}]}}}};
}
function retainClipDraft(f: Fixture, slot: ClipDraftSlot, raw = JSON.stringify(slot)): void {
  f.store.db.prepare("INSERT INTO main.local_draft_states(kind,workspaceScope) VALUES('clip',?)").run(hash);
  f.store.db.prepare('INSERT INTO main.local_clip_drafts(projectId,timelineId,clipId,revision,data,ordinal) VALUES(?,?,?,?,?,1)')
    .run(slot.projectId, slot.timelineId, slot.clipId, slot.revision, raw);
}

test('S8 clip draft retains its semantic source after its current timeline and clip are gone', t => {
  const f = fixture(t), slot = clipDraft(f);
  assert.ok(clipDraftSlotSchema.safeParse(slot).success);
  retainClipDraft(f, slot);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project.timelines').get()!.n, 0);
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.local_clip_drafts.data'});
});

for (const kind of ['tombstone', 'other-source'] as const) test(`S8 ${kind} clip slot does not turn raw UUID text into an asset consumer`, t => {
  const f = fixture(t), slot = clipDraft(f, randomUUID());
  if (kind === 'tombstone') slot.draft = null;
  assert.ok(clipDraftSlotSchema.safeParse(slot).success);
  retainClipDraft(f, slot);
  assert.deepEqual(f.read(), {status: 'clear'});
});

for (const damage of ['missing-raw', 'bad-source', 'future-field', 'bad-envelope', 'duplicate-key', 'projection', 'oversized'] as const)
  test(`S8 ${damage} clip record refuses an absence proof without repairing it`, t => {
    const f = fixture(t), slot = clipDraft(f, randomUUID());
    const original = JSON.stringify(slot);
    const raw = damage === 'missing-raw' ? original.replace('"raw":', '"missingRaw":')
      : damage === 'bad-source' ? original.replace(slot.draft!.source.assetId, 'not-an-asset')
        : damage === 'future-field' ? original.replace('"source":{', '"source":{"futureAssetId":null,')
          : damage === 'bad-envelope' ? original.replace('"frame":""', '"frame":"invalid"')
            : damage === 'duplicate-key' ? original.replace('"source":{', `"source":{"assetId":"${f.assetId}",`)
              : damage === 'projection' ? original.replace(slot.clipId, randomUUID()) : original + ' '.repeat(8193 - Buffer.byteLength(original));
    // These two emulate damaged persisted CHECK projections/row length; normal
    // SQL writes reject them before this read-only proof can run.
    const damagedCheck = damage === 'projection' || damage === 'oversized';
    if (damagedCheck) f.store.db.exec('PRAGMA ignore_check_constraints=ON');
    try {retainClipDraft(f, slot, raw);} finally {if (damagedCheck) f.store.db.exec('PRAGMA ignore_check_constraints=OFF');}
    assert.deepEqual(f.read(), {status: 'unproven', reason: damage === 'oversized' ? 'limit' : 'invalid'});
    assert.equal(f.store.db.prepare('SELECT data FROM main.local_clip_drafts').get()!.data, raw);
  });

test('S8 clip source proof admits exactly 8192 UTF-8 bytes without normalizing the retained JSON', t => {
  const f = fixture(t), slot = clipDraft(f, randomUUID());
  slot.draft!.raw.name = `界🙂 ${f.assetId}`;
  const original = JSON.stringify(slot), raw = original + ' '.repeat(8192 - Buffer.byteLength(original));
  assert.equal(Buffer.byteLength(raw), 8192);
  retainClipDraft(f, slot, raw);
  assert.deepEqual(f.read(), {status: 'clear'});
  assert.equal(f.store.db.prepare('SELECT data FROM main.local_clip_drafts').get()!.data, raw);
});

test('S8 scope, delivery and text records carry text and fixed intents rather than asset references', t => {
  const f = fixture(t), timelineId = randomUUID(), shotId = randomUUID(), draftId = randomUUID();
  const delivery = {projectId: f.projectId, draftRevision: 1,
    draft: {draftId, timelineId, baseRevision: 1, raw: {deliveryName: f.assetId}, updatedAt: now}, intentRevision: 1,
    intent: {intentId: randomUUID(), timelineId, baseRevision: 1, draft: {draftId, revision: 1, raw: {deliveryName: f.assetId}},
      input: {projectId: f.projectId, expectedRevision: 1, requestId: randomUUID(), purpose: 'export', deliveryName: f.assetId},
      createdAt: now, outcome: {status: 'pending'}}};
  const text = {projectId: f.projectId, shotId, draftRevision: 1,
    draft: {draftId, baseRevision: 1, baseText: {title: 'Before', prompt: ''}, raw: {title: f.assetId, prompt: f.assetId}, updatedAt: now}, intentRevision: 1,
    intent: {intentId: randomUUID(), baseRevision: 1, baseText: {title: 'Before', prompt: ''},
      draft: {draftId, revision: 1, raw: {title: f.assetId, prompt: f.assetId}},
      input: {requestId: randomUUID(), shotId, expectedRevision: 1, patch: {title: f.assetId, prompt: f.assetId}},
      createdAt: now, outcome: {status: 'pending'}}};
  assert.ok(createLocalDeliverySchemas(value => schemas['timeline.render'].safeParse(value).success).slot.safeParse(delivery).success);
  assert.ok(createLocalShotTextSchemas(value => schemas['shot.update'].safeParse(value).success).slot.safeParse(text).success);
  f.store.tx(() => {
    for (const kind of ['clip', 'delivery', 'shot-text'])
      f.store.db.prepare('INSERT INTO main.local_draft_states(kind,workspaceScope) VALUES(?,?)').run(kind, hash);
    f.store.db.prepare('INSERT INTO main.local_delivery_drafts(projectId,draftRevision,intentRevision,intentId,requestId,intentStatus,data,ordinal) VALUES(?,1,1,?,?,\'pending\',?,1)')
      .run(f.projectId, delivery.intent.intentId, delivery.intent.input.requestId, JSON.stringify(delivery));
    f.store.db.prepare('INSERT INTO main.local_shot_text_drafts(projectId,shotId,draftRevision,intentRevision,intentId,requestId,intentStatus,data,ordinal) VALUES(?,?,1,1,?,?,\'pending\',?,1)')
      .run(f.projectId, shotId, text.intent.intentId, text.intent.input.requestId, JSON.stringify(text));
  });
  assert.deepEqual(f.read(), {status: 'clear'});
});

for (const state of ['applied', 'reverted', 'superseded'] as const)
  test(`Mio ${state} compensation history only blocks a still recoverable reference`, t => {
    const f = fixture(t), {run, step} = mioAudit(f), current = shot(f), previous = {...current, referenceAssetIds: [f.assetId]};
    f.store.put('shots', current);
    const id = randomUUID(), before = {kind: 'shot', id: current.id, table: 'shots', value: previous, revision: 1},
      after = {...before, value: current, revision: 2};
    const value = {id, runId: run, stepId: step, projectId: f.projectId, operation: 'shot.update', targets: [{kind: 'shot', id: current.id, revision: 2}],
      before: [before], after: [after], undo: [{before, after}], reversible: true, status: state, createdAt: now};
    f.store.db.prepare('INSERT INTO main.mio_changes(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(id, run, step, f.projectId, JSON.stringify(value));
    assert.deepEqual(f.read(), state === 'applied' ? {status: 'referenced', source: 'main.mio_changes.data'} : {status: 'clear'});
  });

for (const [table, columns, values] of [
  ['asset_annotations', 'assetId,projectId,revision,tags,note', [1, '[]', '']],
  ['asset_dispositions', 'assetId,projectId,revision,disposition', [1, 'neutral']],
  ['asset_ranges', 'assetId,projectId,revision,inFrame,outFrame', [1, 0, 1]],
] as const) test(`native FK ${table} refuses deletion even for neutral sidecar state`, t => {
  const f = fixture(t);
  f.store.db.prepare(`INSERT INTO project.${table}(${columns}) VALUES(${Array(values.length + 2).fill('?').join(',')})`).run(f.assetId, f.projectId, ...values);
  assert.deepEqual(f.read(), {status: 'referenced', source: `project.${table}.assetId`});
});

test('native subject versions are consumers independently of JSON visibility', t => {
  const f = fixture(t), subject = randomUUID(), version = randomUUID();
  f.store.tx(() => {
    f.store.db.prepare('INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt) VALUES(?,?,\'character\',\'Person\',1,?,?,?)').run(subject, f.projectId, version, now, now);
    f.store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,1,?,?)').run(version, f.projectId, subject, f.assetId,
      JSON.stringify({id: version, projectId: f.projectId, subjectId: subject, number: 1, assetId: f.assetId}));
  });
  assert.deepEqual(f.read(), {status: 'referenced', source: 'project.subject_versions.assetId'});
});

test('native image version FK is checked before presentation data', t => {
  const f = fixture(t), groupId = randomUUID(), id = randomUUID(), taskId = randomUUID();
  f.store.tx(() => {
    f.store.db.prepare('INSERT INTO project.image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt) VALUES(?,?,\'Image\',1,?,NULL,?,?)')
      .run(groupId, f.projectId, id, now, now);
    f.store.db.prepare('INSERT INTO project.image_versions(id,projectId,groupId,taskId,number,assetId,data) VALUES(?,?,?,?,1,?,?)')
      .run(id, f.projectId, groupId, taskId, f.assetId, JSON.stringify({id, projectId: f.projectId, groupId, taskId, number: 1, assetId: f.assetId}));
  });
  assert.deepEqual(f.read(), {status: 'referenced', source: 'project.image_versions.assetId'});
});

test('native scene result FK retains its source', t => {
  const f = fixture(t), taskId = acceptScene(f);
  f.store.db.prepare("UPDATE main.scene_tasks SET state='running',started=1,revision=2 WHERE id=?").run(taskId);
  f.store.db.prepare(`INSERT INTO project.scene_results(id,projectId,assetId,position,sourceHash,origin,taskId,profileId,fps,frameCount,options,cuts,createdAt)
    VALUES(?,?,?,1,?,'detected',?,'scene-cuts-v1',30,150,'{}','[]',?)`).run(randomUUID(), f.projectId, f.assetId, hash, taskId, now);
  assert.deepEqual(f.read(), {status: 'referenced', source: 'project.scene_results.assetId'});
});

function acceptFrame(f: Fixture, sourceAssetId: string, outputAssetId?: string) {
  const id = randomUUID(), requestId = randomUUID(), db = f.store.db;
  const input = {projectId: f.projectId, requestId, sourceAssetId, sourceHash: hash, sourceFrame: 0};
  const frozen = {schemaVersion: 1, projectId: f.projectId, taskId: id,
    source: {assetId: sourceAssetId, sha256: hash, mimeType: 'video/mp4', sizeBytes: 100, reference: f.asset.reference, referenceRevision: 1, duration: 5, width: 1024, height: 1024},
    requested: {sourceFrame: 0, fps: 30}, profile: FRAME_PROFILE};
  const response = {id, projectId: f.projectId, requestId, sourceAssetId, sourceHash: hash, sourceFrame: 0, fps: 30, profileId: FRAME_PROFILE_ID,
    state: 'queued', revision: 1, started: false, result: null, errorCode: null, createdAt: now, updatedAt: now};
  f.store.tx(() => {
    db.prepare(`INSERT INTO main.frame_tasks(id,projectId,requestId,inputHash,input,snapshot,state,revision,started,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,'queued',1,0,?,?)`).run(id, f.projectId, requestId, hash, JSON.stringify(input), JSON.stringify(frozen), now, now);
    db.prepare(`INSERT INTO main.frame_requests(requestId,operation,projectId,taskId,inputHash,canonicalInput,response) VALUES(?,'frame.extract',?,?,?,?,?)`)
      .run(requestId, f.projectId, id, hash, JSON.stringify(input), JSON.stringify(response));
    if (outputAssetId) {
      const receipt = {schemaVersion: 1, projectId: f.projectId, taskId: id, inputHash: hash, sourceAssetId, sourceHash: hash, sourceFrame: 0,
        fps: 30, profileId: FRAME_PROFILE_ID, selectionRule: FRAME_SELECTION_RULE, assetId: outputAssetId, sha256: hash, mimeType: 'image/png', width: 1024, height: 1024,
        byteLength: 100, probe: {streamIndex: 0, timeBaseNumerator: 1, timeBaseDenominator: 30, width: 1024, height: 1024, rotation: 0, sarNumerator: 1, sarDenominator: 1}};
      db.prepare("UPDATE main.frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(id);
      db.prepare("UPDATE main.frame_tasks SET state='persisting',stagedReceipt=?,revision=3 WHERE id=?").run(JSON.stringify(receipt), id);
      db.prepare("UPDATE main.frame_tasks SET state='succeeded',assetId=?,revision=4 WHERE id=?").run(outputAssetId, id);
    }
  });
}

test('frame output is a true cross-file FK even without a visible node', t => {
  const f = fixture(t), source = randomUUID();
  f.store.put('assets', {...f.asset, id: source, mimeType: 'video/mp4', duration: 5});
  acceptFrame(f, source, f.assetId);
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.frame_tasks.assetId'});
});

test('queued frame input consumes a source before output registration', t => {
  const f = fixture(t); f.store.put('assets', {...f.asset, mimeType: 'video/mp4', duration: 5});
  acceptFrame(f, f.assetId);
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.frame_requests.canonicalInput'});
});

function acceptScene(f: Fixture): string {
  const id = randomUUID(), requestId = randomUUID(), options = {mode: 'adaptive', sensitivity: 60, minShotSeconds: 0.6};
  f.store.put('assets', {...f.asset, mimeType: 'video/mp4', duration: 5});
  const input = {projectId: f.projectId, sourceAssetId: f.assetId, sourceHash: hash, options, requestId};
  const frozen = {schemaVersion: 1, projectId: f.projectId, taskId: id, kind: 'detect', source: {assetId: f.assetId, sha256: hash, mimeType: 'video/mp4', sizeBytes: 100,
    reference: f.asset.reference, referenceRevision: 1, duration: 5}, options, profileId: 'scene-cuts-v1', fps: 30};
  const response = {id, projectId: f.projectId, kind: 'detect', requestId, sourceAssetId: f.assetId, sourceHash: hash, options, profileId: 'scene-cuts-v1',
    fps: 30, state: 'queued', revision: 1, started: false, resultId: null, errorCode: null, createdAt: now, updatedAt: now};
  f.store.tx(() => {
    f.store.db.prepare(`INSERT INTO main.scene_tasks(id,projectId,kind,sourceAssetId,requestId,inputHash,input,snapshot,state,revision,started,createdAt,updatedAt)
      VALUES(?,?,'detect',?,?,?,?,?,'queued',1,0,?,?)`).run(id, f.projectId, f.assetId, requestId, hash, JSON.stringify(input), JSON.stringify(frozen), now, now);
    f.store.db.prepare(`INSERT INTO main.scene_requests(requestId,operation,projectId,taskId,inputHash,canonicalInput,response) VALUES(?,'scene.detect',?,?,?,?,?)`)
      .run(requestId, f.projectId, id, hash, JSON.stringify(input), JSON.stringify(response));
  });
  return id;
}

test('scene source is a true cross-file FK before execution', t => {
  const f = fixture(t); acceptScene(f);
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.scene_tasks.sourceAssetId'});
});

test('mio_imports remains a real cross-file FK, unlike the import change/step audit', t => {
  const f = fixture(t);
  f.store.db.prepare(`INSERT INTO main.mio_imports(id,projectId,requestId,name,mimeType,relativePath,sha256,status,assetId,createdAt)
    VALUES(?,?,?,?,?,?,?,'imported',?,?)`).run(randomUUID(), f.projectId, randomUUID(), 'Selected', 'image/png', 'private.png', hash, f.assetId, now);
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.mio_imports.assetId'});
});

for (const kind of ['shot', 'tail', 'node-image', 'node-video', 'node-audio', 'previs', 'edge', 'version'] as const)
  test(`current ${kind} has an explicit asset consumer`, t => {
    const f = fixture(t);
    if (kind === 'shot' || kind === 'tail') f.store.put('shots', {...shot(f, kind === 'shot' ? [f.assetId] : []), ...(kind === 'tail' ? {lastFrameAssetId: f.assetId} : {})});
    else if (kind.startsWith('node-')) f.store.put('nodes', {id: randomUUID(), projectId: f.projectId, type: kind.slice(5), assetId: f.assetId, revision: 1});
    else if (kind === 'previs') {
      const scene = defaultPrevisScene(); scene.keyframes = [{id: 'k1', name: '', camera: scene.camera, exports: [f.assetId]}];
      f.store.put('nodes', {id: randomUUID(), projectId: f.projectId, type: 'previs', label: '', text: '', position: {x: 0, y: 0}, revision: 1, sceneRevision: 1, scene, createdAt: now});
    } else if (kind === 'edge') f.store.put('edges', {id: randomUUID(), projectId: f.projectId, source: randomUUID(), target: randomUUID(), kind: 'reference', role: 'first_frame', sourceAssetId: f.assetId, createdAt: now});
    else f.store.put('versions', {id: randomUUID(), projectId: f.projectId, jobId: randomUUID(), assetId: f.assetId, snapshot: snapshot(f)});
    assert.equal(f.read().status, 'referenced');
  });

for (const location of ['current', 'history-before', 'history-after', 'receipt', 'render-receipt'] as const)
  test(`timeline ${location} retains a source after current clips were removed`, t => {
    const f = fixture(t), full = timeline(f, true), empty = {...full, clips: [], durationFrames: 0};
    f.store.put('timelines', location === 'current' ? full : empty);
    if (location.startsWith('history-')) {
      const saved = (value: typeof full) => JSON.stringify({tracks: value.tracks, clips: value.clips, durationFrames: value.durationFrames});
      f.store.db.prepare('INSERT INTO main.timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,1,\'timeline.clip.remove\',?,?,?)')
        .run(randomUUID(), f.projectId, now, saved(location === 'history-before' ? full : empty), saved(location === 'history-after' ? full : empty));
    } else if (location === 'receipt') f.store.db.prepare('INSERT INTO main.timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(randomUUID(), hash, JSON.stringify(full));
    else if (location === 'render-receipt') {
      const requestId = randomUUID(), value = {id: randomUUID(), projectId: f.projectId, requestId, mode: 'timeline', purpose: 'export', timelineRevision: 1,
        snapshot: {timeline: full, assets: [{id: f.assetId, sha256: hash, mimeType: 'image/png', width: 1024, height: 1024, hasAudio: false}]},
        status: 'queued', assetId: null, url: null, error: null, createdAt: now, updatedAt: now};
      f.store.db.prepare('INSERT INTO main.timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(requestId, hash, JSON.stringify(value));
    }
    assert.equal(f.read().status, 'referenced');
  });

for (const [name, patch] of [
  ['direct', (f: Fixture) => ({referenceAssetIds: [f.assetId]})],
  ['tail', (f: Fixture) => ({lastFrameAssetId: f.assetId})],
  ['frozen image', (f: Fixture) => ({referenceAssets: [{id: f.assetId}]})],
  ['binding', (f: Fixture) => ({referenceBindings: [{role: 'first_frame', assetId: f.assetId, sha256: hash}]})],
  ['connection', (f: Fixture) => ({referenceConnections: [{sourceAssetId: f.assetId}]})],
  ['audio', (f: Fixture) => ({referenceAudios: [{id: f.assetId, role: 'reference_audio'}]})],
  ['video input image', (f: Fixture) => ({videoInput: {version: 1, mode: 'reference_images', images: [{role: 'reference_image', assetId: f.assetId}]}})],
  ['video input audio', (f: Fixture) => ({videoInput: {version: 1, mode: 'reference_images', images: [], audios: [{role: 'reference_audio', assetId: f.assetId}]}})],
] as const) test(`failed generation still consumes ${name}`, t => {
  const f = fixture(t); job(f, snapshot(f, patch(f))); assert.equal(f.read().status, 'referenced');
});

test('a frozen generation without a relation stays clear, while unknown fields cannot prove absence', t => {
  const f = fixture(t); job(f, snapshot(f)); assert.deepEqual(f.read(), {status: 'clear'});
  job(f, snapshot(f, {futureMediaBindings: []})); assert.deepEqual(f.read(), {status: 'unproven', reason: 'unsupported'});
});

for (const [name, capabilities, expected] of [
  ['retained capability version 5', {schemaVersion: 5}, {status: 'clear'}],
  ['version 6 in another history column', {schemaVersion: 6}, {status: 'unproven', reason: 'unsupported'}],
  ['nested version 6 outside the intent root', {nested: {schemaVersion: 6}}, {status: 'unproven', reason: 'unsupported'}],
  ['future version 7', {schemaVersion: 7}, {status: 'unproven', reason: 'unsupported'}],
] as const) test(`G1a's narrow review exception keeps ${name} explicitly classified`, t => {
  const f = fixture(t); job(f, snapshot(f, {capabilities}));
  assert.deepEqual(f.read(), expected);
});

test('image edit acceptance consumes its source before there is any result asset', t => {
  const f = fixture(t), requestId = randomUUID(), input = {projectId: f.projectId, requestId, name: 'Edit', prompt: 'Edit it', providerId: 'mock', model: 'mock-image-v1',
    options: IMAGE_FIXED_OPTIONS, purpose: 'edit', inputImage: {assetId: f.assetId, sha256: hash}};
  f.store.db.prepare(`INSERT INTO main.image_requests(requestId,operation,projectId,inputHash,canonicalInput,response) VALUES(?,'image.generate',?,?,?,?)`)
    .run(requestId, f.projectId, hash, JSON.stringify(input), JSON.stringify({id: randomUUID(), groupId: randomUUID(), ...input,
      state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: now, updatedAt: now}));
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.image_requests.canonicalInput'});
});

test('legacy storyboard export freezes source IDs even after the shot/version went away', t => {
  const f = fixture(t);
  f.store.put('exports', {id: randomUUID(), projectId: f.projectId, status: 'cancelled', snapshot: [{assetId: f.assetId, versionId: randomUUID(), shotId: randomUUID(), sha256: hash}], assetId: null});
  assert.equal(f.read().status, 'referenced');
});

test('portable extracted-frame provenance still consumes the original source without a local task', t => {
  const f = fixture(t), id = randomUUID(), taskId = randomUUID();
  f.store.put('assets', {...f.asset, id, provenance: 'extracted-frame', frameResult: {requestId: randomUUID(), receipt: {schemaVersion: 1, projectId: f.projectId,
    taskId, inputHash: hash, sourceAssetId: f.assetId, sourceHash: hash, sourceFrame: 0, fps: 30, profileId: FRAME_PROFILE_ID, selectionRule: FRAME_SELECTION_RULE,
    assetId: id, sha256: hash, mimeType: 'image/png', width: 1024, height: 1024, byteLength: 100,
    probe: {streamIndex: 0, timeBaseNumerator: 1, timeBaseDenominator: 30, width: 1024, height: 1024, rotation: 0, sarNumerator: 1, sarDenominator: 1}}}});
  assert.equal(f.read().status, 'referenced');
});

test('recoverable project versions retain the registration itself', t => {
  const f = fixture(t);
  f.store.tx(() => {const saved = captureProjectDocumentInside(f.store); storeManualVersionInside(f.store.db, f.projectId, 'Saved', saved.evidence.contentSequence, encodeProjectDocument(saved));});
  assert.deepEqual(f.read(), {status: 'referenced', source: 'main.project_versions.assets'});
});

test('a version captured before this registration is not a permanent consumer', t => {
  const f = fixture(t, false);
  f.store.tx(() => {const saved = captureProjectDocumentInside(f.store); storeManualVersionInside(f.store.db, f.projectId, 'Before', saved.evidence.contentSequence, encodeProjectDocument(saved));});
  f.store.put('assets', f.asset);
  assert.deepEqual(f.read(), {status: 'clear'});
});

function retainFormat(f: Fixture, format: number, mioRunId?: string) {
  const document = f.store.tx(() => captureProjectDocumentInside(f.store));
  const raw = Buffer.from(canonicalJson({...document, projectFormatVersion: format})), payload = gzipSync(raw, {level: 1});
  const blob = {profile: 1 as const, codec: 'gzip' as const, hash: createHash('sha256').update(raw).digest('hex'), rawBytes: raw.length,
    compressedBytes: payload.length, payload};
  const version = f.store.tx(() => storeProjectVersionInside(f.store.db, {projectId: f.projectId,
    trigger: mioRunId ? 'mio-turn' : 'manual', ...(mioRunId ? {mioRunId} : {}), contentSequence: document.evidence.contentSequence,
    blob, mioChangeRowid: 0, createdAt: now}));
  return {document, blob, version};
}
function assertRetainedBlob(f: Fixture, expected: {hash: string; payload: Uint8Array}): void {
  const row = f.store.db.prepare('SELECT hash,payload FROM main.project_version_blobs WHERE hash=?').get(expected.hash), payload = row?.payload;
  assert.equal(row?.hash, expected.hash); assert.ok(payload instanceof Uint8Array);
  assert.deepEqual(Buffer.from(payload), Buffer.from(expected.payload));
}

test('V5 history-resolution confirmation is an audit ACK, not a media consumer', t => {
  const f = fixture(t), requestId = randomUUID(), content = f.store.db.prepare('SELECT contentSequence,contentToken FROM project.project_file').get();
  f.store.db.prepare('INSERT INTO main.project_history_resolution(singleton,requestId,digest,result) VALUES(1,?,?,?)')
    .run(requestId, hash, JSON.stringify({projectId: f.projectId, requestId, action: 'continue',
      archive: `history-20261104000000-${requestId}.db`, content, activation: 'pending'}));
  assert.deepEqual(f.read(), {status: 'clear'});
});

for (const includesAsset of [false, true]) test(`V5 format-2 snapshot ${includesAsset ? 'retains its asset' : 'before creation stays clear'} through the supported decoder`, t => {
  const f = fixture(t, includesAsset), saved = retainFormat(f, 2);
  assert.equal(saved.document.projectFormatVersion, 3, 'The live kernel captures current format 3');
  if (!includesAsset) f.store.put('assets', f.asset);
  assert.deepEqual(f.read(), includesAsset ? {status: 'referenced', source: 'main.project_versions.assets'} : {status: 'clear'});
  assertRetainedBlob(f, saved.blob);
});

test('V5 preserves format 1 without granting a current-business decoder to dependency proof', t => {
  const f = fixture(t, false), saved = retainFormat(f, 1);
  f.store.put('assets', f.asset);
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'unsupported'});
  assertRetainedBlob(f, saved.blob);
});

test('unknown historical formats remain fail-closed without rewriting their retained blob', t => {
  const f = fixture(t, false), saved = retainFormat(f, 99);
  f.store.put('assets', f.asset);
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'invalid'});
  assertRetainedBlob(f, saved.blob);
});

test('V5 replacement history retains a format-2 Mio version consumer without copying its execution owner', t => {
  const source = fixture(t), {run} = mioAudit(source), saved = retainFormat(source, 2, run);
  const target = fixture(t, false, source.projectId);
  target.store.tx(() => copyProjectVersionsInside(source.store.db, target.store.db, {projectId: source.projectId}));
  target.store.put('assets', source.asset);
  assert.equal(target.store.db.prepare('SELECT count(*) n FROM main.mio_runs').get()?.n, 0);
  assert.equal(target.store.db.prepare('SELECT mioRunId FROM main.project_versions WHERE id=?').get(saved.version.id)?.mioRunId, run);
  const before = target.changes();
  assert.deepEqual(readMioProjectImportDependencies(target.store, source.assetId), {status: 'referenced', source: 'main.project_versions.assets'});
  assert.equal(target.changes(), before);
  assertRetainedBlob(target, saved.blob);
});

for (const [name, body, reason] of [
  ['invalid JSON', '{broken', 'invalid'],
  ['duplicate keys', '{"id":"x","id":"y"}', 'invalid'],
  ['unknown shape', JSON.stringify({id: randomUUID(), type: 'future'}), 'invalid'],
  ['oversized cell', ' '.repeat(33 * 1024), 'limit'],
  ['deep value', JSON.stringify({value: JSON.parse('['.repeat(66) + '0' + ']'.repeat(66))}), 'limit'],
] as const) test(`${name} refuses an empty dependency proof`, t => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO project.nodes(id,projectId,data) VALUES(?,?,?)').run(randomUUID(), f.projectId, body);
  assert.deepEqual(f.read(), {status: 'unproven', reason});
});

test('unknown kernel tables fail closed', t => {
  const f = fixture(t); f.store.db.exec('CREATE TABLE project.future_media_links(id TEXT)');
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'unsupported'});
});

test('damaged and unknown live Mio compensation records cannot prove absence', t => {
  const f = fixture(t), {run, step} = mioAudit(f), id = randomUUID();
  f.store.db.prepare('INSERT INTO main.mio_changes(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(id, run, step, f.projectId, '{}');
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'invalid'});
});

test('wrong JSON owner refuses a proof even when SQL ownership is local', t => {
  const f = fixture(t), id = randomUUID();
  f.store.db.prepare('INSERT INTO project.nodes(id,projectId,data) VALUES(?,?,?)').run(id, f.projectId, JSON.stringify({id, projectId: randomUUID(), type: 'text'}));
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'invalid'});
});

test('the row budget never silently truncates later consumers', t => {
  const f = fixture(t), put = f.store.db.prepare('INSERT INTO project.nodes(id,projectId,data) VALUES(?,?,?)');
  f.store.tx(() => {for (let index = 0; index < LIMITS.rows; index++) {const id = randomUUID(); put.run(id, f.projectId, JSON.stringify({id, projectId: f.projectId, type: 'text'}));}});
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'limit'});
});

test('version metadata is bounded before loading or inflating a blob', t => {
  const f = fixture(t);
  f.store.tx(() => {
    f.store.db.prepare('INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,1,\'gzip\',?,1,?)')
      .run(hash, LIMITS.totalBytes + 1, Buffer.from('x'));
    f.store.db.prepare(`INSERT INTO main.project_versions(id,projectId,trigger,name,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(?,?,'manual',NULL,0,?,?,0)`)
      .run(randomUUID(), f.projectId, now, hash);
  });
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'limit'});
});

test('cumulative retained bytes and JSON nodes have independent limits', t => {
  const f = fixture(t), insert = f.store.db.prepare('INSERT INTO main.jobs(id,projectId,data) VALUES(?,?,?)');
  f.store.tx(() => {
    for (let index = 0; index < Math.ceil(LIMITS.totalBytes / 120000); index++) {
      const id = randomUUID(); insert.run(id, f.projectId, JSON.stringify({id, projectId: f.projectId, status: 'failed', snapshot: snapshot(f), error: 'x'.repeat(120000)}));
    }
  });
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'limit'});
});

test('many small numeric JSON values do not bypass the node budget', t => {
  const f = fixture(t), insert = f.store.db.prepare('INSERT INTO main.jobs(id,projectId,data) VALUES(?,?,?)');
  f.store.tx(() => {for (let index = 0; index < 5; index++) {const id = randomUUID(); insert.run(id, f.projectId,
    JSON.stringify({id, projectId: f.projectId, status: 'failed', snapshot: snapshot(f), error: Array(50000).fill(0)}));}});
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'limit'});
});

test('bad gzip cannot be treated as an empty historical version', t => {
  const f = fixture(t);
  f.store.tx(() => {
    f.store.db.prepare('INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,1,\'gzip\',1,1,?)').run(hash, Buffer.from('x'));
    f.store.db.prepare(`INSERT INTO main.project_versions(id,projectId,trigger,name,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(?,?,'manual',NULL,0,?,?,0)`)
      .run(randomUUID(), f.projectId, now, hash);
  });
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'invalid'});
});

test('the distinct version-blob limit refuses rather than skipping older recovery content', t => {
  const f = fixture(t, false);
  for (let index = 0; index <= LIMITS.versionBlobs; index++) f.store.tx(() => {
    f.store.put('projects', {id: f.projectId, name: `Before ${index}`, revision: 1, createdAt: now, updatedAt: now});
    const saved = captureProjectDocumentInside(f.store);
    storeManualVersionInside(f.store.db, f.projectId, null, saved.evidence.contentSequence, encodeProjectDocument(saved));
  });
  f.store.put('assets', f.asset);
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'limit'});
});

function customServiceReviewIntent(f: Fixture, groupId?: string) {
  const reviewId = randomUUID(), configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true,
    baseUrl: 'https://images.example.test/review/v1', model: 'import-proof-image-model'};
  const input = {projectId: f.projectId, requestId: randomUUID(), name: f.assetId, prompt: `Unrelated user text: ${f.assetId}`,
    providerId: 'openai-compatible', model: configuration.model, options: IMAGE_FIXED_OPTIONS,
    ...(groupId ? {groupId, expectedRevision: 1} : {})};
  const parsed = imageReviewIntentSchema.parse({schemaVersion: 6, reviewId, input, settingsRevision: 1,
    connectionId: randomUUID(), configurationRevision: 1, configuration,
    destination: `${configuration.baseUrl}/images/generations`, policy: IMAGE_REVIEW_POLICY});
  assert.equal(parsed.schemaVersion, 6);
  if (parsed.schemaVersion !== 6) assert.fail('The fixture must be the exact text-to-image service review contract');
  assert.equal('purpose' in parsed.input, false); assert.equal('inputImage' in parsed.input, false); assert.equal('sourceImage' in parsed, false);
  return parsed;
}
function retainServiceReview(f: Fixture, intent: ReturnType<typeof customServiceReviewIntent>, options: {rawIntent?: string; corrupt?: boolean} = {}) {
  const canonicalInput = JSON.stringify(intent.input), canonicalIntent = options.rawIntent ?? JSON.stringify(intent),
    digest = (value: string) => createHash('sha256').update(value).digest('hex');
  // Only explicit negative persisted-corruption cases bypass the fixture CHECK.
  // The production catalog and every valid v6 insert retain their exact checks.
  if (options.corrupt) f.store.db.exec('PRAGMA ignore_check_constraints=ON');
  try {
    f.store.db.prepare(`INSERT INTO main.image_reviews(id,projectId,requestId,inputHash,canonicalInput,intentHash,canonicalIntent,
      state,revision,taskId,postAttempts,createdAt,updatedAt,approvedAt,rejectedAt,dispatchedAt)
      VALUES(?,?,?,?,?,?,?,'pending',1,NULL,0,?,?,NULL,NULL,NULL)`)
      .run(intent.reviewId, f.projectId, intent.input.requestId, digest(canonicalInput), canonicalInput, digest(canonicalIntent), canonicalIntent, now, now);
  } finally {if (options.corrupt) f.store.db.exec('PRAGMA ignore_check_constraints=OFF');}
  return canonicalIntent;
}
function assertReviewProofUnchanged(f: Fixture, expected: ReturnType<typeof readMioProjectImportDependencies>) {
  const before = JSON.stringify(f.store.db.prepare('SELECT rowid,* FROM main.image_reviews ORDER BY rowid').all()), changes = f.changes();
  assert.deepEqual(f.read(), expected); assert.equal(f.changes(), changes);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT rowid,* FROM main.image_reviews ORDER BY rowid').all()), before);
}

test('G1a valid root v6 service review without an asset relation grants a clear metadata-only proof', t => {
  const f = fixture(t), intent = customServiceReviewIntent(f), retained = retainServiceReview(f, intent);
  assert.ok(imageReviewIntentSchema.safeParse(JSON.parse(retained)).success);
  assertReviewProofUnchanged(f, {status: 'clear'});
  assert.equal(f.store.db.prepare('SELECT canonicalIntent FROM main.image_reviews WHERE id=?').get(intent.reviewId)!.canonicalIntent, retained);
});

test('G1a valid v6 group target retains its image version asset through the actual project FK', t => {
  const f = fixture(t), groupId = randomUUID(), versionId = randomUUID(), taskId = randomUUID();
  const version = imageVersionResponseSchema.parse({id: versionId, projectId: f.projectId, groupId, taskId, number: 1, assetId: f.assetId,
    sha256: hash, mimeType: 'image/png', width: 1024, height: 1024, byteLength: 100, isMock: true,
    providerId: 'mock', model: 'mock-image-v1', options: IMAGE_FIXED_OPTIONS, createdAt: now});
  f.store.tx(() => {
    f.store.db.prepare(`INSERT INTO project.image_groups(id,projectId,name,revision,headVersionId,activeTaskId,createdAt,updatedAt)
      VALUES(?,?,?,1,?,NULL,?,?)`).run(groupId, f.projectId, f.assetId, versionId, now, now);
    f.store.db.prepare('INSERT INTO project.image_versions(id,projectId,groupId,taskId,number,assetId,data) VALUES(?,?,?,?,1,?,?)')
      .run(versionId, f.projectId, groupId, taskId, f.assetId, JSON.stringify(version));
  });
  const intent = customServiceReviewIntent(f, groupId), retained = retainServiceReview(f, intent);
  assert.ok(imageReviewIntentSchema.safeParse(JSON.parse(retained)).success);
  assert.equal(intent.input.groupId, version.groupId); assert.equal(version.assetId, f.assetId);
  assert.deepEqual(f.store.db.prepare('PRAGMA project.foreign_key_check').all(), []);
  const before = JSON.stringify(f.store.db.prepare('SELECT rowid,* FROM project.image_versions').all());
  assertReviewProofUnchanged(f, {status: 'referenced', source: 'project.image_versions.assetId'});
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT rowid,* FROM project.image_versions').all()), before);
});

for (const damage of ['missing-connection', 'mismatched-revision', 'nested-version', 'future-v7'] as const)
  test(`G1a ${damage} in canonicalIntent remains contract-invalid rather than widening the version exception`, t => {
    const f = fixture(t), intent = customServiceReviewIntent(f), damaged: Record<string, unknown> = structuredClone(intent);
    if (damage === 'missing-connection') delete damaged.connectionId;
    else if (damage === 'mismatched-revision') damaged.configurationRevision = 2;
    else if (damage === 'nested-version') damaged.extra = {schemaVersion: 6};
    else damaged.schemaVersion = 7;
    assert.equal(imageReviewIntentSchema.safeParse(damaged).success, false);
    const retained = retainServiceReview(f, intent, {rawIntent: JSON.stringify(damaged), corrupt: true});
    // canonicalIntent is validated as a contract before its tree is traversed.
    // Wrong-column/nested capability v6 and future v7 cases above remain unsupported.
    assertReviewProofUnchanged(f, {status: 'unproven', reason: 'invalid'});
    assert.equal(f.store.db.prepare('SELECT canonicalIntent FROM main.image_reviews WHERE id=?').get(intent.reviewId)!.canonicalIntent, retained);
  });

test('G1a v6 review cannot borrow a foreign JSON project owner through a local SQL row', t => {
  const f = fixture(t), valid = customServiceReviewIntent(f), intent = {...valid, input: {...valid.input, projectId: randomUUID()}};
  assert.ok(imageReviewIntentSchema.safeParse(intent).success);
  retainServiceReview(f, intent, {corrupt: true});
  assertReviewProofUnchanged(f, {status: 'unproven', reason: 'invalid'});
});

test('G1a valid v6 JSON does not bypass the existing canonicalIntent cell budget', t => {
  const f = fixture(t), intent = customServiceReviewIntent(f), original = JSON.stringify(intent), retained = original + ' '.repeat(LIMITS.cellBytes + 1 - Buffer.byteLength(original));
  assert.equal(Buffer.byteLength(retained), LIMITS.cellBytes + 1);
  assert.ok(imageReviewIntentSchema.safeParse(JSON.parse(retained)).success);
  retainServiceReview(f, intent, {rawIntent: retained, corrupt: true});
  assertReviewProofUnchanged(f, {status: 'unproven', reason: 'limit'});
});


test('candidate canvas patches are asset-free but archived consumers remain in the import dependency proof', t => {
  const f = fixture(t, true, undefined, true), {store, projectId} = f, canvas = createCanvasEditing(store);
  const {requestEpoch, requestAfter} = canvasEditingResponses['canvas.history.get'].parse(canvas.call('canvas.history.get', {projectId}));
  const request = () => createCanvasRequestId(requestEpoch, randomUUID(), Math.max(Date.now(), requestAfter + 1));
  const node = {id: randomUUID(), projectId, type: 'text', revision: 1, position: {x: 0, y: 0}, createdAt: now, updatedAt: now};
  store.put('nodes', node);
  const target = (id: string) => ({kind: 'node', id, revision: readMioTargetRevision(store.db, projectId, 'node', id)});
  const moved = canvasEditingResponses['canvas.apply'].parse(canvas.call('canvas.apply', {projectId, requestId: request(), operation: 'move', historyRevision: 0,
    moves: [{...target(node.id), position: {x: 50, y: 60}}]}));
  assert.deepEqual(f.read(), {status: 'clear'});
  const beforePatch = store.db.prepare('SELECT beforePatch FROM main.canvas_history_entries WHERE id=?').get(moved.actionId)!.beforePatch!;
  store.db.prepare('UPDATE main.canvas_history_entries SET beforePatch=? WHERE id=?').run(JSON.stringify({assetId: f.assetId}), moved.actionId);
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'unsupported'});
  store.db.prepare('UPDATE main.canvas_history_entries SET beforePatch=? WHERE id=?').run(beforePatch, moved.actionId);
  const media = {...node, id: randomUUID(), type: 'image', assetId: f.assetId};
  store.put('nodes', media);
  canvas.call('canvas.apply', {projectId, requestId: request(), operation: 'archive', historyRevision: moved.history.revision, targets: [target(media.id)]});
  assert.equal(store.db.prepare('SELECT archiveReason FROM project.nodes WHERE id=?').get(media.id)?.archiveReason, 'user-delete');
  assert.deepEqual(f.read(), {status: 'referenced', source: 'project.nodes.data'});
});

test('strict canvas receipts do not consume the Mio import proof traversal budget', t => {
  const f = fixture(t, true, undefined, true);
  const response = canvasEditingResponses['canvas.apply'].parse({projectId: f.projectId, actionId: null, affected: 0,
    history: {revision: 0, undo: null, redo: null, conflict: false}, contentSequence: 0, contentToken: '0'.repeat(32)});
  const count = LIMITS.rows + 1;
  const raw = JSON.stringify(response).padEnd(Math.floor(LIMITS.totalBytes / count) + 1, ' ');
  const {db} = f.store;
  const insert = db.prepare("INSERT INTO main.canvas_requests(requestId,projectId,operation,inputDigest,response,createdAt) VALUES(?,?,'move',?,?,?)");
  f.store.tx(() => {
    for (let index = 0; index < count; index++) insert.run(`receipt-${index}`, f.projectId, hash, raw, now);
  });
  assert.deepEqual(f.read(), {status: 'clear'});
  insert.run('unknown-shape', f.projectId, hash, JSON.stringify({...response, assetId: f.assetId}), now);
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'unsupported'}, 'an unrecognized receipt must still fail closed');
});

test('the canvas receipt window is optional, but a malformed stored window refuses absence proof', t => {
  const f = fixture(t, true, undefined, true);
  const {db} = f.store;
  assert.deepEqual(f.read(), {status: 'clear'});
  db.exec('PRAGMA ignore_check_constraints=ON');
  try {db.prepare('INSERT OR REPLACE INTO main.canvas_receipt_window(singleton,epoch,floor) VALUES(1,?,0)').run('malformed');}
  finally {db.exec('PRAGMA ignore_check_constraints=OFF');}
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'unsupported'});
});

test('candidate import proof accepts private anchors only on valid archived shot content', t => {
  const f = fixture(t, false, undefined, true), {store, projectId} = f, canvas = createCanvasEditing(store);
  const {requestEpoch, requestAfter} = canvasEditingResponses['canvas.history.get'].parse(canvas.call('canvas.history.get', {projectId}));
  const first = shot(f), second = {...shot(f), orderIndex: 1};
  store.put('shots', first);
  store.put('shots', second);
  const requestId = createCanvasRequestId(requestEpoch, randomUUID(), Math.max(Date.now(), requestAfter + 1));
  canvas.call('canvas.apply', {projectId, requestId, operation: 'archive', historyRevision: 0,
    targets: [{kind: 'shot', id: first.id, revision: readMioTargetRevision(store.db, projectId, 'shot', first.id)}]});
  const saved = store.get('shots', first.id) as Record<string, unknown>;
  assert.deepEqual(saved[CANVAS_ARCHIVE_ORDER_FIELD], {previous: null, next: second.id});
  store.tx(() => {
    const document = captureProjectDocumentInside(store);
    storeManualVersionInside(store.db, projectId, 'Before import', document.evidence.contentSequence, encodeProjectDocument(document));
  });
  store.put('assets', f.asset);
  assert.deepEqual(f.read(), {status: 'clear'}, 'the archived shot and its named version do not consume the later asset');

  store.put('shots', {...second, [CANVAS_ARCHIVE_ORDER_FIELD]: {previous: null, next: first.id}});
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'invalid'}, 'a live shot cannot carry the private field');
  store.put('shots', second);

  store.put('shots', {...saved, [CANVAS_ARCHIVE_ORDER_FIELD]: {previous: null, next: second.id, assetId: f.assetId}});
  assert.deepEqual(f.read(), {status: 'unproven', reason: 'invalid'}, 'unknown anchor fields fail closed');
  store.put('shots', {...saved, referenceAssetIds: [f.assetId]});
  assert.deepEqual(f.read(), {status: 'referenced', source: 'project.shots.data'}, 'the archived shot still owns its real asset references');
});
