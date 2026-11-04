import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectHostManager, SYSTEM_CLOCK} from '../apps/server/src/project-host/manager.ts';
import type {ManagerClock} from '../apps/server/src/project-host/manager.ts';
import {createMemoryProjectRegistry, createMemoryBackgroundTaskIndex} from '../apps/server/src/project-host/stand-ins.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {canonicalJson} from '../packages/business/src/project-versions/document.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectHistoryResolveInput} from '../packages/contracts/src/project-history-recovery.ts';
import type {ProjectHistoryStatus} from '../packages/contracts/src/project-history-recovery.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';

async function fixture(t: TestContext, processTargets = false, clock?: ManagerClock) {
  const root = mkdtempSync(path.join(tmpdir(), 'history-recovery-'));
  const directories = serverAppDirectories(root), registry = createMemoryProjectRegistry(), taskIndex = createMemoryBackgroundTaskIndex();
  const counts = {factory: 0, opened: 0, closed: 0}, owner = new AbortController();
  const library = openAppLibrary({dataDir: path.join(root, 'app-owner')});
  const guard = createProjectServiceApplication(library, owner.signal).assertMutationAllowed;
  const manager = createProjectHostManager({directories, registry, taskIndex, assertMutationAllowed: guard, ...(clock ? {clock} : {}),
    factory: async context => {
      counts.factory++; ensureProjectRow(context.store, {name: 'Original'});
      return {handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}};
    }, hooks: [{afterOpen() {counts.opened++;}, beforeClose() {counts.closed++;}}]});
  t.after(async () => {await manager.closeAll(); if (library.db.isOpen) library.close(); rmSync(root, {recursive: true, force: true});});
  const registration = await manager.create({name: 'Original'}), projectId = registration.projectId;
  const lease = await manager.acquire(projectId, 'window'), store = lease.host.store;
  const saved = createProjectVersions(store).save({projectId, requestId: randomUUID(), name: 'Before external edit'}).version;
  if (processTargets) store.tx(() => {
    for (const kind of ['job', 'export', 'image_task', 'frame_task']) store.db.prepare('INSERT INTO project.agent_task_target_revisions_v2(projectId,kind,targetId,revision) VALUES(?,?,?,3)').run(projectId, kind, randomUUID());
  });
  lease.release(); await manager.close(projectId);
  const raw = new DatabaseSync(registration.projectFile);
  let sequence: number;
  try {
    raw.prepare("UPDATE projects SET data=json_set(data,'$.name','External','$.revision',2) WHERE id=?").run(projectId);
    sequence = Number(raw.prepare('SELECT contentSequence FROM project_file').get()!.contentSequence);
  } finally {raw.close();}
  const local = projectLocation(directories, projectId);
  // Model a local branch that made one different edit: its seen sequence is
  // equal, but its original token differs from this externally edited file.
  const old = new DatabaseSync(path.join(local.localDir, 'history.db'));
  try {old.prepare('UPDATE history_state SET seenContentSequence=?').run(sequence);} finally {old.close();}
  return {root, directories, registry, taskIndex, counts, owner, library, manager, registration, projectId, saved, local, guard};
}
function confirmation(status: ProjectHistoryStatus, action: 'continue' | 'restore-version', versionId?: string, previewDigest?: string): ProjectHistoryResolveInput {
  const shared = {projectId: status.projectId, requestId: randomUUID(), expected: status.file, historyIdentity: status.historyIdentity, confirmationDigest: status.confirmationDigest};
  return action === 'continue' ? {...shared, action} : {...shared, action, versionId: versionId!, previewDigest: previewDigest!};
}
function files(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root).filter(name => !name.endsWith('-journal')).map(name => [name, readFileSync(path.join(root, name)).toString('base64')]));
}

