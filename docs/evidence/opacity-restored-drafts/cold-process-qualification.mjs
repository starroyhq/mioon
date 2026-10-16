// Retained qualification. Run each phase in a different Node process:
// node <this-file> create <record.json>, then restore, discard, verify.
// All workspace paths are newly allocated below /private/tmp. No listener,
// native process, real media, provider, browser or user project participates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {mock} from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as legacy from '../../../packages/contracts/src/index.mjs';
import {seedOpacityBackupWorkspace, logicalTables} from '../../../tests/helpers/opacity-backup-fixture.mjs';
import {request, restoredApplicationToken} from '../../../tests/helpers/opacity-restored-application-fixture.mjs';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../../../packages/business/src/opacity-candidate-backup.ts';
import {onMediaProcess} from '../../../packages/business/src/media-processes.mjs';
import {createRestoredOpacityCandidateLaunch} from '../../../apps/server/src/opacity-candidate-launch.ts';
import {createOpacityCandidateRequestApplication} from '../../../apps/server/src/index.mjs';
import {createOpacityCandidateApplication, readOpacityCandidateApplication} from '../../../apps/web/src/opacity-candidate-application.ts';
import {readOpacityCandidateInspectorBinding} from '../../../apps/web/src/clip-opacity-candidate-assembly.ts';
import {createClipDraftController, clipDraftRaw, clipDraftSource} from '../../../apps/web/src/clip-draft-state.ts';
import {rawOpacityEnvelopeFields} from '../../../apps/web/src/clip-opacity-envelope-state.ts';
import {createEditTaskClient} from '../../../apps/web/src/edit-task-client.js';
import {rpc} from '../../../apps/web/src/api.js';

