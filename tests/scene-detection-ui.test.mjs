import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { canonicalSceneInput } from '@mioon/contracts';
import { ApiError } from '../apps/web/src/api.ts';
import * as cuts from '../apps/web/src/scene-cuts.ts';
import * as scene from '../apps/web/src/scene-detection.ts';
import { clearSceneThumbnails, createSceneThumbnailer } from '../apps/web/src/scene-thumbnails.ts';
import { sceneOverviewItems, sceneTaskCenterRows, sceneTaskStatus } from '../apps/web/src/scene-task-views.ts';
import { i18nTestModule, renderMessage, translate } from './helpers/i18n.ts';

const project = '00000000-0000-4000-8000-0000000000a1', otherProject = '00000000-0000-4000-8000-0000000000a2';
const assetId = '00000000-0000-4000-8000-0000000000a3', taskId = '00000000-0000-4000-8000-0000000000a4', resultId = '00000000-0000-4000-8000-0000000000a5';
const savedId = '00000000-0000-4000-8000-0000000000a6', hash = 'c'.repeat(64), at = '2026-10-25T08:00:00.000Z';
const asset = { id: assetId, projectId: project, name: '参考片-雨夜.mp4', sha256: hash, mimeType: 'video/mp4', duration: 27.4, sizeBytes: 4_000_000 };
const options = { mode: 'adaptive', sensitivity: 60, minShotSeconds: 0.6 };
const task = (patch = {}) => ({ id: taskId, projectId: project, kind: 'detect', requestId: 'request-0001', sourceAssetId: assetId, sourceHash: hash, options, profileId: 'scene-cuts-v1', fps: 30,
  state: 'queued', revision: 1, started: false, result: null, progress: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const running = (frames, patch = {}) => task({ state: 'running', revision: 2, started: true, progress: { frames, frameCount: 822, cuts: 3 }, ...patch });
const succeeded = (patch = {}) => task({ state: 'succeeded', revision: 3, started: true, result: { id: resultId, frameCount: 822, cutCount: 6 }, ...patch });
const detected = { id: resultId, projectId: project, assetId, sourceHash: hash, origin: 'detected', taskId, basedOnResultId: null, requestId: null, profileId: 'scene-cuts-v1', fps: 30, frameCount: 822,
  createdAt: at, options, cuts: [108, 234, 336, 516, 600, 690].map(frame => ({ frame, score: 0.5 })) };
const resultResponse = (result = detected) => ({ projectId: project, assetId, result, current: true, staleReason: null });
const page = (items = [], projectId = project) => ({ projectId, items, nextCursor: null });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const refusal = (code, operation, input, patch = {}) => new ApiError('refused', code, { sceneOutcome: { status: 'not_accepted', operation, projectId: input.projectId, requestId: input.requestId,
  inputHash: createHash('sha256').update(canonicalSceneInput(input)).digest('hex'), ...patch } }, true, code === 'SCENE_CAPACITY' ? 507 : 409);

function setup(handler = () => page(), extra = {}) {
  const calls = [], settled = []; let serial = 0, clock = 0;
  const controller = scene.createSceneDetectionController({ rpc: async (operation, input) => { calls.push({ operation, input }); return handler(operation, input); },
    createRequestId: () => `request-${String(++serial).padStart(4, '0')}`, now: () => clock, onTaskSettled: value => settled.push(value), ...extra });
  controller.configure({ projectId: project, visible: true });
  return { controller, calls, settled, tick: ms => { clock += ms; }, of: operation => calls.filter(call => call.operation === operation) };
}

test('segments, the middle keyframe and the cut edits keep cuts strictly inside the source', () => {
  assert.deepEqual(cuts.sceneSegments([30, 90], 120).map(segment => [segment.index, segment.start, segment.end, segment.middle]), [[1, 0, 30, 15], [2, 30, 90, 60], [3, 90, 120, 105]]);
  assert.deepEqual(cuts.sceneSegments([0, 120, 200], 120).map(segment => [segment.start, segment.end]), [[0, 120]], 'cuts outside the source are not segment bounds');
  assert.equal(cuts.sceneSegmentAt(cuts.sceneSegments([30], 60), 45).index, 2);
  assert.equal(cuts.sceneSegmentAt(cuts.sceneSegments([30], 60), 999).index, 2, 'frames past the end belong to the last segment');
  const draft = cuts.sceneDraftFrom([{ frame: 30 }, { frame: 90 }]);
  assert.deepEqual(cuts.addSceneCut(draft, 60, 120).map(cut => [cut.frame, cut.origin]), [[30, 30], [60, null], [90, 90]]);
  for (const frame of [0, 120, 30, 12.5]) assert.equal(cuts.addSceneCut(draft, frame, 120), null, `frame ${frame} is refused`);
  assert.deepEqual(cuts.moveSceneCut(draft, 0, 500, 120).map(cut => cut.frame), [89, 90], 'a dragged cut stops one frame before its neighbour');
  assert.deepEqual(cuts.moveSceneCut(draft, 1, -50, 120).map(cut => cut.frame), [30, 31]);
  assert.deepEqual(cuts.removeSceneCut(draft, 0).map(cut => cut.frame), [90]);
});

test('adjustments count each added, moved and removed cut once, and moving back undoes the count', () => {
  const saved = [30, 90], draft = cuts.sceneDraftFrom(saved.map(frame => ({ frame })));
  assert.equal(cuts.sceneAdjustments(draft, saved), 0);
  const moved = cuts.moveSceneCut(draft, 0, 40, 120);
  assert.equal(cuts.sceneAdjustments(moved, saved), 1); assert.equal(cuts.sceneCutAdjusted(moved[0]), true);
  assert.equal(cuts.sceneAdjustments(cuts.moveSceneCut(moved, 0, 30, 120), saved), 0);
  assert.equal(cuts.sceneAdjustments(cuts.addSceneCut(moved, 100, 120), saved), 2);
  assert.equal(cuts.sceneAdjustments(cuts.addSceneCut(cuts.removeSceneCut(draft, 1), 100, 120), saved), 2, 'removing one cut and adding another are two changes');
});

test('times use the dialog format and the filmstrip samples each tile centre', () => {
  assert.equal(cuts.sceneTime(0), '00:00.0'); assert.equal(cuts.sceneTime(702), '00:23.4'); assert.equal(cuts.sceneTime(2160), '01:12.0'); assert.equal(cuts.sceneTime(108000), '60:00.0');
  assert.equal(cuts.sceneClock(2160), '01:12'); assert.equal(cuts.sceneSeconds(186), 6.2); assert.equal(cuts.sceneSegmentNumber(5), '05');
  assert.deepEqual(cuts.sceneFilmstripFrames(120, 4), [15, 45, 75, 105]);
  assert.deepEqual(cuts.sceneFilmstripFrames(2, 4), [0, 0, 1, 1]); assert.deepEqual(cuts.sceneFilmstripFrames(0, 4), []);
});

test('sources outside the frame capture profile explain why they cannot be detected', () => {
  assert.equal(scene.sceneSourceIssue(asset), null); assert.equal(scene.sceneSourceIssueMessage(asset), null);
  assert.equal(scene.sceneSourceIssue({ ...asset, mimeType: 'video/quicktime' }), 'type');
  assert.equal(scene.sceneSourceIssue({ ...asset, sha256: undefined }), 'type');
  assert.equal(scene.sceneSourceIssue({ ...asset, duration: 601 }), 'duration');
  assert.equal(scene.sceneSourceIssue({ ...asset, sizeBytes: 600 * 1048576 }), 'size');
  assert.equal(renderMessage('zh-Hans', scene.sceneSourceIssueMessage({ ...asset, duration: 900 })), '参考片最长 10 分钟，先截一段再拆');
  assert.equal(renderMessage('en', scene.sceneSourceIssueMessage({ ...asset, sizeBytes: 1e9 })), 'The file is over 512 MB; trim it first');
  assert.equal(renderMessage('zh-Hans', scene.sceneErrorMessage('SCENE_CUTS_LIMIT')), '检测到的切点太多，请降低灵敏度或加大最短镜头');
  assert.equal(renderMessage('zh-Hans', scene.sceneErrorMessage('SOMETHING_NEW')), '本地检测没有完成');
  assert.deepEqual([10, 40, 69, 70].map(scene.sceneSensitivityLevel), ['low', 'medium', 'medium', 'high']);
  assert.deepEqual([task(), running(10), task({ state: 'cancelling', started: true, revision: 3 }), succeeded()].map(scene.sceneTaskCanCancel), [true, true, false, false]);
  assert.deepEqual([task(), running(411), succeeded(), running(822)].map(scene.sceneTaskPercent), [0, 50, 100, 99]);
});

test('configuration is inert; listing keeps detection tasks, estimates time left and announces settled ones', async () => {
  let items = [running(100)];
  const h = setup(operation => operation === 'scene.task.list' ? page(items) : resultResponse());
  assert.deepEqual(h.calls, []);
  assert.equal(await h.controller.refreshTasks(), true);
  assert.deepEqual(h.calls[0].input, { projectId: project, limit: 20 });
  assert.equal(h.controller.getState().tasks[0].state, 'running'); assert.equal(h.controller.activeTask(assetId).id, taskId);
  h.tick(4000); items = [running(300)]; await h.controller.refreshTasks();
  assert.equal(h.controller.getState().remaining[taskId], 11, '200 frames in 4 s leaves 522 frames: about 11 s');
  await h.controller.loadResult(assetId);
  items = [succeeded()]; await h.controller.refreshTasks();
  assert.equal(h.settled.length, 1); assert.equal(h.settled[0].state, 'succeeded');
  assert.equal(h.of('scene.result.get').length, 2, 'a shown result is read again once a newer detection succeeds');
  assert.equal(h.controller.activeTask(assetId), null); assert.deepEqual(h.controller.getState().remaining, {});
  await h.controller.refreshTasks(); assert.equal(h.settled.length, 1, 'a settled task is announced once');
});

test('an invalid page, a foreign project or an older revision never replaces what is shown', async () => {
  let response = page([running(100)]);
  const h = setup(operation => operation === 'scene.task.list' ? response : null);
  await h.controller.refreshTasks();
  response = page([running(100)], otherProject); assert.equal(await h.controller.refreshTasks(), false);
  assert.equal(h.controller.getState().tasksError, true); assert.equal(h.controller.getState().tasks.length, 1);
  response = page([task()]); await h.controller.refreshTasks();
  assert.equal(h.controller.getState().tasks[0].state, 'running', 'a revision 1 read cannot move a running task back to queued');
});

test('detect sends normalized options with a fresh request, validates the receipt and reads the task', async () => {
  const submitted = deferred();
  const h = setup(operation => operation === 'scene.task.list' ? page() : operation === 'scene.detect' ? submitted.promise : operation === 'scene.task.get' ? running(30) : resultResponse());
  await h.controller.refreshTasks();
  const first = h.controller.detect(asset, { sensitivity: 80 });
  assert.equal(await h.controller.detect(asset), null, 'a second click while submitting sends nothing');
  assert.equal(h.controller.getState().phase, 'submitting');
  assert.equal(Object.isFrozen(h.controller.getState().pending.input), true);
  submitted.resolve(task({ options: { ...options, sensitivity: 80 } }));
  const accepted = await first;
  assert.deepEqual(h.of('scene.detect').map(call => call.input), [{ projectId: project, sourceAssetId: assetId, sourceHash: hash, options: { mode: 'adaptive', sensitivity: 80, minShotSeconds: 0.6 }, requestId: 'request-0001' }]);
  assert.equal(accepted.state, 'running', 'the current task replaces the queued receipt');
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().phase, 'idle');
  assert.equal(await h.controller.detect(asset), null); assert.equal(h.of('scene.detect').length, 1, 'a video with active detection is not queued again');
  assert.equal(renderMessage('zh-Hans', h.controller.getState().notice.descriptor), '这个视频已有拆解在进行');
});

test('a lost receipt keeps the exact request until the receipt read or an explicit resend settles it', async () => {
  let detects = 0, receipt = null;
  const h = setup(operation => {
    if (operation === 'scene.task.list') return page();
    if (operation === 'scene.detect') { if (++detects === 1) throw new Error('connection reset'); return task(); }
    if (operation === 'scene.request.get') return receipt;
    if (operation === 'scene.task.get') return task();
    return null;
  });
  await h.controller.refreshTasks(); await h.controller.detect(asset);
  assert.equal(h.controller.getState().phase, 'unknown'); const kept = h.controller.getState().pending.input;
  await h.controller.reconcileUnknown();
  assert.equal(h.controller.getState().phase, 'unknown'); assert.equal(h.controller.getState().pending.input, kept);
  assert.equal(renderMessage('zh-Hans', h.controller.getState().notice.descriptor), '还没找到这次请求的回执。可以稍后再核对，或重发同一请求。');
  assert.equal(await h.controller.detect(asset), null, 'a new detect cannot bypass the unconfirmed one');
  await h.controller.retryUnknown();
  assert.deepEqual(h.of('scene.detect').map(call => call.input), [kept, kept]);
  assert.equal(h.controller.getState().pending, null);
  receipt = { projectId: project, requestId: 'request-0001', operation: 'scene.detect', response: task() };
  assert.equal(await h.controller.reconcileUnknown(), null, 'nothing is left to reconcile');
});

test('a receipt read settles an unknown request; a mismatched receipt does not', async () => {
  let receipt = { projectId: project, requestId: 'request-0001', operation: 'scene.cuts.save', response: task() };
  const h = setup(operation => operation === 'scene.task.list' ? page() : operation === 'scene.detect' ? Promise.reject(new Error('lost')) : operation === 'scene.request.get' ? receipt : task());
  await h.controller.refreshTasks(); await h.controller.detect(asset); await h.controller.reconcileUnknown();
  assert.ok(h.controller.getState().pending, 'a receipt for another operation is rejected');
  receipt = { projectId: project, requestId: 'request-0001', operation: 'scene.detect', response: task() };
  await h.controller.reconcileUnknown();
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().tasks[0].id, taskId);
});

