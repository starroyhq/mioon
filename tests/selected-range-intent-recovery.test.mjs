import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {isTimelineMutationResponse, publicValue} from '@mioon/contracts';
import {installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {hash} from '../packages/business/src/services.ts';
import {matchesRestoredExport, restoreExportIdentity} from '../packages/business/src/workspace-restore-exports.ts';
import {selectedRangeFixture, RANGE, SETTINGS, authority, action} from './fixtures/selected-range-http-fixture.mjs';

async function prepared(f, {settings = false} = {}) {
  const initial = await f.local();
  const draft = await f.local('/draft', {...authority(initial), expectedDraftRevision: initial.draftRevision, draftId: randomUUID(),
    timelineId: f.timeline.id, baseRevision: f.timeline.revision, raw: {deliveryName: '交付 · exact range 🎬'}});
  const input = f.prepare(draft, settings ? {exportSettings: structuredClone(SETTINGS)} : {});
  const value = await f.local('/prepare', input);
  assert.equal(value.intent.outcome.status, 'pending'); assert.deepEqual(value.intent.input, input.input);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  const disk = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(disk.version, 1); assert.deepEqual(disk.entries[0].intent.input, value.intent.input);
  assert.deepEqual(disk.entries[0].draft.raw, {deliveryName: '交付 · exact range 🎬'}, 'existing draft stays title-only');
  assert.equal(f.dispatches.length, 0); assert.equal(f.store.list('exports').length, 0); await f.assertNoWorker();
  return {value, input};
}
async function passiveGet(f) {
  const before = await f.checkpoint(), count = f.dispatches.length, media = f.media.length;
  const result = await f.local(); await f.unchanged(before);
  assert.equal(f.dispatches.length, count, 'GET cannot dispatch an export'); assert.equal(f.media.length, media, 'GET cannot probe or render');
  await f.assertNoWorker(); return result;
}
async function passiveRestart(f) {
  const before = await f.checkpoint(), count = f.dispatches.length, media = f.media.length;
  await f.restart(); await f.unchanged(before);
  assert.equal(f.dispatches.length, count, 'service/companion recreation cannot dispatch');
  assert.equal(f.media.length, media, 'startup cannot probe or render'); await f.assertNoWorker();
  return passiveGet(f);
}

test('prepared ranged companion survives close/recreate and GET without dispatch; explicit recovery dispatches only its original key and range', {timeout: 30_000}, async t => {
  const f = await selectedRangeFixture(t);
  await passiveGet(f); await assert.rejects(stat(f.file), {code: 'ENOENT'});
  const beforePrepare = f.rows(), {value, input} = await prepared(f, {settings: true}), frozen = JSON.stringify(value.intent.input), sidecar = await readFile(f.file);
  assert.deepEqual(f.rows(), beforePrepare, 'prepare writes only the existing private companion');
  assert.equal(f.receipt(input.input.requestId), undefined);
  const current = await passiveRestart(f);
  assert.notEqual(current.instanceId, value.instanceId); assert.equal(current.workspaceScope, value.workspaceScope);
  assert.equal(current.intent.intentId, value.intent.intentId); assert.equal(JSON.stringify(current.intent.input), frozen);
  assert.deepEqual(await readFile(f.file), sidecar); assert.equal(f.store.list('exports').length, 0);
  const stale = await f.request('/api/local-delivery/recover', {method: 'POST', input: action(value)});
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'LOCAL_DELIVERY_STALE_INSTANCE');
  const replacement = {...input, ...authority(current), intentId: randomUUID(), input: {...input.input, requestId: randomUUID(), exportRange: {startFrame: 0, endFrame: 1}}};
  const refused = await f.request('/api/local-delivery/prepare', {method: 'POST', input: replacement});
  assert.equal(refused.status, 409); assert.equal(refused.body.error.code, 'LOCAL_DELIVERY_CONFLICT');
  await passiveGet(f); assert.deepEqual(f.dispatches, []);
  const recovered = await f.local('/recover', action(current));
  assert.equal(recovered.envelope.intent.outcome.status, 'accepted'); assert.equal(recovered.envelope.draft, null);
  assert.equal(isTimelineMutationResponse('timeline.render', input.input, recovered.response), true);
  assert.deepEqual(recovered.response.snapshot.exportRange, RANGE); assert.deepEqual(f.dispatches, [input.input]);
  assert.equal(f.store.list('exports').length, 1);
  const receipt = f.receipt(input.input.requestId); assert.equal(receipt.requestHash, hash({operation: 'timeline.render', input: input.input}));
  assert.deepEqual(publicValue(JSON.parse(receipt.response)), recovered.response);
  assert.equal(recovered.envelope.intent.outcome.responseSha256, hash(recovered.response));
  const committed = await f.checkpoint();
  assert.deepEqual(await f.local('/recover', action(recovered.envelope)), recovered); await f.unchanged(committed);
  const restarted = await passiveRestart(f); assert.equal(JSON.stringify(restarted.intent.input), frozen);
  assert.deepEqual((await f.local('/recover', action(restarted))).response, recovered.response);
  assert.deepEqual(f.receipt(input.input.requestId), receipt); assert.deepEqual(f.dispatches, [input.input]); await f.assertNoWorker();
});

