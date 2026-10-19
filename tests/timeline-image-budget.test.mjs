import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  TIMELINE_RESPONSE_BYTES, TIMELINE_SUBTITLE_PROFILE_ID,
  hasRequestNotAppliedProof, isTimelineMutationResponse, isTimelineRecord,
} from '@mioon/contracts';
import {
  openStore, installCurrentWorkspaceRestoreSchema, validateCurrentWorkspaceRestoreSchema,
  getWorkspaceRestoreContext,
  classifyCurrentWorkspaceSchema,
} from '../packages/business/src/db.ts';
import {createServices, hash} from '../packages/business/src/services.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {timelineImageResponseBudgetIssue} from '../packages/business/src/timeline-image-budget.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {parseCube3D} from '../packages/business/src/cube-lut.ts';
import {lutInputHash} from '../packages/business/src/lut-resource-validation.ts';
import {png, imageColour, sha, stamp} from './helpers/timeline-image-fixtures.ts';
import {snapshot, facade, open} from './workspace-schema26-fixtures.mjs';

const limit = 262144;
const budgetCode = 'TIMELINE_IMAGE_AGGREGATE_BUDGET';
const encodedBytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const cube = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
const sourceBytes = png({width: 4096, height: 506});
const editTables = ['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'];
const captureEdits = db => Object.fromEntries(editTables.map(table => [table,
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
]));
const totalChanges = db => db.prepare('SELECT total_changes() AS count').get().count;
const editableSnapshot = timeline => ({
  tracks: timeline.tracks, clips: timeline.clips, durationFrames: timeline.durationFrames,
  subtitles: timeline.subtitles,
});
const restoreMetadata = () => ({
  restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(),
  manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: stamp,
});

function corruptStoredText(db, table, sql, ...values) {
  const guards = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? AND sql LIKE '%BEFORE UPDATE%'").all(table);
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  try { db.prepare(sql).run(...values); }
  finally { for (const guard of guards) db.exec(guard.sql); }
}

// Each field is individually legal. JSON escaping, not JavaScript string length,
// is what brings this aggregate close to the retained 256 KiB record ceiling.
function crowdedTimeline({projectId = randomUUID(), assetId = randomUUID(), colour, provenance = false} = {}) {
  const tracks = Array.from({length: 12}, (_, index) => ({
    id: randomUUID(), name: '\u0001'.repeat(index === 11 ? 149 : 150), kind: 'video',
    orderIndex: index, hidden: false, muted: false,
  }));
  const clips = Array.from({length: 100}, (_, index) => ({
    id: randomUUID(), assetId, trackId: tracks[index % tracks.length].id,
    name: '\u0001'.repeat(200), startFrame: Math.floor(index / tracks.length) * 30,
    durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
    fadeInFrames: 0, fadeOutFrames: 0,
    ...(provenance ? {versionId: randomUUID(), shotId: randomUUID(), jobId: randomUUID()} : {}),
    colour,
  }));
  return {
    id: randomUUID(), projectId, revision: 1, fps: 30, width: 720, height: 1280,
    tracks, clips, durationFrames: 270, createdAt: stamp, updatedAt: stamp,
    subtitles: {profileId: TIMELINE_SUBTITLE_PROFILE_ID, cues: Array.from({length: 100}, (_, index) => ({
      id: randomUUID(), text: '界'.repeat(20) + '\n' + '界'.repeat(20), startFrame: index * 2, durationFrames: 2,
    }))},
  };
}

function tuneBytes(timeline, target) {
  let excess = encodedBytes(timeline) - target;
  assert.ok(excess >= 0, `fixture must start above ${target}, got ${encodedBytes(timeline)}`);
  for (const clip of timeline.clips) {
    const replacements = Math.min(Math.floor(excess / 5), clip.name.length);
    clip.name = 'x'.repeat(replacements) + clip.name.slice(replacements);
    excess -= replacements * 5;
    if (excess < 5) break;
  }
  // Replacing U+0001 by ASCII removes five encoded bytes. Removing the final
  // zero-to-four ASCII characters makes every single-byte boundary reachable.
  if (excess) {
    const clip = timeline.clips.find(clip => clip.name.startsWith('x'.repeat(excess)) && clip.name.length > excess);
    assert.ok(clip);
    clip.name = clip.name.slice(excess);
  }
  assert.equal(encodedBytes(timeline), target);
  return timeline;
}

