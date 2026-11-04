import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {backup, DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {createServerProject} from './helpers/project-database.ts';
import {buildPreviousHistoryDatabase} from './fixtures/kernel-history-previous-schema.ts';
import {copyProjectVersionsToNewProjectInside} from '../packages/business/src/project-versions/copy-to-project.ts';
import {canonicalJson, captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import type {SnapshotRow} from '../packages/business/src/project-versions/document.ts';
import {decodeProjectDocument, encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import type {EncodedProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {storeProjectVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {PROJECT_SNAPSHOT_MAX_RAW_BYTES} from '../packages/business/src/project-versions/limits.ts';
import {newTimelineRecord} from '../packages/business/src/timeline-new-record.ts';
import {parseLutBytes} from '../packages/business/src/lut-resource-validation.ts';
import {resolveReferencePath} from '../packages/business/src/media-reference/paths.ts';
import type {MediaReference} from '../packages/contracts/src/media-reference.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {beginFixtureToolStep, mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioProjectJournal} from '../packages/business/src/agent/mio-journal-factory.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {HISTORY_TABLES} from '../packages/business/src/project-file/schema/tables.ts';

const at = '2026-11-04T00:00:00.000Z';
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const processKinds = ['job', 'export', 'image_task', 'frame_task'];
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-project-copy-'));
  const stores = new Set<ReturnType<typeof createServerProject>['store']>();
  const cleanup: (() => void | Promise<void>)[] = [];
  const source = createServerProject(path.join(root, 'source'), {name: 'Source'}), target = createServerProject(path.join(root, 'target'), {name: 'Target'});
  stores.add(source.store); stores.add(target.store);
  const api = createProjectVersions(target.store, {assertMutationAllowed() {}});
  t.after(async () => {for (const dispose of cleanup.reverse()) await dispose(); for (const store of stores) store.close(); rmSync(root, {recursive: true, force: true});});
  const capture = () => source.store.tx(() => captureProjectDocumentInside(source.store));
  const options = {sourceProjectId: source.projectId, projectId: target.projectId, sourceProjectDir: source.store.projectDir, targetProjectDir: target.store.projectDir};
  const state = () => ['main', 'project', 'cache'].map(schema => target.store.db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table' ORDER BY name`).all()
    .map(row => [row.name, target.store.db.prepare(`SELECT * FROM ${schema}.${quote(String(row.name))} ORDER BY rowid`).all()]));
  async function snapshot(damage?: (db: DatabaseSync) => void) {
    const original = path.join(source.store.localDir, 'history.db');
    source.store.close(); stores.delete(source.store);
    const originalBytes = readFileSync(original), snapshotFile = path.join(root, `history-${randomUUID()}.db`), reader = new DatabaseSync(original, {readOnly: true});
    try {await backup(reader, snapshotFile);} finally {reader.close();}
    if (damage) {const writer = new DatabaseSync(snapshotFile); try {damage(writer);} finally {writer.close();}}
    const bytes = readFileSync(snapshotFile), db = new DatabaseSync(snapshotFile, {readOnly: true});
    cleanup.push(() => db.close());
    return {db, unchanged() {assert.deepEqual(readFileSync(snapshotFile), bytes); assert.deepEqual(readFileSync(original), originalBytes);}};
  }
  const copy = (db: DatabaseSync) => target.store.tx(() => copyProjectVersionsToNewProjectInside(db, target.store.db, options));
  const restore = (versionId: string) => {
    const preview = api.preview({projectId: target.projectId, versionId});
    return api.restore({projectId: target.projectId, versionId, requestId: randomUUID(), expectedContentSequence: preview.contentSequence,
      expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest});
  };
  return {root, source, target, api, options, capture, state, snapshot, copy, restore, cleanup};
}
function encoded(value: unknown): EncodedProjectDocument {
  const raw = Buffer.from(canonicalJson(value)), payload = gzipSync(raw, {level: 1});
  return {profile: 1, codec: 'gzip', hash: createHash('sha256').update(raw).digest('hex'), rawBytes: raw.length, compressedBytes: payload.length, payload};
}
const readBlob = (db: DatabaseSync, versionId: string) => decodeProjectDocument(db.prepare('SELECT b.* FROM main.project_version_blobs b JOIN main.project_versions v ON v.blobHash=b.hash WHERE v.id=?').get(versionId) as unknown as EncodedProjectDocument);

test('cross-project conversion preserves every version identity, canonical typed content and historical media locations without source writes', async t => {
  const f = fixture(t), {store, projectId} = f.source, assetId = randomUUID(), absoluteId = randomUUID(), missingId = randomUUID(), nodeId = randomUUID(), shotId = randomUUID();
  const media = path.join(store.projectDir, 'media'); mkdirSync(media, {recursive: true});
  writeFileSync(path.join(media, 'old.png'), 'original media'); writeFileSync(path.join(media, 'new.png'), 'relinked media');
  const absolute = path.join(f.root, 'outside.png'); writeFileSync(absolute, 'outside media');
  const reference = {pathForm: 'relative' as const, path: 'media/old.png', volume: null, sizeBytes: 14, mtimeMs: 1, sampledSha256: 'a'.repeat(64), fullSha256: 'a'.repeat(64)};
  const asset = {id: assetId, projectId, name: 'Historical locator', mimeType: 'image/png', sha256: 'a'.repeat(64), sizeBytes: 14, width: 1080, height: 1920,
    duration: null, hasAudio: false, hasVideo: true, provenance: 'user-import', referenceRevision: 7, reference, createdAt: at};
  store.put('assets', asset);
  store.put('assets', {...asset, id: absoluteId, reference: {...reference, pathForm: 'absolute', path: absolute, volume: 'original-volume'}});
  store.put('assets', {...asset, id: missingId, reference: {...reference, path: 'media/missing.png'}});
  store.put('shots', {id: shotId, projectId, revision: 1, title: 'Reusable identity', prompt: projectId, duration: 2});
  store.put('nodes', {id: nodeId, projectId, type: 'note', text: projectId, owner: {projectId}, arbitraryId: projectId});
  store.put('timelines', newTimelineRecord(projectId, {fps: 30, width: 1080, height: 1920}, () => at));
  const content = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'), lutId = randomUUID();
  store.tx(() => {
    store.db.prepare("INSERT INTO project.project_lut_resources VALUES(?,?,'Copied LUT',?,?,'mioon-cube3d-normalized-tetrahedral-v1',?,?,?)")
      .run(lutId, projectId, createHash('sha256').update(content).digest('hex'), content.length, canonicalJson(parseLutBytes(content).metadata), content, at);
    for (const kind of processKinds) store.db.prepare('INSERT INTO project.agent_task_target_revisions_v2 VALUES(?,?,?,?)').run(projectId, kind, randomUUID(), 19);
    store.db.prepare("INSERT INTO main.idempotency VALUES('source-local','source-key','source-hash','source-only')").run();
  });
  const journal = createAgentTaskJournal(store), run = journal.create({projectId, requestId: randomUUID(), text: 'Source provenance', configuration: mioFixtureConfiguration}).run;
  const document = f.capture(), blob = encodeProjectDocument(document);
  const versions = store.tx(() => [
    storeProjectVersionInside(store.db, {projectId, trigger: 'manual', name: 'Old reference', contentSequence: document.evidence.contentSequence, blob, mioChangeRowid: 43, createdAt: at}),
    storeProjectVersionInside(store.db, {projectId, trigger: 'mio-turn', mioRunId: run.id, contentSequence: document.evidence.contentSequence, blob, mioChangeRowid: 44, createdAt: at}),
    storeProjectVersionInside(store.db, {projectId, trigger: 'manual', name: 'Format 2', contentSequence: document.evidence.contentSequence,
      blob: encoded({...document, projectFormatVersion: 2}), mioChangeRowid: 45, createdAt: at}),
  ]);
  store.put('assets', {...asset, reference: {...reference, path: 'media/new.png'}, referenceRevision: 8});
  const recent = createProjectVersions(store).save({projectId, requestId: randomUUID(), name: 'New reference'}).version; versions.push(recent);
  const sourceRows = store.db.prepare('SELECT * FROM main.project_versions ORDER BY id').all(), sourceBlobs = store.db.prepare('SELECT * FROM main.project_version_blobs ORDER BY hash').all();
  const snapshot = await f.snapshot(), result = f.copy(snapshot.db);
  assert.equal(result.versions, 4); assert.equal(result.blobs, 2, 'format 2 and current snapshots converge to one canonical current body');
  assert.equal(result.compressedBytes, f.target.store.db.prepare('SELECT sum(compressedBytes) n FROM main.project_version_blobs').get()!.n);
  const listed = f.api.list({projectId: f.target.projectId}).versions;
  assert.deepEqual(listed.map(item => ({...item, projectId})).sort((a, b) => a.id.localeCompare(b.id)), [...versions].sort((a, b) => a.id.localeCompare(b.id)));
  for (const row of sourceRows) {
    const copied = f.target.store.db.prepare('SELECT * FROM main.project_versions WHERE id=?').get(row.id)!;
    assert.deepEqual({...copied}, {...row, projectId: f.target.projectId, mioChangeRowid: 0, blobHash: copied.blobHash});
    assert.notEqual(copied.blobHash, row.blobHash);
  }
  assert.deepEqual(snapshot.db.prepare('SELECT * FROM main.project_versions ORDER BY id').all(), sourceRows);
  assert.deepEqual(snapshot.db.prepare('SELECT * FROM main.project_version_blobs ORDER BY hash').all(), sourceBlobs);
  const converted = readBlob(f.target.store.db, versions[0].id);
  assert.equal(converted.projectFormatVersion, 3); assert.equal(converted.projectId, f.target.projectId);
  assert.equal(converted.tables.projects[0].id, f.target.projectId);
  assert.ok(converted.evidence.targetRevisions.every(row => row.projectId === f.target.projectId && !processKinds.includes(String(row.kind))));
  const expectedRevisions: readonly SnapshotRow[] = document.evidence.targetRevisions.filter(row => !processKinds.includes(String(row.kind)))
    .map(row => ({...row, projectId: f.target.projectId, targetId: row.kind === 'project' || row.kind === 'timeline' ? f.target.projectId : row.targetId}));
  assert.deepEqual(converted.evidence.targetRevisions, expectedRevisions,
    'all persistent revision evidence survives with only the project-scoped virtual IDs rebound');
  for (const kind of ['project', 'timeline']) assert.equal(converted.evidence.targetRevisions.find(row => row.kind === kind)!.targetId, f.target.projectId);
  assert.deepEqual(converted.tables.project_lut_resources[0].content, {type: 'blob', base64: content.toString('base64')});
  const note = JSON.parse(String(converted.tables.nodes[0].data));
  assert.equal(note.projectId, f.target.projectId); assert.equal(note.owner.projectId, f.target.projectId);
  assert.equal(note.text, projectId); assert.equal(note.arbitraryId, projectId);
  for (const table of HISTORY_TABLES.filter(name => !['project_versions', 'project_version_blobs', 'mio_storage_counters'].includes(name)))
    assert.equal(f.target.store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n, 0, table);
  assert.equal(f.target.store.db.prepare('SELECT 1 FROM main.mio_runs WHERE id=?').get(run.id), undefined);
  assert.throws(() => f.api.list({projectId}), {code: 'PROJECT_ID_MISMATCH'});
  assert.equal(f.target.store.get('assets', assetId), null, 'version copying does not apply old content');
  const filesBefore = readdirSync(f.target.store.projectDir).sort();
  f.restore(versions[0].id);
  for (const [id, originalPath, revision] of [[assetId, path.join(media, 'old.png'), 7], [absoluteId, absolute, 7], [missingId, path.join(media, 'missing.png'), 7]] as const) {
    const restored = f.target.store.get('assets', id) as typeof asset;
    assert.equal(restored.projectId, f.target.projectId); assert.equal(restored.referenceRevision, revision);
    assert.equal(resolveReferencePath(f.target.store.projectDir, restored.reference), originalPath);
    assert.deepEqual({...restored.reference, pathForm: reference.pathForm, path: reference.path, volume: null}, reference);
    assert.equal(restored.sha256, asset.sha256);
  }
  assert.deepEqual(readdirSync(f.target.store.projectDir).sort(), filesBefore, 'no referenced source media is copied into the target');
  assert.equal(readFileSync(path.join(media, 'old.png'), 'utf8'), 'original media');
  assert.equal(readFileSync(path.join(media, 'new.png'), 'utf8'), 'relinked media');
  assert.equal(readFileSync(absolute, 'utf8'), 'outside media');
  f.restore(recent.id);
  // Existing-asset restoration deliberately keeps the current locator. The
  // historical body itself must nevertheless retain its separately relocated path.
  const recentAsset = JSON.parse(String(readBlob(f.target.store.db, recent.id).tables.assets.find(row => row.id === assetId)!.data));
  assert.equal(resolveReferencePath(f.target.store.projectDir, recentAsset.reference), path.join(media, 'new.png'));
  assert.equal(recentAsset.referenceRevision, 8); snapshot.unchanged();
});

for (const version of [2, 3, 4, 5] as const) test(`history ${version} without versions is a valid empty source, with strict owner checking`, t => {
  const f = fixture(t), source = new DatabaseSync(':memory:'); t.after(() => source.close());
  source.exec('BEGIN'); buildPreviousHistoryDatabase(source, version);
  source.prepare('INSERT INTO history_state VALUES(1,?,0)').run(f.source.projectId); source.exec('COMMIT');
  const before = f.state(); assert.deepEqual(f.copy(source), {versions: 0, blobs: 0, compressedBytes: 0}); assert.deepEqual(f.state(), before);
  assert.throws(() => f.target.store.tx(() => copyProjectVersionsToNewProjectInside(source, f.target.store.db,
    {...f.options, sourceProjectId: randomUUID()})), {code: 'PROJECT_ID_MISMATCH', status: 400}); assert.deepEqual(f.state(), before);
});

for (const version of [6, 7] as const) test(`frozen history ${version} carries all logical format-2 versions into the current new-project profile`, t => {
  const f = fixture(t), source = new DatabaseSync(':memory:'), document = f.capture(); t.after(() => source.close());
  source.exec('BEGIN'); buildPreviousHistoryDatabase(source, version);
  source.prepare('INSERT INTO history_state VALUES(1,?,0)').run(f.source.projectId);
  const saved = storeProjectVersionInside(source, {projectId: f.source.projectId, trigger: 'manual', name: `Frozen ${version}`,
    contentSequence: document.evidence.contentSequence, blob: encoded({...document, projectFormatVersion: 2}), mioChangeRowid: 37, createdAt: at});
  source.exec('COMMIT');
  const before = source.prepare('SELECT * FROM project_versions').all(), blobs = source.prepare('SELECT * FROM project_version_blobs').all();
  assert.equal(f.copy(source).versions, 1);
  assert.deepEqual(f.api.list({projectId: f.target.projectId}).versions, [{...saved, projectId: f.target.projectId}]);
  assert.equal(readBlob(f.target.store.db, saved.id).projectFormatVersion, 3);
  assert.equal(f.target.store.db.prepare('SELECT mioChangeRowid FROM project_versions WHERE id=?').get(saved.id)!.mioChangeRowid, 0);
  assert.deepEqual(source.prepare('SELECT * FROM project_versions').all(), before); assert.deepEqual(source.prepare('SELECT * FROM project_version_blobs').all(), blobs);
  f.restore(saved.id); assert.equal((f.target.store.get('projects', f.target.projectId) as {id: string}).id, f.target.projectId);
});

for (const damage of ['format-1', 'hash', 'blob-owner', 'version-owner', 'sequence', 'limit', 'orphan', 'missing-blob', 'partial-domain'] as const)
  test(`cross-project ${damage} refuses the whole conversion, preserving every target table and source byte`, async t => {
    const f = fixture(t), document = f.capture(), blob = encodeProjectDocument(document), {store, projectId} = f.source;
    const [good, second] = store.tx(() => [9, 10].map(mioChangeRowid => storeProjectVersionInside(store.db, {projectId, trigger: 'manual',
      name: `Source ${mioChangeRowid}`, contentSequence: document.evidence.contentSequence, blob, mioChangeRowid}))).sort((a, b) => a.id.localeCompare(b.id));
    const foreignDocument = f.target.store.tx(() => captureProjectDocumentInside(f.target.store));
    const snapshot = await f.snapshot(db => {
      db.exec('PRAGMA foreign_keys=OFF');
      for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()) db.exec(`DROP TRIGGER ${quote(String(row.name))}`);
      if (damage === 'partial-domain') {db.exec('DROP TABLE project_version_capture_marks'); return;}
      if (damage === 'orphan') {db.prepare("INSERT INTO project_version_blobs VALUES(?,1,'gzip',1,1,?)").run('f'.repeat(64), Buffer.from('x')); return;}
      if (damage === 'version-owner') {db.prepare('UPDATE project_versions SET projectId=? WHERE id=?').run(randomUUID(), second.id); return;}
      if (damage === 'sequence') {db.prepare('UPDATE project_versions SET contentSequence=contentSequence+1 WHERE id=?').run(second.id); return;}
      if (damage === 'missing-blob') {db.exec('DELETE FROM project_version_blobs'); return;}
      let changed = damage === 'format-1' ? encoded({...document, projectFormatVersion: 1}) : damage === 'blob-owner'
        ? encoded({...foreignDocument, evidence: {...foreignDocument.evidence, contentSequence: document.evidence.contentSequence}}) : {...blob, hash: 'f'.repeat(64)};
      if (damage === 'limit') changed = {...blob, hash: 'f'.repeat(64), rawBytes: PROJECT_SNAPSHOT_MAX_RAW_BYTES + 1};
      db.exec('PRAGMA ignore_check_constraints=ON');
      db.prepare('INSERT INTO project_version_blobs VALUES(?,?,?,?,?,?)').run(changed.hash, changed.profile, changed.codec, changed.rawBytes, changed.compressedBytes, changed.payload);
      db.prepare('UPDATE project_versions SET blobHash=? WHERE id=?').run(changed.hash, second.id);
    });
    const before = f.state();
    const code = damage === 'format-1' ? 'PROJECT_VERSION_SNAPSHOT_UNSUPPORTED' : damage === 'hash'
      ? 'PROJECT_VERSION_SNAPSHOT_INVALID' : damage === 'limit' ? 'PROJECT_VERSION_SNAPSHOT_LIMIT' : 'PROJECT_VERSION_RECORD_INVALID';
    assert.throws(() => f.copy(snapshot.db), error => {
      assert.equal((error as {code: string}).code, code); assert.equal((error as {status: number}).status, damage === 'limit' ? 413 : 422);
      if (damage === 'format-1') assert.equal((error as {details: {versionId: string}}).details.versionId, second.id);
      return true;
    });
    assert.deepEqual(f.state(), before); snapshot.unchanged(); assert.notEqual(good.id, second.id);
  });

test('the trusted conversion refuses absent target transaction, same identity and a nonempty execution domain', async t => {
  const f = fixture(t); createProjectVersions(f.source.store).save({projectId: f.source.projectId, requestId: randomUUID()});
  const snapshot = await f.snapshot(), before = f.state();
  assert.throws(() => copyProjectVersionsToNewProjectInside(snapshot.db, f.target.store.db, f.options), TypeError);
  assert.throws(() => f.target.store.tx(() => copyProjectVersionsToNewProjectInside(snapshot.db, f.target.store.db, {...f.options, projectId: f.source.projectId})), TypeError);
  assert.deepEqual(f.state(), before);
  f.target.store.db.exec("INSERT INTO main.idempotency VALUES('local','request','hash','kept')");
  const occupied = f.state(); assert.throws(() => f.copy(snapshot.db), {code: 'PROJECT_VERSION_RECORD_INVALID', status: 422});
  assert.deepEqual(f.state(), occupied); snapshot.unchanged();
});

test('new-project Mio changes have new execution authority and exact attribution after a copied version restore', async t => {
  const f = fixture(t), {store, projectId} = f.source, shotId = randomUUID();
  store.put('shots', {id: shotId, projectId, revision: 1, title: 'Copied target', prompt: 'Before', duration: 2, referenceAssetIds: []});
  const oldRun = createAgentTaskJournal(store).create({projectId, requestId: randomUUID(), text: 'Old source only', configuration: mioFixtureConfiguration}).run;
  const document = f.capture(), saved = store.tx(() => storeProjectVersionInside(store.db, {projectId, trigger: 'mio-turn', mioRunId: oldRun.id,
    contentSequence: document.evidence.contentSequence, blob: encodeProjectDocument(document), mioChangeRowid: 99}));
  const snapshot = await f.snapshot(); f.copy(snapshot.db); f.restore(saved.id);
  const target = f.target.store, library = testProjectAppLibrary(target)!, services = createServices(target, new Map(), {env: {}, imageOptions: {autoRun: false}, frameOptions: {autoRun: false}, sceneOptions: {autoRun: false}});
  const journal = createMioProjectJournal(target, library.agentPolicy), tools = createAgentTaskTools({store: target, services, journal, policyStore: library.agentPolicy});
  f.cleanup.push(async () => {tools.dispose(); await services.drain();});
  const run = journal.create({projectId: f.target.projectId, requestId: randomUUID(), text: 'New domain', configuration: mioFixtureConfiguration}).run;
  assert.notEqual(run.id, oldRun.id); assert.equal(target.db.prepare('SELECT 1 FROM main.mio_runs WHERE id=?').get(oldRun.id), undefined);
  assert.throws(() => journal.snapshot(oldRun.id), {code: 'AGENT_TASK_NOT_FOUND'});
  const shot = target.get('shots', shotId) as {revision: number};
  const input = {shotId, expectedRevision: shot.revision, patch: {prompt: 'New Mio edit'}}, prepared = tools.prepare({projectId: f.target.projectId, operation: 'shot.update', input});
  const step = beginFixtureToolStep(journal, run.id, {tier: prepared.risk, targets: prepared.targets,
    toolCall: {id: randomUUID(), name: tools.list().find(tool => tool.operation === 'shot.update')!.name, arguments: input as AgentTaskJson}});
  journal.markDispatch(run.id, step.id);
  const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
    beforeEffect: () => journal.assertTargets(f.target.projectId, prepared.targets), recordInside: (result, changes) => journal.completeStepInside(run.id, step.id, {result, changes}),
    appendChangesInside: changes => journal.appendChangesInside(run.id, step.id, changes)});
  if (!outcome.recorded) journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
  const [change] = journal.snapshot(run.id).changes;
  assert.equal(target.db.prepare('SELECT rowid FROM main.mio_changes WHERE id=?').get(change.id)!.rowid, 1);
  assert.equal(f.api.preview({projectId: f.target.projectId, versionId: saved.id}).changes.find(row => row.table === 'shots')!.source, 'mio');
  journal.transition(run.id, journal.run(run.id).revision, 'completed');
  f.restore(saved.id); const before = f.state();
  assert.throws(() => tools.undo(change, {beforeEffect: () => services.assertMutationAllowed(), recordInside: item => journal.markChangeRevertedInside(item.id),
    retainInside: (item, reason) => journal.markChangeRetainedInside(item.id, reason)}), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.deepEqual(f.state(), before); assert.equal(journal.snapshot(run.id).changes[0].status, 'applied'); snapshot.unchanged();
});
