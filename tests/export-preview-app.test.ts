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
    sampleRangeDraftRef: { current: null }, exportCheckContext: () => ({ scope: 'owner' }),
    setSampleRangeDraft: (update: unknown) => { draft = typeof update === 'function' ? (update as (current: unknown) => unknown)(draft) : update; },
  }) as (...args: unknown[]) => void;
  choose({ startText: '10', endText: '20' }); assert.deepEqual(draft, { startText: '10', endText: '20', scope: 'owner', version: 1 });
  assert.match(source, /timelineJobs\.find\(e => !e\.snapshot\?\.exportRange/);
  assert.match(source, /onBeforePlay: beforeTimelineAudioPlay/);
  assert.match(source, /onBeforePlay=\{beforeExportPreviewPlay\}/);
});

type SampleDraft = {scope: string; startText: string; endText: string; version: number};
function generationFixture(initialDraft: SampleDraft | null = {scope: 'owner', startText: '30', endText: '60', version: 1}) {
  const calls: {kind: string; binding?: unknown}[] = [], draft = {current: initialDraft}, dirty = {current: false}, panel = {current: 1};
  let owner = 'owner', formatted = false, allow = true;
  const binding = {projectId, expectedRevision: 4, exportRange: {startFrame: 30, endFrame: 60}}, checked: {binding: unknown; attempted: boolean; phase: string} = {binding, attempted: false, phase: 'ready'};
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sampleContext = () => ({ scope: owner, exportRange: draft.current?.scope === owner && /^\d+$/.test(draft.current.startText) && /^\d+$/.test(draft.current.endText) ? {startFrame: Number(draft.current.startText), endFrame: Number(draft.current.endText)} : null });
  const controller = {setContext() { calls.push({kind: 'context'}); }, async check() { calls.push({kind: 'check'}); await pending; }, getState: () => checked};
  const generate = execute('  async function generateSampleExport(', '  function clipLoudnessContext(', {
    workbenchReady: true, showDelivery: true, showExports: false, exportRangeContext: () => ({enabled: allow}),
    isBusy: () => false, localDeliveryRef: {current: {state: {busy: false}}}, pendingTimelineExport: false,
    dirtyRef: dirty, timelineFormatRef: {current: {controller: {hasUnsaved: () => formatted}}},
    context: () => owner, isCurrent: (captured: string) => captured === owner, panelIntent: panel,
    sampleExportPreflight: {controller}, sampleRangeDraftRef: draft, exportCheckContext: () => ({scope: owner}),
    selectSampleExportRange() { calls.push({kind: 'select'}); draft.current = {scope: owner, startText: '0', endText: '300', version: 1}; },
    isExportPreviewRange, sampleExportContext: sampleContext,
    sampleExportContextKey: () => JSON.stringify([sampleContext(), draft.current?.version]),
    dataRef: {current: {timeline: {durationFrames: 600}}},
    renderTimeline: async (purpose: string, input: unknown, unchecked: unknown, sample: boolean) => {assert.equal(purpose, 'export'); assert.equal(unchecked, undefined); assert.equal(sample, true); calls.push({kind: 'render', binding: input});},
  }) as () => Promise<void>;
  return {generate, calls, draft, dirty, panel, checked, binding, finish,
    changeOwner() {owner = 'replacement';}, setFormatDirty() {formatted = true;}, disable() {allow = false;}};
}

test('one explicit generate action selects only a missing range, awaits checks and uses the exact current controller binding', async () => {
  for (const initial of [null, {scope: 'owner', startText: '30', endText: '60', version: 1}]) {
    const f = generationFixture(initial), pending = f.generate();
    assert.equal(f.calls.filter(call => call.kind === 'select').length, initial ? 0 : 1);
    assert.equal(f.calls.filter(call => call.kind === 'check').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'render').length, 0);
    f.finish(); await pending;
    assert.equal(f.calls.filter(call => call.kind === 'render').length, 1);
    assert.equal(f.calls.find(call => call.kind === 'render')?.binding, f.binding);
  }
});

test('an invalid user-entered sample range is retained and never silently replaced or submitted', async () => {
  for (const [startText, endText] of [['', '30'], ['0', ''], ['2', '1'], ['0', '301'], ['599', '601'], ['1.5', '30']]) {
    const original = {scope: 'owner', startText, endText, version: 2}, f = generationFixture(original);
    await f.generate();
    assert.deepEqual(f.draft.current, original); assert.deepEqual(f.calls, []);
  }
});

test('closing or leaving during checks, range edits and new unsaved drafts prevent sample submission', async () => {
  for (const change of ['close', 'close-reopen', 'project', 'range', 'dirty', 'format', 'blocked', 'consumed', 'disconnected']) {
    const f = generationFixture(), pending = f.generate();
    if (change === 'close' || change === 'close-reopen') f.panel.current++;
    if (change === 'project') f.changeOwner();
    if (change === 'range') f.draft.current = {...f.draft.current!, startText: '40', version: 2};
    if (change === 'dirty') f.dirty.current = true;
    if (change === 'format') f.setFormatDirty();
    if (change === 'blocked') {f.checked.phase = 'blocked'; f.checked.binding = null;}
    if (change === 'consumed') f.checked.attempted = true;
    // The real controller removes a binding when connection context changes.
    if (change === 'disconnected') {f.checked.phase = 'stale'; f.checked.binding = null;}
    f.finish(); await pending;
    assert.equal(f.calls.some(call => call.kind === 'render'), false, change);
  }
  const unavailable = generationFixture(); unavailable.disable(); await unavailable.generate(); assert.deepEqual(unavailable.calls, []);
});
