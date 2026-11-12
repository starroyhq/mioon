import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createServerProject} from './helpers/project-database.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {captureProjectDocumentInside, canonicalJson} from '../packages/business/src/project-versions/document.ts';
import {decodeProjectDocument, encodeProjectDocument, inspectProjectDocumentForCopy} from '../packages/business/src/project-versions/codec.ts';
import {buildRestorePlan} from '../packages/business/src/project-versions/preview.ts';
import {applyRestorePlanInside} from '../packages/business/src/project-versions/restore.ts';
import {copyProjectVersionsInside} from '../packages/business/src/project-versions/copy.ts';
import {copyProjectVersionsToNewProjectInside} from '../packages/business/src/project-versions/copy-to-project.ts';
import {storeProjectVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';

const at = '2026-11-04T00:00:00.000Z';
function fixture(t: TestContext, projectId?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-v5-'));
  const created = createServerProject(root, {name: 'Original', ...(projectId ? {projectId} : {})});
  const {store} = created;
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const api = createProjectVersions(store, {assertMutationAllowed() {}});
  const capture = () => store.tx(() => captureProjectDocumentInside(store));
  const rename = (name: string) => store.put('projects', {...store.get('projects', created.projectId) as Record<string, unknown>, name});
  const state = () => ['project.projects', 'project.project_file', 'project.agent_task_target_revisions_v2',
    'main.project_versions', 'main.project_version_blobs', 'main.project_version_requests', 'main.project_version_capture_marks']
    .map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return {...created, api, capture, rename, state};
}
function encoded(value: unknown) {
  const raw = Buffer.from(canonicalJson(value)), payload = gzipSync(raw, {level: 1});
  return {profile: 1 as const, codec: 'gzip' as const, hash: createHash('sha256').update(raw).digest('hex'),
    rawBytes: raw.length, compressedBytes: payload.length, payload};
}

function format4Fixture(t: TestContext, projectId: string = randomUUID()) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-format4-'));
  const store = createProjectStore({projectFile: path.join(root, 'project.mioon'), projectId, format4: {}, locate: () => ({
    localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp'),
  })});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  ensureProjectRow(store, {name: 'Candidate'});
  const api = createProjectVersions(store, {assertMutationAllowed() {}});
  return {store, api, projectId};
}

test('same sequence with a different token invalidates the complete preview and restore CAS without writes', t => {
  const f = fixture(t), version = f.api.save({projectId: f.projectId, requestId: randomUUID()}).version;
  f.rename('Current');
  const before = f.api.preview({projectId: f.projectId, versionId: version.id});
  const stamp = readProjectContentStamp(f.store.db);
  const changedToken = stamp.contentToken === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32);
  f.store.db.prepare('UPDATE project.project_file SET contentToken=? WHERE singleton=1').run(changedToken);
  const after = f.api.preview({projectId: f.projectId, versionId: version.id}), state = f.state();
  assert.equal(before.contentSequence, after.contentSequence); assert.notEqual(before.contentToken, after.contentToken);
  assert.deepEqual(before.changes, after.changes); assert.notEqual(before.previewDigest, after.previewDigest);
  const input = {projectId: f.projectId, versionId: version.id, requestId: randomUUID(), expectedContentSequence: before.contentSequence,
    expectedContentToken: before.contentToken, previewDigest: before.previewDigest};
  assert.throws(() => f.api.restore(input), {code: 'PROJECT_VERSION_BASELINE_CHANGED', status: 409});
  assert.deepEqual(f.state(), state);
  assert.throws(() => f.api.restore({...input, expectedContentToken: after.contentToken}), {code: 'PROJECT_VERSION_PREVIEW_CHANGED', status: 409});
  assert.deepEqual(f.state(), state);
  const result = f.api.restore({...input, expectedContentToken: after.contentToken, previewDigest: after.previewDigest});
  assert.ok(result.contentSequence > after.contentSequence); assert.notEqual(result.contentToken, after.contentToken);
  assert.deepEqual({contentSequence: result.contentSequence, contentToken: result.contentToken}, readProjectContentStamp(f.store.db));
});