test('only a proof bound to the exact input clears a refused request', async () => {
  let proofPatch = {};
  const h = setup((operation, input) => { if (operation === 'scene.task.list') return page(); if (operation === 'scene.detect') throw refusal('SCENE_QUEUE_FULL', operation, input, proofPatch); return null; });
  await h.controller.refreshTasks();
  proofPatch = { inputHash: 'd'.repeat(64) }; await h.controller.detect(asset);
  assert.equal(h.controller.getState().phase, 'unknown', 'a proof for different input is not trusted');
  h.controller.configure({ projectId: otherProject, visible: true }); h.controller.configure({ projectId: project, visible: true });
  assert.equal(h.controller.getState().phase, 'unknown', 'the unconfirmed request survives switching projects');
  proofPatch = {}; await h.controller.retryUnknown();
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().phase, 'idle');
  assert.equal(renderMessage('zh-Hans', h.controller.getState().notice.descriptor), '拆解队列已满，等前面的完成后再试');
});

test('cancel sends the shown revision; saving cuts names its base result and reads the new one', async () => {
  let shown = [running(100)], result = resultResponse();
  const saved = { ...detected, id: savedId, origin: 'manual', taskId: null, basedOnResultId: resultId, requestId: 'request-0002', options: null, cuts: [{ frame: 108, score: 0.5 }, { frame: 300, score: null }] };
  const h = setup((operation, input) => {
    if (operation === 'scene.task.list') return page(shown);
    if (operation === 'scene.task.cancel') return running(100, { state: 'cancelling', revision: 3, progress: null });
    if (operation === 'scene.task.get') return task({ state: 'cancelled', revision: 4, started: true });
    if (operation === 'scene.cuts.save') { const { cuts: frames, options: none, ...summary } = saved; return { ...summary, cutCount: input.cuts.length }; }
    if (operation === 'scene.result.get') return result;
    return null;
  });
  await h.controller.refreshTasks();
  await h.controller.cancel(running(100));
  assert.deepEqual(h.of('scene.task.cancel')[0].input, { projectId: project, taskId, expectedRevision: 2, requestId: 'request-0001' });
  assert.equal(h.settled.at(-1).state, 'cancelled');
  assert.equal(await h.controller.cancel(h.controller.getState().tasks[0]), null, 'a cancelled task cannot be cancelled again');
  shown = [];
  await h.controller.loadResult(assetId);
  result = resultResponse(saved);
  const summary = await h.controller.saveCuts(asset, resultId, [108, 300]);
  assert.equal(summary.id, savedId);
  assert.deepEqual(h.of('scene.cuts.save')[0].input, { projectId: project, assetId, sourceHash: hash, expectedResultId: resultId, cuts: [108, 300], requestId: 'request-0002' });
  assert.equal(h.controller.getState().results[assetId].response.result.id, savedId);
});

