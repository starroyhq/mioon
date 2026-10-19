import test from 'node:test';
import assert from 'node:assert/strict';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { EXPORT_LOUDNESS_PROFILE } from '@mioon/contracts/export-loudness';
import { createExportLoudnessController, exportLoudnessTargets, exportLoudnessViewState, parseExportLoudnessTarget, exportLoudnessErrorMessage } from '../apps/web/src/export-loudness-state.ts';
import { context, fixture, report, unready, row, asset, id, projectId } from './helpers/export-loudness-ui-fixture.ts';
interface UiContext {[key: string]: unknown; exports: Array<Record<string, unknown>>; assets: Array<Record<string, unknown>>; timeline?: Record<string, unknown>; sourceAssets?: unknown; scope?: string; projectId?: string}
interface MutableReport {[key: string]: unknown; projectId?: unknown; exportId?: unknown; expectedArtifactSha256?: unknown; measurementProfile?: unknown; target?: Record<string, unknown>; artifact: Record<string, unknown> & {sha256?: unknown; assetId?: unknown; timelineRevision?: number; deliveryName?: unknown; snapshotSha256?: unknown; exportRange?: unknown; loop?: unknown}; measurement: Record<string, unknown> & {integratedLufs?: number; sampleFrames?: number; decodedDurationSeconds?: number; gatingBlockCount?: number; absoluteGatedBlockCount?: number; relativeGatedBlockCount?: number}; suggestion: {[key: string]: unknown; applyAllowed?: boolean; requiredGainDb?: number; gainMultiplier?: number; marginDb?: number; truePeakRoomDb?: number; projectedTruePeakDbtp?: number; conflictsWithCeiling?: boolean; currentTimelineValidated?: boolean; purpose?: string; requestId?: string} | null; path?: unknown}
interface UiTarget {exportId: string; artifact?: Record<string, unknown>; [key: string]: unknown}
interface UiState {phase: string; report: MutableReport | null; scope: unknown; draftVersion: unknown; draft: {integratedLufs?: string; truePeakCeilingDbtp?: string}; error: string}
interface UiFixture {
  set(patch: Record<string, unknown>, live?: boolean): void;
  edit(draft: Record<string, unknown>): void;
  ready(...args: unknown[]): Promise<void>;
  measure(...args: unknown[]): Promise<unknown>;
  cancel(...args: unknown[]): void;
  calls: Array<{input: Record<string, unknown> & {target?: {integratedLufs?: number}}; options: {signal: AbortSignal}}>;
  reads: Array<{resolve(value: unknown): void; reject(error: unknown): void}>;
  target(...args: unknown[]): UiTarget;
  state(): UiState;
  auth: boolean[];
  controller: {dispose(): void; attach(value: unknown): void; cancel(target: unknown, scope: unknown, draftVersion: unknown): void; setDraft(...args: unknown[]): boolean; measure(target: unknown, scope: unknown, draftVersion: unknown): Promise<unknown>};
}
const contextOf = context as unknown as (patch?: Record<string, unknown>) => UiContext;
const reportOf = report as unknown as (file: unknown, target?: unknown, patch?: Record<string, unknown>) => MutableReport;
const unreadyOf = unready as unknown as (file: unknown, status?: string, code?: string, target?: unknown) => Record<string, unknown>;
const rowOf = row as unknown as (value?: unknown) => Record<string, unknown>;
const assetOf = asset as unknown as (value?: unknown) => Record<string, unknown>;
const fixtureOf = fixture as unknown as (patch?: Record<string, unknown>) => UiFixture;
const targetsOf=(value: unknown, guard: unknown): readonly unknown[]=>exportLoudnessTargets(value as never, guard as never);
const viewStateOf=(state: unknown, value: unknown, guard: unknown): {report: unknown; draft: Record<string, unknown>}=>exportLoudnessViewState(state as never, value as never, guard as never) as unknown as {report: unknown; draft: Record<string, unknown>};