test('diverged admission precedes factory, lifecycle hooks and all business dispatch; readonly preview preserves evidence', async t => {
  const f = await fixture(t), before = files(f.local.localDir), counts = {...f.counts};
  const lease = await f.manager.acquire(f.projectId, 'window');
  const session = lease.host.recovery!;
  assert.ok(session); assert.deepEqual(f.counts, counts);
  assert.throws(() => lease.host.runtime, {code: 'PROJECT_HISTORY_DIVERGED'});
  const status = session.status();
  assert.equal(status.state, 'diverged'); assert.equal(status.reason, 'content-token-different'); assert.equal(status.versionCount, 1);
  assert.equal(status.unknownProviderTasks, 0); assert.notEqual(status.file.contentToken, status.seen.contentToken);
  assert.equal(session.listVersions({projectId: f.projectId}).versions[0]!.id, f.saved.id);
  const preview = session.previewVersion({projectId: f.projectId, versionId: f.saved.id});
  assert.equal(preview.restoreAvailable, true); assert.ok(preview.totalChanges > 0);
  assert.deepEqual(session.status(), status); assert.deepEqual(files(f.local.localDir), before);
  assert.throws(() => lease.host.store.db.exec('UPDATE project.projects SET data=data'), /readonly|PROJECT_HISTORY_DIVERGED/u);
  lease.release(); await f.manager.close(f.projectId); assert.deepEqual(f.counts, counts);
});

test('recovery admission and confirmation preserve lastOpenedAt until the resolved project opens normally', async t => {
  let now = Date.UTC(2026, 10, 4, 0, 0, 0);
  const f = await fixture(t, false, {...SYSTEM_CLOCK, now: () => now});
  const registration = f.registry.get(f.projectId)!;
  assert.equal(registration.lastOpenedAt, new Date(now).toISOString());
  const counts = {...f.counts};

  now += 60_000;
  const lease = await f.manager.openPath(f.registration.projectFile, 'window');
  assert.ok(lease.host.recovery);
  assert.deepEqual(f.registry.get(f.projectId), registration);
  assert.deepEqual(f.counts, counts);
  const input = confirmation(lease.host.recovery.status(), 'continue');
  lease.release(); await f.manager.close(f.projectId);
  assert.deepEqual(f.registry.get(f.projectId), registration);

  now += 60_000;
  const result = await f.manager.resolveHistory(input);
  assert.equal(result.activation, 'pending');
  assert.deepEqual(f.registry.get(f.projectId), registration);
  assert.deepEqual(f.counts, counts);

  now += 60_000;
  const current = await f.manager.acquire(f.projectId, 'window');
  assert.equal(current.host.recovery, undefined);
  assert.deepEqual(f.counts, {...counts, factory: counts.factory + 1, opened: counts.opened + 1});
  assert.deepEqual(f.registry.get(f.projectId), {...registration, lastOpenedAt: new Date(now).toISOString()});
  assert.equal((current.host.store.get('projects', f.projectId) as {name: string}).name, 'External');
  current.release();
});

test('continue archives the complete original history, carries only immutable versions, then normal runtime admits new work', async t => {
  const f = await fixture(t), original = readFileSync(path.join(f.local.localDir, 'history.db'));
  const lease = await f.manager.acquire(f.projectId, 'window'), status = lease.host.recovery!.status();
  const input = confirmation(status, 'continue'); lease.release();
  const result = await f.manager.resolveHistory(input);
  assert.deepEqual(result.content, status.file); assert.equal(result.activation, 'pending');
  const archive = path.join(f.local.localDir, result.archive);
  assert.deepEqual(readFileSync(archive), original); assert.equal(lstatSync(archive).mode & 0o777, 0o400);
  const current = await f.manager.acquire(f.projectId, 'window');
  assert.equal(current.host.recovery, undefined); assert.equal(f.counts.factory, 2);
  assert.equal((current.host.store.get('projects', f.projectId) as {name: string}).name, 'External');
  const db = current.host.store.db;
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_version_requests').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_version_capture_marks').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mio_runs').get()!.n, 0);
  const versions = createProjectVersions(current.host.store, {assertMutationAllowed: f.guard});
  assert.equal(versions.list({projectId: f.projectId}).versions[0]!.id, f.saved.id);
  assert.ok(versions.preview({projectId: f.projectId, versionId: f.saved.id}).totalChanges > 0);
  current.release(); await f.manager.close(f.projectId);
  assert.deepEqual(await f.manager.resolveHistory(input), result);
  await assert.rejects(f.manager.resolveHistory({...input, confirmationDigest: 'a'.repeat(64)}), {code: 'REQUEST_ID_REUSED'});
  assert.equal(readdirSync(f.local.localDir).filter(name => /^history-\d/u.test(name)).length, 1);
});