test('a refused save reads the newer result; a restored workspace only reads', async () => {
  const h = setup((operation, input) => operation === 'scene.cuts.save' ? Promise.reject(refusal('SCENE_RESULT_CONFLICT', operation, input)) : operation === 'scene.result.get' ? resultResponse() : page());
  await h.controller.refreshTasks();
  assert.equal(await h.controller.saveCuts(asset, resultId, [108]), null);
  assert.equal(h.controller.getState().pending, null); assert.equal(h.of('scene.result.get').length, 1);
  assert.equal(renderMessage('zh-Hans', h.controller.getState().notice.descriptor), '这个视频有了更新的拆解结果，已重新读取');
  h.controller.configure({ projectId: project, visible: true, readOnly: true });
  const before = h.calls.length;
  assert.equal(await h.controller.detect(asset), null); assert.equal(await h.controller.saveCuts(asset, resultId, [108]), null);
  assert.equal(h.calls.length, before);
  await h.controller.loadResult(assetId); assert.equal(h.calls.length, before + 1, 'results stay readable');
});

test('late responses from the previous project are dropped', async () => {
  const listed = deferred(), result = deferred();
  const h = setup(operation => operation === 'scene.task.list' ? listed.promise : result.promise);
  const reading = h.controller.refreshTasks(), loading = h.controller.loadResult(assetId);
  h.controller.configure({ projectId: otherProject, visible: true });
  listed.resolve(page([running(100)])); result.resolve(resultResponse());
  assert.equal(await reading, false); assert.equal(await loading, null);
  assert.deepEqual(h.controller.getState().tasks, []); assert.deepEqual(h.controller.getState().results, {});
});