for (const loss of ['after-business-commit', 'accepted-http-ack']) test(`${loss}: real selected-range execution survives a lost HTTP ACK and close/recreate with one immutable export`, {timeout: 30_000}, async t => {
  const f = await selectedRangeFixture(t), {value, input} = await prepared(f), frozen = JSON.stringify(value.intent.input);
  const before = f.rows();
  if (loss === 'after-business-commit') f.fault(point => {if (point === 'afterDispatch') throw Error('Synthetic lost business acknowledgement');});
  f.lose('/api/local-delivery/execute');
  await assert.rejects(f.request('/api/local-delivery/execute', {method: 'POST', input: action(value)}));
  f.fault(() => {});
  const observed = f.observations.at(-1);
  assert.equal(observed.path, '/api/local-delivery/execute');
  if (loss === 'accepted-http-ack') {
    assert.equal(observed.status, 200); assert.equal(observed.body.data.envelope.intent.outcome.status, 'accepted');
    assert.equal(observed.body.data.envelope.intent.outcome.responseSha256, hash(observed.body.data.response));
  } else assert.equal(observed.status, 503);
  assert.deepEqual(f.dispatches, [input.input]); assert.equal(f.store.list('exports').length, 1);
  assert.equal(f.rows().timeline_requests.length, before.timeline_requests.length + 1);
  const receipt = f.receipt(input.input.requestId), original = publicValue(JSON.parse(receipt.response));
  assert.equal(receipt.requestHash, hash({operation: 'timeline.render', input: input.input}));
  assert.equal(isTimelineMutationResponse('timeline.render', input.input, original), true);
  assert.deepEqual(original.snapshot.exportRange, RANGE); assert.deepEqual(original.snapshot.timeline, f.timeline);
  const sidecar = await readFile(f.file), current = await passiveRestart(f);
  assert.equal(current.intent.outcome.status, loss === 'accepted-http-ack' ? 'accepted' : 'pending');
  assert.equal(current.intent.intentId, value.intent.intentId); assert.equal(JSON.stringify(current.intent.input), frozen);
  assert.deepEqual(await readFile(f.file), sidecar); assert.equal(f.store.list('exports').length, 1);
  // Current form/title and saved timeline change after restart. Recovery must
  // use the persisted composition/key/range, including when its old end is now
  // outside the shorter current composition.
  let shorter = await f.services.call('timeline.clip.remove', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), clipId: f.timeline.clips[1].id});
  shorter = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: shorter.revision, requestId: randomUUID(), clipId: shorter.clips[0].id, patch: {durationFrames: 6}});
  // An existing title draft retains its own original target until explicitly
  // discarded. Updating its text is allowed; silently rebasing it is not.
  const changed = await f.local('/draft', {...authority(current), expectedDraftRevision: current.draftRevision,
    draftId: current.draft?.draftId ?? randomUUID(), timelineId: current.draft?.timelineId ?? shorter.id,
    baseRevision: current.draft?.baseRevision ?? shorter.revision, raw: {deliveryName: 'Later form title'}});
  assert.equal((await passiveGet(f)).intentTargetStatus, 'changed');
  const rows = f.rows(), recovered = await f.local('/recover', action(changed));
  assert.deepEqual(recovered.response, original); assert.equal(JSON.stringify(recovered.envelope.intent.input), frozen);
  assert.deepEqual(recovered.envelope.draft.raw, {deliveryName: 'Later form title'});
  assert.deepEqual(f.rows(), rows); assert.deepEqual(f.receipt(input.input.requestId), receipt);
  assert.deepEqual(f.dispatches, [input.input], 'receipt recovery never calls render again');
  assert.equal(f.store.list('exports').length, 1);
  const settled = await f.checkpoint(); assert.deepEqual(await f.local('/recover', action(recovered.envelope)), recovered); await f.unchanged(settled);
  const again = await passiveRestart(f); assert.deepEqual((await f.local('/recover', action(again))).response, original);
  assert.deepEqual(f.dispatches, [input.input]); assert.deepEqual(f.receipt(input.input.requestId), receipt); await f.assertNoWorker();
});

