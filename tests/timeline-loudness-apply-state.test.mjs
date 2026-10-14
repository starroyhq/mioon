import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineLoudnessApplyController, timelineLoudnessCanReview } from '../apps/web/src/timeline-loudness-apply-state.ts';
import { timelineMixLoudnessViewState } from '../apps/web/src/timeline-mix-loudness-state.ts';
import { fixture, deferred, draft, id, report, input } from './helpers/timeline-mix-loudness-ui-fixture.mjs';
const digest = 'timeline-loudness-candidate-v1:' + 'a'.repeat(64);
const prepared = intent => ({id:id(70),digest:'d'.repeat(64),operation:intent.operation,projectId:intent.input.projectId,requestId:intent.input.requestId,input:intent.input});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function harness(overrides = {}) {
  const observation = fixture(); observation.edit(); await observation.ready();
  const hashes = [], confirms = [], submits = []; let keys = 0;
  const getObservation = () => timelineMixLoudnessViewState(observation.state(), observation.live());
  const controller = createTimelineLoudnessApplyController({ getObservation, createRequestId: () => `original-apply-request-${++keys}`,
    digest(value) { const wait = deferred(); hashes.push({ value, wait }); return wait.promise; },
    confirm(message) { const wait = deferred(); confirms.push({ message, wait }); return wait.promise; },
    submit(intent, canExecute) { const wait = deferred(); submits.push({ intent, canExecute, wait }); return wait.promise; }, ...overrides });
  controller.attach();
  const h = { observation, controller, getObservation, hashes, confirms, submits, get keys() { return keys; },
    review: () => controller.review(getObservation()),
    async confirm() { hashes.at(-1).wait.resolve(digest); await flush(); },
    async submit() { await h.confirm(); confirms.at(-1).wait.resolve(true); await flush(); },
  };
  return h;
}
test('explicit human apply binds scalar intent, shared report digest and fixed review; attach and polling are passive', async () => {
  const h = await harness(), before = h.getObservation(); h.controller.setObservation(before);
  assert.equal(h.hashes.length, 0); const pending = h.review(); assert.equal(h.hashes[0].value, before.report);
  await h.confirm(); assert.equal(h.submits.length, 0); assert.match(h.confirms[0].message, /rev 4.*1 个可听片段/);
  assert.match(h.confirms[0].message, /重新核验来源.*不会自动选择 v2/);
  h.confirms[0].wait.resolve(true); await flush(); const { intent, canExecute } = h.submits[0];
  assert.deepEqual(intent.input, { ...input(), requestId: 'original-apply-request-1', snapshotSha256: 'b'.repeat(64), candidateDigest: digest });
  assert.deepEqual(Object.keys(intent.input).sort(), ['candidateDigest','expectedRevision','measurementProfile','mixProfile','projectId','requestId','snapshotSha256','target']);
  assert.equal(intent.scope, before.scope); assert.equal(intent.timelineId, before.timelineId); assert.equal(intent.sourceIdentity, before.sourceIdentity);
  assert.equal(intent.executionScope, before.executionScope); assert.equal(canExecute(), true); assert.ok(Object.isFrozen(intent)); assert.ok(Object.isFrozen(intent.input.target));
  assert.equal(before.report.applyAllowed, false); h.submits[0].wait.resolve({ status: 'applied' }); await pending;
  assert.equal(h.controller.getState().phase, 'applied'); assert.equal(await h.review(), null); assert.equal(h.keys, 1);
});
const changes = [ ['project', h => h.observation.set({ projectId: id(90) }, false)], ['scope', h => h.observation.set({ scope: 'other-workspace' }, false)],
  ['revision', h => h.observation.set({ revision: 5 }, false)], ['timeline', h => h.observation.set({ timelineId: id(91) }, false)],
  ['source', h => h.observation.set({ sourceIdentity: 'new-source-bytes' }, false)], ['panel intent', h => h.observation.set({ executionScope: '0:1:editing' }, false)],
  ['tab', h => h.observation.set({ visible: false }, false)], ['offline', h => h.observation.set({ connected: false }, false)],
  ['draft', h => h.observation.set({ hasUnsavedDrafts: true }, false)], ['pending', h => h.observation.set({ pending: true }, false)],
  ['restore', h => h.observation.set({ restored: true }, false)], ['target', h => h.observation.edit({ ...draft, integratedLufs: '-18' })],
  ['window close', h => h.controller.revoke()], ['dispose', h => h.controller.dispose()] ];