async function fixture(t, {bytes = limit, revision = 1, updatedAt = stamp} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-image-budget-'));
  let store = openStore(root), services = createServices(store, new Map());
  const projectId = (await services.call('project.create', {name: 'Image aggregate budget'})).id;
  const assetId = randomUUID();
  const asset = store.put('assets', {
    id: assetId, projectId, name: 'Bound PNG', mimeType: 'image/png',
    relativePath: `media/${assetId}.png`, sha256: sha(sourceBytes), sizeBytes: sourceBytes.length,
    width: 4096, height: 506, duration: null, hasVideo: true, hasAudio: false,
    provenance: 'user-import', createdAt: stamp,
  });
  writeFileSync(path.join(root, asset.relativePath), sourceBytes);
  const resourceId = randomUUID();
  store.db.prepare('INSERT INTO project_lut_resources VALUES(?,?,?,?,?,?,?,?,?)').run(
    resourceId, projectId, 'look.cube', sha(cube), cube.length,
    'mioon-cube3d-normalized-tetrahedral-v1', JSON.stringify(parseCube3D(cube.toString()).metadata), cube, stamp,
  );
  const lutRequest = randomUUID();
  store.db.prepare('INSERT INTO lut_import_requests VALUES(?,?,?,?)').run(
    lutRequest, projectId, lutInputHash({projectId, requestId: lutRequest, name: 'look.cube'}, sha(cube), cube.length), resourceId,
  );
  const look = {
    resourceId, resourceSha256: sha(cube), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1',
    purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: 0.35,
  };
  const evidence = {
    profileId: 'png-rgb8-srgb-v1', sha256: asset.sha256, sourceByteLength: sourceBytes.length,
    width: 4096, height: 506, bitDepth: 8, alphaMode: 'straight', orientation: 1, colourTag: 'srgb',
  };
  const timeline = crowdedTimeline({projectId, assetId: asset.id, colour: imageColour(evidence, look)});
  timeline.revision = revision;
  timeline.updatedAt = updatedAt;
  tuneBytes(timeline, bytes);
  assert.equal(isTimelineRecord(timeline), true);
  store.put('timelines', timeline);
  const f = {
    root, projectId, asset, timeline,
    get store() { return store; },
    call: (operation, input, context) => services.call(operation, input, context),
    params: (current, extra = {}) => ({projectId, requestId: randomUUID(), expectedRevision: current.revision, ...extra}),
    async close() { await services.drain(); if (store.db.isOpen) store.close(); },
    async reopen() {
      await f.close();
      store = openStore(root);
      services = createServices(store, new Map());
    },
  };
  t.after(async () => { await f.close(); rmSync(root, {recursive: true, force: true}); });
  return f;
}

async function assertNoWrites(f, operation, input, {code = budgetCode, actualBytes, proof = true} = {}) {
  const before = captureEdits(f.store.db), changes = totalChanges(f.store.db);
  let rejection;
  await assert.rejects(f.call(operation, input), error => {
    rejection = error;
    assert.equal(error.code, code);
    assert.equal(error.details?.mutationOutcome, proof ? 'not_applied' : undefined);
    if (proof) {
      assert.equal(error.status, 409);
      assert.equal(error.details.maxBytes, limit);
      assert.equal(error.details.actualBytes, actualBytes);
      assert.match(error.message, /缩短.*减少.*未保存/u);
      assert.equal(hasRequestNotAppliedProof(error, input, {operation}), true);
      for (const field of ['operation', 'projectId', 'requestId']) {
        const missing = {...error, details: {...error.details}};
        delete missing.details[field];
        assert.equal(hasRequestNotAppliedProof(missing, input, {operation}), false, `missing ${field}`);
        const mismatched = {...error, details: {...error.details, [field]: randomUUID()}};
        assert.equal(hasRequestNotAppliedProof(mismatched, input, {operation}), false, `mismatched ${field}`);
      }
    } else assert.equal(hasRequestNotAppliedProof(error, input, {operation}), false);
    return true;
  });
  assert.equal(f.store.db.isTransaction, false);
  assert.equal(totalChanges(f.store.db), changes, 'even rolled-back SQL writes must not occur');
  assert.deepEqual(captureEdits(f.store.db), before, 'timeline, history, receipts and cursor remain byte-exact');
  return rejection;
}

