import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {randomUUID} from 'node:crypto';
import {opacityBackupFixture} from './helpers/opacity-backup-fixture.ts';
import {createOpacityCandidateWorkspaceBackup, restoreOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-candidate-backup.ts';
import {openOpacityCandidateStore, reopenRestoredOpacityCandidateApplicationStore, reopenOpacityCandidateApplicationStore,
  getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateLocalDrafts, createRestoredOpacityCandidateLocalDrafts,
  OPACITY_RESTORED_LOCAL_DRAFT_FILENAME, captureOpacityRestoredDraftRequest, captureOpacityCandidateDraftRequest} from '../packages/business/src/opacity-candidate-local-drafts.ts';
import {clipDraftOpacityRestoredEnvelopeSchema, clipDraftOpacityRestoredListSchema, clipDraftOpacityRestoredWriteSchema,
  captureClipDraftOpacityRestoredDisk, OPACITY_RESTORED_DRAFT_PROFILE} from '../packages/contracts/src/local-drafts-opacity-restored.ts';
import {clipDraftOpacityCandidateEnvelopeSchema, captureClipDraftOpacityCandidateDiskV3} from '../packages/contracts/src/local-drafts-opacity-candidate.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {createHash} from 'node:crypto';
import {createOpacityRestoredApplicationInspection, isOpacityRestoredApplicationInspection} from '../packages/contracts/src/opacity-restored-application.ts';

let forbiddenAttempts = 0;
const forbidden = () => {forbiddenAttempts++; throw Error('No listener, media process or provider in restored draft qualification');};
mock.method(http.Server.prototype, 'listen', forbidden);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) mock.method(cp, name, forbidden);
syncBuiltinESMExports();
after(() => {mock.restoreAll(); syncBuiltinESMExports(); assert.equal(forbiddenAttempts, 0);});
const snapshot = store => JSON.stringify(['projects', 'assets', 'timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests', 'edit_tasks',
  'workspace_restoration', 'workspace_restore_holds', 'workspace_restore_evidence'].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
async function fixture(t) {
  const f = await opacityBackupFixture(t);
  await createOpacityCandidateWorkspaceBackup({source: f.source, destination: f.backup});
  const restored = await restoreOpacityCandidateWorkspaceBackup({directory: f.backup, destination: f.destination});
  let store, drafts;
  const open = () => {store = reopenRestoredOpacityCandidateApplicationStore(f.destination); drafts = createRestoredOpacityCandidateLocalDrafts(store);}; open();
  f.manage(() => store.close());
  const key = {projectId: f.projectId, timelineId: f.timelineId, clipId: f.clipId};
  const identity = {schemaVersion: 1, expectedWorkspaceOrigin: restored.workspaceOrigin};
  return {...f, restored, key, identity, file: path.join(f.destination, OPACITY_RESTORED_LOCAL_DRAFT_FILENAME),
    get store() {return store;}, get drafts() {return drafts;},
    get() {return drafts.get({...key, ...identity});},
    input(value, raw = f.draft.draft.raw) {return {...key, ...identity, workspaceScope: value.workspaceScope, instanceId: value.instanceId,
      expectedRevision: value.revision, baseRevision: 3, source: {assetId: f.assetId, assetSha256: f.draft.draft.source.assetSha256}, raw};},
    deletion(value) {return {...key, ...identity, workspaceScope: value.workspaceScope, instanceId: value.instanceId, expectedRevision: value.revision};},
    reopen() {store.close(); open();}, close() {store.close();},
  };
}

test('only independently admitted43 application stores acquire current-origin draft persistence', async t => {
  const f = await fixture(t), inspection = createOpacityRestoredApplicationInspection(getOpacityCandidateAssembly(f.store).getRestoreContext());
  assert.deepEqual(inspection.localClipDrafts, {schemaVersion: 1, profileId: OPACITY_RESTORED_DRAFT_PROFILE, policy: 'new-origin-only'});
  const old = {...inspection}; delete old.localClipDrafts;
  assert.equal(isOpacityRestoredApplicationInspection(old), true, 'an old43 inspection remains readable without minting persistence');
  for (const invalid of [null, {...inspection.localClipDrafts, schemaVersion: 3}, {...inspection.localClipDrafts, policy: 'all-origins'}, {...inspection.localClipDrafts, extra: true}])
    assert.equal(isOpacityRestoredApplicationInspection({...inspection, localClipDrafts: invalid}), false);
  const ordinary = reopenOpacityCandidateApplicationStore(f.source);
  try {assert.throws(() => createRestoredOpacityCandidateLocalDrafts(ordinary), {code: 'LOCAL_DRAFT_OWNER_REQUIRED'});}
  finally {ordinary.close();}
  assert.throws(() => createRestoredOpacityCandidateLocalDrafts({...f.store}), {code: 'LOCAL_DRAFT_OWNER_REQUIRED'});
  const oldService = createOpacityCandidateLocalDrafts(f.store);
  assert.deepEqual(oldService.get(f.key), {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'});
  f.close(); const generic = openOpacityCandidateStore(f.destination);
  try {assert.throws(() => createRestoredOpacityCandidateLocalDrafts(generic), {code: 'LOCAL_DRAFT_OWNER_REQUIRED'});}
  finally {generic.close();}
});

test('current-origin incomplete input persists independently, reopens with a new instance and never mutates business evidence', async t => {
  const f = await fixture(t), before = snapshot(f.store), changes = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const initial = f.get(), input = f.input(initial);
  assert.equal(initial.draft, null); assert.equal(fs.existsSync(f.file), false);
  const saved = f.drafts.put(input);
  assert.equal(clipDraftOpacityRestoredEnvelopeSchema.safeParse(saved).success, true);
  assert.equal(clipDraftOpacityCandidateEnvelopeSchema.safeParse(saved).success, false);
  assert.equal(saved.workspaceOrigin, f.restored.workspaceOrigin); assert.deepEqual(saved.draft.raw, f.draft.draft.raw);
  const disk = JSON.parse(fs.readFileSync(f.file)); assert.equal(disk.version, 1); assert.equal(disk.profileId, OPACITY_RESTORED_DRAFT_PROFILE);
  assert.equal(disk.workspaceOrigin, f.restored.workspaceOrigin); assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(captureClipDraftOpacityRestoredDisk(disk).disk.entries[0].draft.raw.opacityEnvelope.points[0].opacity, '.');
  assert.throws(() => captureClipDraftOpacityCandidateDiskV3(disk));
  const base = calculateWorkspaceScope({channel: 'web', root: f.destination, directory: fs.lstatSync(f.destination), db: fs.lstatSync(path.join(f.destination, 'workbench.sqlite'))});
  assert.equal(saved.workspaceScope, createHash('sha256').update(JSON.stringify([OPACITY_RESTORED_DRAFT_PROFILE, f.restored.workspaceOrigin, base])).digest('hex'));
  assert.deepEqual(f.drafts.put(input), saved); assert.equal(snapshot(f.store), before); assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  const listed = f.drafts.list({projectId: f.projectId, ...f.identity});
  assert.equal(clipDraftOpacityRestoredListSchema.safeParse(listed).success, true); assert.equal(listed.items.length, 1);
  f.reopen(); const reopened = f.get();
  assert.notEqual(reopened.instanceId, saved.instanceId); assert.equal(reopened.workspaceScope, saved.workspaceScope); assert.deepEqual(reopened.draft, saved.draft);
  assert.throws(() => f.drafts.put(input), {code: 'LOCAL_DRAFT_STALE_INSTANCE'}); assert.equal(snapshot(f.store), before);
});

test('new43 draft never reads or imports source42 v3 or a legacy target companion', async t => {
  const f = await fixture(t), legacy = path.join(f.destination, 'local-drafts-v3.json'), bytes = Buffer.from('{not even valid v3 JSON\n');
  fs.writeFileSync(legacy, bytes, {mode: 0o600});
  assert.equal(f.get().draft, null); assert.equal(fs.existsSync(f.file), false);
  const saved = f.drafts.put(f.input(f.get())); assert.equal(saved.revision, 1);
  assert.deepEqual(fs.readFileSync(legacy), bytes); assert.deepEqual(fs.readFileSync(path.join(f.source, 'local-drafts-v3.json')), f.draftBytes);
  const before = fs.readFileSync(f.file);
  const v3 = {version: 3, workspaceScope: saved.workspaceScope, entries: JSON.parse(before).entries};
  fs.writeFileSync(f.file, JSON.stringify(v3), {mode: 0o600});
  const invalid = fs.readFileSync(f.file);
  assert.throws(() => f.get(), {code: 'LOCAL_DRAFT_STORAGE_UNAVAILABLE'});
  assert.throws(() => f.drafts.put(f.input(saved)), {code: 'LOCAL_DRAFT_STORAGE_UNAVAILABLE'});
  assert.deepEqual(fs.readFileSync(f.file), invalid); assert.deepEqual(fs.readFileSync(legacy), bytes);
});

test('wire version, origin, scope, instance and CAS cannot cross branches or revive deleted revisions', async t => {
  const f = await fixture(t), initial = f.get(), input = f.input(initial);
  for (const key of ['schemaVersion', 'expectedWorkspaceOrigin']) {const invalid = {...input}; delete invalid[key]; assert.throws(() => f.drafts.put(invalid), {code: 'LOCAL_DRAFT_VALIDATION'});}
  assert.throws(() => f.drafts.get({...f.key, ...f.identity, expectedWorkspaceOrigin: randomUUID()}), {code: 'LOCAL_DRAFT_SCOPE_MISMATCH'});
  assert.throws(() => f.drafts.put({...input, schemaVersion: 3}), {code: 'LOCAL_DRAFT_VALIDATION'});
  assert.throws(() => f.drafts.put({...input, expectedWorkspaceOrigin: randomUUID()}), {code: 'LOCAL_DRAFT_SCOPE_MISMATCH'});
  assert.throws(() => f.drafts.put({...input, workspaceScope: 'f'.repeat(64)}), {code: 'LOCAL_DRAFT_SCOPE_MISMATCH'});
  assert.throws(() => f.drafts.put({...input, instanceId: randomUUID()}), {code: 'LOCAL_DRAFT_STALE_INSTANCE'});
  assert.equal(fs.existsSync(f.file), false);
  const saved = f.drafts.put(input), updated = f.drafts.put(f.input(saved, {...input.raw, name: 'New current-origin input'}));
  assert.throws(() => f.drafts.put(input), {code: 'LOCAL_DRAFT_CONFLICT'});
  assert.throws(() => f.drafts.discard(f.deletion(saved)), {code: 'LOCAL_DRAFT_CONFLICT'});
  const removed = f.drafts.discard(f.deletion(updated)); assert.equal(removed.revision, 3); assert.equal(removed.draft, null);
  assert.deepEqual(f.drafts.discard(f.deletion(updated)), removed);
  const recreated = f.drafts.put(f.input(removed)); assert.equal(recreated.revision, 4);
  assert.throws(() => f.drafts.discard(f.deletion(updated)), {code: 'LOCAL_DRAFT_CONFLICT'});
});

test('source ownership and base revision mismatches retain input without resetting stored raw text', async t => {
  const f = await fixture(t), initial = f.get(), input = f.input(initial);
  assert.throws(() => f.drafts.put({...input, baseRevision: 2}), {code: 'LOCAL_DRAFT_CONFLICT'});
  assert.throws(() => f.drafts.put({...input, source: {...input.source, assetSha256: 'f'.repeat(64)}}), {code: 'LOCAL_DRAFT_CONFLICT'});
  const saved = f.drafts.put(input), bytes = fs.readFileSync(f.file);
  assert.throws(() => f.drafts.put({...f.input(saved), baseRevision: 4}), {code: 'LOCAL_DRAFT_CONFLICT'});
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  const timeline = f.store.get('timelines', f.timelineId); f.store.put('timelines', {...timeline, revision: 4});
  const changed = f.get(); assert.equal(changed.targetStatus, 'changed'); assert.deepEqual(changed.draft, saved.draft);
});

test('restored request descriptor capture retains only the new two identity leaves and never invokes hostile input', async t => {
  const f = await fixture(t), input = f.input(f.get());
  assert.equal(clipDraftOpacityRestoredWriteSchema.safeParse(input).success, true);
  const captured = captureOpacityRestoredDraftRequest(input); assert.deepEqual(captured.value, input);
  const ordinary = {...input}; delete ordinary.schemaVersion; delete ordinary.expectedWorkspaceOrigin;
  assert.equal(captured.nodes, captureOpacityCandidateDraftRequest(ordinary).nodes + 2);
  let calls = 0; const trap = () => {calls++; throw Error('Untrusted input executed');};
  const getter = {...input}; Object.defineProperty(getter, 'expectedWorkspaceOrigin', {enumerable: true, get: trap});
  for (const value of [getter, new Proxy(input, {get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap}), {...input, unknown: true}])
    assert.throws(() => f.drafts.put(value), {code: 'LOCAL_DRAFT_VALIDATION'});
  assert.equal(calls, 0); assert.equal(fs.existsSync(f.file), false);
});