const [phase, recordFile] = process.argv.slice(2);
assert.ok(['create', 'restore', 'discard', 'verify'].includes(phase)); assert.ok(recordFile);
let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener, native process or external fetch is permitted.');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
mock.method(globalThis, 'fetch', forbidden); syncBuiltinESMExports();
const media = [], off = onMediaProcess(event => media.push(event));
const stringify = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const rowsHash = root => {
  const db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  try {return hash(stringify(logicalTables(db)));} finally {db.close();}
};
const result = response => {assert.equal(response.status, 200, response.text); assert.equal(response.data.ok, true, response.text); return response.data.data;};
let record, app, controller;
try {
  if (phase === 'create') {
    assert.equal(fs.existsSync(recordFile), false);
    const base = fs.mkdtempSync('/private/tmp/mioon-opacity-restored-drafts-qualification-');
    const source = path.join(base, 'source42'), backup = path.join(base, 'backup42'), target = path.join(base, 'restored43');
    const seeded = await seedOpacityBackupWorkspace(source);
    const sourceDbHash = fileHash(path.join(source, 'workbench.sqlite')), sourceDraftHash = fileHash(path.join(source, 'local-drafts-v3.json'));
    const archived = await createOpacityCandidateWorkspaceBackup({source, destination: backup});
    const restored = await restoreOpacityCandidateWorkspaceBackup({directory: backup, destination: target});
    assert.equal(archived.draftPolicy, 'excluded'); assert.equal(restored.draftPolicy, 'excluded');
    assert.equal(fs.existsSync(path.join(target, 'local-drafts-v3.json')), false);
    const dist = path.join(base, 'candidate-dist'); fs.mkdirSync(dist, {mode: 0o700});
    fs.writeFileSync(path.join(dist, 'mioon-opacity-candidate-entry.json'), JSON.stringify({schemaVersion: 1, profileId: 'mioon-workspace-v42', entry: 'opacity-candidate.html'}));
    fs.writeFileSync(path.join(dist, 'opacity-candidate.html'), '<html>Owned cold-process qualification</html>');
    record = {base, source, backup, target, dist, projectId: seeded.projectId, timelineId: seeded.timelineId, clipId: seeded.clipId,
      sourceDbHash, sourceDraftHash, restored, initialLogicalHash: rowsHash(target), phases: []};
  } else record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(record.phases.some(entry => entry.pid === process.pid), false, 'every phase uses a new process');
  assert.equal(fs.existsSync(path.join(record.target, 'server.lock')), false, 'previous process released its owned lock');
  app = await createOpacityCandidateRequestApplication({opacityCandidateLaunch: createRestoredOpacityCandidateLaunch(record.target),
    port: 4319, distDir: record.dist, token: restoredApplicationToken});
  const fetcher = async (url, options = {}) => {
    const address = new URL(url, 'http://127.0.0.1:4319');
    const response = await request(app, address.pathname + address.search, {method: options.method ?? 'GET',
      input: options.body ? JSON.parse(options.body) : undefined});
    return new Response(response.bytes, {status: response.status, headers: response.headers});
  };
  const application = readOpacityCandidateApplication(createOpacityCandidateApplication({...legacy, rpc, createEditTaskClient}, fetcher));
  const inspection = await application.rpc('workspace.restore.inspect');
  assert.equal(inspection.workspaceOrigin, record.restored.workspaceOrigin); assert.equal(inspection.localClipDrafts.policy, 'new-origin-only');
  const page = await application.rpc('project.get', {projectId: record.projectId}), clip = page.timeline.clips.find(value => value.id === record.clipId);
  const binding = readOpacityCandidateInspectorBinding(application.inspectorBinding); assert.ok(binding);
  const context = {scope: `${inspection.workspaceOrigin}:${record.projectId}:cold-process`, workspaceOrigin: inspection.workspaceOrigin,
    projectId: record.projectId, timelineId: record.timelineId, clipId: record.clipId, restored: true, connected: true,
    visible: true, busy: false, opacityEnvelopeEditable: true, timelineRevision: page.timeline.revision,
    source: clipDraftSource(clip, page.assets.find(value => value.id === clip.assetId)), saved: {...clipDraftRaw(clip), ...rawOpacityEnvelopeFields(clip)}};
  controller = createClipDraftController({context, client: binding.client, delay: 60000,
    validateTimeline: (value, projectId) => application.isTimelineRecord(value, {projectId})});
  await controller.load(); assert.equal(controller.supportsRestoredPersistence(inspection.workspaceOrigin), true);
  const key = {projectId: record.projectId, timelineId: record.timelineId, clipId: record.clipId};
  const initial = await binding.client.get(key), sidecar = path.join(record.target, 'local-drafts-restored43-v1.json');
  if (phase === 'create') {
    assert.equal(initial.draft, null);
    controller.edit('name', 'Cold reopen 草稿 日本語');
    assert.equal(controller.editOpacityEnvelope({profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: '0', opacity: '.'},
      {frame: String(clip.durationFrames), opacity: '1'}]}, controller.capture()), true);
    record.raw = structuredClone(controller.getState().raw);
    assert.equal(await controller.flushForClose(), true); assert.equal(controller.hasUnpersisted(), false);
    const saved = await binding.client.get(key); assert.deepEqual(saved.draft.raw, record.raw);
    record.saved = saved; record.sidecarHash = fileHash(sidecar);
  } else {
    assert.equal(initial.workspaceScope, record.saved.workspaceScope); assert.notEqual(initial.instanceId, record.saved.instanceId);
    if (phase === 'restore') {
      assert.deepEqual(initial.draft.raw, record.raw); assert.equal(fileHash(sidecar), record.sidecarHash);
      assert.equal(controller.hasUnsaved(), false); assert.notDeepEqual(controller.getState().raw, record.raw);
      assert.equal(controller.restore(), true); assert.deepEqual(controller.getState().raw, record.raw);
      assert.equal(await controller.flushForClose(), true); assert.equal(fileHash(sidecar), record.sidecarHash);
      const stale = await request(app, '/api/local-drafts/restored43/clip', {method: 'PUT', input: {...key, schemaVersion: 1,
        expectedWorkspaceOrigin: inspection.workspaceOrigin, workspaceScope: record.saved.workspaceScope, instanceId: record.saved.instanceId,
        expectedRevision: record.saved.revision, baseRevision: page.timeline.revision, source: context.source, raw: record.raw}});
      assert.equal(stale.data.ok, false); assert.equal(stale.data.error.code, 'LOCAL_DRAFT_STALE_INSTANCE');
      assert.equal(fileHash(sidecar), record.sidecarHash);
    } else if (phase === 'discard') {
      assert.deepEqual(controller.getState().candidate.raw, record.raw);
      assert.equal(await controller.discard(controller.capture()), true);
      const discarded = await binding.client.get(key); assert.equal(discarded.draft, null); assert.equal(discarded.revision, record.saved.revision + 1);
      record.discardRevision = discarded.revision; record.tombstoneHash = fileHash(sidecar);
    } else {
      assert.equal(initial.draft, null); assert.equal(initial.revision, record.discardRevision);
      assert.equal(controller.getState().candidate, null); assert.equal(fileHash(sidecar), record.tombstoneHash);
      const listing = result(await request(app, `/api/local-drafts/restored43?${new URLSearchParams({projectId: record.projectId,
        schemaVersion: '1', expectedWorkspaceOrigin: inspection.workspaceOrigin})}`));
      assert.deepEqual(listing.items, []);
    }
  }
  controller.dispose(); controller = null; await app.close(); app = null;
  assert.equal(fs.existsSync(path.join(record.target, 'server.lock')), false);
  assert.equal(rowsHash(record.target), record.initialLogicalHash, 'draft operations preserve all logical business/held/history rows');
  assert.equal(fileHash(path.join(record.source, 'workbench.sqlite')), record.sourceDbHash);
  assert.equal(fileHash(path.join(record.source, 'local-drafts-v3.json')), record.sourceDraftHash);
  assert.equal(fs.existsSync(path.join(record.target, 'local-drafts-v3.json')), false);
  assert.equal(forbiddenAttempts, 0); assert.deepEqual(media, []);
  record.phases.push({phase, pid: process.pid, passed: true, normalClose: true, lockReleased: true, instanceId: initial.instanceId,
    logicalHash: record.initialLogicalHash, noListenNativeExternalAttempts: forbiddenAttempts, mediaProcesses: media.length});
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(record.phases.at(-1)));
} finally {
  controller?.dispose(); await app?.close(); off(); mock.restoreAll(); syncBuiltinESMExports();
}
