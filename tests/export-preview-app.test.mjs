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
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).trim();
const execute = (start, end, env) => Function(...Object.keys(env), `return (${extract(start, end)});`)(...Object.values(env));
function fixture({ rejected = false, pending = false, gated = false } = {}) {
  const finalRange = Object.freeze({ startFrame: 0, endFrame: 60 }), sampleRange = { startFrame: 0, endFrame: 30 };
  const record = row(10, { exportRange: sampleRange }), calls = [], history = [];
  let attempt = null, liveKey = 'sample-one', resolve;
  const waiting = new Promise(done => { resolve = done; });
  const finalContext = { scope: 'owner', projectId, revision: 4, rangeVersion: 9, exportRange: finalRange };
  const binding = { projectId, expectedRevision: 4, exportRange: sampleRange };
  const env = { msg, isTimelineRenderRecord, isExportPreviewRange,
    dataRef: { current: { timeline: record.snapshot.timeline } }, dirtyRef: { current: false }, timelineFormatRef: { current: null },
    sampleExportContext: () => ({ ...finalContext, exportRange: sampleRange }), exportCheckContext: () => finalContext,
    sampleExportContextKey: () => liveKey,
    sampleExportPreflight: { controller: { setContext() {}, takeExportBinding(value) { assert.equal(value, binding); return structuredClone(binding); } } },
    exportPreflight: { controller: { setContext() { assert.fail('sample must not mutate final preflight'); } } },
    isBusy: () => false, pendingForProject: () => pending ? [{ key: 'timeline:render:export' }] : [],
    currentProject: { current: projectId }, workspaceRef: { current: { restored: false } }, panelIntent: { current: 1 },
    localDeliveryRef: { current: { controller: { canPrepare: () => true, async submit(input, options) {
      calls.push(structuredClone(input)); if (gated) await waiting;
      if (!options.canExecute() || rejected) return null;
      return { ...record, requestId: input.requestId };
    } } } },
    deliveryNameRef: { current: { controller: { capture: () => null } } }, requestId: () => 'exact-sample-request', context: () => ({}), isCurrent: () => true,
    setExportPreviewAttempt(value) { attempt = typeof value === 'function' ? value(attempt) : value; },
    setDeliveryAttempt() {}, setShowExports() {}, notify() {}, openTasks() {}, openExportHistory() { history.push(true); }, run() { assert.fail('normal workspace must use durable local delivery'); },
  };
  const render = execute('  async function renderTimeline(', '  async function previewSource(', env);
  return { render, binding, finalContext, calls, history, attempt: () => attempt, change: () => { liveKey = 'sample-two'; }, resolve };
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
  let draft = null;
  const choose = execute('  function chooseSampleExportRange(', '  function selectSampleExportRange(', {
    exportRangeContext: () => ({ enabled: true }), localDelivery: { state: { busy: false } }, pendingTimelineExport: false,
    exportCheckContext: () => ({ scope: 'owner' }), setSampleRangeDraft: update => { draft = update(draft); },
  });
  choose({ startText: '10', endText: '20' }); assert.deepEqual(draft, { startText: '10', endText: '20', scope: 'owner', version: 1 });
  assert.match(source, /timelineJobs\.find\(e => !e\.snapshot\?\.exportRange/);
  assert.match(source, /onBeforePlay: beforeTimelineAudioPlay/);
  assert.match(source, /onBeforePlay=\{beforeExportPreviewPlay\}/);
});
