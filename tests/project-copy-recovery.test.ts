import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {serverAppDirectories, projectLocation} from '../apps/server/src/project-host/directories.ts';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createProjectCopies} from '../apps/server/src/project-host/copies.ts';
import {createApplicationFileGuard} from '../apps/server/src/project-host/application-storage.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {storeManualVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import type {ProjectCopyInput} from '../packages/contracts/src/project-copies.ts';
import {copyIdentity} from '../apps/server/src/project-host/copy-records.ts';

const runtime = async () => ({handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}});
function owner(root: string, onBoundary?: Parameters<typeof createProjectCopies>[0]['onBoundary']) {
  const directories = serverAppDirectories(root), signal = new AbortController();
  let manager: ReturnType<typeof createProjectHostManager>;
  const library = openAppLibrary({dataDir: root, isProjectOpen: id => manager?.status(id) !== null && manager?.status(id) !== undefined});
  manager = createProjectHostManager({directories, registry: library.registry, identity: library.projectFileIdentity, factory: runtime});
  const copies = createProjectCopies({manager, library, directories, signal: signal.signal,
    assertProjectFile: createApplicationFileGuard(directories), ...(onBoundary ? {onBoundary} : {})});
  return {library, manager, copies, directories, async close() {await copies.drain(); await manager.closeAll(); library.close();}};
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'project-copy-recovery-'));
  let app = owner(root);
  t.after(async () => {await app.close(); rmSync(root, {recursive: true, force: true});});
  const source = await app.manager.create({name: 'Original'});
  const store = openProjectStore({projectFile: source.projectFile, locate: id => projectLocation(app.directories, id)});
  ensureProjectRow(store, {name: 'Original'});
  store.db.prepare("INSERT INTO project.agent_task_target_revisions_v2 VALUES(?,'job',?,3)").run(source.projectId, randomUUID());
  store.tx(() => storeManualVersionInside(store.db, source.projectId, 'Checkpoint', readProjectContentStamp(store.db).contentSequence,
    encodeProjectDocument(captureProjectDocumentInside(store))));
  store.db.prepare("INSERT INTO main.idempotency VALUES('source-only','one','hash','resource')").run();
  const originalStamp = readProjectContentStamp(store.db); store.close();
  const sourceHistory = path.join(projectLocation(app.directories, source.projectId).localDir, 'history.db');
  const original = {project: readFileSync(source.projectFile), history: readFileSync(sourceHistory)};
  const targetDir = mkdtempSync(path.join(tmpdir(), 'project-copy-target-'));
  t.after(() => rmSync(targetDir, {recursive: true, force: true}));
  const input: ProjectCopyInput = {projectId: source.projectId, requestId: randomUUID(), projectFile: path.join(targetDir, 'copy.mioon'), name: 'Copied'};
  return {root, source, sourceHistory, originalStamp, input, get app() {return app;},
    async restart(boundary?: Parameters<typeof createProjectCopies>[0]['onBoundary']) {await app.close(); app = owner(root, boundary);},
    unchanged() {assert.deepEqual(readFileSync(source.projectFile), original.project); assert.deepEqual(readFileSync(sourceHistory), original.history);}};
}