test('a trusted plan also rejects an equal-sequence token swap before applying any restore row', t => {
  const f = fixture(t), saved = f.capture(); f.rename('Current'); const state = f.state();
  assert.throws(() => f.store.tx(() => {
    const plan = buildRestorePlan(f.store, saved, captureProjectDocumentInside(f.store), 0, at);
    f.store.db.prepare("UPDATE project.project_file SET contentToken=lower(hex(randomblob(16)))").run();
    applyRestorePlanInside(f.store, plan, {requestId: randomUUID()});
  }), {code: 'PROJECT_VERSION_BASELINE_CHANGED', status: 409});
  assert.deepEqual(f.state(), state);
});

test('same-sequence token replacement invalidates a paginated preview cursor without modifying any rows', t => {
  const f = fixture(t), version = f.api.save({projectId: f.projectId, requestId: randomUUID()}).version;
  for (const title of ['One', 'Two']) f.store.put('shots', {id: randomUUID(), projectId: f.projectId, title, revision: 1});
  const input = {projectId: f.projectId, versionId: version.id, limit: 1};
  const page = f.api.preview(input); assert.ok(page.nextCursor);
  f.store.db.prepare('UPDATE project.project_file SET contentToken=lower(hex(randomblob(16)))').run();
  const before = f.state();
  assert.throws(() => f.api.preview({...input, cursor: page.nextCursor!}), {code: 'PROJECT_VERSION_CURSOR_INVALID', status: 400});
  assert.deepEqual(f.state(), before); assert.equal(f.store.list('shots', f.projectId).length, 2);
});

test('recovery preview ignores archived timeline execution references and matches the replacement empty domain', t => {
  const f = fixture(t), saved = f.api.save({projectId: f.projectId, requestId: randomUUID()}).version;
  const timeline = newTimelineRecord(f.projectId, {fps: 30, width: 1080, height: 1920}, () => at);
  f.store.put('timelines', timeline);
  f.store.db.prepare('INSERT INTO main.timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,1,?,?,?,?)')
    .run(randomUUID(), f.projectId, 'timeline.seed', at, '{}', '{}');
  const recovery = createProjectVersions(f.store, {executionDomain: 'empty', assertMutationAllowed() {}});
  const state = f.state(), normal = f.api.preview({projectId: f.projectId, versionId: saved.id});
  const empty = recovery.preview({projectId: f.projectId, versionId: saved.id});
  assert.equal(normal.changes.find(change => change.table === 'timelines')!.action, 'keep-current');
  assert.equal(empty.changes.find(change => change.table === 'timelines')!.action, 'remove');
  assert.ok(empty.changes.every(change => change.source === 'user-or-other'));
  assert.deepEqual(f.state(), state);
  f.store.db.prepare('DELETE FROM main.timeline_history').run();
  const replacement = f.api.preview({projectId: f.projectId, versionId: saved.id});
  assert.equal(replacement.previewDigest, empty.previewDigest); assert.deepEqual(replacement.changes, empty.changes);
});

test('format-2 profile-1 blobs use frozen constraints and adapt logically without rewriting original bytes or inventing tokens', t => {
  const f = fixture(t), old = {...f.capture(), projectFormatVersion: 2}, blob = encoded(old), bytes = Buffer.from(blob.payload), hash = blob.hash;
  const decoded = decodeProjectDocument(blob);
  assert.equal(decoded.projectFormatVersion, PROJECT_FILE_SCHEMA_VERSION); assert.equal(decoded.snapshotProfileVersion, 1);
  assert.deepEqual(decoded.tables, old.tables); assert.deepEqual(decoded.evidence, old.evidence);
  assert.equal(Object.hasOwn(decoded.evidence, 'contentToken'), false);
  assert.deepEqual(blob.payload, bytes); assert.equal(blob.hash, hash);
  assert.throws(() => decodeProjectDocument(encoded({...old, projectFormatVersion: 1})), {code: 'PROJECT_VERSION_SNAPSHOT_UNSUPPORTED', status: 422});
  for (const invalid of [{...old, snapshotProfileVersion: 2}, {...old, extra: true},
    {...old, evidence: {...old.evidence, contentToken: 'f'.repeat(32)}},
    {...old, tables: {...old.tables, projects: [{...old.tables.projects[0], extra: 'not a frozen column'}]}},
    {...old, tables: {...old.tables, assets: [{id: randomUUID(), projectId: randomUUID(), data: '{}'}]}}])
    assert.throws(() => decodeProjectDocument(encoded(invalid)), {code: 'PROJECT_VERSION_SNAPSHOT_INVALID', status: 422});
  assert.deepEqual(blob.payload, bytes); assert.equal(blob.hash, hash);
});