test('task views show progress, time left and cancel only where it is allowed', () => {
  const context = { t: (key, params) => translate('zh-Hans', key, params), renderMessage: value => renderMessage('zh-Hans', value), name: id => id === assetId ? '参考片-街景.mp4' : undefined,
    remaining: { [taskId]: 20 }, readOnly: false, opened: [], cancelled: [], onOpen(value) { this.opened.push(value.id); }, onCancel(value) { this.cancelled.push(value.id); } };
  const [item] = sceneOverviewItems([running(296, { progress: { frames: 296, frameCount: 822, cuts: 4 } }), succeeded({ id: savedId })], context);
  assert.equal(item.label, '拆解镜头 · 参考片-街景.mp4'); assert.equal(item.status, '36%'); assert.equal(item.progress, 36);
  assert.equal(item.detail, '检测切镜 · 已找到 4 处切点 · 预计剩余 20 秒');
  assert.equal(sceneOverviewItems([task()], context)[0].status, '排队中'); assert.equal(sceneOverviewItems([task()], context)[0].detail, undefined);
  item.onOpen(); item.onCancel(); assert.deepEqual(context.opened, [taskId]); assert.deepEqual(context.cancelled, [taskId]);
  assert.equal(sceneOverviewItems([running(10)], { ...context, readOnly: true })[0].onCancel, undefined);
  assert.equal(sceneOverviewItems([task({ sourceAssetId: savedId })], context)[0].onOpen, undefined, 'a video that left the project cannot be opened');
  assert.equal(sceneTaskStatus(succeeded(), context), '已完成 · 7 段');
  assert.equal(sceneTaskStatus(task({ state: 'failed', started: true, revision: 3, errorCode: 'SCENE_ATTEMPT_TIMEOUT' }), context), '失败 · 检测超过了时间上限');
  const rows = sceneTaskCenterRows([succeeded(), task({ id: savedId, sourceAssetId: savedId, state: 'interrupted', started: true, revision: 3, errorCode: 'SCENE_INTERRUPTED' })], context);
  assert.deepEqual(rows.map(row => [row.key, row.active, row.warning, row.available, row.status]), [[`scene:${taskId}`, false, false, true, '已完成 · 7 段'], [`scene:${savedId}`, false, true, false, '已中断']]);
  assert.equal(rows[1].label, '拆解镜头 · 素材已不在项目里');
});