test('restored profile allows an explicit new-origin range export while captured exports and inherited companion remain unavailable', {timeout: 30_000}, async t => {
  const f = await selectedRangeFixture(t), {value, input} = await prepared(f);
  const accepted = await f.local('/execute', action(value)), heldId = accepted.response.id, heldReceipt = f.receipt(input.input.requestId);
  const sidecar = await readFile(f.file), originalExport = f.store.get('exports', heldId);
  const metadata = {restorationId: randomUUID(), workspaceOrigin: randomUUID(), sourceBackupId: randomUUID(), manifestHash: 'a'.repeat(64), sourceDbHash: 'b'.repeat(64), createdAt: new Date().toISOString()};
  // Reuse the real restore-schema installation boundary while this disposable
  // store is closed. This is a profile/origin test, not a backup-copy claim.
  await f.restart(async () => {
    const db = new DatabaseSync(path.join(f.root, 'workbench.sqlite'));
    try {installCurrentWorkspaceRestoreSchema(db, metadata); db.exec('PRAGMA wal_checkpoint(TRUNCATE)');} finally {db.close();}
  });
  const holds = JSON.stringify(f.store.db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all());
  assert.equal(matchesRestoredExport(f.store, originalExport), false, 'captured selected-range record is not dispatch-eligible');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(heldId).n, 1);
  const unsupported = {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'};
  assert.deepEqual(await passiveGet(f), unsupported);
  for (const method of ['execute', 'recover']) assert.deepEqual(await f.local('/' + method, action(value)), {envelope: unsupported, response: null});
  assert.deepEqual(await readFile(f.file), sidecar); assert.deepEqual(f.dispatches, [input.input]);
  const fresh = {...input.input, requestId: randomUUID(), exportRange: {startFrame: 45, endFrame: 46}, exportSettings: structuredClone(SETTINGS)};
  await assert.rejects(f.services.call('timeline.render', fresh), {code: 'RESTORE_WORKSPACE_ORIGIN_REQUIRED'});
  await assert.rejects(f.services.call('timeline.render', fresh, {expectedWorkspaceOrigin: randomUUID()}), {code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'});
  const result = await f.services.call('timeline.render', fresh, {expectedWorkspaceOrigin: metadata.workspaceOrigin});
  assert.deepEqual(result.snapshot.exportRange, fresh.exportRange); assert.notEqual(result.id, heldId);
  const binding = f.store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=?').get(result.id);
  assert.equal(binding.workspaceOrigin, metadata.workspaceOrigin); assert.equal(binding.requestHash, hash({operation: 'timeline.render', input: fresh}));
  assert.equal(binding.identityHash, restoreExportIdentity(f.store.get('exports', result.id)));
  assert.equal(matchesRestoredExport(f.store, f.store.get('exports', result.id)), true);
  assert.equal(matchesRestoredExport(f.store, {...f.store.get('exports', result.id), snapshot: {...result.snapshot, exportRange: {...RANGE}}}), false);
  assert.deepEqual(await f.services.call('timeline.render', fresh), result, 'new receipt replays without another origin dispatch');
  const heldRead = await f.services.call('export.get', {exportId: heldId});
  assert.equal(heldRead.id, heldId); assert.equal(matchesRestoredExport(f.store, f.store.get('exports', heldId)), false);
  assert.deepEqual(f.store.get('exports', heldId), originalExport); assert.deepEqual(f.receipt(input.input.requestId), heldReceipt);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all()), holds);
  assert.deepEqual(await readFile(f.file), sidecar); assert.equal(f.store.list('exports').length, 2); await f.assertNoWorker();
});
