



import {projectApiPath} from '../packages/contracts/src/project-file.ts';
import type {SelectedRangeFixture} from './helpers/strict-timeline-selected-range-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';


import {isTimelineMutationResponse, publicValue} from '@mioon/contracts';

import {hash} from '../packages/business/src/services.ts';

import {selectedRangeFixture, RANGE, SETTINGS, authority, action} from './fixtures/selected-range-http-fixture.ts';

async function prepared(f: SelectedRangeFixture, {settings = false} = {}) {
  const initial = await f.local();
  const draft = await f.local('/draft', {...authority(initial as Parameters<typeof authority>[0]), expectedDraftRevision: initial.draftRevision, draftId: randomUUID(),
    timelineId: f.timeline.id, baseRevision: f.timeline.revision, raw: {deliveryName: '交付 · exact range 🎬'}});
  const input = f.prepare(draft, settings ? {exportSettings: structuredClone(SETTINGS)} : {});
  const value = await f.local('/prepare', input);
  assert.equal((value.intent)!.outcome.status, 'pending'); assert.deepEqual((value.intent)!.input, input.input);
  await assert.rejects(stat(f.file),{code:'ENOENT'});
  const savedSlot = f.draftRows()[0];
  assert.equal(f.store.db.prepare("SELECT kind FROM main.local_draft_states WHERE kind='delivery'").get()!.kind,'delivery'); assert.deepEqual(savedSlot.intent!.input, (value.intent)!.input);
  assert.deepEqual(savedSlot.draft!.raw, {deliveryName: '交付 · exact range 🎬'}, 'existing draft stays title-only');
  assert.equal(f.dispatches.length, 0); assert.equal(f.store.list('exports').length, 0); await f.assertNoWorker();
  return {value, input};
}
async function passiveGet(f: SelectedRangeFixture) {
  const before = await f.checkpoint(), count = f.dispatches.length, media = f.media.length;
  const result = await f.local(); await f.unchanged(before);
  assert.equal(f.dispatches.length, count, 'GET cannot dispatch an export'); assert.equal(f.media.length, media, 'GET cannot probe or render');
  await f.assertNoWorker(); return result;
}
async function passiveRestart(f: SelectedRangeFixture) {
  const before = await f.checkpoint(), count = f.dispatches.length, media = f.media.length;
  await f.restart(); await f.unchanged(before);
  assert.equal(f.dispatches.length, count, 'service/draft repository recreation cannot dispatch');
  assert.equal(f.media.length, media, 'startup cannot probe or render'); await f.assertNoWorker();
  return passiveGet(f);
}

test('prepared ranged intent survives close/recreate and GET without dispatch; explicit recovery dispatches only its original key and range', {timeout: 30_000}, async t => {
  const f = (await selectedRangeFixture(t) as unknown as SelectedRangeFixture);
  await passiveGet(f); await assert.rejects(stat(f.file), {code: 'ENOENT'});
  const beforePrepare = f.rows(), {value, input} = await prepared(f, {settings: true}), frozen = JSON.stringify((value.intent)!.input), sidecar = f.draftState();
  assert.deepEqual(f.rows(), beforePrepare, 'prepare writes only the history drafts domain');
  assert.equal(f.receipt(input.input.requestId), undefined);
  const current = await passiveRestart(f);
  assert.notEqual(current.instanceId, value.instanceId); assert.equal(current.workspaceScope, value.workspaceScope);
  assert.equal((current.intent)!.intentId, (value.intent)!.intentId); assert.equal(JSON.stringify((current.intent)!.input), frozen);
  assert.deepEqual(f.draftState(), sidecar); assert.equal(f.store.list('exports').length, 0);
  const stale = await f.request(projectApiPath(f.project.id,'local-delivery','recover'), {method: 'POST', input: action(value as Parameters<typeof action>[0])});
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'LOCAL_DELIVERY_STALE_INSTANCE');
  const replacement = {...input, ...authority(current as Parameters<typeof authority>[0]), intentId: randomUUID(), input: {...input.input, requestId: randomUUID(), exportRange: {startFrame: 0, endFrame: 1}}};
  const refused = await f.request(projectApiPath(f.project.id,'local-delivery','prepare'), {method: 'POST', input: replacement});
  assert.equal(refused.status, 409); assert.equal(refused.body.error.code, 'LOCAL_DELIVERY_CONFLICT');
  await passiveGet(f); assert.deepEqual((f.dispatches as unknown), []);
  const recovered = await f.local('/recover', action(current as Parameters<typeof action>[0]));
  assert.equal((recovered.envelope.intent)!.outcome.status, 'accepted'); assert.equal(recovered.envelope.draft, null);
  assert.equal(isTimelineMutationResponse('timeline.render', input.input, recovered.response), true);
  assert.deepEqual((recovered.response)!.snapshot.exportRange, RANGE); assert.deepEqual(f.dispatches, [input.input]);
  assert.equal(f.store.list('exports').length, 1);
  const receipt = f.receipt(input.input.requestId); assert.equal((receipt)!.requestHash, hash({operation: 'timeline.render', input: input.input}));
  assert.deepEqual(publicValue(JSON.parse((receipt)!.response as string)), recovered.response);
  assert.equal((recovered.envelope.intent)!.outcome.responseSha256, hash(recovered.response));
  const committed = await f.checkpoint();
  assert.deepEqual(await f.local('/recover', action(recovered.envelope as Parameters<typeof action>[0])), recovered); await f.unchanged(committed);
  const restarted = await passiveRestart(f); assert.equal(JSON.stringify((restarted.intent)!.input), frozen);
  assert.deepEqual((await f.local('/recover', action(restarted as Parameters<typeof action>[0]))).response, recovered.response);
  assert.deepEqual(f.receipt(input.input.requestId), receipt); assert.deepEqual(f.dispatches, [input.input]); await f.assertNoWorker();
});