test('format 2 and 3 version documents validate their original shapes before adding empty format 4 archive fields', t => {
  const f = fixture(t), id = randomUUID();
  f.store.put('shots', {id, projectId: f.projectId, title: 'Original shot', revision: 1});
  const released = f.capture();
  assert.equal(released.projectFormatVersion, PROJECT_FILE_SCHEMA_VERSION);
  const row = released.tables.shots[0]!;
  const active = {archivedAt: null, archiveBatchId: null, archiveReason: null};
  for (const sourceFormat of [2, 3] as const) {
    const source = {...released, projectFormatVersion: sourceFormat};
    const blob = encoded(source), originalBytes = Buffer.from(blob.payload), originalHash = blob.hash;
    const upgraded = decodeProjectDocument(blob, FORMAT4_PROJECT_SCHEMA_VERSION);
    assert.equal(upgraded.projectFormatVersion, FORMAT4_PROJECT_SCHEMA_VERSION);
    assert.deepEqual(upgraded.tables.shots, [{...row, ...active}]);
    assert.deepEqual(upgraded.evidence, source.evidence);
    assert.deepEqual(inspectProjectDocumentForCopy(blob), {projectId: f.projectId,
      contentSequence: source.evidence.contentSequence, projectFormatVersion: sourceFormat, restoreSupported: true});
    assert.deepEqual(blob.payload, originalBytes);
    assert.equal(blob.hash, originalHash);
    const forged = encoded({...source, tables: {...source.tables, shots: [{...row, ...active}]}});
    assert.throws(() => decodeProjectDocument(forged, FORMAT4_PROJECT_SCHEMA_VERSION), {code: 'PROJECT_VERSION_SNAPSHOT_INVALID'});
  }
});

test('version documents keep legacy timeline bytes and admit the new geometry profile only in format 4', t => {
  const f = fixture(t);
  const timeline = newTimelineRecord(f.projectId, {fps: 30, width: 720, height: 1280}, () => at);
  const assetId = randomUUID();
  f.store.put('assets', {id: assetId, projectId: f.projectId, name: 'Referenced source'});
  const clip = {id: randomUUID(), trackId: timeline.tracks[0]!.id, assetId, startFrame: 0, durationFrames: 30, sourceInFrame: 0,
    rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1};
  const legacy = {...timeline, clips: [clip], durationFrames: 30, subtitles: {profileId: 'bottom_cjk_v1', cues: []}};
  f.store.put('timelines', legacy);
  const released = f.capture(), timelineRow = released.tables.timelines[0]!;
  const current = decodeProjectDocument(encoded(released), FORMAT4_PROJECT_SCHEMA_VERSION);
  assert.equal(current.tables.timelines[0]!.data, timelineRow.data);
  const replaceTimeline = (document: typeof released, data: unknown) => ({...document, tables: {...document.tables,
    timelines: [{...timelineRow, data: canonicalJson(data)}],
  }});
  for (const change of [
    {...legacy, clips: [{...clip, layout: {profileId: 'mioon-clip-layout-v2', basisPresetId: 'portrait_720'}}]},
    {...legacy, subtitles: {profileId: 'bottom_cjk_relative_v2', basisPresetId: 'portrait_720', cues: []}},
  ]) {
    assert.throws(() => decodeProjectDocument(encoded(replaceTimeline(released, change)), FORMAT4_PROJECT_SCHEMA_VERSION),
      {code: 'PROJECT_VERSION_SNAPSHOT_INVALID', details: {reason: 'timeline-geometry'}});
    assert.equal(decodeProjectDocument(encoded(replaceTimeline(current, change))).tables.timelines[0]!.data, canonicalJson(change));
  }
  const malformed = {...legacy, clips: [{...clip, layout: {profileId: 'mioon-clip-layout-v2', basisPresetId: 'unknown'}}]};
  assert.throws(() => decodeProjectDocument(encoded(replaceTimeline(current, malformed))),
    {code: 'PROJECT_VERSION_SNAPSHOT_INVALID', details: {reason: 'timeline-geometry'}});
});