function fakeVideo(log, { fail = false } = {}) {
  const listeners = new Map();
  const video = { muted: false, preload: '', readyState: 0, videoWidth: 160, videoHeight: 90, _time: 0,
    addEventListener(type, listener) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type) { for (const listener of [...(listeners.get(type) ?? [])]) listener(); },
    removeAttribute(name) { log.push(`remove:${name}`); }, load() { log.push('load'); },
    set src(value) { log.push(`src:${value}`); queueMicrotask(() => video.emit(fail ? 'error' : 'loadeddata')); }, get src() { return ''; },
    set currentTime(value) { video._time = value; log.push(`seek:${value.toFixed(4)}`); queueMicrotask(() => video.emit('seeked')); }, get currentTime() { return video._time; } };
  return video;
}
const fakeCanvas = log => ({ width: 0, height: 0, getContext: () => ({ drawImage(_image, x, y, width, height) { log.push(`draw:${width}x${height}`); } }), toDataURL: type => `data:${type};frame` });
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

test('thumbnails seek one frame at a time, cache by source and frame, and honour priority', async () => {
  clearSceneThumbnails();
  const log = [], updates = [];
  const thumbnails = createSceneThumbnailer({ key: `${assetId}:${hash}`, url: '/media/a', width: 160, onUpdate: () => updates.push(1), createVideo: () => fakeVideo(log), createCanvas: () => fakeCanvas(log) });
  thumbnails.request([15, 45, 15]); thumbnails.prioritize([75]);
  await settle();
  assert.deepEqual(log.filter(entry => entry.startsWith('seek:')), ['seek:0.5167', 'seek:2.5167', 'seek:1.5167'], 'the prioritized frame jumps ahead of queued ones; a running seek finishes first');
  assert.deepEqual(log.filter(entry => entry.startsWith('draw:'))[0], 'draw:160x90');
  assert.equal(thumbnails.get(45), 'data:image/jpeg;frame'); assert.ok(updates.length >= 1);
  const again = createSceneThumbnailer({ key: `${assetId}:${hash}`, url: '/media/a', width: 160, createVideo: () => fakeVideo(log), createCanvas: () => fakeCanvas(log) });
  assert.equal(again.get(75), 'data:image/jpeg;frame', 'another dialog for the same bytes reuses the cache');
  thumbnails.dispose(); assert.ok(log.includes('remove:src'));
  const broken = createSceneThumbnailer({ key: 'other', url: '/media/b', createVideo: () => fakeVideo(log, { fail: true }), createCanvas: () => fakeCanvas(log) });
  broken.request([1, 2]); await settle();
  assert.equal(broken.unavailable(), true); assert.equal(broken.get(1), undefined);
});