const blank = { integratedLufs: '', truePeakCeilingDbtp: '' }, custom = { integratedLufs: '-14', truePeakCeilingDbtp: '-1' };
test('optional target is absent by default, exact bounded explicit values only', () => {
  assert.deepEqual(parseExportLoudnessTarget(blank), { error: '' });
  assert.deepEqual(parseExportLoudnessTarget(custom), { target: { integratedLufs: -14, truePeakCeilingDbtp: -1 }, error: '' });
  for (const [integratedLufs, truePeakCeilingDbtp] of [['-60', '-20'], ['-5', '0']]) assert.equal(parseExportLoudnessTarget({ integratedLufs, truePeakCeilingDbtp }).error, '');
  for (const draft of [{ ...blank, integratedLufs: '-14' }, { ...blank, truePeakCeilingDbtp: '-1' }, ...['-61','-4','NaN','Infinity','-14dB','1e1'].map(integratedLufs => ({ ...custom, integratedLufs })), ...['-21','1','Infinity'].map(truePeakCeilingDbtp => ({ ...custom, truePeakCeilingDbtp }))]) assert.ok(parseExportLoudnessTarget(draft).error);
});
test('complete owned validated output metadata is required; download strings cannot grant measurement', () => {
  assert.equal(targetsOf(contextOf(), isTimelineRenderRecord).length, 2);
  for (const patch of [{ sha256: undefined }, { sha256: 'invalid' }, { projectId: id(99) }, { provenance: 'import' }, { url: 'https://elsewhere/film.mp4' }, { sizeBytes: 0 }]) {
    assert.equal(targetsOf(contextOf({ exports: [rowOf()], assets: [{ ...assetOf(rowOf()), ...patch }] }), isTimelineRenderRecord).length, 0);
  }
  for (const patch of [{ purpose: 'preview' }, { mode: 'storyboard' }, { status: 'running' }, { url: 'file:///private' }, { snapshot: {} }]) {
    const item = { ...rowOf(), ...patch }; assert.equal(targetsOf(contextOf({ exports: [item], assets: [assetOf(item)] }), isTimelineRenderRecord).length, 0);
  }
  assert.equal(targetsOf(contextOf(), () => false).length, 0);
});
test('mount, polling, history open, draft edits and reconnect never decode or restart', () => {
  const f = fixtureOf({ visible: false }); f.set({ visible: true }); f.edit(custom); f.set({ connected: false }); f.set({ connected: true });
  f.set({ exports: [...contextOf().exports, rowOf(12)], assets: [...contextOf().assets, assetOf(rowOf(12))] });
  f.set({ executionScope: '1:2:canvas' }); f.controller.dispose(); f.controller.attach(contextOf()); assert.equal(f.calls.length, 0);
});
test('explicit measurement captures project/export/expected hash/profile, with no implicit target or mutable authority', async () => {
  const f = fixtureOf(); await f.ready();
  assert.deepEqual(f.calls[0].input, { projectId, exportId: f.target().exportId, expectedArtifactSha256: 'a'.repeat(64), measurementProfile: EXPORT_LOUDNESS_PROFILE });
  assert.ok(Object.isFrozen(f.calls[0].input)); assert.deepEqual(Object.keys(f.calls[0].options), ['signal']); assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.state().phase, 'ready'); assert.ok(Object.isFrozen(f.state().report)); assert.ok(Object.isFrozen(f.state().report!.measurement)); assert.equal(f.state().report!.suggestion, null);
});
test('target edits clear advice immediately; custom response and suggestion bind exact captured target', async () => {
  const f = fixtureOf(); f.edit(custom); await f.ready();
  assert.deepEqual(f.calls[0].input.target, { integratedLufs: -14, truePeakCeilingDbtp: -1 });
  assert.equal(f.state().report!.suggestion!.requiredGainDb, 6); assert.equal(f.state().report!.suggestion!.conflictsWithCeiling, true); assert.equal(f.state().report!.suggestion!.applyAllowed, false);
  f.edit({ ...custom, integratedLufs: '-16' }); assert.equal(f.state().report, null); assert.equal(f.state().phase, 'idle'); assert.equal(f.calls.length, 1);
});
test('partial invalid target prevents decoding and has no fallback standard', async () => {
  const f = fixtureOf(); f.edit({ ...blank, integratedLufs: '-14' }); await f.measure(); assert.equal(f.calls.length, 0);
  f.edit(blank); await f.ready(); assert.equal(Object.hasOwn(f.calls[0].input, 'target'), false);
});
test('rapid same/different repeated clicks never queue work', async () => {
  const f = fixtureOf(), pending = f.measure(); await f.measure(); await f.measure(1); assert.equal(f.calls.length, 1);
  f.reads[0].resolve(reportOf(f.target())); await pending; assert.equal(f.state().phase, 'ready');
});
for (const patch of [{ scope: 'other:2:normal', projectId: id(99) }, { scope: `${projectId}:2:normal` }, { restored: true }, { executionScope: '1:9:canvas' }, { visible: false }, { connected: false }]) test(`live result fence before layout: ${JSON.stringify(patch)}`, async () => {
  const f = fixtureOf(), file = f.target(), pending = f.measure(); f.set(patch, false); f.reads[0].resolve(reportOf(file)); await pending;
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().report, null); assert.notEqual(f.state().phase, 'ready');
});
test('editing target while pending aborts observer and rejects late success, without retrying', async () => {
  const f = fixtureOf(); f.edit(custom); const pending = f.measure(), input = f.calls[0].input;
  f.edit({ ...custom, integratedLufs: '-18' }); assert.equal(f.calls[0].options.signal.aborted, true);
  f.reads[0].resolve(reportOf(f.target(), input.target)); await pending; assert.equal(f.state().report, null); assert.equal(f.state().draft.integratedLufs, '-18'); assert.equal(f.calls.length, 1);
  await f.ready(); assert.equal(f.state().report!.target!.integratedLufs, -18);
});
test('cancel and stale row callbacks cannot replace target or cancel a newer observer', async () => {
  const f = fixtureOf(), first = f.measure(), staleState = f.state(), old = f.target(); f.cancel();
  const second = f.measure(1); f.controller.cancel(old, staleState.scope, staleState.draftVersion);
  assert.equal(f.calls[1].options.signal.aborted, false);
  assert.equal(f.controller.setDraft(old, staleState.scope, custom, staleState.draftVersion), false);
  f.reads[1].resolve(reportOf(f.target(1))); await second;
  f.reads[0].reject(Object.assign(Error('/secret'), { code: 'UNAUTHORIZED' })); await first;
  assert.equal(f.auth.length, 0); assert.equal(f.state().report!.exportId, f.target(1).exportId);
});
test('same row old cancellation cannot cancel its newer explicit measurement', async () => {
  const f = fixtureOf(), first = f.measure(), staleState = f.state(); f.cancel(); const second = f.measure();
  f.controller.cancel(f.target(), staleState.scope, staleState.draftVersion); assert.equal(f.calls[1].options.signal.aborted, false);
  f.reads[1].resolve(reportOf(f.target())); await second; f.reads[0].resolve(reportOf(f.target())); await first; assert.equal(f.state().phase, 'ready');
});
test('A→B→A and dispose/reattach cannot revive old report or target draft', async () => {
  const f = fixtureOf(); f.edit(custom); const first = f.measure(), file = f.target();
  f.set({ scope: 'B:2', projectId: id(99) }); f.set({ scope: `${projectId}:3:normal`, projectId }); f.reads[0].resolve(reportOf(file, { integratedLufs: -14, truePeakCeilingDbtp: -1 })); await first;
  assert.equal(f.state().report, null); assert.deepEqual(f.state().draft, blank);
  const second = f.measure(); f.controller.dispose(); f.controller.attach(contextOf()); f.reads[1].resolve(reportOf(file)); await second; assert.equal(f.state().report, null);
});
test('historical observation survives unrelated timeline/source edits; exact output replacement invalidates it', async () => {
  const f = fixtureOf(); await f.ready(); const saved = f.state().report;
  f.set({ timeline: { revision: 99, clips: [] }, sourceAssets: [], exports: structuredClone(contextOf().exports), assets: structuredClone(contextOf().assets) });
  f.set({ visible: false }); f.set({ visible: true }); assert.equal(f.state().report, saved); assert.equal(f.calls.length, 1);
  const assets = contextOf().assets; assets[0].sha256 = 'b'.repeat(64); f.set({ assets }); assert.equal(f.state().report, null); assert.equal(f.state().phase, 'stale');
});
test('pre-layout replacement and owner projections never flash old numeric advice', async () => {
  const f = fixtureOf(); f.edit(custom); await f.ready(); const assets = contextOf().assets; assets[0].sha256 = 'b'.repeat(64);
  for (const patch of [{ assets }, { scope: 'new-owner' }, { connected: false }, { restored: true }]) {
    const projected = viewStateOf(f.state(), contextOf(patch), isTimelineRenderRecord); assert.equal(projected.report, null); assert.deepEqual(projected.draft, blank);
  }
  assert.equal(viewStateOf(f.state(), contextOf(), isTimelineRenderRecord), f.state());
});
const mutators: Array<[string, (v: MutableReport) => void]> = [
  ['project', v => { v.projectId = id(99); }], ['export', v => { v.exportId = id(99); }], ['expected hash', v => { v.expectedArtifactSha256 = 'b'.repeat(64); }],
  ['hash', v => { (v.artifact as Record<string, unknown>).sha256 = 'b'.repeat(64); }], ['asset', v => { (v.artifact as Record<string, unknown>).assetId = id(99); }], ['revision', v => { (v.artifact as {timelineRevision: number}).timelineRevision++; }],
  ['name', v => { (v.artifact as Record<string, unknown>).deliveryName = 'forged'; }], ['snapshot digest', v => { (v.artifact as Record<string, unknown>).snapshotSha256 = 'bad'; }], ['profile', v => { v.measurementProfile = 'other'; }],
  ['target', v => { v.target = { integratedLufs: -18, truePeakCeilingDbtp: -2 }; }], ['nonfinite', v => { (v.measurement as {integratedLufs: number}).integratedLufs = NaN; }],
  ['gain authority', v => { (v.suggestion as {applyAllowed: boolean}).applyAllowed = true; }], ['advisory arithmetic', v => { (v.suggestion as {requiredGainDb: number}).requiredGainDb = 99; }],
  ['extra path', v => { v.path = '/private'; }], ['duration', v => { (v.measurement as Record<string, number>).sampleFrames = 48000; (v.measurement as Record<string, number>).decodedDurationSeconds = 1; (v.measurement as Record<string, number>).gatingBlockCount = 7; (v.measurement as Record<string, number>).absoluteGatedBlockCount = 7; (v.measurement as Record<string, number>).relativeGatedBlockCount = 7; }],
];
for (const [name, mutate] of mutators) test(`misbound or invalid ${name} fails closed`, async () => {
  const f = fixtureOf(); f.edit(custom); const value = reportOf(f.target(), { integratedLufs: -14, truePeakCeilingDbtp: -1 }); mutate(value); await f.ready(value);
  assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null); assert.match(f.state().error, /不完整或与此导出文件、目标不匹配/);
});
for (const [status, code] of [['unsupported','NO_AUDIO'], ['unsupported','UNSUPPORTED_FORMAT'], ['incomplete','TIMEOUT'], ['incomplete','BUSY'], ['stale','ARTIFACT_CHANGED']]) test(`${code} discards prior numbers and never automatically retries`, async () => {
  const f = fixtureOf(); await f.ready(); const waiting = f.measure(); assert.equal(f.state().report, null); f.reads[f.reads.length-1].resolve(unreadyOf(f.target(), status, code)); await waiting;
  assert.equal(f.state().phase, status); assert.equal(f.state().report!.measurement, null); assert.equal(f.calls.length, 2);
});
test('current unauthorized is surfaced once and server/private messages are not shown', async () => {
  const f = fixtureOf(), pending = f.measure(); f.reads[0].reject(Object.assign(Error('/secret/path'), { code: 'UNAUTHORIZED' })); await pending;
  assert.deepEqual(f.auth, [false]); assert.match(f.state().error, /会话已过期/); assert.doesNotMatch(f.state().error, /secret|path/);
  assert.doesNotMatch(exportLoudnessErrorMessage({ message: '/private/token' }), /private|token/);
});
test('restored, hidden, disconnected, stale scope and arbitrary caller artifact cannot authorize measurement', async () => {
  for (const patch of [{ restored: true }, { visible: false }, { connected: false }]) { const f = fixtureOf(patch); await f.measure(); assert.equal(f.calls.length, 0); }
  const f = fixtureOf(), target = f.target(), old = f.state(); f.set({ scope: `${projectId}:2:normal` }); await f.controller.measure(target, old.scope, old.draftVersion); assert.equal(f.calls.length, 0);
  const forged = { ...f.target(), artifact: { ...f.target().artifact, sha256: 'b'.repeat(64) }, outputFrames: 30 };
  const pending = f.controller.measure(forged, f.state().scope, f.state().draftVersion); assert.equal(f.calls[0].input.expectedArtifactSha256, 'a'.repeat(64));
  f.reads[0].resolve(reportOf(forged)); await pending; assert.equal(f.state().phase, 'error');
});
test('complete captured frozen range is authoritative while current timeline is irrelevant', async () => {
  const f = fixtureOf(); await f.ready(undefined, 1); assert.deepEqual(f.state().report!.artifact.exportRange, { startFrame: 15, endFrame: 45 });
  assert.equal(f.state().report!.measurement.sampleFrames, 48000); assert.equal(f.state().report!.artifact.deliveryName, '冻结的成片 <v1>');
});
for (const changed of ['hash','frozen snapshot','frozen range']) test(`live ${changed} replacement before layout aborts pending result`, async () => {
  const f = fixtureOf(), file = f.target(1), pending = f.measure(1), live = contextOf();
  if (changed === 'hash') live.assets[1].sha256 = 'b'.repeat(64);
  else if (changed === 'frozen range') (live.exports[1] as {snapshot: {exportRange: unknown}}).snapshot.exportRange = { startFrame: 0, endFrame: 30 };
  else (live.exports[1] as {snapshot: {timeline: {clips: Array<{name: string}>}}}).snapshot.timeline.clips[0].name = 'A changed frozen snapshot';
  f.set(live, false); f.reads[0].resolve(reportOf(file)); await pending;
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.state().report, null); assert.equal(f.calls.length, 1);
});
test('same-duration shifted range response cannot stand in for the captured export range', async () => {
  const f = fixtureOf(), value = reportOf(f.target(1)); value.artifact.exportRange = { startFrame: 0, endFrame: 30 };
  await f.ready(value, 1); assert.equal(f.state().phase, 'error'); assert.equal(f.state().report, null);
});
test('a newly selected row never inherits another file’s custom target', async () => {
  const f = fixtureOf(); f.edit(custom); await f.ready(); await f.ready(undefined, 1);
  assert.equal(Object.hasOwn(f.calls[1].input, 'target'), false); assert.deepEqual(f.state().draft, blank); assert.equal(f.state().report!.suggestion, null);
});
