import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {opacityUpgradeFixture, upgradeFixtureStamp} from './helpers/opacity-upgrade-fixture.ts';
import {request, restoredApplicationToken as token} from './helpers/opacity-restored-application-fixture.ts';
import {tree} from './helpers/opacity-backup-fixture.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {upgradeOpacityWorkspace40To42 as upgrade} from '../packages/business/src/opacity-upgrade.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {createExistingOpacityCandidateLaunch} from '../apps/server/src/opacity-candidate-launch.ts';
import {createOpacityCandidateRequestApplication} from '../apps/server/src/index.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';

// Actual server composition and stream requests, without a listener, provider,
// media process, native child, real project or external fetch.
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener, child or external fetch is permitted.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) mock.method(cp, name, forbidden);
mock.method(globalThis, 'fetch', forbidden); syncBuiltinESMExports();
const media: unknown[] = [], stopMedia = onMediaProcess(event => media.push(event));
after(() => {stopMedia(); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0); assert.deepEqual(media, []);});

function remember(f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture, channel: 'web'|'production'|'development') {
  const value = {version: 1, workspaceScope: calculateWorkspaceScope((({channel, root: f.source,
    directory: fs.statSync(f.source), db: fs.statSync(f.database)}) as unknown as Parameters<typeof calculateWorkspaceScope>[0])), revision: 3, projectId: f.projectId, updatedAt: upgradeFixtureStamp};
  fs.writeFileSync(path.join(f.source, 'last-project-v1.json'), JSON.stringify(value) + '\n', {mode: 0o600});
  return value;
}
async function openApplication(f: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture) {
  const dist = path.join(f.base, 'candidate-dist'); fs.mkdirSync(dist, {mode: 0o700});
  fs.writeFileSync(path.join(dist, 'mioon-opacity-candidate-entry.json'), JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}));
  fs.writeFileSync(path.join(dist, 'opacity-candidate.html'), '<html>owned upgrade candidate</html>');
  // Match the only candidate CLI's trusted channel; the upgrade's --channel
  // identifies the source and cannot select a different target application.
  return createOpacityCandidateRequestApplication({opacityCandidateLaunch: createExistingOpacityCandidateLaunch(f.destination),
    port: 4319, distDir: dist, token, localDraftChannel: 'development'});
}

for (const sourceChannel of ['web', 'production', 'development'] as const) test(`upgraded ${sourceChannel} last-project opens and saves in the actual development candidate application`, async t => {
  const f = await (opacityUpgradeFixture(t) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture>), old = remember(f, sourceChannel);
  await (createWorkspaceBackup({source: f.source, destination: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  const sourceBefore = tree(f.source), backupBefore = tree(f.backup);
  await upgrade({source: f.source, backup: f.backup, destination: f.destination, channel: sourceChannel});
  const app = await openApplication(f);
  try {
    const read = await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(app, '/api/last-project');
    assert.equal(read.status, 200, read.text); assert.equal(read.data.ok, true, read.text);
    const value = read.data.data;
    assert.equal(value.supported, true); assert.equal(value.projectId, old.projectId);
    assert.equal(value.revision, old.revision); assert.equal(value.updatedAt, old.updatedAt); assert.equal(value.targetStatus, 'matching');
    assert.equal(value.workspaceScope, calculateWorkspaceScope({channel: 'development', root: f.destination,
      directory: fs.statSync(f.destination), db: fs.statSync(path.join(f.destination, 'workbench.sqlite'))}));
    const put = await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(app, '/api/last-project', {method: 'PUT', input: {
      workspaceScope: value.workspaceScope, instanceId: value.instanceId, expectedRevision: value.revision, projectId: value.projectId,
    }});
    assert.equal(put.status, 200, put.text); assert.equal(put.data.data.revision, old.revision + 1);
    const tasks = await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(app, `/api/tasks?projectId=${f.projectId}&pendingOnly=false`);
    assert.equal(tasks.status, 200, tasks.text); assert.equal(tasks.data.data.items.length, 1);
    const task = await (request as unknown as import('./helpers/strict-opacity-restored-types.ts').RestoredRequest)(app, `/api/tasks/${f.taskId}?projectId=${f.projectId}`);
    assert.equal(task.status, 200, task.text); assert.equal(task.data.data.task.operation, 'timeline.clip.update');
  } finally {await app.close();}
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false);
});

test('target development binding does not relax source companion channel validation', async t => {
  const f = await (opacityUpgradeFixture(t) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture>); remember(f, 'production');
  await (createWorkspaceBackup({source: f.source, destination: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  const sourceBefore = tree(f.source), backupBefore = tree(f.backup);
  await assert.rejects(upgrade({source: f.source, backup: f.backup, destination: f.destination, channel: 'web'}), {code: 'WORKSPACE_UPGRADE_SCOPE_MISMATCH'});
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
  assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite')), false);
});

for (const [operation, status] of [['timeline.clip.split', 'not_applied'], ['timeline.clip.split', 'applied'], ['timeline.clip.replaceSource', 'not_applied']] as const) test(`acknowledged ${status} ${operation} is explicitly unsupported before any42 publication`, async t => {
  // Seed the genuine terminal receipt before constructing exact40. Opening
  // source40 with today's runtime would legitimately migrate it to current.
  const f = await (opacityUpgradeFixture(t, {beforeFreeze: async ({tasks, projectId, timeline, clipId, assetId}: import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeContext) => {
    const input = {projectId, requestId: randomUUID(), expectedRevision: status === 'applied' ? timeline.revision : 999,
      ...(operation === 'timeline.clip.split' ? {clipId, atFrame: 15} : {clipId, assetId})};
    const prepared = tasks.prepare({projectId, operation, input, origin: 'new'});
    const result = await tasks.execute({projectId, taskId: prepared.task.id, digest: prepared.task.digest, instanceId: prepared.instanceId});
    assert.equal(result.task.status, status);
    const acknowledged = tasks.acknowledge({projectId, taskId: result.task.id, digest: result.task.digest,
      expectedRevision: result.task.revision, status});
    assert.equal(acknowledged.task.acknowledged, true);
  }} as unknown as Parameters<typeof opacityUpgradeFixture>[1]) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture>);
  await (createWorkspaceBackup({source: f.source, destination: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  const sourceBefore = tree(f.source), backupBefore = tree(f.backup);
  await assert.rejects(upgrade({source: f.source, backup: f.backup, destination: f.destination, channel: 'web'}), {code: 'WORKSPACE_UPGRADE_SOURCE_UNSUPPORTED'});
  assert.deepEqual(tree(f.source), sourceBefore); assert.deepEqual(tree(f.backup), backupBefore);
  assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite')), false);
});