function loadCutBar() {
  const slots = []; let cursor = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: value => { const index = cursor++; return slots[index] ??= { current: value }; },
    useState: value => { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; } };
  react.default = react;
  const module = { exports: {} }, source = readFileSync(new URL('../apps/web/src/SceneCutBar.tsx', import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(name => {
    if (name === 'react') return react;
    if (name.endsWith('I18nProvider.tsx')) return i18nTestModule();
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    if (name === './icons.tsx') return { __esModule: true, default: 'Icon' };
    if (name === './scene-cuts.ts') return cuts;
    throw new Error(`Unexpected cut bar dependency ${name}`);
  }, module, module.exports);
  return { ...module.exports, render: (component, props) => { cursor = 0; return component(props); }, slots };
}
const tree = value => Array.isArray(value) ? value.flatMap(tree) : value && typeof value === 'object' ? [value, ...tree(value.props?.children)] : [];
const byTest = (root, id) => tree(root).find(node => node.props?.['data-testid'] === id);

test('the cut bar adds on double click, nudges and removes from the keyboard, and stays inert when locked', () => {
  const bar = loadCutBar(), calls = [];
  const props = { frameCount: 120, cuts: cuts.sceneDraftFrom([{ frame: 30 }, { frame: 90 }]), editable: true, selected: null, playhead: 45, tiles: [],
    onSeek: frame => calls.push(['seek', frame]), onAdd: frame => calls.push(['add', frame]), onMove: (index, frame) => calls.push(['move', index, frame]), onRemove: index => calls.push(['remove', index]) };
  let root = bar.render(bar.SceneCutBar, props);
  const track = byTest(root, 'scene-cutbar');
  bar.slots[0].current = { getBoundingClientRect: () => ({ left: 100, width: 600 }) };
  track.props.onDoubleClick({ clientX: 400, target: { closest: () => null } });
  track.props.onClick({ clientX: 160, target: { closest: () => null } });
  track.props.onDoubleClick({ clientX: 400, target: { closest: () => ({}) } });
  const marker = byTest(root, 'scene-cut-1');
  assert.equal(marker.props['aria-label'], '切点 00:03.0');
  marker.props.onKeyDown({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} });
  marker.props.onKeyDown({ key: 'Delete', preventDefault() {} });
  let prevented = false; marker.props.onContextMenu({ preventDefault() { prevented = true; } });
  assert.deepEqual(calls, [['add', 60], ['seek', 12], ['move', 1, 80], ['remove', 1], ['remove', 1]]); assert.equal(prevented, true);
  root = bar.render(bar.SceneCutBar, { ...props, editable: false });
  assert.equal(byTest(root, 'scene-cut-1'), undefined, 'locked markers are not focusable controls');
  calls.length = 0; byTest(root, 'scene-cutbar').props.onDoubleClick({ clientX: 400, target: { closest: () => null } }); assert.deepEqual(calls, []);
});

