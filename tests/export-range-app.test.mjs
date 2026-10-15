import { message as msg } from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {schemas, isTimelineMutationResponse, hasRequestNotAppliedProof, resolveTimelineExportDelivery} from '@mioon/contracts';
import {timelineExportRangeFields} from '@mioon/contracts/timeline-export-range';
import {timelineDeliveryNameFields} from '@mioon/contracts/timeline-delivery';
import {createExportRangeController} from '../apps/web/src/export-range-state.ts';
import {createExportSettingsController} from '../apps/web/src/export-settings-state.js';
import {createTimelineDeliveryNameController} from '../apps/web/src/export-delivery-state.ts';
import {createExportPreflightController} from '../apps/web/src/export-preflight-state.js';
import {createLocalDeliveryController} from '../apps/web/src/local-delivery-state.ts';
import {pinNewWorkspaceIntent} from '../apps/web/src/workspace-origin.js';

const source = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const id = n => `89400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), scope = `${projectId}:1`, stamp = '2026-10-13T00:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const until = async check => { for (let index = 0; index < 80 && !check(); index++) await Promise.resolve(); assert.ok(check(), 'Expected asynchronous App fixture boundary'); };
function slice(begin, end) {
  const first = source.indexOf(begin), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'Actual App extraction boundaries remain present');
  assert.equal(source.indexOf(begin, first + begin.length), -1, 'Extracted App owner is unique');
  return source.slice(first, last);
}
function actual(begin, end, environment) {
  return Function(...Object.keys(environment), `return (${slice(begin, end).trim()});`)(...Object.values(environment));
}
function timeline() {
  return {id: timelineId, projectId, revision: 4, fps: 30, width: 720, height: 1280, durationFrames: 60,
    tracks: [{id: id(3), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false}],
    clips: [{id: id(4), trackId: id(3), assetId: id(5), name: 'Still', startFrame: 0, durationFrames: 60,
      sourceInFrame: 0, gain: 1, rect: {x: 0, y: 0, width: 720, height: 1280}}], createdAt: stamp, updatedAt: stamp};
}
function receipt(input, saved) {
  const result = {id: id(6), projectId, requestId: input.requestId, mode: 'timeline', purpose: input.purpose,
    timelineRevision: input.expectedRevision, snapshot: {timeline: clone(saved), ...timelineDeliveryNameFields(input),
      ...timelineExportRangeFields(input), ...(input.exportSettings === undefined ? {} : {delivery: resolveTimelineExportDelivery(saved, input.exportSettings)}),
      assets: [{id: id(5), sha256: 'a'.repeat(64), mimeType: 'image/png', duration: 0, width: 16, height: 16, hasAudio: false}]},
    status: 'queued', assetId: null, url: null, error: null, createdAt: stamp, updatedAt: stamp};
  assert.equal(isTimelineMutationResponse('timeline.render', input, result), true, 'Synthetic transport ACK passes the actual shared input-bound guard');
  return result;
}
function preflight(input, saved) {
  return {projectId, timelineId: saved.id, timelineRevision: saved.revision, expectedRevision: input.expectedRevision,
    snapshotHash: 'b'.repeat(64), checkedAt: stamp, status: 'ready', summary: {fps: 30, width: saved.width, height: saved.height,
      durationFrames: saved.durationFrames, trackCount: 1, clipCount: 1, assetCount: 1, visualClipCount: 1,
      audibleClipCount: 0, mutedTrackCount: 0, hiddenVideoTrackCount: 0, ...timelineDeliveryNameFields(input), ...timelineExportRangeFields(input),
      ...(input.exportSettings === undefined ? {} : {delivery: resolveTimelineExportDelivery(saved, input.exportSettings)})},
    checks: {totalAssets: 1, checkedAssets: 1, bytesHashed: 123, fullDecode: false}, issues: []};
}

// Only the React hook shell is replaced. Every App context/options/callback is
// extracted verbatim, and each adapter uses its real production controller.
async function harness(t, {restored = false, gates = {}, projectReady = true} = {}) {
  const transportCalls = [], reads = [], direct = [], history = [], notices = [], refreshes = [], panels = [];
  const saved = timeline(), dataRef = {current: {project: {id: projectId}, timeline: saved}};
  let visible = true, requestCount = 0, sequence = 100;
  let stored = {supported: true, workspaceScope: 'c'.repeat(64), instanceId: id(7), projectId,
    draftRevision: 0, draft: null, intentRevision: 0, intent: null, draftTargetStatus: 'unset', intentTargetStatus: 'unset'};
  const record = (method, input) => transportCalls.push({method, input: clone(input)});
  const settle = async method => {
    if (gates.execute) await gates.execute.promise;
    const response = receipt(stored.intent.input, saved);
    stored = {...stored, intentRevision: stored.intentRevision + 1,
      intent: {...stored.intent, outcome: {status: 'accepted', exportId: response.id, responseSha256: sha(response), resolvedAt: stamp}},
      draftRevision: stored.draftRevision + 1, draft: null, draftTargetStatus: 'unset'};
    return {envelope: clone(stored), response};
  };
  const client = {
    async get(value) { record('get', value); return clone(stored); },
    async put(input) {
      record('put', input); if (gates.put) await gates.put.promise;
      stored = {...stored, draftRevision: stored.draftRevision + 1,
        draft: {draftId: input.draftId, timelineId: input.timelineId, baseRevision: input.baseRevision,
          raw: clone(input.raw), updatedAt: stamp}, draftTargetStatus: 'matching'};
      return clone(stored);
    },
    async prepare(input) {
      record('prepare', input); stored = {...stored, intentRevision: stored.intentRevision + 1,
        intent: {intentId: input.intentId, timelineId: input.timelineId, baseRevision: input.baseRevision,
          draft: clone(input.draft), input: clone(input.input), createdAt: stamp, outcome: {status: 'pending'}}, intentTargetStatus: 'matching'};
      if (gates.prepare) await gates.prepare.promise; return clone(stored);
    },
    async execute(input) { record('execute', input); return settle('execute'); },
    async recover(input) { record('recover', input); return settle('recover'); },
    async discard() { assert.fail('Range changes cannot discard the title through transport'); },
  };
  const environment = {msg, schemas, isTimelineMutationResponse, hasRequestNotAppliedProof, pinNewWorkspaceIntent,
    dataRef, currentProject: {current: projectId}, projectEpoch: {current: 1}, navigationEpoch: {current: 0}, panelIntent: {current: 0},
    workspaceRef: {current: restored ? {restored: true, workspaceOrigin: id(8)} : {restored: false}},
    exportSettingsRef: {current: null}, exportRangeRef: {current: null},
    deliveryNameRef: {current: null}, localDeliveryRef: {current: null}, online: true, auth: true, loading: false,
    // Existing export cases start inside an already opened workbench. Exercise
    // the opposite App readiness boundary separately without faking its reads.
    projectSessionReady: () => projectReady, workbenchReady: projectReady,
    rightDockTab: 'delivery', showExports: false, panelVisible: () => visible,
    isBusy: () => false, pendingForProject: () => [], setAuth() { assert.fail('Fixture cannot cause authentication loss'); },
    async refresh(value) { refreshes.push(value); if (gates.refresh) await gates.refresh.promise; },
    async rpc(operation, input, options) {
      reads.push({operation, input: clone(input), options});
      if (operation === 'timeline.export.capabilities') return {projectId, timelineId, timelineRevision: 4, expectedRevision: 4,
        exportSettings: clone(input.exportSettings), delivery: resolveTimelineExportDelivery(saved, input.exportSettings),
        checkedAt: stamp, status: 'available', issues: []};
      assert.equal(operation, 'timeline.export.preflight');
      if (gates.preflight) await gates.preflight.promise;
      return preflight(input, saved);
    },
    useExportSettings(options) { const controller = createExportSettingsController(options); controller.setContext(options); return {controller}; },
    useExportRange(options) {
      const controller = createExportRangeController(options); controller.setContext(options);
      return {controller, get error() { return controller.getState().error; }, get value() { return controller.getState().value; }};
    },
    useTimelineDeliveryName(options) { const controller = createTimelineDeliveryNameController(options); controller.setContext(options); return {controller}; },
    useLocalDelivery(options) { const controller = createLocalDeliveryController({...options, client, delay: 60000, createId: () => id(sequence++)}); return {controller}; },
    useExportPreflight(options) { const controller = createExportPreflightController(options); controller.setContext(options); controller.setVisible(options.visible); return {controller}; },
  };
  const block = slice('  function exportSettingsContext()', '  const canOpenExport =');
  const core = Function(...Object.keys(environment), `${block};return {exportSettings,exportRange,deliveryName,localDelivery,exportPreflight,exportRangeContext,exportCheckContext,localDeliveryContext};`)(...Object.values(environment));
  Object.assign(environment, core, {
    context: () => ({projectId: environment.currentProject.current, epoch: environment.projectEpoch.current}),
    isCurrent: value => value.projectId === environment.currentProject.current && value.epoch === environment.projectEpoch.current,
    requestId: () => `range-app-request-${++requestCount}`,
    openExportHistory: () => history.push(true), notify: (...args) => notices.push(args), openTasks: () => panels.push('tasks'),
    setShowExports: value => panels.push(['history', value]), setRightDockTab: value => panels.push(['tab', value]),
    setPanelOpen: (...args) => panels.push(args), updateView() {}, setPreviewKind() {},
    async run(...args) { direct.push(clone(args)); if (gates.direct) await gates.direct.promise; return receipt(args[2], saved); },
  });
  t.after(() => { core.localDelivery.controller.dispose(); core.exportPreflight.controller.dispose(); });
  await core.localDelivery.controller.load();
  const render = actual('  async function renderTimeline(', '  async function previewSource(', environment);
  const check = actual('  function checkTimelineExport(', '  const exportLoudness =', environment);
  const open = actual('  function openTimelineExport(', '  const historyState', environment);
  const choose = (startFrame = 7, endFrame = 19) => {
    const controller = core.exportRange.controller;
    assert.equal(controller.chooseRange({mode: 'selected', startText: String(startFrame), endText: String(endFrame)}, scope, controller.getVersion(scope)), true);
  };
  const sync = () => { core.exportPreflight.controller.setContext(core.exportCheckContext()); core.localDelivery.controller.setContext(core.localDeliveryContext()); };
  return {...core, environment, render, check, open, choose, sync, saved, transportCalls, reads, direct, history, notices, refreshes, panels,
    requestCount: () => requestCount, stored: () => clone(stored),
    setVisible(value) { visible = value; environment.panelIntent.current++; core.exportPreflight.controller.setVisible(value); sync(); },
    setTimelineView(revision, durationFrames) {
      dataRef.current = {...dataRef.current, timeline: {...saved, revision, durationFrames,
        clips: saved.clips.map(clip => ({...clip, durationFrames}))}};
      if (stored.intent) stored.intentTargetStatus = 'changed';
      if (stored.draft) stored.draftTargetStatus = 'changed';
      core.exportRange.controller.setContext(core.exportRangeContext()); sync();
    },
    attemptRange(startFrame = 10, endFrame = 22) {
      const controller = core.exportRange.controller;
      return controller.chooseRange({mode: 'selected', startText: String(startFrame), endText: String(endFrame)}, scope, controller.getVersion(scope));
    },
    chooseName(value) { const controller = core.deliveryName.controller; assert.equal(controller.choose(value, scope, controller.getVersion(scope)), true); sync(); },
    async ready() { await check(core.exportCheckContext()); const binding = core.exportPreflight.controller.getState().binding; assert.ok(binding); return binding; },
  };
}

test('actual App hook/context wiring carries one exact selected range through preflight, prepared intent and ACK', async t => {
  const h = await harness(t); h.choose(); h.chooseName('Range test');
  const savedBytes = JSON.stringify(h.saved), binding = await h.ready();
  assert.deepEqual(binding.exportRange, {startFrame: 7, endFrame: 19});
  assert.equal(Object.hasOwn(h.reads[0].input, 'exportRange'), false, 'Capability remains range-free');
  assert.deepEqual(h.reads[1].input.exportRange, binding.exportRange);
  await h.render('export', binding); await h.render('export', binding);
  assert.equal(h.requestCount(), 1); assert.deepEqual(h.transportCalls.map(row => row.method), ['get', 'put', 'prepare', 'execute']);
  const exact = {...binding, requestId: 'range-app-request-1', purpose: 'export'};
  assert.deepEqual(h.transportCalls.find(row => row.method === 'prepare').input.input, exact);
  assert.deepEqual(h.localDelivery.controller.getState().intent.input, exact);
  assert.equal(h.localDelivery.controller.getState().intent.outcome.status, 'accepted');
  assert.deepEqual(h.history, [true]); assert.deepEqual(h.refreshes, [projectId]); assert.deepEqual(h.direct, []);
  assert.equal(JSON.stringify(h.saved), savedBytes);
});

test('actual export contexts remain inactive until project opening has been accepted', async t => {
  const h = await harness(t, {projectReady: false});
  assert.equal(h.exportRangeContext().projectId, null); assert.equal(h.exportRangeContext().enabled, false);
  assert.equal(h.localDeliveryContext().projectId, null); assert.equal(h.localDeliveryContext().connected, false); assert.equal(h.localDeliveryContext().visible, false);
  assert.equal(h.exportCheckContext().projectId, null); assert.equal(h.exportCheckContext().connected, false);
  assert.equal(h.attemptRange(), false); await h.check(h.exportCheckContext()); await h.render('export');
  assert.deepEqual(h.reads, []); assert.deepEqual(h.transportCalls, []); assert.deepEqual(h.direct, []); assert.equal(h.requestCount(), 0);
});

test('actual App uses range version for Check and both live contexts, including A to B to A', async t => {
  const h = await harness(t); h.choose(); const viewed = h.exportCheckContext(), local = h.localDeliveryContext();
  h.choose(8, 20); h.choose();
  assert.deepEqual(h.exportCheckContext().exportRange, viewed.exportRange);
  assert.notEqual(h.exportCheckContext().rangeVersion, viewed.rangeVersion);
  assert.notEqual(h.localDeliveryContext().executionEpoch, local.executionEpoch);
  assert.equal(await h.check(viewed), null); assert.deepEqual(h.reads, []);
  const pending = await h.ready(); assert.ok(pending.exportRange);
  h.choose(9, 21); await h.render('export', pending);
  assert.equal(h.requestCount(), 0); assert.deepEqual(h.transportCalls.map(row => row.method), ['get']);
});

test('changing range during an awaited title save cannot prepare or execute the prior range', async t => {
  const put = deferred(), h = await harness(t, {gates: {put}}); h.choose(); h.chooseName('Saving title');
  const binding = await h.ready(), result = h.render('export', binding);
  await until(() => h.transportCalls.some(row => row.method === 'put')); h.choose(10, 22);
  put.resolve(); await result;
  assert.deepEqual(h.transportCalls.map(row => row.method), ['get', 'put']); assert.deepEqual(h.direct, []); assert.deepEqual(h.history, []);
  assert.deepEqual(h.exportRange.controller.getRange(scope), {startFrame: 10, endFrame: 22});
});

for (const change of ['saved bounds changed', 'saved bounds A to B to A']) test(`range version change during actual prepared-intent await blocks dispatch: ${change}`, async t => {
  const prepare = deferred(), h = await harness(t, {gates: {prepare}}); h.choose();
  const binding = await h.ready(), result = h.render('export', binding);
  await until(() => h.transportCalls.some(row => row.method === 'prepare'));
  const exact = clone(h.transportCalls.find(row => row.method === 'prepare').input.input);
  assert.equal(h.attemptRange(), false, 'Busy prepared intent disables editing through real range controller');
  h.setTimelineView(5, 90); if (change === 'saved bounds A to B to A') h.setTimelineView(6, 60);
  prepare.resolve(); await result;
  assert.deepEqual(h.transportCalls.map(row => row.method), ['get', 'prepare']);
  assert.deepEqual(h.localDelivery.controller.getState().intent.input, exact);
  assert.equal(h.localDelivery.controller.getState().intent.outcome.status, 'pending'); assert.equal(h.localDelivery.controller.canPrepare(), false);
  assert.deepEqual(h.direct, []); assert.deepEqual(h.history, []);
  await h.render('export', binding); assert.equal(h.requestCount(), 1);
  const recovered = await h.localDelivery.controller.recover(); assert.ok(recovered);
  assert.deepEqual(recovered.snapshot.exportRange, {startFrame: 7, endFrame: 19});
  assert.deepEqual(h.localDelivery.controller.getState().intent.input, exact);
  assert.equal(h.transportCalls.filter(row => row.method === 'prepare').length, 1);
  assert.deepEqual(h.transportCalls.map(row => row.method), ['get', 'prepare', 'recover']);
});

for (const moment of ['execute', 'refresh']) test(`late actual ACK preserves saved range context and cannot navigate after ${moment} wait`, async t => {
  const execute = deferred(), refresh = deferred(), h = await harness(t, {gates: {execute, refresh}}); h.choose();
  const binding = await h.ready(), result = h.render('export', binding);
  await until(() => h.transportCalls.some(row => row.method === 'execute'));
  const exact = clone(h.transportCalls.find(row => row.method === 'prepare').input.input);
  assert.equal(h.attemptRange(), false, 'Executing intent disables direct range edits');
  if (moment === 'execute') h.setTimelineView(5, 90);
  execute.resolve(); await until(() => h.refreshes.length === 1);
  if (moment === 'refresh') { assert.equal(h.attemptRange(), false); h.setTimelineView(5, 90); }
  refresh.resolve(); await result;
  assert.deepEqual(h.localDelivery.controller.getState().intent.input, exact);
  assert.equal(h.localDelivery.controller.getState().intent.outcome.status, 'accepted');
  assert.deepEqual(h.exportRange.controller.getRange(scope), {startFrame: 7, endFrame: 19});
  assert.equal(h.exportRange.controller.getState().revision, 5);
  assert.deepEqual(h.history, []); assert.equal(h.requestCount(), 1);
  assert.equal(h.attemptRange(), true, 'Editing can resume only after the accepted operation settles');
});

test('restored actual route preserves frozen range and separately pinned origin without opening local delivery storage', async t => {
  const h = await harness(t, {restored: true}); h.choose(); const binding = await h.ready();
  assert.equal(h.localDelivery.controller.getState().phase, 'unsupported'); assert.deepEqual(h.transportCalls, []);
  for (const read of h.reads) assert.equal(read.options.expectedWorkspaceOrigin, id(8));
  await h.render('export', binding);
  assert.deepEqual(h.direct, [['timeline:render:export', 'timeline.render', {...binding, requestId: 'range-app-request-1', purpose: 'export'}]]);
  assert.equal(Object.hasOwn(h.direct[0][2], 'expectedWorkspaceOrigin'), false);
  assert.deepEqual(h.transportCalls, []); assert.deepEqual(h.history, [true]);
});

for (const restored of [false, true]) test(`hidden actual delivery pane cannot submit its retained range closure: restored=${restored}`, async t => {
  const h = await harness(t, {restored}); h.choose(); const binding = await h.ready();
  const beforeReads = h.reads.length, beforeCalls = h.transportCalls.length;
  h.setVisible(false); await h.render('export', binding);
  assert.equal(h.reads.length, beforeReads); assert.equal(h.transportCalls.length, beforeCalls); assert.deepEqual(h.direct, []);
  assert.equal(h.requestCount(), 0);
  h.setVisible(true); assert.deepEqual(h.exportRange.controller.getRange(scope), {startFrame: 7, endFrame: 19});
  assert.equal(h.requestCount(), 0, 'Showing the pane does not submit');
});

test('actual open and range toggles are passive; whole export and preview retain omitted range', async t => {
  const h = await harness(t); h.open(); h.choose();
  const controller = h.exportRange.controller;
  assert.equal(controller.chooseRange({mode: 'whole', startText: '7', endText: '19'}, scope, controller.getVersion(scope)), true);
  h.sync(); assert.deepEqual(h.reads, []); assert.deepEqual(h.transportCalls.map(row => row.method), ['get']);
  const binding = await h.ready(); assert.equal(Object.hasOwn(binding, 'exportRange'), false);
  await h.render('export', binding); assert.equal(Object.hasOwn(h.stored().intent.input, 'exportRange'), false);
  h.choose(); await h.render('preview');
  assert.equal(h.direct.length, 1); assert.equal(h.direct[0][0], 'timeline:render:preview');
  assert.equal(Object.hasOwn(h.direct[0][2], 'exportRange'), false);
  assert.equal(Object.hasOwn(h.direct[0][2], 'exportSettings'), false);
});
