import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {isOpacityRestoredApplicationInspection} from '../packages/contracts/src/opacity-restored-application.ts';
import {publicValue} from '../packages/contracts/src/index.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import {hash} from './helpers/opacity-backup-fixture.ts';
import {restoredApplicationFixture, request, rpc, prepareTask, applyTask} from './helpers/opacity-restored-application-fixture.ts';

// Actual SQLite/cold archive/restore/launch/shared handler. Synthetic asset
// bytes never enter a decoder, worker, provider or listening socket.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener or subprocess is permitted in restored application HTTP tests.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
const mediaEvents = [], off = onMediaProcess(event => mediaEvents.push(event));
after(() => {off(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0); assert.deepEqual(mediaEvents, []);});

const originOf = f => ({expectedWorkspaceOrigin: f.restored.workspaceOrigin});
const updateInput = (f, expectedRevision = 3, patch = {name: 'Explicit restored action'}) => ({
  projectId: f.projectId, clipId: f.clipId, expectedRevision, requestId: randomUUID(), patch,
});
const readTask = (f, id = f.taskId) => request(f.app, `/api/tasks/${id}?projectId=${f.projectId}`);
const snapshot = f => f.readDb(db => Object.fromEntries(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests',
  'edit_tasks', 'workspace_restore_holds', 'workspace_restore_evidence', 'workspace_restoration', 'workspace_preferences',
  'workspace_restore_timeline_history', 'workspace_restore_timeline_cursors',
  'exports', 'workspace_restore_export_origins'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
const refused = (response, code) => {
  assert.equal(response.data?.ok, false, response.text);
  assert.equal(response.data.error.code, code, response.text);
};

test('actual restored43 shared handler discloses its fixed policy, captured history and excluded drafts', async t => {
  const f = await restoredApplicationFixture(t);
  assert.equal((await request(f.app, '/', {authenticate: false})).text, '<html>isolated restored opacity43 entry</html>');
  assert.equal((await request(f.app, `/editor/${f.projectId}`, {authenticate: false})).text, '<html>isolated restored opacity43 entry</html>');
  assert.equal((await request(f.app, '/health', {authenticate: false})).data.ok, true);
  assert.equal((await request(f.app, '/api/rpc', {method: 'POST', input: {operation: 'project.list'}, authenticate: false})).status, 401);
  assert.equal((await request(f.app, '/health', {headers: {host: 'foreign.invalid'}})).status, 403);
  assert.equal((await request(f.app, '/health', {headers: {origin: 'https://foreign.invalid'}})).status, 403);
  const before = snapshot(f), inspected = await rpc(f.app, 'workspace.restore.inspect', {includeVolumeEnvelopeCapability: true, includeAudioRoleCapability: true});
  assert.equal(inspected.data.ok, true, inspected.text);
  assert.equal(isOpacityRestoredApplicationInspection(inspected.data.data), true);
  const info = inspected.data.data;
  assert.equal(info.schemaVersion, 43); assert.equal(info.source.schemaVersion, 42); assert.equal(info.workspaceOrigin, f.restored.workspaceOrigin);
  assert.equal(info.draftPolicy, 'excluded'); assert.equal(info.backupCreate.available, false);
  assert.equal(info.operationPolicy.find(row => row.operation === 'project.create').available, false);
  const page = (await rpc(f.app, 'project.get', {projectId: f.projectId})).data.data;
  assert.deepEqual(page.timeline, f.timeline);
  assert.deepEqual(page.restore, {workspaceOrigin: f.restored.workspaceOrigin, heldExportIds: [f.captured.id]});
  assert.deepEqual(page.exports, [publicValue(f.captured)]);
  assert.deepEqual((await rpc(f.app, 'project.list')).data.data, [page.project]);
  assert.deepEqual((await rpc(f.app, 'export.list', {projectId: f.projectId})).data.data, [publicValue(f.captured)]);
  assert.deepEqual((await rpc(f.app, 'export.get', {exportId: f.captured.id})).data.data, publicValue(f.captured));
  assert.deepEqual((await rpc(f.app, 'provider.list')).data.data, []);
  assert.equal((await rpc(f.app, 'asset.list', {projectId: f.projectId})).data.data[0].relativePath, undefined);
  const source = (await rpc(f.app, 'asset.get', {assetId: f.assetId})).data.data;
  assert.equal(source.relativePath, undefined); assert.equal(source.sha256, hash(f.mediaBytes));
  assert.deepEqual((await request(f.app, `/media/${f.assetId}`)).bytes, f.mediaBytes);
  assert.deepEqual((await rpc(f.app, 'timeline.get', {projectId: f.projectId})).data.data, f.timeline);
  assert.equal((await rpc(f.app, 'timeline.history.get', {projectId: f.projectId})).data.ok, true);
  assert.equal(info.operationPolicy.find(row => row.operation === 'timeline.format.get').available, false);
  refused(await rpc(f.app, 'timeline.format.get', {projectId: f.projectId}), 'RESTORE_OPERATION_UNAVAILABLE');
  assert.deepEqual(snapshot(f), before, 'all application reads leave captured evidence and rows unchanged');
  assert.equal(fs.existsSync(path.join(f.destination, 'local-drafts-v3.json')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
});

test('HTTP origin gates and fixed operation catalogue reject writes without changing rows', async t => {
  const f = await restoredApplicationFixture(t), before = snapshot(f), input = updateInput(f);
  refused(await rpc(f.app, 'timeline.clip.update', input), 'RESTORE_WORKSPACE_ORIGIN_REQUIRED');
  refused(await rpc(f.app, 'timeline.clip.update', input, {expectedWorkspaceOrigin: randomUUID()}), 'RESTORE_WORKSPACE_ORIGIN_MISMATCH');
  const envelope = {projectId: f.projectId, operation: 'timeline.clip.update', input, origin: 'new'};
  refused(await request(f.app, '/api/tasks/prepare', {method: 'POST', input: envelope}), 'RESTORE_WORKSPACE_ORIGIN_REQUIRED');
  refused(await request(f.app, '/api/tasks/prepare', {method: 'POST', input: {...envelope, expectedWorkspaceOrigin: randomUUID()}}), 'RESTORE_WORKSPACE_ORIGIN_MISMATCH');
  const denied = {
    'project.create': {name: 'Forbidden project'},
    'asset.import': {projectId: f.projectId, path: path.join(f.source, f.relativePath)},
    'timeline.track.add': {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, kind: 'video'},
    'timeline.track.update': {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, trackId: f.trackId, patch: {name: 'Forbidden track'}},
    'timeline.clip.add': {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, assetId: f.assetId, trackId: f.trackId, startFrame: 30, durationFrames: 30},
    'timeline.clip.remove': {projectId: f.projectId, requestId: randomUUID(), expectedRevision: 3, clipId: f.clipId},
    'generation.submit': {}, 'workspace.backup.inspect': {},
  };
  for (const [operation, payload] of Object.entries(denied)) refused(await rpc(f.app, operation, payload, originOf(f)), 'RESTORE_OPERATION_UNAVAILABLE');
  for (const route of ['/api/agent/settings', '/api/images/settings', '/api/comfy/settings', '/api/timeline-audio-preview/pcm'])
    refused(await request(f.app, route), 'RESTORE_OPERATION_UNAVAILABLE');
  assert.deepEqual(snapshot(f), before);
  for (const directory of ['agent-settings', 'image-settings', 'comfy-settings']) assert.equal(fs.existsSync(path.join(f.destination, directory)), false);
});

test('captured pending HTTP tasks stay held through execute, reconcile and acknowledge', async t => {
  const f = await restoredApplicationFixture(t), before = snapshot(f), held = (await readTask(f)).data.data;
  assert.deepEqual(held.restore, {workspaceOrigin: f.restored.workspaceOrigin, executionEpoch: 'captured', held: true});
  assert.equal(held.task.status, 'prepared'); assert.equal(held.task.acknowledged, false);
  const authority = {projectId: f.projectId, digest: held.task.digest, ...originOf(f)};
  for (const [action, fields] of [['execute', {instanceId: held.instanceId}], ['reconcile', {}], ['acknowledge', {expectedRevision: 1, status: 'applied'}]])
    refused(await request(f.app, `/api/tasks/${f.taskId}/${action}`, {method: 'POST', input: {...authority, ...fields}}), 'RESTORED_RECORD_HELD');
  const listed = (await request(f.app, `/api/tasks?projectId=${f.projectId}&pendingOnly=true`)).data.data;
  assert.deepEqual(listed.items, [], 'captured pending tasks are not resumed as current work');
  const all = (await request(f.app, `/api/tasks?projectId=${f.projectId}&pendingOnly=false`)).data.data;
  assert.equal(all.items[0].id, f.taskId); assert.equal(all.restore.tasks[0].executionEpoch, 'captured');
  assert.deepEqual(snapshot(f), before);
});

test('new-origin HTTP prepare execute ACK saves opacity and supports actual Undo and Redo', async t => {
  const f = await restoredApplicationFixture(t), before = snapshot(f);
  const curve = {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: 0, opacity: .6}, {frame: 30, opacity: .9}]};
  const saved = await applyTask(f, 'timeline.clip.update', updateInput(f, 3, {opacityEnvelope: curve}));
  assert.deepEqual(saved.result.clips[0].opacityEnvelope, curve);
  assert.equal(saved.prepared.restore.executionEpoch, f.restored.workspaceOrigin); assert.equal(saved.prepared.restore.held, false);
  assert.equal(saved.acknowledged.task.acknowledged, true);
  assert.equal(f.readDb(db => db.prepare('SELECT executionEpoch FROM edit_tasks WHERE id=?').get(saved.prepared.task.id).executionEpoch), f.restored.workspaceOrigin);
  const undone = await applyTask(f, 'timeline.undo', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: saved.result.revision});
  assert.deepEqual(undone.result.clips[0].opacityEnvelope, f.opacityEnvelope);
  const redone = await applyTask(f, 'timeline.redo', {projectId: f.projectId, requestId: randomUUID(), expectedRevision: undone.result.revision});
  assert.deepEqual(redone.result.clips[0].opacityEnvelope, curve);
  const after = snapshot(f);
  assert.deepEqual(after.workspace_restore_holds, before.workspace_restore_holds);
  assert.deepEqual(after.workspace_restore_evidence, before.workspace_restore_evidence);
  assert.deepEqual(after.workspace_restoration, before.workspace_restoration);
  assert.deepEqual(after.workspace_restore_timeline_history, before.workspace_restore_timeline_history);
  assert.deepEqual(after.workspace_restore_timeline_cursors, before.workspace_restore_timeline_cursors);
  assert.deepEqual(after.edit_tasks.find(row => row.id === f.taskId), before.edit_tasks.find(row => row.id === f.taskId));
  assert.equal(after.timeline_requests.length, before.timeline_requests.length + 3);
  const page = (await rpc(f.app, 'project.get', {projectId: f.projectId})).data.data;
  assert.deepEqual(page.restore.heldExportIds, [f.captured.id]);
  assert.deepEqual(page.timeline, redone.result);
  await f.close(); assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
  await f.reopen();
  assert.deepEqual((await rpc(f.app, 'project.get', {projectId: f.projectId})).data.data, page);
  assert.deepEqual(snapshot(f), after, 'normal reopen never resets epoch, receipts, history or captured evidence');
});

test('reopen leaves a fresh prepared task idle and requires a current instance plus explicit execute', async t => {
  const f = await restoredApplicationFixture(t), input = updateInput(f), before = snapshot(f);
  const prepared = await prepareTask(f, 'timeline.clip.update', input), preparedRows = snapshot(f);
  assert.deepEqual((await rpc(f.app, 'timeline.get', {projectId: f.projectId})).data.data, f.timeline);
  for (const [action, fields] of [['execute', {instanceId: prepared.instanceId}], ['reconcile', {}], ['acknowledge', {expectedRevision: 1, status: 'applied'}]]) {
    const actionInput = {projectId: f.projectId, digest: prepared.task.digest, ...fields};
    refused(await request(f.app, `/api/tasks/${prepared.task.id}/${action}`, {method: 'POST', input: actionInput}), 'RESTORE_WORKSPACE_ORIGIN_REQUIRED');
    refused(await request(f.app, `/api/tasks/${prepared.task.id}/${action}`, {method: 'POST', input: {...actionInput, expectedWorkspaceOrigin: randomUUID()}}), 'RESTORE_WORKSPACE_ORIGIN_MISMATCH');
  }
  assert.deepEqual(snapshot(f), preparedRows);
  await f.close(); await f.reopen();
  assert.deepEqual(snapshot(f), preparedRows, 'opening and startup reconciliation do not dispatch prepared tasks');
  refused(await request(f.app, `/api/tasks/${prepared.task.id}/execute`, {method: 'POST', input: {
    projectId: f.projectId, digest: prepared.task.digest, instanceId: prepared.instanceId, ...originOf(f),
  }}), 'EDIT_TASK_STALE_INSTANCE');
  assert.deepEqual(snapshot(f), preparedRows);
  const current = await prepareTask(f, 'timeline.clip.update', input);
  assert.equal(current.task.id, prepared.task.id); assert.notEqual(current.instanceId, prepared.instanceId);
  const applied = await applyTask(f, 'timeline.clip.update', input);
  assert.equal(applied.result.clips[0].name, input.patch.name);
  assert.equal(snapshot(f).timeline_requests.length, before.timeline_requests.length + 1);
  assert.equal((await readTask(f)).data.data.restore.held, true);
});

test('restored companion endpoints remain unsupported and never read or overwrite local draft files', async t => {
  const f = await restoredApplicationFixture(t), before = snapshot(f), files = ['local-drafts-v3.json', 'local-delivery-v1.json'];
  for (const filename of files) {assert.equal(fs.existsSync(path.join(f.destination, filename)), false); fs.writeFileSync(path.join(f.destination, filename), 'owned-invalid-companion-sentinel', {mode: 0o600, flag: 'wx'});}
  const original = files.map(filename => ({filename, info: fs.statSync(path.join(f.destination, filename)), bytes: fs.readFileSync(path.join(f.destination, filename))}));
  const unsupported = {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'};
  for (const pathname of [`/api/local-drafts?projectId=${f.projectId}`, `/api/local-drafts/clip?projectId=${f.projectId}&timelineId=${f.timelineId}&clipId=${f.clipId}`, `/api/local-delivery?projectId=${f.projectId}`])
    assert.deepEqual((await request(f.app, pathname)).data.data, unsupported);
  for (const [pathname, methods] of [['/api/local-drafts/clip', ['PUT', 'DELETE']], ['/api/local-delivery/draft', ['PUT', 'DELETE']], ['/api/local-delivery/prepare', ['POST']], ['/api/local-delivery/execute', ['POST']], ['/api/local-delivery/recover', ['POST']]])
    for (const method of methods) assert.deepEqual((await request(f.app, pathname, {method, input: {ignored: 'does not parse unsupported companions'}})).data.data,
      ['/api/local-delivery/execute', '/api/local-delivery/recover'].includes(pathname) ? {envelope: unsupported, response: null} : unsupported);
  for (const {filename, info, bytes} of original) {
    const file = path.join(f.destination, filename), after = fs.statSync(file);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(after.ino, info.ino); assert.equal(after.mtimeMs, info.mtimeMs);
  }
  assert.deepEqual(snapshot(f), before);
});

test('restored preferences read through HTTP while all writes refuse even with the correct origin', async t => {
  const f = await restoredApplicationFixture(t), before = snapshot(f), pathname = `/api/workspace-preferences/${f.projectId}`;
  assert.deepEqual((await request(f.app, pathname)).data.data, {projectId: f.projectId, revision: 0, state: null});
  const state = defaultWorkspaceState(); delete state.shared.assetSearch; state.activeMode = 'editing'; state.editing.selectedClipId = f.clipId;
  for (const authority of [{}, {expectedWorkspaceOrigin: randomUUID()}, originOf(f)])
    refused(await request(f.app, pathname, {method: 'PUT', input: {expectedRevision: 0, state, ...authority}}), 'RESTORE_OPERATION_UNAVAILABLE');
  assert.deepEqual(snapshot(f), before);
});

test('already disconnected HTTP advisory calls are cancelled before effects and a healthy read remains available', async t => {
  const f = await restoredApplicationFixture(t), before = snapshot(f);
  for (const operation of ['timeline.export.preflight', 'timeline.export.capabilities']) {
    const sent = await request(f.app, '/api/rpc', {method: 'POST', aborted: true, input: {operation,
      input: operation.endsWith('preflight') ? {projectId: f.projectId, expectedRevision: 3} : {}, ...originOf(f)}});
    refused(sent, 'OPERATION_CANCELLED');
    // The shared HTTP response lease owns its listeners through actual finish,
    // which can follow handleRequest's return for this test-owned Writable.
    if (!sent.res.writableFinished) await once(sent.res, 'finish');
    assert.equal(sent.req.listenerCount('aborted'), 0); assert.equal(sent.res.listenerCount('close'), 0);
  }
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual((await rpc(f.app, 'timeline.get', {projectId: f.projectId})).data.data, f.timeline);
  const first = f.app, closing = first.close(); assert.equal(first.close(), closing); await closing;
  assert.equal((await request(first, '/health')).status, 503);
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
});
