import type {SamplePeakReportFixture} from './helpers/strict-export-sample-peak-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import '@mioon/contracts/export-sample-peak';
import { EXPORT_SAMPLE_PEAK_ALGORITHM, exportSamplePeakReason } from '@mioon/contracts/export-sample-peak';
import { createExportSamplePeakController, exportSamplePeakTargets, exportSamplePeakErrorMessage, exportSamplePeakViewState } from '../apps/web/src/export-sample-peak-state.ts';

import { id, projectId, unready } from './helpers/export-sample-peak-ui-fixture.ts';
import {row, asset, context, report, fixture} from './helpers/strict-export-sample-peak-types.ts';

test('actual complete record guard admits named/unnamed/ranged historical outputs only', () => {
  const c = context(); assert.equal(exportSamplePeakTargets(c, isTimelineRenderRecord).length, 2);
  const named = exportSamplePeakTargets(c, isTimelineRenderRecord)[1];
  assert.equal(named!.artifact.deliveryName, '冻结的成片 <v1>'); assert.deepEqual(named.artifact.exportRange, { startFrame: 15, endFrame: 45 }); assert.equal(named!.outputFrames, 30);
  for (const change of [{ purpose: 'preview' }, { mode: 'storyboard' }, { status: 'running' }, { status: 'ready' }, { error: 'bad' }, { projectId: id(99) }, { timelineRevision: 8 }, { snapshot: {} }, { url: '/media/foreign' }]) {
    const item = { ...row(), ...change }; assert.equal(exportSamplePeakTargets(context({ exports: [item], assets: [asset(item)] }), isTimelineRenderRecord).length, 0, JSON.stringify(change));
  }
});
for (const patch of [{ sha256: 'bad' }, { sizeBytes: 0 }, { projectId: id(99) }, { provenance: 'import' }, { mimeType: 'audio/wav' }, { url: '/media/other' }]) test(`asset identity rejects ${JSON.stringify(patch)}`, () => {
  assert.equal(exportSamplePeakTargets(context({ exports: [row()], assets: [{ ...asset(row()), ...patch }] }), isTimelineRenderRecord).length, 0);
});
test('duplicate row/asset identities and full-guard failure fail closed', () => {
  const item = row();
  assert.equal(exportSamplePeakTargets(context({ exports: [item, item], assets: [asset(item)] }), isTimelineRenderRecord).length, 0);
  assert.equal(exportSamplePeakTargets(context({ exports: [item], assets: [asset(item), asset(item)] }), isTimelineRenderRecord).length, 0);
  assert.equal(exportSamplePeakTargets(context(), () => false).length, 0);
});
test('mount, new success rows, history open, mode change and reconnect never dispatch', () => {
  const f = fixture({ visible: false }); f.set({ visible: true }); f.set({ executionScope: '1:2:canvas' }); f.set({ connected: false }); f.set({ connected: true });
  f.set({ exports: [...context().exports, row(12)], assets: [...context().assets, asset(row(12))] }); assert.equal(f.calls.length, 0); assert.equal(f.state().report, null);
  f.controller.dispose(); assert.equal(f.state().report, null);
  f.controller.attach(context()); assert.equal(f.calls.length, 0); assert.equal(f.state().phase, 'idle');
});
test('explicit call sends only project/export identity and cancellation signal, stores a frozen observation', async () => {
  const f = fixture(), target = f.target(); await f.ready();
  assert.deepEqual(f.calls[0].input, { projectId, exportId: target.exportId }); assert.deepEqual(Object.keys(f.calls[0].options), ['signal']); assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.state().phase, 'ready'); assert.ok(Object.isFrozen(f.state().report)); assert.ok(Object.isFrozen(f.state().report!.measurement!.channelPeaks[0]));
});
test('all row checks are globally busy; same/different repeated click cannot queue work', async () => {
  const f = fixture(), wait = f.check(); await f.check(); await f.check(1); assert.equal(f.calls.length, 1);
  f.reads[0].resolve(report(f.target())); await wait; assert.equal(f.state().phase, 'ready');
});
for (const patch of [{ scope: 'other:2:normal', projectId: id(99) }, { scope: `${projectId}:2:normal` }, { scope: `${projectId}:1:restored:branch`, restored: true }, { executionScope: '1:9:canvas' }, { visible: false }, { connected: false }]) test(`live pre-layout result fence ${JSON.stringify(patch)}`, async () => {
  const f = fixture(), target = f.target(), wait = f.check(); f.set(patch, false); f.reads[0].resolve(report(target)); await wait;
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().report, null); assert.notEqual(f.state().phase, 'ready');
});
test('cancel, target switch and late unauthorized/success cannot steal report or authentication', async () => {
  const f = fixture(), original = f.target(), waiting = f.check(); f.controller.cancel(); assert.equal(f.calls[0].options.signal.aborted, true);
  const second = f.check(1); f.reads[1].resolve(report(f.target(1))); await second;
  f.reads[0].reject(Object.assign(Error('/private/token'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.equal(f.state().report!.exportId, f.target(1).exportId); assert.equal(f.auth.length, 0); assert.equal(f.calls.length, 2);
  const third = f.check(); f.controller.cancel(); f.reads[2].resolve(report(original)); await third; assert.equal(f.state().phase, 'cancelled'); assert.equal(f.state().report, null);
});
test('A→B→A and dispose/reattach cannot revive an old observation', async () => {
  const f = fixture(), target = f.target(), wait = f.check(); f.set({ scope: 'B:2', projectId: id(99) }); f.set({ scope: `${projectId}:3:normal`, projectId });
  f.reads[0].resolve(report(target)); await wait; assert.equal(f.state().report, null);
  const next = f.check(), target2 = f.target(); f.controller.dispose(); f.controller.attach(context()); f.reads[1].resolve(report(target2)); await next; assert.equal(f.state().report, null);
});
test('current timeline/source removal or edits do not change frozen report; output hash changes do', async () => {
  const f = fixture(); await f.ready(); const saved = f.state().report;
  f.set({ timeline: { revision: 99, clips: [] }, sourceAssets: [], exports: structuredClone(context().exports), assets: structuredClone(context().assets) }); assert.equal(f.state().report, saved);
  f.set({ visible: false }); f.set({ visible: true }); assert.equal(f.state().report, saved); assert.equal(f.calls.length, 1);
  const assets = context().assets; assets[0].sha256 = 'b'.repeat(64); f.set({ assets }); assert.equal(f.state().report, null); assert.equal(f.state().phase, 'stale'); assert.equal(f.calls.length, 1);
});
test('live output metadata replacement invalidates pending callback even before layout', async () => {
  const f = fixture(), target = f.target(), wait = f.check(); const items = context().exports; items[0].updatedAt = '2026-10-14T00:00:00.000Z';
  f.set({ exports: items }, false); f.reads[0].resolve(report(target)); await wait; assert.equal(f.state().report, null); assert.equal(f.calls[0].options.signal.aborted, true);
});
for (const [label, mutate] of [
  ['project', (value: SamplePeakReportFixture) => { value.projectId = id(99); }], ['export', (value: SamplePeakReportFixture) => { value.exportId = id(99); }], ['asset', (value: SamplePeakReportFixture) => { value.artifact.assetId = id(99); }],
  ['hash', (value: SamplePeakReportFixture) => { value.artifact.sha256 = 'b'.repeat(64); }], ['revision', (value: SamplePeakReportFixture) => { value.artifact.timelineRevision++; }], ['name presence', (value: SamplePeakReportFixture) => { value.artifact.deliveryName = 'forged'; }],
  ['duration', (value: SamplePeakReportFixture) => { value.measurement.sampleFrames = 48000; value.measurement.decodedDurationSeconds = 1; }],
  ['nonfinite', (value: SamplePeakReportFixture) => { value.measurement.peakLinear = NaN; }], ['unknown field', (value: SamplePeakReportFixture) => { value.path = '/private'; }], ['channel', (value: SamplePeakReportFixture) => { value.measurement.channelPeaks.reverse(); }],
] as const) test(`bad/misbound ${label} yields safe error without a numeric report`, async () => {
  const f = fixture(), value = report(f.target()); mutate(value); await f.ready(value); assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null); assert.match(f.state().error, /不完整或与此导出文件不匹配/);
});
for (const [status, code] of [['unsupported', 'UNSUPPORTED_FORMAT'], ['incomplete', 'TIMEOUT'], ['incomplete', 'BUSY'], ['stale', 'ARTIFACT_CHANGED']] as const) test(`${code} clears prior measurement and requires explicit recheck`, async () => {
  const f = fixture(); await f.ready(); const waiting = f.check(); assert.equal(f.state().report, null); f.reads.at(-1)!.resolve(unready(f.target(), status, code)); await waiting;
  assert.equal(f.state().phase, status); assert.equal(f.state().report!.measurement, null); assert.equal(f.calls.length, 2);
  await f.ready(); assert.equal(f.calls.length, 3); assert.equal(f.state().phase, 'ready');
});
test('restored/hidden/disconnected views cannot start any check; stale row click is rejected', async () => {
  for (const patch of [{ restored: true }, { visible: false }, { connected: false }]) { const f = fixture(patch); await f.check(); assert.equal(f.calls.length, 0); }
  const f = fixture(), target = f.target(), scope = f.state().scope; f.set({ scope: `${projectId}:2:normal` }); await f.controller.check(target, scope); assert.equal(f.calls.length, 0);
});
test('only current auth failure reaches owner; arbitrary server messages are never surfaced', async () => {
  const f = fixture(), waiting = f.check(); f.reads[0].reject(Object.assign(Error('/private/token'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.deepEqual(f.auth, [false]); assert.match(f.state().error, /会话已过期/); assert.doesNotMatch(f.state().error, /private|token/);
  assert.doesNotMatch(exportSamplePeakErrorMessage({ message: '/private/secret' }), /private|secret/);
});

test('pre-layout render projection cannot flash checked or busy state for a replaced identity', async () => {
  const f = fixture(); await f.ready(); const stored = f.state(), changedAssets = context().assets;
  changedAssets[0].sha256 = 'b'.repeat(64);
  for (const patch of [{ assets: changedAssets }, { scope: `${projectId}:99:normal` }, { connected: false }, { restored: true }]) {
    const view = exportSamplePeakViewState(stored, context(patch), isTimelineRenderRecord);
    assert.equal(view.report, null); assert.notEqual(view.phase, 'ready');
  }
  assert.equal(exportSamplePeakViewState(stored, context(), isTimelineRenderRecord), stored);
  const waiting = f.check(), target = f.target();
  const hidden = exportSamplePeakViewState(f.state(), context({ visible: false }), isTimelineRenderRecord);
  assert.notEqual(hidden.phase, 'checking'); assert.equal(hidden.report, null);
  f.controller.cancel(); f.reads.at(-1)!.resolve(report(target)); await waiting;
});
test('caller target metadata cannot override the live checked artifact or duration', async () => {
  const f = fixture(), real = f.target(), altered = { ...real, artifact: { ...real.artifact, sha256: 'b'.repeat(64) }, outputFrames: 30 };
  const waiting = f.controller.check(altered, f.state().scope); f.reads[0].resolve(report(altered)); await waiting;
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null);
});

for (const ranged of [false, true]) {
  for (const discrepancy of [4800, 4801]) test(`${ranged ? 'ranged' : 'full'} 600s frozen output uses exact integer duration boundary: ${discrepancy} sample frames`, async () => {
    const item = row(10, ranged ? { exportRange: { startFrame: 0, endFrame: 18000 } } : {});
    item.snapshot.timeline.durationFrames = 18000;
    item.snapshot.timeline.clips[0].durationFrames = 18000;
    const f = fixture({ exports: [item], assets: [asset(item)] });
    assert.equal(f.target().outputFrames, 18000);
    const value = report(f.target());
    value.measurement.sampleFrames -= discrepancy;
    value.measurement.decodedDurationSeconds = value.measurement.sampleFrames / 48000;
    await f.ready(value);
    assert.equal(f.state().phase, discrepancy === 4800 ? 'ready' : 'error');
    if (discrepancy === 4800) assert.equal(f.state().report!.measurement!.sampleFrames, 28795200);
    else assert.equal(f.state().report, null);
    assert.equal(f.calls.length, 1);
  });
}