test('format 4 versions restore and copy exact archive fields while older bodies and released projects stay intact', t => {
  const source = fixture(t), target = format4Fixture(t, source.projectId), shotId = randomUUID(), nodeId = randomUUID(), edgeId = randomUUID();
  const {projectId} = source;
  source.store.put('shots', {id: shotId, projectId, title: 'Original shot', revision: 1});
  source.store.put('nodes', {id: nodeId, projectId, label: 'Original node', type: 'text', revision: 1});
  source.store.put('edges', {id: edgeId, projectId, source: nodeId, target: shotId, kind: 'decorative'});
  const active = source.api.save({projectId, requestId: randomUUID()}).version;
  const readBlob = (store: typeof source.store, versionId: string) => store.db.prepare(`SELECT b.* FROM main.project_version_blobs b
    JOIN main.project_versions v ON v.blobHash=b.hash WHERE v.id=?`).get(versionId) as unknown as ReturnType<typeof encoded>;
  const oldBlob = readBlob(source.store, active.id);
  target.store.put('projects', source.store.get('projects', projectId) as object);
  for (const [table, id] of [['shots', shotId], ['nodes', nodeId], ['edges', edgeId]] as const) {
    target.store.put(table, source.store.get(table, id) as object);
  }
  target.store.tx(() => copyProjectVersionsInside(source.store.db, target.store.db, {projectId}));
  assert.deepEqual(readBlob(target.store, active.id), oldBlob);

  const archive = {archivedAt: at, archiveBatchId: randomUUID(), archiveReason: 'user-delete'};
  const tables = ['shots', 'nodes', 'edges'] as const;
  target.store.tx(() => {
    for (const table of tables) target.store.db.prepare(`UPDATE project.${table} SET archivedAt=?,archiveBatchId=?,archiveReason=?`)
      .run(archive.archivedAt, archive.archiveBatchId, archive.archiveReason);
  });
  const archived = target.api.save({projectId, requestId: randomUUID()}).version;
  const archiveBlob = readBlob(target.store, archived.id);
  const document = decodeProjectDocument(archiveBlob);
  assert.equal(document.projectFormatVersion, FORMAT4_PROJECT_SCHEMA_VERSION);
  assert.throws(() => decodeProjectDocument(archiveBlob, PROJECT_FILE_SCHEMA_VERSION), {code: 'PROJECT_VERSION_SNAPSHOT_UNSUPPORTED'});
  const broken = encoded({...document, tables: {...document.tables, shots: [{...document.tables.shots[0], archiveBatchId: null}]}});
  assert.throws(() => decodeProjectDocument(broken), {code: 'PROJECT_VERSION_SNAPSHOT_INVALID'});

  const restore = (versionId: string) => {
    const preview = target.api.preview({projectId, versionId});
    for (const table of tables) assert.deepEqual([...(preview.changes.find(change => change.table === table)?.fields ?? [])].sort(),
      ['archiveBatchId', 'archiveReason', 'archivedAt']);
    target.api.restore({projectId, versionId, requestId: randomUUID(), expectedContentSequence: preview.contentSequence,
      expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest});
  };
  const assertArchive = (expected: {[Key in keyof typeof archive]: string | null}) => {
    for (const table of tables) assert.deepEqual({...target.store.db.prepare(`SELECT archivedAt,archiveBatchId,archiveReason FROM project.${table}`).get()}, expected);
  };
  restore(active.id);
  assertArchive({archivedAt: null, archiveBatchId: null, archiveReason: null});
  restore(archived.id);
  assertArchive(archive);
  assert.deepEqual(readBlob(source.store, active.id), oldBlob);
  assert.deepEqual(readBlob(target.store, active.id), oldBlob);
  assert.deepEqual(readBlob(target.store, archived.id), archiveBlob);

  const copy = format4Fixture(t);
  const copyVersions = (destination: typeof copy) => destination.store.tx(() => copyProjectVersionsToNewProjectInside(target.store.db,
    destination.store.db, {sourceProjectId: projectId, projectId: destination.projectId, sourceProjectDir: target.store.projectDir,
      targetProjectDir: destination.store.projectDir}));
  copyVersions(copy);
  const copied = decodeProjectDocument(readBlob(copy.store, archived.id));
  const copiedActive = decodeProjectDocument(readBlob(copy.store, active.id));
  assert.equal(copied.projectId, copy.projectId);
  assert.equal(copiedActive.projectFormatVersion, FORMAT4_PROJECT_SCHEMA_VERSION);
  for (const table of tables) {
    const row = copied.tables[table][0]!;
    assert.equal(row.projectId, copy.projectId);
    assert.equal(row.id, document.tables[table][0]!.id);
    assert.equal(row.archivedAt, archive.archivedAt);
    assert.equal(row.archiveBatchId, archive.archiveBatchId);
    assert.equal(row.archiveReason, archive.archiveReason);
    assert.equal(copiedActive.tables[table][0]!.archivedAt, null);
  }
  const released = fixture(t);
  const before = released.state();
  assert.throws(() => copyVersions(released), {code: 'PROJECT_VERSION_SNAPSHOT_UNSUPPORTED'});
  assert.deepEqual(released.state(), before);
});

