type StrictIntersection<T> = (T extends unknown ? (value: T)=>void : never) extends ((value: infer I)=>void) ? I : never;
import {fixture} from './helpers/strict-timeline-mix-fixture-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';
import { createTimelineMixLoudnessController, parseTimelineMixLoudnessTarget, timelineMixLoudnessAvailable, timelineMixLoudnessErrorMessage, timelineMixLoudnessViewState } from '../apps/web/src/timeline-mix-loudness-state.ts';
import {  context, input, report, draft, id } from './helpers/timeline-mix-loudness-ui-fixture.ts';

test('blank explicit target cannot measure; accepted finite target ranges have no preset or fallback', () => {
  for (const value of ([{ integratedLufs: '', truePeakCeilingDbtp: '' }, { ...draft, integratedLufs: '' }, { ...draft, truePeakCeilingDbtp: '' },
    ...['NaN','Infinity','-61','-4','1e1','-14LUFS'].map(integratedLufs => ({ ...draft, integratedLufs })),
    ...['-21','1','Infinity'].map(truePeakCeilingDbtp => ({ ...draft, truePeakCeilingDbtp }))] as const)) assert.ok(parseTimelineMixLoudnessTarget(value).error);
  for (const [integratedLufs, truePeakCeilingDbtp] of ([['-60','-20'],['-5','0'],['-24','-1']] as const))
    assert.deepEqual(parseTimelineMixLoudnessTarget({ integratedLufs, truePeakCeilingDbtp }), { target: { integratedLufs: +integratedLufs, truePeakCeilingDbtp: +truePeakCeilingDbtp }, error: '' });
});
test('mount, polling, reconnect, navigation and restart are passive; explicit target is never persisted', async () => {
  const f = fixture(); assert.deepEqual(f.state().draft, { integratedLufs: '', truePeakCeilingDbtp: '' });
  await f.prepare(); f.edit(); f.set({ visible: false }); f.set({ visible: true }); f.set({ connected: false }); f.set({ connected: true });
  f.set({ executionScope: '1:2:editing' }); f.controller.dispose(); f.controller.attach(f.live());
  assert.deepEqual(f.state().draft, { integratedLufs: '', truePeakCeilingDbtp: '' }); assert.equal(f.calls.length, 0);
});
test('prepare captures full saved revision, both explicit profiles/targets and pinned read-only invocation', async () => {
  const f = fixture({}, { getInvocation: () => ({ expectedWorkspaceOrigin: id(77) }) }); f.edit(); await f.ready();
  assert.deepEqual(f.calls[0].input, input()); assert.equal(f.calls[0].options.expectedWorkspaceOrigin, id(77));
  assert.equal(f.calls[0].options.signal.aborted, false); assert.ok(isTimelineMixLoudnessResponse(f.state().report, input()));
  assert.equal((f.state().report)!.applyAllowed, false); assert.equal((f.state().report)!.identity.range.startFrame, 0);
  assert.equal((f.state().report)!.candidate.marginDb, .5); assert.equal((f.state().report)!.candidate.gains[0].afterGain, .5 * 10 ** (-4 / 20));
  assert.ok(Object.isFrozen((f.state().report)!.candidate.gains[0])); assert.ok(!('exportRange' in f.calls[0].input));
});
const changes = [ { projectId: id(11) }, { timelineId: id(12) }, { revision: 5 }, { durationFrames: 61 }, { sourceIdentity: 'source-bytes-or-metadata-changed' },
  { scope: 'workspace-or-project-open-changed' }, { executionScope: 'new-navigation' }, { visible: false }, { connected: false }, { restored: true }, { hasUnsavedDrafts: true }, { pending: true } ];