test('restore is a new content commit, and replay after later edits cannot restore twice', async t => {
  const f = await fixture(t), lease = await f.manager.acquire(f.projectId, 'window'), session = lease.host.recovery!;
  const status = session.status(), preview = session.previewVersion({projectId: f.projectId, versionId: f.saved.id});
  const input = confirmation(status, 'restore-version', f.saved.id, preview.previewDigest); lease.release();
  const result = await f.manager.resolveHistory(input);
  assert.ok(result.content.contentSequence > status.file.contentSequence); assert.notEqual(result.content.contentToken, status.file.contentToken);
  const current = await f.manager.acquire(f.projectId, 'window'), store = current.host.store;
  assert.equal((store.get('projects', f.projectId) as {name: string}).name, 'Original');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_version_requests').get()!.n, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM project_versions WHERE trigger='restore'").get()!.n, 1);
  const project = store.get('projects', f.projectId) as {id: string; name: string; revision: number};
  store.tx(() => store.put('projects', {...project, name: 'Later edit', revision: project.revision + 1}));
  const later = readProjectContentStamp(store.db); current.release(); await f.manager.close(f.projectId);
  assert.deepEqual(await f.manager.resolveHistory(input), result);
  const reopened = await f.manager.acquire(f.projectId, 'window');
  assert.deepEqual(readProjectContentStamp(reopened.host.store.db), later);
  assert.equal((reopened.host.store.get('projects', f.projectId) as {name: string}).name, 'Later edit'); reopened.release();
});

for (const mode of ['abort', 'reopen-owner'] as const) test(`recovery confirmation refuses ${mode} with zero project/history writes`, async t => {
  const f = await fixture(t), lease = await f.manager.acquire(f.projectId, 'window');
  const input = confirmation(lease.host.recovery!.status(), 'continue'); lease.release();
  const before = files(f.local.localDir), content = readFileSync(f.registration.projectFile);
  let replacement: ReturnType<typeof openAppLibrary> | undefined;
  if (mode === 'abort') f.owner.abort(new Error('owner stopped'));
  else {f.library.close(); replacement = openAppLibrary({dataDir: path.join(f.root, 'app-owner')});}
  try {
    await assert.rejects(f.manager.resolveHistory(input), mode === 'abort' ? /owner stopped/u : /live application library owner/u);
    assert.deepEqual(files(f.local.localDir), before); assert.deepEqual(readFileSync(f.registration.projectFile), content);
  } finally {replacement?.close();}
});

test('stale pair or history confirmation never creates an archive or a receipt', async t => {
  const f = await fixture(t), lease = await f.manager.acquire(f.projectId, 'window');
  const input = confirmation(lease.host.recovery!.status(), 'continue'); lease.release();
  const before = files(f.local.localDir);
  await assert.rejects(f.manager.resolveHistory({...input, expected: {...input.expected, contentToken: 'a'.repeat(32)}}), {code: 'PROJECT_HISTORY_BASELINE_CHANGED'});
  assert.deepEqual(files(f.local.localDir), before);
  const reopened = openProjectStore({projectFile: f.registration.projectFile, locate: () => f.local});
  try {assert.equal(canonicalJson(readProjectContentStamp(reopened.db)), canonicalJson(input.expected));} finally {reopened.close();}
});

