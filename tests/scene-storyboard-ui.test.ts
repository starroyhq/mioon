import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import type {SceneUndoBlocker} from '@mioon/contracts';
import type {SceneTaskViewContext} from '../apps/web/src/scene-task-views.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { canonicalSceneInput } from '@mioon/contracts';
import { ApiError } from '../apps/web/src/api.ts';
import * as cuts from '../apps/web/src/scene-cuts.ts';
import * as scene from '../apps/web/src/scene-detection.ts';
import { storyboardBatchSummary, storyboardBlock, storyboardBlockMessage, storyboardKeyframes, storyboardNeedsAttention, storyboardSegments, storyboardUndoReason } from '../apps/web/src/scene-storyboard.ts';
import { sceneOverviewItems, sceneTaskCenterRows, sceneTaskStatus } from '../apps/web/src/scene-task-views.ts';
import { i18nTestModule, renderMessage, translate } from './helpers/i18n.ts';
import type { DisplayMessage } from '../packages/i18n/src/types.ts';

const project = '00000000-0000-4000-8000-0000000000b1', assetId = '00000000-0000-4000-8000-0000000000b2', resultId = '00000000-0000-4000-8000-0000000000b3';
const taskId = '00000000-0000-4000-8000-0000000000b4', otherTaskId = '00000000-0000-4000-8000-0000000000b5', hash = 'e'.repeat(64);
const at = '2026-10-26T08:00:00.000Z', later = '2026-10-26T08:05:00.000Z';
const shotIds = ['00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000c3'];
const keyIds = ['00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d3'];
const asset = { id: assetId, projectId: project, name: '参考片-晴天.mp4', sha256: hash, mimeType: 'video/mp4', duration: 72, sizeBytes: 8_000_000 };
const shots = (patch: Partial<scene.SceneShotsTask> = {}): scene.SceneShotsTask => ({ id: taskId, projectId: project, kind: 'shots', requestId: 'request-0001', sourceAssetId: assetId, sourceHash: hash, resultId,
  segments: [1, 3, 5], titlePrefix: '参考', aspectRatio: '9:16', state: 'queued', revision: 1, started: false, shots: null, progress: null, undo: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const built = (patch: Partial<scene.SceneShotsTask> = {}): scene.SceneShotsTask => shots({ state: 'succeeded', revision: 4, started: true,
  shots: [1, 3, 5].map((segment, index) => ({ segment, shotId: shotIds[index]!, assetId: keyIds[index]! })), ...patch });
const failed = (patch: Partial<scene.SceneShotsTask> = {}): scene.SceneShotsTask => shots({ id: otherTaskId, requestId: 'request-0009', state: 'failed', revision: 3, started: true, errorCode: 'SCENE_SOURCE_CHANGED', ...patch });
const page = (items: unknown[] = []) => ({ projectId: project, items, nextCursor: null });
const refusal = (code: string, operation: string, input: {projectId?: unknown; requestId?: unknown}) => new ApiError('refused', code, { sceneOutcome: { status: 'not_accepted', operation, projectId: input.projectId, requestId: input.requestId,
  inputHash: createHash('sha256').update(canonicalSceneInput(input)).digest('hex') } }, true, 409);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const t = ((key: string, params?: unknown) => (translate as (locale: 'zh-Hans', key: string, params?: unknown) => string)('zh-Hans', key, params)) as SceneTaskViewContext['t'];
const en = ((key: string, params?: unknown) => (translate as (locale: 'en', key: string, params?: unknown) => string)('en', key, params)) as SceneTaskViewContext['t'];

function setup(handler: (operation: string, input: Record<string, unknown>) => unknown) {
  const calls: { operation: string; input: unknown; }[] = [], settled: scene.SceneTask[] = []; let serial = 0;
  const controller = scene.createSceneDetectionController({ rpc: async (operation, input) => { calls.push({ operation, input }); return handler(operation, input as Record<string, unknown>); },
    createRequestId: () => `request-${String(++serial).padStart(4, '0')}`, onTaskSettled: value => settled.push(value) });
  controller.configure({ projectId: project, visible: true });
  return { controller, calls, settled, of: (operation: string) => calls.filter(call => call.operation === operation) };
}

test('storyboard tasks are listed with detections, stay active while saving and count captured keyframes', async () => {
  let items: unknown[] = [shots({ state: 'running', revision: 2, started: true, progress: { done: 1, total: 3 } })];
  const h = setup(operation => operation === 'scene.task.list' ? page(items) : null);
  await h.controller.refreshTasks();
  const listed = h.controller.getState().tasks[0]!;
  assert.equal(listed.kind, 'shots'); assert.equal(scene.sceneTaskPercent(listed), 33); assert.equal(h.controller.activeTask(assetId)?.id, taskId);
  items = [shots({ state: 'persisting', revision: 3, started: true })]; await h.controller.refreshTasks();
  const saving = h.controller.getState().tasks[0]!;
  assert.equal(scene.sceneTaskActive(saving), true); assert.equal(scene.sceneTaskCanCancel(saving), false, 'a storyboard saving its shots finishes on its own'); assert.equal(scene.sceneTaskPercent(saving), 99);
  items = [built()]; await h.controller.refreshTasks();
  assert.equal(h.settled.length, 1); assert.equal(h.settled[0]!.state, 'succeeded');
  assert.equal((h.controller.getState().tasks[0] as scene.SceneShotsTask).undo, null, 'pages never carry undo availability');
  assert.equal(h.of('scene.result.get').length, 0, 'a storyboard leaves the cut result as it was');
});

test('a storyboard is queued from the shown result with the chosen segments, one scene task per video', async () => {
  const h = setup((operation, input) => operation === 'scene.task.list' ? page() : operation === 'scene.shots.create' ? shots({ requestId: input.requestId as string })
    : operation === 'scene.task.get' ? shots({ state: 'running', revision: 2, started: true, progress: { done: 0, total: 3 } }) : null);
  await h.controller.refreshTasks();
  const task = await h.controller.createShots(asset, resultId, [1, 3, 5]);
  assert.deepEqual(h.of('scene.shots.create').map(call => call.input), [{ projectId: project, sourceAssetId: assetId, sourceHash: hash, resultId, segments: [1, 3, 5], requestId: 'request-0001' }]);
  assert.equal(task?.state, 'running'); assert.equal(h.controller.getState().pending, null);
  assert.equal(await h.controller.createShots(asset, resultId, [2]), null);
  assert.equal(await h.controller.detect(asset), null, 'a storyboard in progress also holds detection');
  assert.equal(h.of('scene.shots.create').length, 1); assert.equal(h.of('scene.detect').length, 0);
  assert.equal(renderMessage('zh-Hans', h.controller.getState().notice!.descriptor), '这个视频已有拆解或建分镜在进行');
});

test('retry builds a storyboard that built nothing again with its result, segments and title prefix', async () => {
  const h = setup((operation, input) => operation === 'scene.task.list' ? page([failed()]) : operation === 'scene.shots.create' ? shots({ requestId: input.requestId as string })
    : operation === 'scene.task.get' ? shots() : null);
  await h.controller.refreshTasks();
  assert.equal(await h.controller.retryShots(built(), asset), null, 'a built storyboard is not retried');
  assert.equal(await h.controller.retryShots(failed(), { ...asset, id: otherTaskId }), null, 'only for its own video');
  await h.controller.retryShots(failed(), asset);
  assert.deepEqual(h.of('scene.shots.create').map(call => call.input), [{ projectId: project, sourceAssetId: assetId, sourceHash: hash, resultId, segments: [1, 3, 5], titlePrefix: '参考', requestId: 'request-0001' }]);
});

test('undo reads the storyboard first: a changed batch is not sent, an untouched one is undone once', async () => {
  let blockers: SceneUndoBlocker[] = [{ segment: 3, shotId: shotIds[1]!, reason: 'EDITED', fields: ['prompt'] }];
  const h = setup(operation => operation === 'scene.task.list' ? page([built()]) : operation === 'scene.task.get' ? built({ undo: { available: blockers.length === 0, blockers } })
    : operation === 'scene.shots.undo' ? built({ state: 'undone', revision: 5 }) : null);
  await h.controller.refreshTasks();
  assert.equal(await h.controller.undoShots(taskId), null);
  assert.equal(h.of('scene.shots.undo').length, 0);
  assert.deepEqual(h.controller.getState().undo[taskId], { phase: 'ready', revision: 4, undo: { available: false, blockers } });
  assert.equal(h.controller.getState().phase, 'idle');
  assert.equal(renderMessage('zh-Hans', h.controller.getState().notice!.descriptor), '有镜头已生成、修改、连线或绑定主体，不能整批撤销');
  blockers = [];
  const undone = await h.controller.undoShots(taskId);
  assert.deepEqual(h.of('scene.shots.undo').map(call => call.input), [{ projectId: project, taskId, expectedRevision: 4, requestId: 'request-0001' }]);
  assert.equal(undone?.state, 'undone'); assert.equal(h.settled.at(-1)?.state, 'undone', 'an undone storyboard is announced');
  assert.equal(h.controller.getState().undo[taskId], undefined, 'nothing is left to undo');
  assert.equal(await h.controller.undoShots(taskId), null); assert.equal(h.of('scene.shots.undo').length, 1);
});

test('a refused undo reads the storyboard again to show what changed', async () => {
  let reads = 0;
  const h = setup((operation, input) => {
    if (operation === 'scene.task.list') return page([built()]);
    if (operation === 'scene.task.get') return built({ undo: ++reads === 1 ? { available: true, blockers: [] } : { available: false, blockers: [{ segment: 1, shotId: shotIds[0]!, reason: 'GENERATED' }] } });
    if (operation === 'scene.shots.undo') throw refusal('SCENE_UNDO_BLOCKED', operation, input);
    return null;
  });
  await h.controller.refreshTasks();
  assert.equal(await h.controller.undoShots(taskId), null);
  await settle();
  assert.equal(h.controller.getState().pending, null, 'the refusal is proven, so nothing stays unconfirmed');
  assert.equal(h.controller.getState().undo[taskId]?.undo?.blockers[0]?.reason, 'GENERATED');
  h.controller.configure({ projectId: project, visible: true, readOnly: true });
  const before = h.calls.length;
  assert.equal(await h.controller.undoShots(taskId), null); assert.equal(h.calls.length, before, 'a restored copy cannot undo');
});

test('choices, blocks and keyframe states follow the dialog rules', () => {
  const segments = cuts.sceneSegments([30, 60, 90], 120);
  assert.deepEqual(storyboardSegments(null, segments), [1, 2, 3, 4]);
  assert.deepEqual(storyboardSegments(new Set([4, 2, 9]), segments), [2, 4], 'segments outside the result are dropped');
  const ready = { readOnly: false, current: true, dirty: false, busy: false, count: 2 };
  assert.equal(storyboardBlock(ready), null);
  assert.deepEqual([{ readOnly: true, current: false }, { current: false, dirty: true }, { dirty: true, busy: true }, { busy: true, count: 0 }, { count: 0 }, { count: 101 }].map(patch => storyboardBlock({ ...ready, ...patch })),
    ['readOnly', 'stale', 'unsaved', 'busy', 'none', 'limit']);
  assert.equal(renderMessage('zh-Hans', storyboardBlockMessage('unsaved')), '先保存切点调整，再建分镜');
  assert.equal(renderMessage('en', storyboardBlockMessage('limit')), 'Up to 100 shots at a time');
  const running = shots({ segments: [1, 3, 4], state: 'running', revision: 2, started: true, progress: { done: 1, total: 3 } });
  assert.deepEqual(storyboardKeyframes(running, 4), ['done', 'skipped', 'current', 'waiting']);
  assert.deepEqual(storyboardKeyframes(shots({ segments: [1, 3, 4], state: 'persisting', revision: 3, started: true }), 4), ['done', 'skipped', 'done', 'done']);
  assert.deepEqual(storyboardKeyframes(shots({ segments: [1, 3, 4] }), 4), ['waiting', 'skipped', 'waiting', 'waiting']);
});

test('the batch is counted as its shots are now, and undo names the first change', () => {
  const summary = storyboardBatchSummary(built(), [{ id: shotIds[0]!, duration: 4 }, { id: shotIds[1]!, duration: 6, selectedVersionId: 'version' }, { id: 'unrelated', duration: 9 }],
    [{ segment: 3, shotId: shotIds[1]!, reason: 'GENERATED' }, { segment: 5, shotId: shotIds[2]!, reason: 'MISSING' }]);
  assert.deepEqual(summary, { shotIds: [shotIds[0], shotIds[1]], first: '参考 01', last: '参考 05', seconds: 10, pending: 1, generated: 1, edited: 0, missing: 1 });
  const edited: SceneUndoBlocker[] = [{ segment: 3, shotId: shotIds[1]!, reason: 'EDITED', fields: ['prompt', 'duration'] }, { segment: 5, shotId: shotIds[2]!, reason: 'CONNECTED' }];
  assert.equal(storyboardUndoReason(built(), edited, t), '参考 03 的画面描述、时长已修改，另有 1 个镜头也有改动，不能整批撤销。');
  assert.equal(storyboardUndoReason(built(), edited.slice(0, 1), en), 'The visual description, duration of 参考 03 changed, so the batch can’t be undone.');
  assert.equal(storyboardUndoReason(built(), [{ segment: 1, shotId: shotIds[0]!, reason: 'SUBJECT_BOUND' }], t), '参考 01 已绑定主体，不能整批撤销。');
  assert.equal(storyboardUndoReason(built(), [], t), null);
});

test('task views show storyboard progress, and a storyboard that built nothing offers retry until a newer one replaces it', () => {
  const context: SceneTaskViewContext & {retried: string[]} = { t, renderMessage: (value?: string | DisplayMessage | null) => renderMessage('zh-Hans', value), name: id => id === assetId ? asset.name : undefined,
    remaining: {}, readOnly: false, retried: [], onOpen() {}, onCancel() {}, onRetry(value) { this.retried.push(value.id); } };
  const twelve = Array.from({ length: 12 }, (_, index) => index + 1);
  const [item] = sceneOverviewItems([shots({ segments: twelve, state: 'running', revision: 2, started: true, progress: { done: 5, total: 12 } })], context);
  assert.deepEqual([item!.label, item!.status, item!.progress, item!.detail, item!.cancelLabel], ['建分镜 · 参考片-晴天.mp4', '5 / 12', 41, '截取关键帧 · 截完后一次建出 12 个镜头', '取消建分镜 参考片-晴天.mp4']);
  const saving = sceneOverviewItems([shots({ state: 'persisting', revision: 3, started: true })], context)[0]!;
  assert.equal(saving.status, '正在建出镜头'); assert.equal(saving.onCancel, undefined);
  const [attention] = sceneOverviewItems([failed()], context);
  assert.deepEqual([attention!.phase, attention!.tone, attention!.status, attention!.detail], ['attention', 'danger', '失败', '参考片在截取时被替换，没有建出镜头']);
  attention!.onRetry!(); assert.deepEqual(context.retried, [otherTaskId]);
  assert.equal(sceneOverviewItems([failed()], { ...context, readOnly: true })[0]!.onRetry, undefined);
  const newer = built({ createdAt: later, updatedAt: later });
  assert.equal(storyboardNeedsAttention(failed(), [newer, failed()]), false);
  assert.deepEqual(sceneOverviewItems([newer, failed()], context), [], 'a built storyboard is neither active nor in need of attention');
  assert.equal(sceneTaskStatus(newer, context), '已建 3 个镜头'); assert.equal(sceneTaskStatus(built({ state: 'undone', revision: 5 }), context), '已撤销');
  const rows = sceneTaskCenterRows([failed(), shots({ id: taskId, state: 'local_result_error', revision: 4, started: true, errorCode: 'SCENE_STORAGE_FAILED', createdAt: later })], context);
  assert.deepEqual(rows.map(row => [row.label, row.status, row.warning, row.retry]), [['建分镜 · 参考片-晴天.mp4', '失败', true, false], ['建分镜 · 参考片-晴天.mp4', '失败', true, true]]);
  assert.equal(renderMessage('zh-Hans', scene.sceneStoryboardErrorMessage('SCENE_KEYFRAME_UNAVAILABLE')), '有一段的中间时刻没有可解码的画面');
});

function loadStrip() {
  const react: {default?: unknown} & Record<string, unknown> = { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => {}] };
  react.default = react;
  const module = { exports: {} as {SceneSegmentStrip(props: unknown): RootTree} }, source = readFileSync(new URL('../apps/web/src/SceneCutBar.tsx', import.meta.url), 'utf8');
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)((name: string) => {
    if (name === 'react') return react;
    if (name.endsWith('I18nProvider.tsx')) return i18nTestModule();
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    if (name === './icons.tsx') return { __esModule: true, default: 'Icon' };
    if (name === './scene-cuts.ts') return cuts;
    throw new Error(`Unexpected segment strip dependency ${name}`);
  }, module, module.exports);
  return module.exports;
}
const tree = (value: RootTree): RootNode[] => Array.isArray(value) ? value.flatMap(tree) : value && typeof value === 'object' ? [value, ...tree(value.props?.children)] : [];
const byTest = (root: RootTree, id: string) => tree(root).find(node => node.props?.['data-testid'] === id);

