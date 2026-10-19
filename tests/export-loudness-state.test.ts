import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import { createExportLoudnessController, exportLoudnessTargets, exportLoudnessViewState, parseExportLoudnessTarget, exportLoudnessErrorMessage } from '../apps/web/src/export-loudness-state.ts';
import { context, fixture, report, unready, row, asset, id, projectId } from './helpers/export-loudness-ui-fixture.ts';

const blank = { integratedLufs: '', truePeakCeilingDbtp: '' }, custom = { integratedLufs: '-14', truePeakCeilingDbtp: '-1' };
test('optional target is absent by default, exact bounded explicit values only', () => {
  assert.deepEqual(parseExportLoudnessTarget(blank), { error: '' });
  assert.deepEqual(parseExportLoudnessTarget(custom), { target: { integratedLufs: -14, truePeakCeilingDbtp: -1 }, error: '' });
  for (const [integratedLufs, truePeakCeilingDbtp] of [['-60', '-20'], ['-5', '0']]) assert.equal(parseExportLoudnessTarget({ integratedLufs, truePeakCeilingDbtp }).error, '');
  for (const draft of [{ ...blank, integratedLufs: '-14' }, { ...blank, truePeakCeilingDbtp: '-1' }, ...['-61','-4','NaN','Infinity','-14dB','1e1'].map(integratedLufs => ({ ...custom, integratedLufs })), ...['-21','1','Infinity'].map(truePeakCeilingDbtp => ({ ...custom, truePeakCeilingDbtp }))]) assert.ok(parseExportLoudnessTarget(draft).error);
});
test('complete owned validated output metadata is required; download strings cannot grant measurement', () => {
  assert.equal(exportLoudnessTargets(context(), isTimelineRenderRecord).length, 2);
  for (const patch of [{ sha256: undefined }, { sha256: 'invalid' }, { projectId: id(99) }, { provenance: 'import' }, { url: 'https://elsewhere/film.mp4' }, { sizeBytes: 0 }]) {
    assert.equal(exportLoudnessTargets(context({ exports: [row()], assets: [{ ...asset(row()), ...patch }] }), isTimelineRenderRecord).length, 0);
  }
  for (const patch of [{ purpose: 'preview' }, { mode: 'storyboard' }, { status: 'running' }, { url: 'file:///private' }, { snapshot: {} }]) {
    const item = { ...row(), ...patch }; assert.equal(exportLoudnessTargets(context({ exports: [item], assets: [asset(item)] }), isTimelineRenderRecord).length, 0);
  }
  assert.equal(exportLoudnessTargets(context(), () => false).length, 0);
});
test('mount, polling, history open, draft edits and reconnect never decode or restart', () => {
  const f = fixture({ visible: false }); f.set({ visible: true }); f.edit(custom); f.set({ connected: false }); f.set({ connected: true });
  f.set({ exports: [...context().exports, row(12)], assets: [...context().assets, asset(row(12))] });
  f.set({ executionScope: '1:2:canvas' }); f.controller.dispose(); f.controller.attach(context()); assert.equal(f.calls.length, 0);
});
test('explicit measurement captures project/export/expected hash/profile, with no implicit target or mutable authority', async () => {
  const f = fixture(); await f.ready();
  assert.deepEqual(f.calls[0].input, { projectId, exportId: f.target().exportId, expectedArtifactSha256: 'a'.repeat(64), measurementProfile: EXPORT_LOUDNESS_PROFILE });
  assert.ok(Object.isFrozen(f.calls[0].input)); assert.deepEqual(Object.keys(f.calls[0].options), ['signal']); assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.state().phase, 'ready'); assert.ok(Object.isFrozen(f.state().report)); assert.ok(Object.isFrozen(f.state().report.measurement)); assert.equal(f.state().report.suggestion, null);
});
test('target edits clear advice immediately; custom response and suggestion bind exact captured target', async () => {
  const f = fixture(); f.edit(custom); await f.ready();
  assert.deepEqual(f.calls[0].input.target, { integratedLufs: -14, truePeakCeilingDbtp: -1 });
  assert.equal(f.state().report.suggestion.requiredGainDb, 6); assert.equal(f.state().report.suggestion.conflictsWithCeiling, true); assert.equal(f.state().report.suggestion.applyAllowed, false);
  f.edit({ ...custom, integratedLufs: '-16' }); assert.equal(f.state().report, null); assert.equal(f.state().phase, 'idle'); assert.equal(f.calls.length, 1);
});
test('partial invalid target prevents decoding and has no fallback standard', async () => {
  const f = fixture(); f.edit({ ...blank, integratedLufs: '-14' }); await f.measure(); assert.equal(f.calls.length, 0);
  f.edit(blank); await f.ready(); assert.equal(Object.hasOwn(f.calls[0].input, 'target'), false);
});
test('rapid same/different repeated clicks never queue work', async () => {
  const f = fixture(), pending = f.measure(); await f.measure(); await f.measure(1); assert.equal(f.calls.length, 1);
  f.reads[0].resolve(report(f.target())); await pending; assert.equal(f.state().phase, 'ready');
});
for (const patch of [{ scope: 'other:2:normal', projectId: id(99) }, { scope: `${projectId}:2:normal` }, { restored: true }, { executionScope: '1:9:canvas' }, { visible: false }, { connected: false }]) test(`live result fence before layout: ${JSON.stringify(patch)}`, async () => {
  const f = fixture(), file = f.target(), pending = f.measure(); f.set(patch, false); f.reads[0].resolve(report(file)); await pending;
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().report, null); assert.notEqual(f.state().phase, 'ready');
});
test('editing target while pending aborts observer and rejects late success, without retrying', async () => {
  const f = fixture(); f.edit(custom); const pending = f.measure(), input = f.calls[0].input;
  f.edit({ ...custom, integratedLufs: '-18' }); assert.equal(f.calls[0].options.signal.aborted, true);
  f.reads[0].resolve(report(f.target(), input.target)); await pending; assert.equal(f.state().report, null); assert.equal(f.state().draft.integratedLufs, '-18'); assert.equal(f.calls.length, 1);
  await f.ready(); assert.equal(f.state().report.target.integratedLufs, -18);
});
test('cancel and stale row callbacks cannot replace target or cancel a newer observer', async () => {
  const f = fixture(), first = f.measure(), staleState = f.state(), old = f.target(); f.cancel();
  const second = f.measure(1); f.controller.cancel(old, staleState.scope, staleState.draftVersion);
  assert.equal(f.calls[1].options.signal.aborted, false);
  assert.equal(f.controller.setDraft(old, staleState.scope, custom, staleState.draftVersion), false);
  f.reads[1].resolve(report(f.target(1))); await second;
  f.reads[0].reject(Object.assign(Error('/secret'), { code: 'UNAUTHORIZED' })); await first;
  assert.equal(f.auth.length, 0); assert.equal(f.state().report.exportId, f.target(1).exportId);
});
test('same row old cancellation cannot cancel its newer explicit measurement', async () => {
  const f = fixture(), first = f.measure(), staleState = f.state(); f.cancel(); const second = f.measure();
  f.controller.cancel(f.target(), staleState.scope, staleState.draftVersion); assert.equal(f.calls[1].options.signal.aborted, false);
  f.reads[1].resolve(report(f.target())); await second; f.reads[0].resolve(report(f.target())); await first; assert.equal(f.state().phase, 'ready');
});
test('A→B→A and dispose/reattach cannot revive old report or target draft', async () => {
  const f = fixture(); f.edit(custom); const first = f.measure(), file = f.target();
  f.set({ scope: 'B:2', projectId: id(99) }); f.set({ scope: `${projectId}:3:normal`, projectId }); f.reads[0].resolve(report(file, { integratedLufs: -14, truePeakCeilingDbtp: -1 })); await first;
  assert.equal(f.state().report, null); assert.deepEqual(f.state().draft, blank);
  const second = f.measure(); f.controller.dispose(); f.controller.attach(context()); f.reads[1].resolve(report(file)); await second; assert.equal(f.state().report, null);
});
test('historical observation survives unrelated timeline/source edits; exact output replacement invalidates it', async () => {
  const f = fixture(); await f.ready(); const saved = f.state().report;
  f.set({ timeline: { revision: 99, clips: [] }, sourceAssets: [], exports: structuredClone(context().exports), assets: structuredClone(context().assets) });
  f.set({ visible: false }); f.set({ visible: true }); assert.equal(f.state().report, saved); assert.equal(f.calls.length, 1);
  const assets = context().assets; assets[0].sha256 = 'b'.repeat(64); f.set({ assets }); assert.equal(f.state().report, null); assert.equal(f.state().phase, 'stale');
});
test('pre-layout replacement and owner projections never flash old numeric advice', async () => {
  const f = fixture(); f.edit(custom); await f.ready(); const assets = context().assets; assets[0].sha256 = 'b'.repeat(64);
  for (const patch of [{ assets }, { scope: 'new-owner' }, { connected: false }, { restored: true }]) {
    const projected = exportLoudnessViewState(f.state(), context(patch), isTimelineRenderRecord); assert.equal(projected.report, null); assert.deepEqual(projected.draft, blank);
  }
  assert.equal(exportLoudnessViewState(f.state(), context(), isTimelineRenderRecord), f.state());
});
for (const [name, mutate] of [
  ['project', v => { v.projectId = id(99); }], ['export', v => { v.exportId = id(99); }], ['expected hash', v => { v.expectedArtifactSha256 = 'b'.repeat(64); }],
  ['hash', v => { v.artifact.sha256 = 'b'.repeat(64); }], ['asset', v => { v.artifact.assetId = id(99); }], ['revision', v => { v.artifact.timelineRevision++; }],
  ['name', v => { v.artifact.deliveryName = 'forged'; }], ['snapshot digest', v => { v.artifact.snapshotSha256 = 'bad'; }], ['profile', v => { v.measurementProfile = 'other'; }],
  ['target', v => { v.target = { integratedLufs: -18, truePeakCeilingDbtp: -2 }; }], ['nonfinite', v => { v.measurement.integratedLufs = NaN; }],
  ['gain authority', v => { v.suggestion.applyAllowed = true; }], ['advisory arithmetic', v => { v.suggestion.requiredGainDb = 99; }],
  ['extra path', v => { v.path = '/private'; }], ['duration', v => { v.measurement.sampleFrames = 48000; v.measurement.decodedDurationSeconds = 1; v.measurement.gatingBlockCount = 7; v.measurement.absoluteGatedBlockCount = 7; v.measurement.relativeGatedBlockCount = 7; }],
]) test(`misbound or invalid ${name} fails closed`, async () => {
  const f = fixture(); f.edit(custom); const value = report(f.target(), { integratedLufs: -14, truePeakCeilingDbtp: -1 }); mutate(value); await f.ready(value);
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null); assert.match(f.state().error, /不完整或与此导出文件、目标不匹配/);
});
for (const [status, code] of [['unsupported','NO_AUDIO'], ['unsupported','UNSUPPORTED_FORMAT'], ['incomplete','TIMEOUT'], ['incomplete','BUSY'], ['stale','ARTIFACT_CHANGED']]) test(`${code} discards prior numbers and never automatically retries`, async () => {
  const f = fixture(); await f.ready(); const waiting = f.measure(); assert.equal(f.state().report, null); f.reads.at(-1).resolve(unready(f.target(), status, code)); await waiting;
  assert.equal(f.state().phase, status); assert.equal(f.state().report.measurement, null); assert.equal(f.calls.length, 2);
});
test('current unauthorized is surfaced once and server/private messages are not shown', async () => {
  const f = fixture(), pending = f.measure(); f.reads[0].reject(Object.assign(Error('/secret/path'), { code: 'UNAUTHORIZED' })); await pending;
  assert.deepEqual(f.auth, [false]); assert.match(f.state().error, /会话已过期/); assert.doesNotMatch(f.state().error, /secret|path/);
  assert.doesNotMatch(exportLoudnessErrorMessage({ message: '/private/token' }), /private|token/);
});
test('restored, hidden, disconnected, stale scope and arbitrary caller artifact cannot authorize measurement', async () => {
  for (const patch of [{ restored: true }, { visible: false }, { connected: false }]) { const f = fixture(patch); await f.measure(); assert.equal(f.calls.length, 0); }
  const f = fixture(), target = f.target(), old = f.state(); f.set({ scope: `${projectId}:2:normal` }); await f.controller.measure(target, old.scope, old.draftVersion); assert.equal(f.calls.length, 0);
  const forged = { ...f.target(), artifact: { ...f.target().artifact, sha256: 'b'.repeat(64) }, outputFrames: 30 };
  const pending = f.controller.measure(forged, f.state().scope, f.state().draftVersion); assert.equal(f.calls[0].input.expectedArtifactSha256, 'a'.repeat(64));
  f.reads[0].resolve(report(forged)); await pending; assert.equal(f.state().phase, 'error');
});
test('complete captured frozen range is authoritative while current timeline is irrelevant', async () => {
  const f = fixture(); await f.ready(undefined, 1); assert.deepEqual(f.state().report.artifact.exportRange, { startFrame: 15, endFrame: 45 });
  assert.equal(f.state().report.measurement.sampleFrames, 48000); assert.equal(f.state().report.artifact.deliveryName, '冻结的成片 <v1>');
});
for (const changed of ['hash','frozen snapshot','frozen range']) test(`live ${changed} replacement before layout aborts pending result`, async () => {
  const f = fixture(), file = f.target(1), pending = f.measure(1), live = context();
  if (changed === 'hash') live.assets[1].sha256 = 'b'.repeat(64);
  else if (changed === 'frozen range') live.exports[1].snapshot.exportRange = { startFrame: 0, endFrame: 30 };
  else live.exports[1].snapshot.timeline.clips[0].name = 'A changed frozen snapshot';
  f.set(live, false); f.reads[0].resolve(report(file)); await pending;
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().report, null); assert.equal(f.calls.length, 1);
});
test('same-duration shifted range response cannot stand in for the captured export range', async () => {
  const f = fixture(), value = report(f.target(1)); value.artifact.exportRange = { startFrame: 0, endFrame: 30 };
  await f.ready(value, 1); assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null);
});
test('a newly selected row never inherits another file’s custom target', async () => {
  const f = fixture(); f.edit(custom); await f.ready(); await f.ready(undefined, 1);
  assert.equal(Object.hasOwn(f.calls[1].input, 'target'), false); assert.deepEqual(f.state().draft, blank); assert.equal(f.state().report.suggestion, null);
});