for (const [name, change] of changes) for (const phase of ['digest','confirm']) test(`late ${phase} after ${name} cannot dispatch or recreate an apply`, async () => {
  const h = await harness(), pending = h.review();
  if (phase === 'confirm') await h.confirm();
  change(h);
  if (phase === 'digest') await h.confirm(); else { h.confirms[0].wait.resolve(true); await flush(); }
  assert.equal(await pending, null); assert.equal(h.submits.length, 0);
  assert.equal(h.confirms.length, phase === 'digest' ? 0 : 1);
});
test('duplicate clicks, cancel confirmation and obsolete render callbacks create no mutations', async () => {
  const h = await harness(), captured = h.getObservation(), pending = h.review(); assert.equal(await h.review(), null);
  await h.confirm(); assert.equal(await h.review(), null); h.confirms[0].wait.resolve(false); await pending;
  assert.equal(h.submits.length, 0); assert.equal(h.controller.getState().phase, 'idle');
  h.observation.edit({ ...draft, truePeakCeilingDbtp: '-2' }); assert.equal(await h.controller.review(captured), null);
});
test('durable preparation pending permits only its captured execution; unknown retains original key until exact recovery', async () => {
  const h = await harness(), pending = h.review(); await h.submit(); const original = h.submits[0];
  h.observation.set({ pending: true }); assert.equal(h.getObservation().report, null); assert.equal(original.canExecute(), false); assert.equal(original.canExecute(prepared(original.intent)), true);
  assert.equal(original.canExecute({...prepared(original.intent),id:id(71)}),false);
  assert.equal(original.canExecute({...prepared(original.intent),input:{...original.intent.input,requestId:'other-window-key'}}),false);
  h.submits[0].wait.resolve({ status: 'unknown' }); await pending; assert.equal(h.controller.getState().requestId, original.intent.input.requestId);
  h.observation.set({ pending: false }); assert.equal(await h.review(), null); assert.equal(h.keys, 1);
  h.controller.recovered({ operation: original.intent.operation, projectId: original.intent.input.projectId, requestId: 'wrong-original', status: 'applied' });
  assert.equal(h.controller.getState().phase, 'unknown');
  h.controller.recovered({ ...prepared(original.intent), status: 'applied', acknowledged: true, revision: 4 }, h.observation.live().scope);
  assert.equal(h.controller.getState().phase, 'applied'); assert.equal(h.submits.length, 1);
});
test('revision, source, target and window changes during durable preparation veto late execute', async () => {
  for (const change of [h => h.observation.set({ revision: 5 }), h => h.observation.set({ sourceIdentity: 'changed' }), h => h.observation.set({ executionScope: 'new-panel' }), h => h.controller.revoke()]) {
    const h = await harness(), pending = h.review(); await h.submit(); h.observation.set({ pending: true }); change(h);
    assert.equal(h.submits[0].canExecute(prepared(h.submits[0].intent)), false); h.submits[0].wait.resolve({ status: 'unknown' }); await pending;
    assert.equal(h.controller.getState().phase, 'unknown');
  }
});
test('definitive stale or unsafe rejection requires explicit new prepare, with no automatic retry', async () => {
  for (const code of ['TIMELINE_LOUDNESS_APPLY_STALE','TIMELINE_LOUDNESS_APPLY_UNSAFE','TIMELINE_LOUDNESS_APPLY_UNCHANGED']) {
    const h = await harness(), pending = h.review(); await h.submit(); h.submits[0].wait.resolve({ status: 'rejected', error: { code, message: '/private/secret.wav' } }); await pending;
    assert.equal(h.controller.getState().phase, 'error'); assert.match(h.controller.getState().error, /重新准备/); assert.doesNotMatch(h.controller.getState().error, /private|secret/);
    assert.equal(await h.review(), null); assert.equal(h.submits.length, 1);
    await h.observation.ready(); const next = h.review(); h.controller.revoke(); h.hashes.at(-1).wait.resolve(digest); await next;
    assert.equal(h.hashes.length, 2);
  }
});
test('failed, unchanged, restored and unsafe observations cannot become apply authority', async () => {
  const h = await harness(), good = h.getObservation();
  for (const value of [{ ...good, restored: true }, { ...good, pending: true }, { ...good, hasUnsavedDrafts: true }, { ...good, phase: 'stale' },
    { ...good, report: null }, { ...good, report: { ...good.report, applyAllowed: true } }, { ...good, report: report(input({ integratedLufs: -20, truePeakCeilingDbtp: -1 })) },
    { ...good, report: report(input({ integratedLufs: -14, truePeakCeilingDbtp: -1 })) }]) assert.equal(timelineLoudnessCanReview(value), false);
});