test('the workbench opens detection from the library, the source toolbar, the inspector and the task views', () => {
  const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
  const app = read('App.tsx');
  assert.match(app, /const scenesSupported = !application && \(!restored \|\| Number\(workspace\?\.schemaVersion\) >= 59\);/, 'restored copies before schema 59 have no scene records');
  assert.match(app, /onDetectScenes=\{scenesSupported \? asset => openSceneDetection\(asset, true\) : undefined\}/);
  assert.match(app, /onDetectScenes=\{!scenesSupported \|\| !sourceAsset \? undefined : \(\) => \{ if \(sourceAsset\) openSceneDetection\(sourceAsset as AppAsset, true\); \}\}/);
  assert.match(app, /assetSections=\{sceneSummary\(librarySource as AppAsset \| null\)\}/);
  assert.match(app, /onAdd=\{addSavedSourceRange\} sections=\{sceneSummary\(sourceAsset as AppAsset \| null\)\}>/);
  assert.match(app, /\.\.\.sceneOverviewItems\(sceneTasks, sceneTaskContext\),/);
  assert.match(app, /<TaskCenter scenes=\{sceneTaskCenterEntries\(sceneTasks,/);
  assert.match(app, /mutateTimeline\('timeline\.clip\.splitAtScenes', \{ assetId, resultId \}, undefined, \{ errorMessage: sceneSplitError \}\)/);
  // Other tests evaluate App slices between neighbouring handlers; the scene handlers stay outside them.
  const handlers = app.indexOf('  // Shot detection. The dialog belongs to one project and video;');
  assert.ok(handlers > app.indexOf('  async function moveTimelineClip(') && handlers < app.indexOf('  function renderUncheckedTimeline('));
  assert.match(read('Inspector.tsx'), /\{annotationPanel\}\{assetSections\}<\/div><\/ScrollArea><\/aside>;/);
  assert.doesNotMatch(read('Inspector.tsx'), /AssetSceneSummary|scene-detection/, 'Inspector keeps its imports; App prepares the section');
  assert.match(read('TaskPopover.tsx'), /if\(item\.onOpen\)item\.onOpen\(\);else onOpenTasks\(item\.id\);/);
});