test('image budget uses exact JSON UTF-8 bytes and leaves the historical 256 KiB cap unchanged', async t => {
  assert.equal(TIMELINE_RESPONSE_BYTES, limit);
  const f = await fixture(t);
  assert.equal(encodedBytes(f.timeline), limit);
  assert.equal(timelineImageResponseBudgetIssue(f.timeline, limit), null);
  const over = structuredClone(f.timeline);
  over.tracks.at(-1).name += 'x';
  assert.equal(encodedBytes(over), limit + 1);
  assert.deepEqual(timelineImageResponseBudgetIssue(over, limit)?.details, {maxBytes: limit, actualBytes: limit + 1});
  assert.equal(isTimelineRecord(over), false);
  const nonImage = structuredClone(over);
  for (const clip of nonImage.clips) clip.colour = {
    profileId: 'mioon-rec709-sdr-clip-v1',
    source: {assetSha256: f.asset.sha256, streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: stamp},
    look: clip.colour.look,
  };
  assert.equal(timelineImageResponseBudgetIssue(nonImage, limit), null);
  assert.equal(isTimelineRecord(nonImage), true, 'the same valid video v1 shape still fits');
  const legacyOversize = {...nonImage, createdAt: 'x'.repeat(limit)};
  assert.equal(timelineImageResponseBudgetIssue(legacyOversize, limit), null);
  assert.equal(isTimelineRecord(legacyOversize), false, 'no old guard or cap is widened');

  const reviewerExample = crowdedTimeline({colour: imageColour({
    ...f.timeline.clips[0].colour.source.evidence, sourceByteLength: 33554432,
  }, f.timeline.clips[0].colour.look), provenance: true});
  for (const track of reviewerExample.tracks) track.name = '\u0001'.repeat(150);
  for (const clip of reviewerExample.clips) { delete clip.fadeInFrames; delete clip.fadeOutFrames; }
  assert.ok(encodedBytes(reviewerExample) > limit, 'individually legal maximal image fields can exceed the retained cap');
  assert.equal(isTimelineRecord(reviewerExample), false);
  for (const clip of reviewerExample.clips) clip.colour = structuredClone(nonImage.clips[0].colour);
  assert.ok(encodedBytes(reviewerExample) < limit);
  assert.equal(isTimelineRecord(reviewerExample), true, 'the equivalent three-UUID video v1 record remains admissible');
});

test('one-byte image candidate overflow rejects before any SQL write with exact scoped proof', async t => {
  const f = await fixture(t);
  const track = f.timeline.tracks.at(-1);
  const input = f.params(f.timeline, {trackId: track.id, patch: {name: track.name + 'x'}});
  await assertNoWrites(f, 'timeline.track.update', input, {actualBytes: limit + 1});
  await assertNoWrites(f, 'timeline.track.update', input, {actualBytes: limit + 1});
});

test('revision 9 to 10 growth is budgeted after mutation and before writing', async t => {
  const f = await fixture(t, {revision: 9});
  await assertNoWrites(f, 'timeline.clip.update', f.params(f.timeline, {
    clipId: f.timeline.clips[0].id, patch: {gain: 0},
  }), {actualBytes: limit + 1});
});

test('canonical timestamp growth is budgeted after mutation and before writing', async t => {
  const f = await fixture(t, {updatedAt: '2026-10-15T00:00:00Z'});
  await assertNoWrites(f, 'timeline.clip.update', f.params(f.timeline, {
    clipId: f.timeline.clips[0].id, patch: {gain: 0},
  }), {actualBytes: limit + 4});
});

test('revision growth during undo cannot write an over-budget reconstructed image response', async t => {
  const f = await fixture(t, {revision: 8});
  const changed = await f.call('timeline.clip.update', f.params(f.timeline, {
    clipId: f.timeline.clips[0].id, patch: {gain: 0},
  }));
  assert.equal(changed.revision, 9);
  assert.equal(encodedBytes(changed), limit);
  await assertNoWrites(f, 'timeline.undo', f.params(changed), {actualBytes: limit + 1});
});