for (const loss of ['after-business-commit', 'accepted-http-ack']) test(`${loss}: real selected-range execution survives a lost HTTP ACK and close/recreate with one immutable export`, {timeout: 30_000}, async t => {
  const f = (await selectedRangeFixture(t) as unknown as SelectedRangeFixture), {value, input} = await prepared(f), frozen = JSON.stringify((value.intent)!.input);
  const before = f.rows();
  if (loss === 'after-business-commit') f.fault((point: string) => {if (point === 'afterDispatch') throw Error('Synthetic lost business acknowledgement');});
  f.lose(projectApiPath(f.project.id,'local-delivery','execute'));
  await assert.rejects(f.request(projectApiPath(f.project.id,'local-delivery','execute'), {method: 'POST', input: action(value as Parameters<typeof action>[0])}));
  f.fault(() => {});
  const observed = f.observations.at(-1);
  assert.equal((observed)!.path, projectApiPath(f.project.id,'local-delivery','execute'));
  if (loss === 'accepted-http-ack') {
    assert.equal((observed)!.status, 200); assert.equal((((observed)!.body as {data: unknown}).data as {envelope: {intent: {outcome: {status: string; responseSha256: string}}}; response: unknown}).envelope.intent.outcome.status, 'accepted');
    assert.equal((((observed)!.body as {data: unknown}).data as {envelope: {intent: {outcome: {status: string; responseSha256: string}}}; response: unknown}).envelope.intent.outcome.responseSha256, hash((((observed)!.body as {data: unknown}).data as {response: unknown}).response));
  } else assert.equal((observed)!.status, 503);
  assert.deepEqual(f.dispatches, [input.input]); assert.equal(f.store.list('exports').length, 1);
  assert.equal(f.rows().timeline_requests.length, before.timeline_requests.length + 1);
  const receipt = f.receipt(input.input.requestId), original = publicValue(JSON.parse((receipt)!.response as string)) as {snapshot: {exportRange: unknown; timeline: unknown}};
  assert.equal((receipt)!.requestHash, hash({operation: 'timeline.render', input: input.input}));
  assert.equal(isTimelineMutationResponse('timeline.render', input.input, original), true);
  assert.deepEqual(original.snapshot.exportRange, RANGE); assert.deepEqual(original.snapshot.timeline, f.timeline);
  const sidecar = f.draftState(), current = await passiveRestart(f);
  assert.equal((current.intent)!.outcome.status, loss === 'accepted-http-ack' ? 'accepted' : 'pending');
  assert.equal((current.intent)!.intentId, (value.intent)!.intentId); assert.equal(JSON.stringify((current.intent)!.input), frozen);
  assert.deepEqual(f.draftState(), sidecar); assert.equal(f.store.list('exports').length, 1);
  // Current form/title and saved timeline change after restart. Recovery must
  // use the persisted composition/key/range, including when its old end is now
  // outside the shorter current composition.
  let shorter = await f.services.call('timeline.clip.remove', {projectId: f.project.id, expectedRevision: f.timeline.revision, requestId: randomUUID(), clipId: f.timeline.clips[1].id});
  shorter = await f.services.call('timeline.clip.update', {projectId: f.project.id, expectedRevision: shorter.revision, requestId: randomUUID(), clipId: shorter.clips[0].id, patch: {durationFrames: 6}});
  // An existing title draft retains its own original target until explicitly
  // discarded. Updating its text is allowed; silently rebasing it is not.
  const changed = await f.local('/draft', {...authority(current as Parameters<typeof authority>[0]), expectedDraftRevision: current.draftRevision,
    draftId: current.draft?.draftId ?? randomUUID(), timelineId: current.draft?.timelineId ?? shorter.id,
    baseRevision: current.draft?.baseRevision ?? shorter.revision, raw: {deliveryName: 'Later form title'}});
  assert.equal((await passiveGet(f)).intentTargetStatus, 'changed');
  const rows = f.rows(), recovered = await f.local('/recover', action(changed as Parameters<typeof action>[0]));
  assert.deepEqual(recovered.response, original); assert.equal(JSON.stringify((recovered.envelope.intent)!.input), frozen);
  assert.deepEqual((recovered.envelope.draft)!.raw, {deliveryName: 'Later form title'});
  assert.deepEqual(f.rows(), rows); assert.deepEqual(f.receipt(input.input.requestId), receipt);
  assert.deepEqual(f.dispatches, [input.input], 'receipt recovery never calls render again');
  assert.equal(f.store.list('exports').length, 1);
  const settled = await f.checkpoint(); assert.deepEqual(await f.local('/recover', action(recovered.envelope as Parameters<typeof action>[0])), recovered); await f.unchanged(settled);
  const again = await passiveRestart(f); assert.deepEqual((await f.local('/recover', action(again as Parameters<typeof action>[0]))).response, original);
  assert.deepEqual(f.dispatches, [input.input]); assert.deepEqual(f.receipt(input.input.requestId), receipt); await f.assertNoWorker();
});