test('a legal format-1 version is carried byte-for-byte and listed while preview and restore remain exactly unsupported', t => {
  const source = fixture(t), target = fixture(t, source.projectId), document = source.capture(), assetId = randomUUID();
  const old = {...document, projectFormatVersion: 1, tables: {...document.tables, assets: [{id: assetId, projectId: source.projectId,
    data: canonicalJson({id: assetId, projectId: source.projectId, name: 'Legacy locator', relativePath: 'media/legacy.png'})}]}};
  const blob = encoded(old), version = source.store.tx(() => storeProjectVersionInside(source.store.db, {projectId: source.projectId,
    trigger: 'manual', name: 'Preserved format 1', contentSequence: old.evidence.contentSequence, blob, mioChangeRowid: 0}));
  const bytes = Buffer.from(blob.payload), before = source.state();
  const copied = target.store.tx(() => copyProjectVersionsInside(source.store.db, target.store.db, {projectId: source.projectId}));
  assert.equal(copied.versions, 1); assert.equal(copied.blobs, 1);
  const stored = target.store.db.prepare('SELECT * FROM main.project_version_blobs WHERE hash=?').get(blob.hash)!;
  assert.ok(stored.payload instanceof Uint8Array); assert.deepEqual(Buffer.from(stored.payload), bytes);
  assert.equal(stored.hash, blob.hash); assert.equal(stored.rawBytes, blob.rawBytes);
  assert.deepEqual(target.api.list({projectId: source.projectId}).versions, [version]); assert.deepEqual(source.state(), before);
  const state = target.state(), changes = target.store.db.prepare('SELECT total_changes() n').get()!.n;
  const unsupported = {code: 'PROJECT_VERSION_SNAPSHOT_UNSUPPORTED', status: 422, details: {projectFormatVersion: 1, snapshotProfileVersion: 1}};
  assert.throws(() => target.api.preview({projectId: source.projectId, versionId: version.id}), unsupported);
  const stamp = readProjectContentStamp(target.store.db);
  assert.throws(() => target.api.restore({projectId: source.projectId, versionId: version.id, requestId: randomUUID(),
    expectedContentSequence: stamp.contentSequence, expectedContentToken: stamp.contentToken, previewDigest: 'a'.repeat(64)}), unsupported);
  assert.deepEqual(target.state(), state); assert.equal(target.store.db.prepare('SELECT total_changes() n').get()!.n, changes);
  assert.equal(target.store.db.prepare('SELECT 1 FROM project.assets WHERE id=?').get(assetId), undefined, 'old business rows are never applied');
});