for (const patch of changes) test(`live ${Object.keys(patch)[0]} change cancels old response, masks ready result and never restarts`, async () => {
  const f = fixture(); f.edit(); const wait = f.prepare(), captured = f.calls[0], response = report(((captured.input) as unknown as Parameters<typeof report>[0]), ((captured.context) as unknown as Parameters<typeof report>[1]));
  f.set(patch, false); f.reads[0].resolve(response); assert.equal((await wait as unknown), null);
  assert.equal(captured.options.signal.aborted, true); assert.equal((f.state().report as unknown), null); assert.notEqual(f.state().phase, 'ready'); assert.equal(f.calls.length, 1);
  const g = fixture(); g.edit(); await g.ready(); const old = g.state(), masked = timelineMixLoudnessViewState(old, context(patch));
  assert.equal((masked.report as unknown), null); assert.equal((old.report)!.status, 'ready'); g.set(patch); assert.equal((g.state().report as unknown), null); assert.equal(g.calls.length, 1);
});
test('only saved, connected, visible, ordinary, clean, bounded workspaces admit controls or retained prepare handlers', async () => {
  for (const patch of ([{ scope: null }, { projectId: null }, { timelineId: null }, { revision: null }, { revision: 0 }, { revision: 1.5 }, { sourceIdentity: '' },
    { durationFrames: 0 }, { durationFrames: 18001 }, { connected: false }, { visible: false }, { restored: true }, { hasUnsavedDrafts: true }, { pending: true }] as const)) {
    const f = fixture(); f.edit(); const old = f.state(); f.set(patch, false);
    assert.equal(timelineMixLoudnessAvailable(context(patch)), false); assert.equal((await f.controller.prepare(old) as unknown), null); assert.equal(f.calls.length, 0);
  }
});
test('target edits invalidate in-flight results; stale field handlers cannot overwrite a later target', async () => {
  const f = fixture(); f.edit(); const stale = f.state(), wait = f.prepare();
  f.edit({ ...draft, integratedLufs: '-18' }); assert.equal(f.controller.setDraft(draft, stale), false);
  f.reads[0].resolve(report(((f.calls[0].input) as unknown as Parameters<typeof report>[0]))); await wait; assert.equal((f.state().report as unknown), null); assert.equal(f.state().draft.integratedLufs, '-18');
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.controller.setDraft({ ...draft, integratedLufs: '1'.repeat(33) }, f.state()), false);
});
test('repeat clicks do not queue; cancel is observational and old cancel cannot cancel a newer attempt', async () => {
  const f = fixture(); f.edit(); const before = f.state(), first = f.prepare(); assert.equal((await f.controller.prepare(before) as unknown), null); assert.equal((await f.prepare() as unknown), null);
  const oldCancel = f.state(); f.cancel(); assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().phase, 'cancelled');
  const second = f.prepare(); f.controller.cancel(oldCancel); assert.equal(f.calls[1].options.signal.aborted, false);
  f.reads[1].resolve(report(((f.calls[1].input) as unknown as Parameters<typeof report>[0]))); await second; f.reads[0].resolve(report(((f.calls[0].input) as unknown as Parameters<typeof report>[0]))); await first;
  assert.equal(f.state().phase, 'ready'); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => call.input), [input(), input()]);
});
test('dispose/re-attach cannot publish or revive old handlers even when workspace identity is identical', async () => {
  const f = fixture(); f.edit(); const old = f.state(), wait = f.prepare(); f.controller.dispose(); f.controller.attach(context());
  f.reads[0].resolve(report(((f.calls[0].input) as unknown as Parameters<typeof report>[0]))); await wait; assert.equal((await f.controller.prepare(old) as unknown), null);
  assert.equal((f.state().report as unknown), null); assert.equal(f.calls.length, 1); assert.equal(f.state().draft.integratedLufs, '');
});
test('source/revision errors stay unavailable; late unauthorized failures never affect a new project', async () => {
  const f = fixture(); f.edit(); const wait = f.prepare(); f.set({ projectId: id(90) }, false);
  f.reads[0].reject(Object.assign(Error('expired'), { code: 'UNAUTHORIZED' })); await wait; assert.equal(f.auth.length, 0); assert.equal(f.state().error, '');
  for (const code of (['UNAUTHORIZED','TIMELINE_MIX_LOUDNESS_STALE','TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT','TIMELINE_MIX_LOUDNESS_BUSY',
    'TIMELINE_MIX_LOUDNESS_TIMEOUT','TIMELINE_MIX_LOUDNESS_RESOURCE_LIMIT','TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT','TIMELINE_MIX_LOUDNESS_INVALID_PCM'] as const)) {
    const g = fixture(); g.edit(); const pending = g.prepare(); g.reads[0].reject(Object.assign(Error('/private/secret.wav'), { code })); await pending;
    assert.equal(g.state().phase, 'error'); assert.equal((g.state().report as unknown), null); assert.equal(g.state().error, timelineMixLoudnessErrorMessage({ code }));
    assert.doesNotMatch(g.state().error, /private|secret/); assert.equal(g.auth.length, code === 'UNAUTHORIZED' ? 1 : 0);
  }
});
test('wrong project, revision, targets, full interval, timeline, profile, margin or apply authority fails closed', async () => {
  for (const mutate of ([(r: { projectId: string; }) => { r.projectId = id(91); }, (r: { expectedRevision: number; }) => { r.expectedRevision++; }, (r: { target: unknown; }) => { r.target = { ...(r.target as Record<string, unknown>), integratedLufs: -18 }; },
(    r: { identity: { timelineId: string; }; }) => { r.identity.timelineId = id(92); }, (r: { identity: { range: { startFrame: number; }; }; }) => { r.identity.range.startFrame = 1; }, (r: { identity: { range: { endFrame: number; }; }; }) => { r.identity.range.endFrame++; },
(    r: { mixProfile: string; }) => { r.mixProfile = 'unknown'; }, (r: { candidate: { marginDb: number; }; }) => { r.candidate.marginDb = 0; }, (r: { applyAllowed: boolean; }) => { r.applyAllowed = true; }, (r: { candidate: { meetsTruePeak: boolean; }; }) => { r.candidate.meetsTruePeak = false; }] as const)) {
    const f = fixture(); f.edit(); const value = report(input()); mutate(((((value) as unknown as Parameters<typeof mutate>[0])) as unknown as StrictIntersection<Parameters<NonNullable<typeof mutate>>[0]>)); await f.ready(value);
    assert.equal(f.state().phase, 'error'); assert.equal((f.state().report as unknown), null); assert.match(f.state().error, /响应不完整/);
  }
});
test('silence and out-of-range candidates preserve original measurement and never invent an applicable candidate', async () => {
  const silent = fixture(); silent.edit(); await silent.ready(report(input(), context(), { silence: true }));
  assert.equal((silent.state().report)!.candidate.reason, 'NO_VALID_LOUDNESS'); assert.equal(((silent.state().report)!.candidate.measurement as unknown), null);
  const out = fixture(); out.edit({ ...draft, integratedLufs: '-5' }); await out.ready(report(input({ integratedLufs: -5, truePeakCeilingDbtp: -1 }), context(), { outOfRange: true }));
  assert.equal((out.state().report)!.candidate.reason, 'GAIN_OUT_OF_RANGE'); assert.deepEqual(((out.state().report)!.candidate.gains as unknown), []);
});
