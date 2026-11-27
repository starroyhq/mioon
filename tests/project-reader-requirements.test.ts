import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test, {type TestContext} from 'node:test';
import {
  assertProjectReaderRequirementsReadOnly, inspectProjectFormatReadOnly, recoverProjectFile,
} from '../packages/business/src/project-file/connection.ts';
import {isHotJournal} from '../packages/business/src/project-file/journals.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {createProjectStore, openProjectStore, registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';
import {
  PROJECT_READER_UPDATE_REQUIRED, TIMELINE_FPS_READER_FEATURE,
} from '../packages/contracts/src/project-reader-requirements.ts';
import {testEnv} from './helpers/test-env.ts';

const format6 = {allowFormat6: true} as const;
const at = '2026-01-01T00:00:00.000Z';
const updateError = {code: PROJECT_READER_UPDATE_REQUIRED, status: 409,
  details: {database: 'project', formatVersion: FORMAT6_PROJECT_SCHEMA_VERSION, unsupportedFeatures: [TIMELINE_FPS_READER_FEATURE]}};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-reader-metadata-'));
  const projectId = randomUUID(), timelineId = randomUUID(), rootId = randomUUID(), trackId = randomUUID();
  const projectFile = path.join(root, 'project.mioon');
  const options = {...format6, projectFile, locate: () => ({
    localDir: path.join(root, 'history'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp'),
  })};
  const store = createProjectStore({...options, projectId, targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const project = {id: projectId, name: 'Synthetic project', revision: 1, createdAt: at, updatedAt: at};
  store.tx(() => {
    store.put('projects', project);
    store.put('nodes', {id: rootId, projectId, type: 'sequence_root', name: 'Film', revision: 1,
      position: {x: 0, y: 0}, createdAt: at});
    store.put('timelines', {id: timelineId, projectId, revision: 1, fps: 30, width: 1280, height: 720, durationFrames: 0,
      createdAt: at, updatedAt: at, mainTrack: {sequenceNodeId: rootId, trackId},
      tracks: [{id: trackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: []});
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, projectId, rootId, 1, JSON.stringify({version: 1, board: [], track: []}));
  });
  return {root, projectFile, project, store, options};
}

function editClosed(file: string, callback: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file);
  try {callback(db);} finally {db.close();}
}

function setFutureFps(db: DatabaseSync) {
  db.prepare("UPDATE projects SET data=json_set(data,'$.requiredReaderFeatures',json_array(?))").run(TIMELINE_FPS_READER_FEATURE);
  db.exec("UPDATE timelines SET data=json_set(data,'$.fps',24)");
}

test('the stable declaration is checked before timeline shape, schema drift, and local open effects', t => {
  const f = fixture(t);
  f.store.close();
  editClosed(f.projectFile, db => {
    setFutureFps(db);
    db.exec('CREATE TABLE future_index(id INTEGER PRIMARY KEY)');
  });
  const before = readFileSync(f.projectFile);
  const unexpectedLocal = path.join(f.root, 'unexpected-local');
  assert.throws(() => assertProjectReaderRequirementsReadOnly(f.projectFile, format6), updateError);
  assert.throws(() => inspectProjectFormatReadOnly(f.projectFile, format6), updateError);
  assert.throws(() => openProjectStore({...f.options,
    checkCopy() {assert.fail('copy check must follow compatibility');},
    locate: () => ({localDir: unexpectedLocal, cacheDir: unexpectedLocal, tempDir: unexpectedLocal}),
  }), updateError);
  assert.equal(existsSync(unexpectedLocal), false);
  assert.deepEqual(readFileSync(f.projectFile), before);
  assert.throws(() => inspectProjectFormatReadOnly(f.projectFile), {code: 'PROJECT_FORMAT_NEWER'});
});

test('format 6 accepts an empty declaration and requires an fps marker for non-30 timelines', t => {
  const f = fixture(t);
  f.store.tx(() => f.store.put('projects', {...f.project, requiredReaderFeatures: []}));
  f.store.close();
  assert.equal(inspectProjectFormatReadOnly(f.projectFile, format6).formatVersion, FORMAT6_PROJECT_SCHEMA_VERSION);
  editClosed(f.projectFile, db => db.exec("UPDATE timelines SET data=json_set(data,'$.fps',24)"));
  assert.throws(() => inspectProjectFormatReadOnly(f.projectFile, format6), {code: 'PROJECT_INVALID'});
  editClosed(f.projectFile, setFutureFps);
  assert.throws(() => inspectProjectFormatReadOnly(f.projectFile, format6), updateError);
});

test('a held transaction cannot install a future declaration or notify observers about it', t => {
  const {store, project} = fixture(t);
  const unregister = registerProjectTransactionObserver(store.db, () => assert.fail('unsupported transaction reached its observer'));
  try {
    assert.throws(() => store.tx(() => store.put('projects', {...project,
      requiredReaderFeatures: [TIMELINE_FPS_READER_FEATURE],
    })), updateError);
  } finally {unregister();}
  assert.deepEqual(store.get('projects', project.id), project);
  assert.equal(store.db.isTransaction, false);
});

test('a format 6 rollback journal is inspected without replaying a committed future project in place', t => {
  const f = fixture(t);
  f.store.close();
  editClosed(f.projectFile, db => {
    db.exec('CREATE TABLE future_index(id INTEGER PRIMARY KEY, pad TEXT)');
    setFutureFps(db);
  });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=4; BEGIN IMMEDIATE');
    db.exec("UPDATE projects SET data=json_remove(data,'$.requiredReaderFeatures')");
    const insert = db.prepare('INSERT INTO future_index(pad) VALUES(?)');
    for (let n = 0; n < 128; n++) insert.run('x'.repeat(4096));
    process.kill(process.pid, 'SIGKILL');
  `, f.projectFile], {encoding: 'utf8', env: testEnv(), timeout: 20_000});
  assert.equal(child.error, undefined, child.stderr);
  const journal = f.projectFile + '-journal';
  assert.ok(isHotJournal(journal), child.stderr);
  const before = [f.projectFile, journal].map(file => readFileSync(file));
  assert.throws(() => assertProjectReaderRequirementsReadOnly(f.projectFile, format6), updateError);
  assert.throws(() => inspectProjectFormatReadOnly(f.projectFile, format6), updateError);
  assert.throws(() => recoverProjectFile(f.projectFile, format6), updateError);
  assert.deepEqual([f.projectFile, journal].map(file => readFileSync(file)), before);
});