for (const action of ['continue', 'restore-version'] as const) test(`${action} clears only local-process revisions in the commit that records the final pair`, async t => {
  const f = await fixture(t, true), lease = await f.manager.acquire(f.projectId, 'window'), session = lease.host.recovery!;
  const status = session.status(), preview = session.previewVersion({projectId: f.projectId, versionId: f.saved.id});
  const contentTargets = lease.host.store.db.prepare("SELECT * FROM project.agent_task_target_revisions_v2 WHERE kind NOT IN ('job','export','image_task','frame_task')").all();
  const input = confirmation(status, action, f.saved.id, preview.previewDigest); lease.release();
  const result = await f.manager.resolveHistory(input), current = await f.manager.acquire(f.projectId, 'window'), store = current.host.store;
  assert.ok(result.content.contentSequence > status.file.contentSequence); assert.notEqual(result.content.contentToken, status.file.contentToken);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM project.agent_task_target_revisions_v2 WHERE kind IN ('job','export','image_task','frame_task')").get()!.n, 0);
  assert.deepEqual(readProjectContentStamp(store.db), result.content);
  if (action === 'continue') assert.deepEqual(store.db.prepare("SELECT * FROM project.agent_task_target_revisions_v2 WHERE kind NOT IN ('job','export','image_task','frame_task')").all(), contentTargets);
  else {
    const receipt = JSON.parse(String(store.db.prepare('SELECT response FROM project_version_requests WHERE requestId=?').get(input.requestId)!.response)) as {contentSequence: number; contentToken: string};
    assert.equal(receipt.contentSequence, result.content.contentSequence); assert.equal(receipt.contentToken, result.content.contentToken);
  }
  const evidence = JSON.parse(String(store.db.prepare('SELECT result FROM project_history_resolution').get()!.result));
  assert.deepEqual(evidence, result); current.release();
});

for (const action of ['continue', 'restore-version'] as const) test(`whole-history ${action} recovers every SIGKILL boundary without replaying old tasks or restoring twice`, async t => {
  for (const boundary of ['prepared', 'copy-started', 'staged', 'before-commit', 'after-commit', 'committed', 'before-archive', 'archived', 'before-publish', 'published', 'completed']) {
    await t.test(boundary, async child => {
      const f = await fixture(child), lease = await f.manager.acquire(f.projectId, 'window'), session = lease.host.recovery!;
      const status = session.status(), preview = session.previewVersion({projectId: f.projectId, versionId: f.saved.id});
      const input = confirmation(status, action, f.saved.id, preview.previewDigest);
      lease.release(); await f.manager.close(f.projectId);
      const config = path.join(f.root, 'crash.json');
      writeFileSync(config, JSON.stringify({root: f.root, registration: f.registration, input, boundary}), {mode: 0o600});
      const killed = spawnSync(process.execPath, ['tests/fixtures/project-history-switch-worker.ts', config], {cwd: process.cwd(), encoding: 'utf8', timeout: 30_000});
      assert.equal(killed.signal, 'SIGKILL', killed.stderr);
      const opened = await f.manager.acquire(f.projectId, 'window');
      if (opened.host.recovery) assert.ok(['prepared', 'copy-started'].includes(boundary), 'an unpublished prepared stage remains explicitly recoverable');
      else assert.equal(opened.host.store.db.prepare('SELECT count(*) AS n FROM mio_runs').get()!.n, 0);
      opened.release(); await f.manager.close(f.projectId);
      const result = await f.manager.resolveHistory(input);
      assert.deepEqual(await f.manager.resolveHistory(input), result);
      assert.equal(readdirSync(f.local.localDir).filter(name => /^history-\d/u.test(name)).length, 1);
      const final = await f.manager.acquire(f.projectId, 'window'), store = final.host.store;
      assert.equal(final.host.recovery, undefined);
      assert.equal((store.get('projects', f.projectId) as {name: string}).name, action === 'continue' ? 'External' : 'Original');
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM project_versions WHERE trigger='restore'").get()!.n, action === 'continue' ? 0 : 1);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_version_requests').get()!.n, action === 'continue' ? 0 : 1);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM project_versions WHERE id=?').get(f.saved.id)!.n, 1);
      final.release();
    });
  }
});