test('the keyframe strip chooses segments with checkboxes and shows capture states while locked', () => {
  const { SceneSegmentStrip } = loadStrip(), chosen: unknown[] = [], segments = cuts.sceneSegments([30, 60], 90);
  let root = SceneSegmentStrip({ segments, selected: 1, thumbnail: () => undefined, onSelect() {}, chosen: new Set([1, 3]), onChoose: (index: number, value: boolean) => chosen.push([index, value]) });
  const second = byTest(root, 'scene-segment-check-2')!;
  assert.equal(second.props.checked, false); assert.equal(second.props.disabled, false); assert.equal(second.props['aria-label'], '建分镜时用第 2 段');
  second.props.onChange({ target: { checked: true } }); assert.deepEqual(chosen, [[2, true]]);
  assert.equal(tree(root).filter(node => node.props?.['data-chosen'] === 'false').length, 1, 'unchosen segments are dimmed');
  root = SceneSegmentStrip({ segments, selected: null, thumbnail: () => undefined, onSelect() {}, chosen: new Set([1, 3]), keyframes: ['done', 'skipped', 'current'] });
  assert.equal(byTest(root, 'scene-segment-check-1')!.props.disabled, true, 'choices lock while a storyboard is built');
  assert.equal(tree(root).filter(node => node.props?.className === 'scene-segment-capturing').length, 1);
  root = SceneSegmentStrip({ segments, selected: null, thumbnail: () => undefined, onSelect() {} });
  assert.equal(byTest(root, 'scene-segment-check-1'), undefined, 'no choices where storyboards cannot be built');
});