test('a delayed original terminal outcome settles only its restored pending owner after navigation or effect cleanup', async () => {
  for (const cleanup of [false, true]) {
    const h = await harness(), originalObservation = h.getObservation(), pending = h.review(); await h.submit();
    if (cleanup) { h.controller.dispose(); h.controller.attach(); }
    else {
      h.observation.set({ projectId: id(90), scope: 'other-project-scope' }); h.controller.setObservation(h.getObservation());
      h.observation.set({ projectId: originalObservation.projectId, scope: originalObservation.scope }); h.controller.setObservation(h.getObservation());
    }
    assert.equal(h.controller.getCloseState().blocked, true);
    h.submits[0].wait.resolve({ status: 'applied' }); await pending;
    assert.equal(h.controller.getState().phase, 'applied'); assert.equal(h.controller.getCloseState().blocked, false);
    assert.equal(h.submits.length, 1);
  }
});

for (const unavailable of [() => null, () => '', () => undefined, () => { throw Error('Unverified identity'); }]) {
  test('unavailable recovery identity stops before digest, confirmation, request ID or pending owner', async () => {
    const h = await harness({ getRecoveryScope: unavailable });
    assert.equal(await h.review(), null); assert.equal(h.hashes.length, 0); assert.equal(h.keys, 0);
    assert.equal(h.confirms.length, 0); assert.equal(h.submits.length, 0);
    assert.equal(h.controller.getState().phase, 'error'); assert.match(h.controller.getState().error, /工作区身份尚未核验/);
    assert.equal(h.controller.getCloseState().busy, false); assert.equal(h.controller.getCloseState().blocked, false);
  });
}

test('recovery identity change during hashing ends review before key minting and never leaves busy', async () => {
  let scope = 'original-verified-workspace'; const h = await harness({ getRecoveryScope: () => scope }), pending = h.review();
  scope = 'replacement-verified-workspace'; await h.confirm();
  assert.equal(await pending, null); assert.equal(h.keys, 0); assert.equal(h.confirms.length, 0); assert.equal(h.submits.length, 0);
  assert.equal(h.controller.getState().phase, 'error'); assert.match(h.controller.getState().error, /身份已变化/);
  assert.equal(h.controller.getCloseState().busy, false); assert.equal(h.controller.getCloseState().blocked, false);
});

for (const outcome of ['unknown', 'applied']) test(`identity change after submission retains the original pending owner through ${outcome}`, async () => {
  let scope = 'original-verified-workspace'; const h = await harness({ getRecoveryScope: () => scope }), pending = h.review(); await h.submit();
  const original = h.submits[0]; h.observation.set({ pending: true }); assert.equal(original.canExecute(prepared(original.intent)), true);
  scope = 'replacement-verified-workspace'; h.controller.setObservation(h.getObservation());
  assert.equal(h.controller.getState().phase, 'submitting'); assert.equal(original.canExecute(prepared(original.intent)), false);
  original.wait.resolve({ status: outcome }); assert.equal((await pending).status, outcome);
  if (outcome === 'unknown') {
    assert.equal(h.controller.getState().phase, 'unknown'); assert.equal(h.controller.getCloseState().blocked, true);
    const terminal = { ...prepared(original.intent), status: 'applied', acknowledged: true, revision: 4 };
    h.controller.recovered(terminal, scope); assert.equal(h.controller.getCloseState().blocked, true);
    h.controller.recovered(terminal, 'original-verified-workspace');
  }
  assert.equal(h.controller.getState().phase, 'applied'); assert.equal(h.controller.getCloseState().blocked, false);
  assert.equal(h.submits.length, 1);
});