test('undo recognizes a valid historical image snapshot that already exceeds the current revision envelope', async t => {
  const f = await fixture(t, {revision: 8});
  const first = await f.call('timeline.clip.update', f.params(f.timeline, {
    clipId: f.timeline.clips[0].id, patch: {gain: 0},
  }));
  assert.ok(first.clips[0].name.startsWith('x'));
  const second = await f.call('timeline.clip.update', f.params(first, {
    clipId: first.clips[0].id, patch: {name: first.clips[0].name.slice(1)},
  }));
  assert.equal(second.revision, 10);
  assert.equal(encodedBytes(second), limit);
  await assertNoWrites(f, 'timeline.undo', f.params(second), {actualBytes: limit + 1});

  const historical = JSON.parse(f.store.db.prepare('SELECT beforeSnapshot FROM timeline_history WHERE projectId=? AND position=2').get(f.projectId).beforeSnapshot);
  historical.clips[0].rect.width = 719;
  corruptStoredText(f.store.db, 'timeline_history',
    'UPDATE timeline_history SET beforeSnapshot=? WHERE projectId=? AND position=2', JSON.stringify(historical), f.projectId);
  await assertNoWrites(f, 'timeline.undo', f.params(second), {code: 'INVALID_TIMELINE_SNAPSHOT', proof: false});
});

for (const phase of ['gain change', 'final revision']) test(`loudness image overflow at ${phase} keeps the frozen unsafe proof and writes nothing`, async t => {
  const f = await fixture(t, {revision: phase === 'final revision' ? 9 : 1});
  const shared = createTimelineServices(f.store, {
    required: (table, id) => f.store.get(table, id), hash, now: () => stamp,
    check: (timeline, revision) => assert.equal(timeline.revision, revision),
  });
  const transactions = shared.createLoudnessApplyTransactions(() => {});
  const operation = 'timeline.loudness.apply';
  const input = f.params(f.timeline, {
    mixProfile: 'timeline-float-mix-v1', measurementProfile: 'bs1770-5-48k-stereo-fir4x-v1',
    target: {integratedLufs: -24, truePeakCeilingDbtp: -1}, snapshotSha256: 'a'.repeat(64),
    candidateDigest: 'timeline-loudness-candidate-v1:' + 'b'.repeat(64),
  });
  let fenceCalls = 0;
  // Deliberately inject only the private admission adapter. This checks its
  // aggregate write boundary, not decoding or real image audio eligibility.
  const admission = {
    report: {identity: {timelineId: f.timeline.id, timelineRevision: f.timeline.revision}},
    application: {gains: [{clipId: f.timeline.clips[0].id, assetId: f.asset.id,
      beforeGain: 1, afterGain: phase === 'gain change' ? 0.5 : 2}]},
    finalFence: () => { fenceCalls++; },
  };
  const injected = {...f, call: async () => transactions.accept(input, admission)};
  const rejection = await assertNoWrites(injected, operation, input, {
    code: 'TIMELINE_LOUDNESS_APPLY_UNSAFE', actualBytes: limit + (phase === 'gain change' ? 2 : 1),
  });
  assert.equal(fenceCalls, 0);
  assert.equal(hasRequestNotAppliedProof({...rejection, code: budgetCode}, input, {operation}), false,
    'the new image code is not added to the historical loudness proof vocabulary');
});

test('a durable image-capacity rejection retains the exact draft, then acknowledgement releases the lane', async t => {
  const f = await fixture(t), operation = 'timeline.track.update';
  const track = f.timeline.tracks.at(-1);
  const input = f.params(f.timeline, {trackId: track.id, patch: {name: track.name + 'x'}});
  const tasks = createEditTasks({store: f.store, services: {call: f.call}});
  t.after(() => tasks.drain());
  const saved = tasks.prepare({projectId: f.projectId, operation, input, origin: 'new'});
  const before = captureEdits(f.store.db);
  const rejected = await tasks.execute({projectId: f.projectId, taskId: saved.task.id,
    digest: saved.task.digest, instanceId: saved.instanceId});
  assert.equal(rejected.task.status, 'not_applied');
  assert.equal(rejected.task.errorCode, budgetCode);
  assert.deepEqual(rejected.task.input, input);
  assert.deepEqual(captureEdits(f.store.db), before);
  assert.deepEqual(tasks.get({projectId: f.projectId, taskId: saved.task.id}).task, rejected.task);
  const acknowledged = tasks.acknowledge({projectId: f.projectId, taskId: saved.task.id,
    digest: saved.task.digest, expectedRevision: rejected.task.revision, status: 'not_applied'});
  assert.equal(acknowledged.task.acknowledged, true);
  const correctedInput = {...input, requestId: randomUUID(), patch: {name: track.name}};
  const corrected = tasks.prepare({projectId: f.projectId, operation, input: correctedInput, origin: 'new'});
  assert.equal(corrected.task.status, 'prepared');
  assert.deepEqual(corrected.task.input, correctedInput);
  assert.deepEqual(captureEdits(f.store.db), before);
});