for (const damage of ['hash', 'project-id'] as const)
  test(`format-1 preservation still rejects ${damage} corruption without publishing a partial target`, t => {
    const source = fixture(t), target = fixture(t, source.projectId), owner = damage === 'project-id' ? fixture(t) : source;
    const document = {...owner.capture(), projectFormatVersion: 1}, blob = encoded(document);
    source.store.tx(() => storeProjectVersionInside(source.store.db, {projectId: source.projectId, trigger: 'manual',
      contentSequence: document.evidence.contentSequence, blob: {...blob, ...(damage === 'hash' ? {hash: 'f'.repeat(64)} : {})}, mioChangeRowid: 0}));
    const before = source.state(), empty = target.state();
    assert.throws(() => target.store.tx(() => copyProjectVersionsInside(source.store.db, target.store.db, {projectId: source.projectId})),
      {code: damage === 'hash' ? 'PROJECT_VERSION_SNAPSHOT_INVALID' : 'PROJECT_VERSION_RECORD_INVALID', status: 422});
    assert.deepEqual(target.state(), empty); assert.deepEqual(source.state(), before);
  });

test('history replacement copies only immutable version rows and original blobs including Mio sources', t => {
  const source = fixture(t), target = fixture(t, source.projectId);
  const manual = source.api.save({projectId: source.projectId, requestId: randomUUID()}).version;
  const journal = createAgentTaskJournal(source.store), run = journal.create({projectId: source.projectId,
    requestId: randomUUID(), text: 'Retained source identity', configuration: mioFixtureConfiguration}).run;
  const document = source.capture(), blob = encodeProjectDocument(document);
  const legacy = source.store.tx(() => storeProjectVersionInside(source.store.db, {projectId: source.projectId, trigger: 'manual',
    name: 'Format 2 source', contentSequence: document.evidence.contentSequence, blob: encoded({...document, projectFormatVersion: 2}), mioChangeRowid: 0}));
  source.store.tx(() => {
    for (const trigger of ['mio-turn', 'daily-open', 'bulk-change', 'restore'] as const)
      storeProjectVersionInside(source.store.db, {projectId: source.projectId, trigger, ...(trigger === 'mio-turn' ? {mioRunId: run.id} : {}),
        contentSequence: document.evidence.contentSequence, blob, mioChangeRowid: 17, createdAt: at});
    source.store.db.prepare("INSERT INTO main.project_version_capture_marks VALUES(?,'daily-open','2026-11-04|UTC',?)").run(source.projectId, at);
  });
  const rows = (db: typeof source.store.db, table: string) => db.prepare(`SELECT * FROM main.${table} ORDER BY 1`).all();
  const before = {blobs: rows(source.store.db, 'project_version_blobs'), versions: rows(source.store.db, 'project_versions')};
  const copied = target.store.tx(() => copyProjectVersionsInside(source.store.db, target.store.db, {projectId: source.projectId}));
  assert.equal(copied.versions, 6); assert.equal(copied.blobs, before.blobs.length);
  assert.equal(copied.compressedBytes, before.blobs.reduce((sum, row) => sum + Number(row.compressedBytes), 0));
  assert.deepEqual(rows(target.store.db, 'project_versions'), before.versions); assert.deepEqual(rows(target.store.db, 'project_version_blobs'), before.blobs);
  assert.deepEqual(rows(source.store.db, 'project_versions'), before.versions); assert.deepEqual(rows(source.store.db, 'project_version_blobs'), before.blobs);
  for (const table of ['project_version_requests', 'project_version_capture_marks', 'mio_runs', 'timeline_history', 'jobs'])
    assert.equal(target.store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n, 0, table);
  assert.equal(target.store.db.prepare('PRAGMA main.foreign_key_check').get(), undefined);
  assert.equal(target.api.list({projectId: source.projectId}).versions.find(version => version.trigger === 'mio-turn')!.mioRunId, run.id);
  assert.ok(target.api.list({projectId: source.projectId}).versions.some(version => version.id === manual.id));
  const preview = target.api.preview({projectId: source.projectId, versionId: legacy.id});
  const result = target.api.restore({projectId: source.projectId, versionId: legacy.id, requestId: randomUUID(),
    expectedContentSequence: preview.contentSequence, expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest});
  assert.equal(result.versionId, legacy.id);
});

