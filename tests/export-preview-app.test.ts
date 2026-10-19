import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTimelineRenderRecord } from '@mioon/contracts';
import { message as msg } from '../packages/i18n/src/index.ts';
import { isExportPreviewRange } from '../apps/web/src/export-preview-state.ts';
import { row, projectId, id } from './helpers/export-sample-peak-ui-fixture.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const extract = (start: string, end: string): string => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).trim();
const execute = (start: string, end: string, env: Record<string, unknown>): ((...args: unknown[]) => unknown) => Function(...Object.keys(env), `return (${extract(start, end)});`)(...Object.values(env)) as (...args: unknown[]) => unknown;
type Render = (kind: string, binding: unknown, extra: unknown, sample: boolean) => Promise<unknown>;
type Attempt = {exportId?: string; input: {requestId?: string}; submitting?: boolean; receipt?: unknown};
function fixture({ rejected = false, pending = false, gated = false }: {rejected?: boolean; pending?: boolean; gated?: boolean} = {}) {
  const finalRange = Object.freeze({ startFrame: 0, endFrame: 60 }), sampleRange = { startFrame: 0, endFrame: 30 };
  const record = row(10, { exportRange: sampleRange }), calls: {exportRange?: unknown; purpose?: string; requestId?: string}[] = [], history: boolean[] = [];
  let attempt: Attempt | null = null, liveKey = 'sample-one'; let resolve!: () => void;
  const waiting = new Promise<void>(done => { resolve = done; });
  const finalContext = { scope: 'owner', projectId, revision: 4, rangeVersion: 9, exportRange: finalRange };
  const binding = { projectId, expectedRevision: 4, exportRange: sampleRange };
  const env = { msg, isTimelineRenderRecord, isExportPreviewRange,
    dataRef: { current: { timeline: (record as {snapshot: {timeline: unknown}}).snapshot.timeline } }, dirtyRef: { current: false }, timelineFormatRef: { current: null },
    sampleExportContext: () => ({ ...finalContext, exportRange: sampleRange }), exportCheckContext: () => finalContext,
    sampleExportContextKey: () => liveKey,
    sampleExportPreflight: { controller: { setContext() {}, takeExportBinding(value: unknown) { assert.equal(value, binding); return structuredClone(binding); } } },
    exportPreflight: { controller: { setContext() { assert.fail('sample must not mutate final preflight'); } } },
    isBusy: () => false, pendingForProject: () => pending ? [{ key: 'timeline:render:export' }] : [],
    currentProject: { current: projectId }, workspaceRef: { current: { restored: false } }, panelIntent: { current: 1 },
    localDeliveryRef: { current: { controller: { canPrepare: () => true, async submit(input: {requestId: string}, options: {canExecute: () => boolean}) {
      calls.push(structuredClone(input)); if (gated) await waiting;
      if (!options.canExecute() || rejected) return null;
      return { ...record, requestId: input.requestId };
    } } } },
    deliveryNameRef: { current: { controller: { capture: () => null } } }, requestId: () => 'exact-sample-request', context: () => ({}), isCurrent: () => true,
    setExportPreviewAttempt(value: unknown) { attempt = typeof value === 'function' ? (value as (current: Attempt | null) => Attempt)(attempt) : value as Attempt; },
    setDeliveryAttempt() {}, setShowExports() {}, notify() {}, openTasks() {}, openExportHistory() { history.push(true); }, run() { assert.fail('normal workspace must use durable local delivery'); },
  };
  const render = execute('  async function renderTimeline(', '  async function previewSource(', env) as Render;
  return { render, binding, finalContext, calls, history, attempt: () => attempt!, change: () => { liveKey = 'sample-two'; }, resolve };
}
test('actual sample submission freezes exact short input through durable path without touching final range or opening history', async () => {
  const f = fixture(), before = structuredClone(f.finalContext);
  await f.render('export', f.binding, undefined, true);
  assert.deepEqual(f.finalContext, before); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].exportRange, { startFrame: 0, endFrame: 30 }); assert.equal(f.calls[0].purpose, 'export');
  assert.equal(f.attempt().exportId, id(10)); assert.equal(f.attempt().input.requestId, f.calls[0].requestId); assert.equal(f.history.length, 0);
});
test('failure and pending recovery never alter final range or silently submit a second request', async () => {
  for (const options of [{ rejected: true }, { pending: true }]) {
    const f = fixture(options), before = structuredClone(f.finalContext);
    await f.render('export', f.binding, undefined, true);
    assert.deepEqual(f.finalContext, before); assert.equal(f.history.length, 0);
    assert.equal(f.calls.length, options.pending ? 0 : 1);
    if (options.rejected) { assert.equal(f.attempt().submitting, false); assert.equal(f.attempt().receipt, null); }
  }
});
test('sample settings/range changes while durable prepare waits prevent execution', async () => {
  const f = fixture({ gated: true }), waiting = f.render('export', f.binding, undefined, true);
  f.change(); f.resolve(); await waiting;
  assert.equal(f.attempt().receipt, null); assert.deepEqual(f.finalContext.exportRange, { startFrame: 0, endFrame: 60 });
});
test('actual trial-range setter owns only trial state; timeline preview excludes selected-range exports', () => {
  let draft: unknown = null;
  const choose = execute('  function chooseSampleExportRange(', '  function selectSampleExportRange(', {
    exportRangeContext: () => ({ enabled: true }), localDelivery: { state: { busy: false } }, pendingTimelineExport: false,
    exportCheckContext: () => ({ scope: 'owner' }), setSampleRangeDraft: (update: unknown) => { draft = (update as (current: unknown) => unknown)(draft); },
  }) as (...args: unknown[]) => void;
  choose({ startText: '10', endText: '20' }); assert.deepEqual(draft, { startText: '10', endText: '20', scope: 'owner', version: 1 });
  assert.match(source, /timelineJobs\.find\(e => !e\.snapshot\?\.exportRange/);
  assert.match(source, /onBeforePlay: beforeTimelineAudioPlay/);
  assert.match(source, /onBeforePlay=\{beforeExportPreviewPlay\}/);
});