test('exact-limit mutation, history, undo, redo and historical replay survive reopen', async t => {
  const f = await fixture(t, {bytes: limit - 1});
  const track = f.timeline.tracks.at(-1);
  const input = f.params(f.timeline, {trackId: track.id, patch: {name: track.name + 'x'}});
  const changed = await f.call('timeline.track.update', input);
  assert.equal(encodedBytes(changed), limit);
  assert.equal(isTimelineMutationResponse('timeline.track.update', input, changed), true);
  const row = f.store.db.prepare('SELECT beforeSnapshot, afterSnapshot FROM timeline_history WHERE projectId=?').get(f.projectId);
  assert.deepEqual(JSON.parse(row.beforeSnapshot), editableSnapshot(f.timeline));
  assert.deepEqual(JSON.parse(row.afterSnapshot), editableSnapshot(changed));
  const undone = await f.call('timeline.undo', f.params(changed));
  assert.equal(encodedBytes(undone), limit - 1);
  assert.deepEqual(editableSnapshot(undone), editableSnapshot(f.timeline));
  const redone = await f.call('timeline.redo', f.params(undone));
  assert.equal(encodedBytes(redone), limit);
  assert.deepEqual(editableSnapshot(redone), editableSnapshot(changed));
  const history = await f.call('timeline.history.get', {projectId: f.projectId});
  assert.equal(history.cursor, 1);
  assert.equal(history.length, 1);
  await f.reopen();
  const before = captureEdits(f.store.db), changes = totalChanges(f.store.db);
  assert.deepEqual(await f.call('timeline.track.update', input), changed, 'replay returns the original exact ACK, not the current revision');
  assert.deepEqual(captureEdits(f.store.db), before);
  assert.equal(totalChanges(f.store.db), changes);
});

for (const location of ['receipt', 'history']) test(`oversized persisted ${location} stays fail-closed without candidate proof or writes`, async t => {
  const f = await fixture(t, {bytes: limit - 1});
  const input = f.params(f.timeline, {clipId: f.timeline.clips[0].id, patch: {gain: 0}});
  const changed = await f.call('timeline.clip.update', input);
  if (location === 'receipt') {
    const response = JSON.stringify(changed);
    corruptStoredText(f.store.db, 'timeline_requests', 'UPDATE timeline_requests SET response=? WHERE requestId=?',
      ' '.repeat(limit + 1 - Buffer.byteLength(response)) + response, input.requestId,
    );
    await assertNoWrites(f, 'timeline.clip.update', input, {code: 'INVALID_TIMELINE_SNAPSHOT', proof: false});
  } else {
    const saved = JSON.stringify(editableSnapshot(f.timeline));
    corruptStoredText(f.store.db, 'timeline_history', 'UPDATE timeline_history SET beforeSnapshot=? WHERE projectId=?',
      ' '.repeat(limit + 1 - Buffer.byteLength(saved)) + saved, f.projectId,
    );
    await assertNoWrites(f, 'timeline.undo', f.params(changed), {code: 'INVALID_TIMELINE_SNAPSHOT', proof: false});
  }
});