test('copy carries only rebound versions, replays the exact receipt after edits and never grants revoked scope again', async t => {
  const f = await fixture(t), outside = path.join(path.dirname(f.input.projectFile), 'outside'); mkdirSync(outside);
  f.app.library.outsidePaths.confirm({projectId: f.source.projectId, directory: outside, confirmedAt: new Date().toISOString()});
  const result = await f.app.copies.duplicate(f.input);
  assert.notEqual(result.project.projectId, f.source.projectId); assert.notEqual(result.contentToken, f.originalStamp.contentToken);
  assert.equal(result.versions, 1); assert.equal(result.contentSequence, f.originalStamp.contentSequence + 1); f.unchanged();
  const lease = await f.app.manager.acquire(result.project.projectId, 'window'), store = lease.host.store;
  assert.equal(store.historyState, 'current'); assert.equal((store.get('projects', result.project.projectId) as {name: string}).name, 'Copied');
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.project_versions').get()!.n, 1);
  assert.equal(store.db.prepare('SELECT mioChangeRowid FROM main.project_versions').get()!.mioChangeRowid, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.idempotency').get()!.n, 0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM project.agent_task_target_revisions_v2 WHERE kind IN ('job','export','image_task','frame_task')").get()!.n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM main.mio_runs').get()!.n, 0);
  store.put('projects', {...store.get('projects', result.project.projectId) as Record<string, unknown>, id: result.project.projectId, name: 'Later edit'});
  f.app.library.outsidePaths.revoke(result.project.projectId, outside);
  assert.deepEqual(await f.app.copies.duplicate(f.input), result);
  assert.equal((store.get('projects', result.project.projectId) as {name: string}).name, 'Later edit');
  assert.equal(f.app.library.outsidePaths.list(result.project.projectId).some(row => row.directory === outside), false);
  lease.release(); await f.app.manager.close(result.project.projectId);
  await assert.rejects(f.app.copies.duplicate({...f.input, name: 'Different'}), {code: 'REQUEST_ID_REUSED'});
  assert.equal(readdirSync(path.join(f.root, 'project-copies')).some(name => !name.endsWith('.json')), false);
  f.unchanged();
});

for (const point of ['prepared', 'captured', 'ready', 'records-prepared', 'records-published', 'project-published', 'registered'] as const) {
  test(`restart ${point === 'prepared' || point === 'captured' ? 'invalidates preparation' : 'resumes the same copy identity'} after ${point} without changing its source`, async t => {
    const f = await fixture(t); let hit = false;
    await f.restart(phase => {if (phase === point) {hit = true; throw Error('injected copy failure');}});
    await assert.rejects(f.app.copies.duplicate(f.input)); assert.equal(hit, true); f.unchanged();
    const saved = JSON.parse(readFileSync(path.join(f.root, 'project-copies', `project.duplicate-${f.input.requestId}.json`), 'utf8'));
    await f.restart(); await f.app.copies.recover();
    const early = point === 'prepared' || point === 'captured';
    if (early) {
      await assert.rejects(f.app.copies.duplicate(f.input), {code: 'PROJECT_COPY_INTERRUPTED'});
      const tombstone = JSON.parse(readFileSync(path.join(f.root, 'project-copies', `project.duplicate-${f.input.requestId}.json`), 'utf8'));
      assert.equal(tombstone.phase, 'abandoned'); assert.equal(tombstone.projectId, saved.projectId);
      assert.equal(tombstone.contentToken, saved.contentToken); assert.equal(existsSync(f.input.projectFile), false);
    }
    const input = early ? {...f.input, requestId: randomUUID()} : f.input;
    const result = await f.app.copies.duplicate(input);
    assert.equal(result.project.projectId === saved.projectId, !early); assert.equal(result.contentToken === saved.contentToken, !early); assert.equal(result.versions, 1);
    assert.deepEqual(await f.app.copies.duplicate(input), result); f.unchanged();
    const store = openProjectStore({projectFile: result.project.projectFile, locate: id => projectLocation(f.app.directories, id)});
    try {assert.equal(store.historyState, 'current'); assert.equal(store.db.prepare('SELECT count(*) n FROM main.project_versions').get()!.n, 1);}
    finally {store.close();}
  });
}

for (const point of ['captured', 'records-prepared', 'records-published', 'registered'] as const) {
  test(`real SIGKILL at ${point} preserves a recoverable copy and its fixed request result`, {timeout: 60_000}, async t => {
    const f = await fixture(t); await f.app.close();
    const worker = new URL('./fixtures/project-copy-worker.ts', import.meta.url);
    const result = spawnSync(process.execPath, [worker.pathname, JSON.stringify({root: f.root, input: f.input, point})], {encoding: 'utf8', timeout: 40_000});
    assert.equal(result.error, undefined); assert.equal(result.signal, 'SIGKILL', result.stderr); f.unchanged();
    await f.restart(); await f.app.copies.recover();
    if (point === 'captured') await assert.rejects(f.app.copies.duplicate(f.input), {code: 'PROJECT_COPY_INTERRUPTED'});
    const input = point === 'captured' ? {...f.input, requestId: randomUUID()} : f.input;
    const copied = await f.app.copies.duplicate(input);
    assert.equal(copied.versions, 1); assert.deepEqual(await f.app.copies.duplicate(input), copied); f.unchanged();
  });
}

