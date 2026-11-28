import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import {gzipSync} from 'node:zlib';
import {startServer} from './helpers/test-server.ts';
import {changeMarks, readProjectState} from './helpers/project-state.ts';
import {PROJECT_READER_UPDATE_REQUIRED, TIMELINE_FPS_READER_FEATURE} from '../packages/contracts/src/project-reader-requirements.ts';
import {createProjectBackup, inspectCopiedProjectFile, inspectProjectBackup} from '../packages/business/src/project-file/backup.ts';
import {captureClosedProjectSnapshot} from '../packages/business/src/project-file/closed-copy.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {copyProjectBackup, copyProjectToNewFile} from '../packages/business/src/project-file/copy.ts';
import {restoreFormat4Backup} from '../packages/business/src/project-file/format4-restore.ts';
import {upgradeProjectSequenceFormat} from '../packages/business/src/project-file/format5-upgrade.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore} from '../packages/business/src/project-file/store.ts';
import {canonicalJson, captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {inspectProjectDocumentForCopy} from '../packages/business/src/project-versions/codec.ts';
import {storeManualVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';

const future = TIMELINE_FPS_READER_FEATURE;
const requiresUpdate = {code: PROJECT_READER_UPDATE_REQUIRED, status: 409};

function fixture(t: TestContext, targetFormat: typeof FORMAT5_PROJECT_SCHEMA_VERSION | typeof FORMAT6_PROJECT_SCHEMA_VERSION = FORMAT6_PROJECT_SCHEMA_VERSION) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'project-reader-copy-'));
  const projectId = randomUUID(), timelineId = randomUUID(), sequenceNodeId = randomUUID(), trackId = randomUUID();
  const projectFile = path.join(root, 'project.mioon'), historyFile = path.join(root, 'records', 'history.db');
  const location = {localDir: path.dirname(historyFile), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp')};
  const store = createProjectStore({projectId, projectFile, targetFormat, allowFormat6: true, locate: () => location});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const at = '2026-01-01T00:00:00.000Z';
  store.tx(() => {
    store.put('projects', {id: projectId, revision: 1, name: 'Synthetic project', createdAt: at, updatedAt: at});
    store.put('nodes', {id: sequenceNodeId, projectId, type: 'sequence_root', name: 'Film', revision: 1, position: {x: 0, y: 0}, createdAt: at});
    store.put('timelines', {id: timelineId, projectId, revision: 1, width: 1280, height: 720, fps: 30, durationFrames: 0,
      createdAt: at, updatedAt: at, mainTrack: {trackId, sequenceNodeId},
      tracks: [{id: trackId, kind: 'video', name: 'V1', orderIndex: 0, hidden: false, muted: false}], clips: []});
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, sequenceNodeId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  return {root, projectId, projectFile, historyFile, location, store};
}

function emulateFutureSave(db: DatabaseSync, schema: 'main' | 'project'): void {
  db.prepare(`UPDATE ${schema}.projects SET data=json_set(data,'$.requiredReaderFeatures',json_array(?))`).run(future);
  db.exec(`UPDATE ${schema}.timelines SET data=json_set(data,'$.fps',24)`);
}

test('future format 6 blocks closed copies and atomic backup restore without touching files', async t => {
  const f = fixture(t), backupFile = path.join(f.root, 'project-backup.mioon'), destination = path.join(f.root, 'restored.mioon');
  await createProjectBackup(f.store, backupFile);
  f.store.close();
  for (const file of [f.projectFile, backupFile]) {
    const db = new DatabaseSync(file);
    try {emulateFutureSave(db, 'main');} finally {db.close();}
  }
  const before = [f.projectFile, backupFile, f.historyFile].map(file => readFileSync(file));
  const entries = readdirSync(f.root);
  assert.throws(() => inspectCopiedProjectFile(f.projectFile), requiresUpdate);
  assert.throws(() => inspectProjectBackup(backupFile), requiresUpdate);
  await assert.rejects(captureClosedProjectSnapshot({projectFile: f.projectFile, format4: {allowFormat6: true},
    directory: path.join(f.root, 'snapshot'), historyFile: () => assert.fail('future project must be rejected before history access')}), requiresUpdate);
  await assert.rejects(copyProjectBackup({backupFile, projectFile: destination, sourceProjectDir: f.root}), requiresUpdate);
  assert.deepEqual(readdirSync(f.root), entries);
  assert.deepEqual([f.projectFile, backupFile, f.historyFile].map(file => readFileSync(file)), before);
});

test('live copy and backup recheck the format 6 marker before allocating destinations', async t => {
  const f = fixture(t);
  emulateFutureSave(f.store.db, 'project');
  const stamp = readProjectContentStamp(f.store.db), entries = readdirSync(f.root);
  await assert.rejects(copyProjectToNewFile(f.store, {projectFile: path.join(f.root, 'copy.mioon'), sourceProjectDir: f.root}), requiresUpdate);
  await assert.rejects(createProjectBackup(f.store, path.join(f.root, 'backup', 'new-backup.mioon')), requiresUpdate);
  assert.deepEqual(readdirSync(f.root), entries);
  assert.deepEqual(readProjectContentStamp(f.store.db), stamp);
  assert.equal(f.store.db.prepare("SELECT json_extract(data,'$.fps') AS fps FROM project.timelines").get()?.fps, 24);
});

test('preview, restore and copy inspection reject a future named version before creating a recovery snapshot or receipt', t => {
  const {store, projectId} = fixture(t);
  const captured = store.tx(() => captureProjectDocumentInside(store));
  const project = captured.tables.projects[0]!, timeline = captured.tables.timelines[0]!;
  const futureDocument = {...captured, tables: {...captured.tables,
    projects: [{...project, data: canonicalJson({...JSON.parse(String(project.data)), requiredReaderFeatures: [future]})}],
    timelines: [{...timeline, data: canonicalJson({...JSON.parse(String(timeline.data)), fps: 24})}],
    future_timeline_settings: [],
  }};
  const raw = Buffer.from(canonicalJson(futureDocument)), payload = gzipSync(raw);
  const blob = {hash: createHash('sha256').update(raw).digest('hex'), rawBytes: raw.length, compressedBytes: payload.length,
    payload, profile: 1 as const, codec: 'gzip' as const};
  const version = store.tx(() => storeManualVersionInside(store.db, projectId, 'Future', captured.evidence.contentSequence, blob));
  const state = () => ['project.project_file', 'project.projects', 'project.timelines', 'main.project_versions',
    'main.project_version_blobs', 'main.project_version_requests', 'main.project_version_capture_marks']
    .map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = state(), marks = changeMarks(store.db), stamp = readProjectContentStamp(store.db),
    api = createProjectVersions(store, {assertMutationAllowed() {}});
  assert.throws(() => inspectProjectDocumentForCopy(blob), requiresUpdate);
  assert.throws(() => api.preview({projectId, versionId: version.id}), requiresUpdate);
  assert.throws(() => api.restore({projectId, versionId: version.id, requestId: randomUUID(), expectedContentSequence: stamp.contentSequence,
    expectedContentToken: stamp.contentToken, previewDigest: '0'.repeat(64)}), requiresUpdate);
  assert.deepEqual(state(), before);
  assert.deepEqual(changeMarks(store.db), marks);
});


test('a trusted future format 6 template cannot publish or register a project on the development channel', async t => {
  const f = fixture(t);
  emulateFutureSave(f.store.db, 'project');
  f.store.close();
  const sourceBefore = readFileSync(f.projectFile), historyBefore = readFileSync(f.historyFile);
  const target = path.join(f.root, 'target'), dataDir = path.join(f.root, 'app');
  mkdirSync(target);
  const previousGate = process.env.MIOON_FORMAT6_DEV;
  t.after(() => {
    if (previousGate === undefined) delete process.env.MIOON_FORMAT6_DEV;
    else process.env.MIOON_FORMAT6_DEV = previousGate;
  });
  process.env.MIOON_FORMAT6_DEV = '1';
  let application!: <T>(read: (db: DatabaseSync) => T) => T;
  const token = 'synthetic-future-template-authentication';
  const server = await startServer({dataDir, projectsDir: path.join(f.root, 'projects'), port: 0, token,
    projectFormatForTest: undefined, localDraftChannel: 'development', inspectApplication: value => {application = value;},
    projectTemplates: [{directory: f.root, manifest: {templateId: 'future-starter', version: 1, assets: [],
      projectFile: {path: path.basename(f.projectFile), sizeBytes: sourceBefore.length,
        sha256: createHash('sha256').update(sourceBefore).digest('hex')}}}]});
  try {
    const appBefore = application(db => ({state: readProjectState(db), marks: changeMarks(db)}));
    const filesBefore = readdirSync(dataDir, {recursive: true}).sort();
    const input = {templateId: 'future-starter', templateVersion: 1, parentDir: target, name: 'Instance', requestId: randomUUID()};
    const response = await fetch(server.url + '/api/rpc', {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({operation: 'project.template.instantiate', input})});
    assert.equal(response.status, 409);
    const body = await response.json() as {ok: boolean; error?: {code: string; details: unknown}};
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, PROJECT_READER_UPDATE_REQUIRED);
    assert.deepEqual(body.error?.details, {database: 'project', formatVersion: FORMAT6_PROJECT_SCHEMA_VERSION, unsupportedFeatures: [future]});
    const instantiate = server.projectEntries.instantiateTemplate;
    assert.ok(instantiate);
    await assert.rejects(instantiate({...input, requestId: randomUUID()}), requiresUpdate);
    assert.deepEqual(readdirSync(target), []);
    assert.deepEqual(readdirSync(dataDir, {recursive: true}).sort(), filesBefore);
    assert.deepEqual(application(db => ({state: readProjectState(db), marks: changeMarks(db)})), appBefore);
    assert.deepEqual(readFileSync(f.projectFile), sourceBefore);
    assert.deepEqual(readFileSync(f.historyFile), historyBefore);
  } finally {await server.close();}
});

test('paired restore leaves the future target and its format upgrade backup intact', {skip: process.platform === 'win32'}, t => {
  const f = fixture(t, FORMAT5_PROJECT_SCHEMA_VERSION);
  f.store.close();
  const current = upgradeProjectSequenceFormat(FORMAT6_PROJECT_SCHEMA_VERSION, {
    projectFile: f.projectFile, locate: () => f.location, approveUpgrade: () => true,
  });
  let expected: ReturnType<typeof readProjectContentStamp>;
  try {
    emulateFutureSave(current.store.db, 'project');
    expected = readProjectContentStamp(current.store.db);
  } finally {current.store.close();}
  assert.ok(current.backupId);
  const backup = path.join(f.location.localDir, 'format-upgrade-backups', current.backupId);
  const files = [f.projectFile, f.historyFile, path.join(backup, 'project.mioon'), path.join(backup, 'history.db'), path.join(backup, 'manifest.json')];
  const before = files.map(file => readFileSync(file)), entries = readdirSync(f.root, {recursive: true}).sort();
  assert.throws(() => restoreFormat4Backup({projectFile: f.projectFile, location: f.location, projectId: f.projectId,
    allowFormat6: true, backupId: current.backupId!, expected, onBoundary: () => assert.fail('future project cannot prepare a restore')}), requiresUpdate);
  assert.deepEqual(readdirSync(f.root, {recursive: true}).sort(), entries);
  assert.deepEqual(files.map(file => readFileSync(file)), before);
});