test('cold backup32 and restored33 preserve exact-limit evidence, receipts and history across reopen', async t => {
  const f = await fixture(t, {bytes: limit - 1});
  const track = f.timeline.tracks.at(-1);
  const changed = await f.call('timeline.track.update', f.params(f.timeline, {trackId: track.id, patch: {name: track.name + 'x'}}));
  assert.equal(encodedBytes(changed), limit);
  const before = captureEdits(f.store.db);
  f.store.db.exec('DELETE FROM schema_version WHERE version=34'); // Explicit historical PNG-only fixture.
  await f.close();
  const dbBytes = readFileSync(path.join(f.root, 'workbench.sqlite'));
  const base = mkdtempSync(path.join(tmpdir(), 'mioon-image-budget-restore-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const backup = path.join(base, 'backup'), destination = path.join(base, 'restored');
  assert.equal((await createWorkspaceBackup({source: f.root, destination: backup})).databaseSchemaVersion, 32);
  assert.equal((await verifyWorkspaceBackup({directory: backup})).databaseSchemaVersion, 32);
  const restored = await restoreWorkspaceBackup({directory: backup, destination});
  assert.equal(restored.databaseSchemaVersion, 33);
  assert.equal(restored.profile, 'restored-local-v5');
  assert.equal(restored.sourceSchema, 32);
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = openStore(destination), services = createServices(store, new Map());
    try {
      assert.equal(getWorkspaceRestoreContext(store).schemaVersion, 33);
      assert.equal(validateCurrentWorkspaceRestoreSchema(store.db).schemaVersion, 33);
      assert.deepEqual(captureEdits(store.db), before);
      assert.deepEqual(await services.call('timeline.get', {projectId: f.projectId}), changed);
      assert.deepEqual(store.db.prepare('SELECT id, projectId, position, operation, createdAt, beforeSnapshot, afterSnapshot FROM workspace_restore_timeline_history ORDER BY capturedRowid').all(), before.timeline_history);
      assert.deepEqual(readFileSync(path.join(destination, f.asset.relativePath)), sourceBytes);
    } finally { await services.drain(); store.close(); }
  }
  assert.deepEqual(readFileSync(path.join(f.root, 'workbench.sqlite')), dbBytes);
});

test('restored33 install rolls back exact-limit timeline, receipt and history bytes on commit failure', async t => {
  const f = await fixture(t);
  await f.call('timeline.clip.update', f.params(f.timeline, {clipId: f.timeline.clips[0].id, patch: {gain: 0}}));
  await f.close();
  const db = new DatabaseSync(path.join(f.root, 'workbench.sqlite'));
  try {
    db.exec('DELETE FROM schema_version WHERE version=34'); // Explicit historical PNG-only fixture.
    const before = snapshot(db);
    let reached = false;
    const interrupted = facade(db, event => {
      if (event.phase === 'before' && event.sql === 'COMMIT') {
        reached = true;
        throw Object.assign(new Error('Injected restore commit failure'), {code: 'INJECTED_BUDGET_RESTORE'});
      }
    });
    assert.throws(() => installCurrentWorkspaceRestoreSchema(interrupted, restoreMetadata()), {code: 'INJECTED_BUDGET_RESTORE'});
    assert.equal(reached, true);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.equal(installCurrentWorkspaceRestoreSchema(db, restoreMetadata()).schemaVersion, 33);
  } finally { db.close(); }
});

for (const sourceVersion of [24, 26, 28, 30, 32]) for (const restored of [false, true]) {
  const role = sourceVersion + Number(restored);
  test(`raw not-applied image-budget error cannot expand historical role ${role}`, () => {
    const db = open(':memory:');
    try {
      initializeWorkspaceSchemaThrough24(db);
      if (sourceVersion >= 26) initializeWorkspaceSchema26(db);
      if (sourceVersion >= 28) initializeWorkspaceSchema28(db);
      if (sourceVersion >= 30) initializeWorkspaceSchema30(db);
      if (sourceVersion >= 32) initializeWorkspaceSchema32(db);
      const projectId = randomUUID(), taskId = randomUUID(), operation = 'timeline.track.update';
      const input = {projectId, requestId: randomUUID(), expectedRevision: 1,
        trackId: randomUUID(), patch: {name: 'Ordinary retained name'}};
      db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,
        JSON.stringify({id: projectId, name: 'Historical role', createdAt: stamp, updatedAt: stamp}));
      db.prepare(`INSERT INTO edit_tasks(id, projectId, operation, input, requestId, digest,
        lane, origin, status, revision, acknowledged, errorCode, createdAt, updatedAt, bytes)
        VALUES(?,?,?,?,?,?,'timeline:mutation','new','not_applied',3,0,'SOURCE_BOUNDS',?,?,16384)`).run(
        taskId, projectId, operation, JSON.stringify(input), input.requestId, hash({operation, input}), stamp, stamp,
      );
      if (restored) assert.equal(installCurrentWorkspaceRestoreSchema(db, restoreMetadata()).schemaVersion, role);
      assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion, role);
      // No new profile string or image evidence appears in the intent. The
      // error code alone must not make a previously invalid task definite.
      corruptStoredText(db, 'edit_tasks', 'UPDATE edit_tasks SET errorCode=? WHERE id=?', budgetCode, taskId);
      const before = snapshot(db), changes = totalChanges(db);
      if (sourceVersion < 32) {
        assert.throws(() => classifyCurrentWorkspaceSchema(db));
        if (restored) assert.throws(() => validateCurrentWorkspaceRestoreSchema(db));
        else assert.throws(() => initializeWorkspaceSchema32(db));
      } else {
        assert.equal(classifyCurrentWorkspaceSchema(db).schemaVersion, role);
        if (restored) assert.equal(validateCurrentWorkspaceRestoreSchema(db).schemaVersion, 33);
      }
      assert.equal(totalChanges(db), changes);
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  });
}