test('a completed target later removed does not block startup or recreate the file', async t => {
  const f = await fixture(t), result = await f.app.copies.duplicate(f.input);
  rmSync(result.project.projectFile); await f.restart(); await f.app.copies.recover();
  assert.equal(existsSync(result.project.projectFile), false);
  await assert.rejects(f.app.copies.duplicate(f.input), {code: 'PROJECT_COPY_TARGET_CHANGED'}); f.unchanged();
});

for (const phase of ['prepared', 'captured'] as const) {
  for (const replaced of [false, true]) {
    test(`${phase} startup abandons the intent and ${replaced ? 'preserves a replaced' : 'cleans its owned'} hidden stage`, async t => {
      const f = await fixture(t);
      await f.restart(point => {if (point === phase) throw Error('stop preparation');});
      await assert.rejects(f.app.copies.duplicate(f.input), /stop preparation/u);
      const record = path.join(f.root, 'project-copies', `project.duplicate-${f.input.requestId}.json`);
      const intent = JSON.parse(readFileSync(record, 'utf8'));
      const stage = mkdtempSync(path.join(path.dirname(f.input.projectFile), '.project-copy-'));
      writeFileSync(path.join(stage, 'project.mioon'), 'owned incomplete stage');
      const builder = mkdtempSync(path.join(stage, 'project-copy-'));
      writeFileSync(path.join(builder, 'project.mioon'), 'incomplete isolated builder');
      writeFileSync(path.join(builder, 'project.mioon-journal'), 'interrupted builder journal');
      intent.stageDirectory = stage; intent.stageDirectoryIdentity = copyIdentity(stage);
      writeFileSync(record, JSON.stringify(intent));
      if (replaced) {renameSync(stage, stage + '-old'); mkdirSync(stage); writeFileSync(path.join(stage, 'user.txt'), 'keep');}
      await f.restart(); await f.app.copies.recover();
      assert.equal(existsSync(stage), replaced);
      if (replaced) assert.equal(readFileSync(path.join(stage, 'user.txt'), 'utf8'), 'keep');
      assert.equal(JSON.parse(readFileSync(record, 'utf8')).phase, 'abandoned');
      await assert.rejects(f.app.copies.duplicate(f.input), {code: 'PROJECT_COPY_INTERRUPTED'});
      await assert.rejects(f.app.copies.duplicate({...f.input, name: 'changed'}), {code: 'REQUEST_ID_REUSED'});
      assert.equal(existsSync(f.input.projectFile), false); f.unchanged();
      await f.app.copies.recover(); assert.equal(existsSync(stage), replaced);
    });
  }
}

test('an existing target is rejected before any copy intent or source close', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.input.projectFile); db.exec('CREATE TABLE untouched(value TEXT)'); db.close();
  const bytes = readFileSync(f.input.projectFile);
  await assert.rejects(f.app.copies.duplicate(f.input), {code: 'PROJECT_FILE_EXISTS'});
  assert.deepEqual(readFileSync(f.input.projectFile), bytes); assert.equal(existsSync(path.join(f.root, 'project-copies')), false); f.unchanged();
});

test('a malformed intent rejects before claiming the target in memory', async t => {
  const f = await fixture(t);
  await f.restart(phase => {if (phase === 'prepared') throw Error('stop before capture');});
  await assert.rejects(f.app.copies.duplicate(f.input), /stop before capture/u);
  const record = path.join(f.root, 'project-copies', `project.duplicate-${f.input.requestId}.json`);
  writeFileSync(record, '{broken');
  await assert.rejects(f.app.copies.duplicate(f.input), {code: 'PROJECT_COPY_INTENT_INVALID'});
  // A different request can still claim this untouched target; invalid input
  // must not leave an in-memory busy claim that survives every later request.
  const other = {...f.input, requestId: randomUUID()};
  await assert.rejects(f.app.copies.duplicate(other), /stop before capture/u);
  assert.equal(existsSync(f.input.projectFile), false); f.unchanged();
});