test('a damaged copied blob rolls back the complete target transaction and leaves all source rows untouched', t => {
  const source = fixture(t), target = fixture(t, source.projectId);
  source.api.save({projectId: source.projectId, requestId: randomUUID()});
  source.store.db.prepare("INSERT INTO main.project_version_blobs(hash,profile,codec,rawBytes,compressedBytes,payload) VALUES(?,1,'gzip',1,1,?)")
    .run('f'.repeat(64), Buffer.from('x'));
  const before = source.state(), empty = target.state();
  assert.throws(() => target.store.tx(() => copyProjectVersionsInside(source.store.db, target.store.db, {projectId: source.projectId})),
    {code: 'PROJECT_VERSION_SNAPSHOT_INVALID', status: 422});
  assert.deepEqual(target.state(), empty); assert.deepEqual(source.state(), before);
});

test('trusted host completion evidence commits with the restore ACK, rolls back on failure and is skipped for replay', t => {
  const f = fixture(t), version = f.api.save({projectId: f.projectId, requestId: randomUUID()}).version;
  f.rename('Current');
  f.store.db.exec('CREATE TEMP TABLE host_commit_probe(requestId TEXT PRIMARY KEY,response TEXT NOT NULL)');
  let fail = true, calls = 0, applyCalls = 0;
  const api = createProjectVersions(f.store, {assertMutationAllowed() {}, afterRestoreApplyInside() {
    applyCalls++;
    f.store.db.exec('UPDATE project.project_file SET contentSequence=contentSequence+1,contentToken=lower(hex(randomblob(16)))');
  }, beforeRestoreCommit(result) {
    calls++; assert.equal(f.store.db.isTransaction, true);
    assert.equal(f.store.db.prepare('SELECT response FROM main.project_version_requests WHERE requestId=?').get(result.requestId)!.response, JSON.stringify(result));
    f.store.db.prepare('INSERT INTO temp.host_commit_probe VALUES(?,?)').run(result.requestId, JSON.stringify(result));
    if (fail) throw Error('Host evidence write failed');
  }});
  const preview = api.preview({projectId: f.projectId, versionId: version.id});
  const input = {projectId: f.projectId, versionId: version.id, requestId: randomUUID(), expectedContentSequence: preview.contentSequence,
    expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest}, before = f.state();
  assert.throws(() => api.restore(input), /Host evidence write failed/u);
  assert.deepEqual(f.state(), before); assert.equal(f.store.db.prepare('SELECT count(*) n FROM temp.host_commit_probe').get()!.n, 0);
  fail = false;
  const result = api.restore(input); assert.equal(calls, 2); assert.equal(applyCalls, 2);
  assert.deepEqual({contentSequence: result.contentSequence, contentToken: result.contentToken}, readProjectContentStamp(f.store.db));
  assert.equal(f.store.db.prepare('SELECT response FROM temp.host_commit_probe').get()!.response, JSON.stringify(result));
  f.rename('After completed restore'); const completed = f.state();
  assert.deepEqual(api.restore(input), result); assert.equal(calls, 2); assert.equal(applyCalls, 2); assert.deepEqual(f.state(), completed);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM temp.host_commit_probe').get()!.n, 1);
});
