import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openOpacityCandidateStore, getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';

const stamp = '2026-10-16T00:00:00.000Z';
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, part) => part && typeof part === 'object' && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part)).digest('hex');
const code = expected => error => error?.code === expected;
const input = projectId => ({projectId, requestId: randomUUID(), expectedRevision: 1, clipId: randomUUID(), patch: {name: 'Synthetic opacity test'}});
function fixture(t) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-opacity-capability-'));
  const stores = [];
  t.after(() => {for (const store of stores) {try {store.close();} catch {}} rmSync(root, {recursive: true, force: true});});
  const open = () => {const store = openOpacityCandidateStore(root); stores.push(store); return store;};
  const store = open(), projectId = randomUUID();
  store.put('projects', {id: projectId, name: 'Synthetic opacity capability', revision: 1, createdAt: stamp, updatedAt: stamp});
  return {root, store, projectId, open};
}
function task(store, intent, {status = 'prepared', epoch, id = randomUUID()} = {}) {
  const claim = status === 'dispatching' ? randomUUID() : null;
  const values = {id, projectId: intent.projectId, operation: 'timeline.clip.update', input: JSON.stringify(intent), requestId: intent.requestId,
    digest: hash({operation: 'timeline.clip.update', input: intent}), lane: 'timeline:mutation', origin: 'new', status, revision: 1,
    acknowledged: 0, claim, claimInstance: claim ? randomUUID() : null, receiptDigest: null, errorCode: null, createdAt: stamp, updatedAt: stamp, bytes: 16384,
    ...(epoch ? {executionEpoch: epoch} : {})};
  const keys = Object.keys(values);
  store.db.prepare(`INSERT INTO edit_tasks(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => values[key]));
  return store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(id);
}
function restore(f) {
  f.store.close();
  const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: stamp};
  const db = new DatabaseSync(path.join(f.root, 'workbench.sqlite'));
  try {db.exec('PRAGMA foreign_keys=ON;'); installWorkspaceRestoreSchemaV43(db, metadata);} finally {db.close();}
  return {...f, store: f.open(), metadata};
}

test('candidate lease is exact-store bound, non-copyable, and permanently revoked after identity replacement', t => {
  const f = fixture(t), assembly = getOpacityCandidateAssembly(f.store), impostor = {...f.store};
  assert.ok(assembly); assert.equal(assembly.ownsLock(), true); assert.equal(assembly.getRestoreContext(), null);
  assert.equal(getOpacityCandidateAssembly(impostor), null);
  f.store.root = path.join(f.root, 'copied');
  assert.throws(() => getOpacityCandidateAssembly(f.store), code('RESTORE_STORE_UNVERIFIED'));
  f.store.root = f.root;
  assert.throws(assembly.checkpoint, code('RESTORE_STORE_UNVERIFIED'));
  assert.equal(assembly.ownsLock(), false);
});

test('closed and recreated stores never revive an earlier capability', t => {
  const f = fixture(t), first = getOpacityCandidateAssembly(f.store);
  f.store.close();
  assert.throws(() => getOpacityCandidateAssembly(f.store), code('RESTORE_STORE_UNVERIFIED'));
  const reopened = f.open(), second = getOpacityCandidateAssembly(reopened);
  assert.notEqual(first, second); assert.equal(second.ownsLock(), true);
  assert.throws(first.checkpoint, code('RESTORE_STORE_UNVERIFIED'));
  assert.equal(reopened.get('projects', f.projectId).id, f.projectId);
});

test('a removed or replaced lease and a modified fixed catalog revoke rather than repair capability', t => {
  const f = fixture(t), assembly = getOpacityCandidateAssembly(f.store);
  unlinkSync(path.join(f.root, 'server.lock'));
  writeFileSync(path.join(f.root, 'server.lock'), String(process.pid), {mode: 0o600});
  assert.equal(assembly.ownsLock(), false);
  assert.throws(assembly.checkpoint, code('RESTORE_STORE_UNVERIFIED'));
  const g = fixture(t), other = getOpacityCandidateAssembly(g.store);
  g.store.db.exec('CREATE TABLE candidate_unsupported(value TEXT)');
  assert.throws(other.checkpoint, code('RESTORE_STORE_UNVERIFIED'));
});

test('ordinary candidate whitelist and synchronous transactions preserve atomic rollback', t => {
  const f = fixture(t), assembly = getOpacityCandidateAssembly(f.store), before = f.store.get('projects', f.projectId);
  for (const operation of ['timeline.render', 'timeline.clip.add', 'generation.submit', 'project.create'])
    assert.throws(() => assembly.refuseOperation(operation, {}), code('RESTORE_OPERATION_UNAVAILABLE'));
  assert.doesNotThrow(() => assembly.refuseOperation('timeline.get', {projectId: f.projectId}));
  assert.throws(() => f.store.tx(() => {f.store.put('projects', {...before, name: 'Rolled back'}); throw new Error('synthetic rollback');}), /synthetic rollback/u);
  assert.deepEqual(f.store.get('projects', f.projectId), before); assert.equal(f.store.db.isTransaction, false);
  assert.throws(() => f.store.tx(async () => {}), /synchronous callback/u);
  assert.throws(() => f.store.tx(() => {f.store.put('projects', {...before, name: 'Thenable rollback'}); return Promise.resolve();}), /synchronous result/u);
  assert.deepEqual(f.store.get('projects', f.projectId), before); assert.equal(f.store.db.isTransaction, false);
  assert.throws(() => f.store.tx(() => f.store.tx(() => {})), /Nested transactions/u);
});

test('restored candidate retains held records and requires exact explicit origin for fresh execution', t => {
  const initial = fixture(t), captured = task(initial.store, input(initial.projectId)), f = restore(initial), assembly = getOpacityCandidateAssembly(f.store);
  assert.equal(assembly.getRestoreContext().schemaVersion, 43);
  assert.throws(() => assembly.assertOrigin({}), code('RESTORE_WORKSPACE_ORIGIN_REQUIRED'));
  assert.throws(() => assembly.assertOrigin({expectedWorkspaceOrigin: randomUUID()}), code('RESTORE_WORKSPACE_ORIGIN_MISMATCH'));
  assert.equal(assembly.assertOrigin({expectedWorkspaceOrigin: f.metadata.workspaceOrigin}).workspaceOrigin, f.metadata.workspaceOrigin);
  assert.throws(() => assembly.refuseTask(captured.id, f.projectId), code('RESTORED_RECORD_HELD'));
  assert.throws(() => assembly.assertRequestVacant('timeline.clip.update', JSON.parse(captured.input)), code('RESTORED_RECORD_HELD'));
  const fresh = input(f.projectId);
  assert.throws(() => assembly.refuseOperation('timeline.clip.update', fresh), code('RESTORE_OPERATION_UNAVAILABLE'));
  assembly.withInvocation('timeline.clip.update', fresh, {}, frozen => {
    assert.equal(Object.isFrozen(frozen.patch), true);
    assembly.refuseOperation('timeline.clip.update', frozen); assembly.effectFence()();
  });
});

test('restored invocations cannot cross stores, change digest, survive completion, or survive abort', async t => {
  const f = restore(fixture(t)), g = restore(fixture(t));
  const a = getOpacityCandidateAssembly(f.store), b = getOpacityCandidateAssembly(g.store), fresh = input(f.projectId);
  let fence;
  await a.withInvocation('timeline.clip.update', fresh, {}, async frozen => {
    fence = a.effectFence(); fence();
    assert.throws(() => b.withInvocation('timeline.clip.update', {...frozen, projectId: g.projectId}, {}, () => {}), code('RESTORE_OPERATION_UNAVAILABLE'));
    assert.throws(() => a.refuseOperation('timeline.clip.update', {...frozen, patch: {name: 'changed'}}), code('RESTORE_OPERATION_UNAVAILABLE'));
  });
  assert.throws(fence, code('RESTORE_OPERATION_UNAVAILABLE'));
  const controller = new AbortController();
  a.withInvocation('timeline.clip.update', fresh, {signal: controller.signal}, () => {
    const check = a.effectFence(); controller.abort(); assert.throws(check, code('RESTORE_OPERATION_UNAVAILABLE'));
  });
  assert.throws(() => a.withInvocation('timeline.render', fresh, {}, () => {}), code('RESTORE_OPERATION_UNAVAILABLE'));
});

test('restored task invocation pins live SQL claim and execution epoch, refusing captured and changed rows', t => {
  const initial = fixture(t), captured = task(initial.store, input(initial.projectId)), f = restore(initial), assembly = getOpacityCandidateAssembly(f.store);
  assert.throws(() => assembly.withTaskInvocation(captured, {}, () => {}), code('RESTORE_OPERATION_UNAVAILABLE'));
  const fresh = task(f.store, input(f.projectId), {status: 'dispatching', epoch: f.metadata.workspaceOrigin});
  assert.throws(() => assembly.withTaskInvocation({...fresh, executionEpoch: randomUUID()}, {}, () => {}), code('RESTORE_OPERATION_UNAVAILABLE'));
  assert.throws(() => assembly.withTaskInvocation({...fresh, claim: randomUUID()}, {}, () => {}), code('RESTORE_OPERATION_UNAVAILABLE'));
  let fence;
  assembly.withTaskInvocation(fresh, {}, () => {
    fence = assembly.effectFence(); fence();
    assembly.refuseOperation(fresh.operation, JSON.parse(fresh.input));
    f.store.db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1,updatedAt=? WHERE id=?").run(stamp, fresh.id);
    assert.throws(fence, code('RESTORE_OPERATION_UNAVAILABLE'));
  });
  assert.throws(fence, code('RESTORE_OPERATION_UNAVAILABLE'));
  assert.throws(() => f.store.db.prepare('UPDATE edit_tasks SET executionEpoch=? WHERE id=?').run('captured', fresh.id), /RESTORE_EPOCH_IMMUTABLE/u);
});

test('a restored43 invocation cannot write or prepare an ordinary42 store through its actual services', async t => {
  const a = fixture(t), b = fixture(t);
  const projectId = a.projectId, timelineId = randomUUID(), trackId = randomUUID(), clipId = randomUUID(), assetId = randomUUID();
  const seed = store => {
    store.put('projects', {id: projectId, name: 'Same synthetic project identity', revision: 1, createdAt: stamp, updatedAt: stamp});
    store.put('assets', {id: assetId, projectId, name: 'No media file exists', mimeType: 'video/mp4', duration: 1, width: 720, height: 1280,
      hasVideo: true, hasAudio: false, sha256: 'a'.repeat(64), relativePath: 'media/never-opened.mp4', createdAt: stamp});
    store.put('timelines', {id: timelineId, projectId, revision: 1, fps: 30, width: 720, height: 1280,
      tracks: [{id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
      clips: [{id: clipId, assetId, trackId, name: 'Synthetic', startFrame: 0, durationFrames: 30, sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1}],
      durationFrames: 30, createdAt: stamp, updatedAt: stamp});
  };
  seed(a.store); seed(b.store);
  const restored = restore(a), authority = getOpacityCandidateAssembly(restored.store), ordinary = getOpacityCandidateAssembly(b.store);
  const services = createServices(b.store, new Map()), tasks = createEditTasks({store: b.store, services});
  const mutation = {projectId, requestId: randomUUID(), expectedRevision: 1, clipId, patch: {name: 'Cross store must refuse'}};
  const snapshot = () => JSON.stringify(['timelines', 'timeline_requests', 'timeline_history', 'timeline_history_cursors', 'edit_tasks']
    .map(table => b.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot(), changes = b.store.db.prepare('SELECT total_changes() AS n').get().n;
  try {
    await authority.withInvocation('timeline.clip.update', mutation, {}, async () => {
      assert.throws(() => ordinary.refuseOperation('timeline.clip.update', mutation), code('RESTORE_OPERATION_UNAVAILABLE'));
      assert.throws(() => b.store.get('projects', projectId), code('RESTORE_OPERATION_UNAVAILABLE'));
      assert.throws(() => b.store.tx(() => {}), code('RESTORE_OPERATION_UNAVAILABLE'));
      await assert.rejects(services.call('timeline.clip.update', mutation), code('RESTORE_OPERATION_UNAVAILABLE'));
      assert.throws(() => tasks.prepare({projectId, operation: 'timeline.clip.update', input: mutation, origin: 'new'}),
        error => ['RESTORE_OPERATION_UNAVAILABLE', 'EDIT_TASK_OWNER_REQUIRED'].includes(error?.code));
    });
    assert.equal(snapshot(), before); assert.equal(b.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.doesNotThrow(ordinary.checkpoint, 'a foreign invocation refuses contextually without revoking the other store');
    const saved = await services.call('timeline.clip.update', mutation);
    assert.equal(saved.revision, 2); assert.equal(saved.clips[0].name, mutation.patch.name);
    const prepared = tasks.prepare({projectId, operation: 'timeline.clip.update', input: {...mutation, requestId: randomUUID(), expectedRevision: 2}, origin: 'new'});
    assert.equal(prepared.task.status, 'prepared');
  } finally {await tasks.drain(); await services.drain();}
});