test('the workbench wires storyboards into the dialog, the canvas, the inspector, the toast and the task views', () => {
  const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
  const app = read('App.tsx'), dialog = read('SceneDetectionDialog.tsx');
  assert.match(app, /if \(task\.kind === 'shots'\) \{ storyboardSettled\(task\); return; \}/);
  assert.match(app, /\{storyboardPanel \?\? <Inspector protectEditing=/, 'the batch takes the inspector while it is selected');
  assert.match(app, /<StoryboardBatchFrame shotIds=\{storyboardSummary\.shotIds\}/);
  assert.match(app, /onPaneClick=\{\(\) => \{ setSelectedEdgeId\(null\); setStoryboardBatch\(null\); \}\}/);
  assert.match(app, /<StoryboardToast key=\{storyboardToast\.taskId\}/);
  assert.match(app, /timelineHistoryActionForKey\(event, \{ modalOpen: hasOpenWorkbenchModal\(document\) \}\) !== 'undo'/);
  assert.match(app, /initialChoice=\{sceneTarget\.choice \?\? null\}/);
  assert.match(app, /batchMark: storyboardEdited\.split\(','\)\.includes\(record\.id\) \? 'edited' : null/);
  // Other tests evaluate App slices between neighbouring handlers; the storyboard handlers stay outside them.
  const handlers = app.indexOf('  // Storyboards. A built one is selected as one batch');
  assert.ok(handlers > app.indexOf('  async function moveTimelineClip(') && handlers < app.indexOf('  function renderUncheckedTimeline('));
  assert.match(dialog, /if \(result && !block\) await controller\.createShots\(asset, result\.id, chosenSegments\);/);
  assert.match(dialog, /editable=\{writable && current && !outdated && !storyboard\}/, 'cuts lock while a storyboard is built');
  assert.match(read('TaskPopover.tsx'), /item\.onRetry&&<WorkbenchButton/);
  assert.match(read('Nodes.tsx'), /data-batch-mark=\{data\.batchMark \|\| undefined\}/);
});
