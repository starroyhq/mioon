import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
type FormatContext=format.TimelineFormatContext&{scope:string;projectId:string;[key:string]:unknown};
type FormatDeferred=ReturnType<typeof deferred>;
type ComponentView=(props:Record<string,unknown>)=>ElementNode;
interface ComponentModule{exports:{default:ComponentView;WorkbenchInspectorTabs:ComponentView;AgentDockPane:ComponentView}}
type ExtractedApp<S extends string>=S extends 'async function saveTimelineFormat('? (intent:format.TimelineFormatIntent)=>Promise<{status:string}>:(...args:unknown[])=>Promise<boolean>;
import type {ElementTree, ElementNode, HookSlot} from './helpers/strict-timeline-audio-harness-types.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import { i18nTestModule, message } from './helpers/i18n.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import { actualAppCloseWarning } from './fixtures/native-close-app-warning.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as exportSettings from '../apps/web/src/export-settings-state.ts';
import * as exportRange from '../apps/web/src/export-range-state.ts';
import * as format from '../apps/web/src/timeline-format-state.ts';
import { createTimelineDeliveryNameController } from '../apps/web/src/export-delivery-state.ts';
import * as deliveryHistory from '../apps/web/src/export-delivery-state.ts';
import { createLocalDeliveryController } from '../apps/web/src/local-delivery-state.ts';
import * as contracts from '@mioon/contracts';
import * as audio from '../apps/web/src/clip-audio-state.ts';
import * as clipDraft from '../apps/web/src/clip-draft-state.ts';
import * as opacityState from '../apps/web/src/clip-opacity-envelope-state.ts';
import * as opacityAssembly from '../apps/web/src/clip-opacity-candidate-assembly.ts';
import * as volumeState from '../apps/web/src/clip-volume-envelope-state.ts';
import * as audioRoleState from '../apps/web/src/clip-audio-role-state.ts';
import * as removalState from '../apps/web/src/timeline-removal.ts';
import * as viewGeometry from '../apps/web/src/timeline-view-geometry.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id = (n: number) => `73000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2);
const context = (patch?:Record<string,unknown>):FormatContext => ({ scope: `${projectId}:1`, projectId, projectRevision: 2, timelineId: null, timelineRevision: 0, connected: true, pending: false, ...patch });
const metadata = (patch?:Record<string,unknown>):format.TimelineFormatSaved => ({ projectId, projectRevision: 2, timelineId: null, timelineRevision: 0, presetId: 'portrait_1080', fps:30 as const,width: 1080, height: 1920, eligible: true, blockedReasons:[] as string[], ...patch });
const timeline = (presetId = 'landscape_1080', revision = 1) => (({ id: timelineId, projectId, revision,
  ...Object.fromEntries(Object.entries(contracts.timelineOutputPreset(presetId as Parameters<typeof contracts.timelineOutputPreset>[0])!).filter(([key]) => ['fps', 'width', 'height'].includes(key))),
  tracks: [{ id: id(3), kind: 'video', name: 'Video', orderIndex: 0, hidden: false, muted: false }], clips: [], durationFrames: 0,
  createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' }) as unknown as FixtureTimeline);
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = (yes as (value?: T | PromiseLike<T>) => void); reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let live = context(), server = metadata(), heldRead:FormatDeferred|null = null;
  const reads: { input: { projectId: string; }; options: format.TimelineFormatReadOptions; }[] = [], submits: format.TimelineFormatIntent[] = [], responses: FormatDeferred[] = [], auth: boolean[] = [];
  let sequence = 0;
  const controller = format.createTimelineFormatController(({
    getContext: () => live,
    read: (input:{projectId:string},options:format.TimelineFormatReadOptions) => { reads.push({ input, options }); const held = heldRead; heldRead = null; return held ? held.promise : Promise.resolve(structuredClone(server)); },
    submit: (intent:format.TimelineFormatIntent) => { submits.push(intent); const response = deferred(); responses.push(response); return response.promise; },
    createRequestId: () => `format-request-${++sequence}`, onUnauthorized: () => auth.push(true),
  } as unknown as Parameters<typeof format.createTimelineFormatController>[0]));
  controller.setContext(live); controller.setVisible(true);
  return { controller, reads, submits, responses, auth, state: () => controller.getState(),
    async ready() { await controller.load(); return controller.getState(); },
    set(patch: { timelineId?: string; timelineRevision?: number; selectedClipId?: string; activeMode?: string; propertiesPage?: string; projectRevision?: number; projectId?: string; scope?: string; connected?: boolean; }, commit = true) { live = { ...live, ...patch }; if (commit) controller.setContext(live); },
    server(patch: Record<string,unknown>) { server = { ...server, ...patch }; },
    holdRead() { heldRead = deferred(); return heldRead; },
    ack(index = 0, presetId = submits[index].input.presetId!) { const value = timeline(presetId, submits[index].input.expectedRevision + 1); server = metadata({ timelineId, timelineRevision: value.revision, presetId, fps: value.fps, width: value.width, height: value.height }); live = { ...live, timelineId, timelineRevision: value.revision }; responses[index].resolve!({ status: 'applied', timeline: value }); return value; },
  };
}

test('closed presets and noncreating read retain exact authoritative eligibility', async () => {
  const f = fixture(); await f.ready();
  assert.deepEqual(format.TIMELINE_OUTPUT_PRESETS.map(preset => [preset.id, preset.width, preset.height, preset.fps]), [
    ['portrait_1080', 1080, 1920, 30], ['landscape_1080', 1920, 1080, 30], ['square_1080', 1080, 1080, 30],
    ['portrait_720', 720, 1280, 30], ['landscape_720', 1280, 720, 30], ['square_720', 720, 720, 30],
  ]);
  assert.deepEqual(f.reads[0].input, { projectId }); assert.equal(f.submits.length, 0);
  assert.equal(f.state().saved!.timelineId, null); assert.equal(f.state().saved!.timelineRevision, 0);
  for (const reason of ['CLIPS_PRESENT', 'HISTORY_PRESENT', 'REQUEST_HISTORY', 'EXPORT_HISTORY', 'PENDING_EDIT']) {
    f.server({ eligible: false, blockedReasons: [reason] }); await f.ready();
    assert.equal(f.controller.choose('landscape_1080'), false); assert.equal(format.timelineFormatCanSave(f.state()), false);
    assert.ok(format.timelineFormatReason(reason));
  }
});

test('saved legacy720 remains readable but new format choices use only the three1080 presets', async () => {
  const f=fixture();f.set({timelineId,timelineRevision:1});f.server({timelineId,timelineRevision:1,presetId:'portrait_720',width:720,height:1280});await f.ready();
  assert.equal(f.state().saved!.presetId,'portrait_720');assert.equal(f.state().saved!.width,720);assert.equal(f.controller.choose('landscape_1080'),true);
  const Panel=component('TimelineFormatPanel.tsx').default,tree=Panel({state:f.state(),controller:f.controller});
  const options=nodes(tree).filter((node: ElementNode)=>node.type==='option');assert.deepEqual(options.map((node:ElementNode)=>node.props.value),['portrait_1080','landscape_1080','square_1080','portrait_720']);
});

test('polls, dock hiding, selection and mode changes preserve the independent format draft', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080');
  const base = structuredClone(f.state().base);
  f.controller.setVisible(false); f.set({ selectedClipId: 'next', activeMode: 'canvas', propertiesPage: 'inspector' }); await f.ready();
  assert.equal(f.state().draftPresetId, 'landscape_1080'); assert.equal(f.state().dirty, true); assert.deepEqual(f.state().base, base);
  assert.equal(await f.controller.save(), null); assert.equal(f.controller.choose('square_1080'), false); assert.equal(f.submits.length, 0);
  f.controller.setVisible(true); assert.equal(f.controller.choose('square_1080'), true); assert.equal(f.state().dirty, true);
});

test('newer authoritative revision preserves dirty choice and prevents blind rebase', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('square_1080');
  f.server({ projectRevision: 3 }); f.set({ projectRevision: 3 }); await f.ready();
  assert.equal(f.state().draftPresetId, 'square_1080'); assert.equal(f.state().base!.projectRevision, 2); assert.equal(f.state().conflict, true);
  assert.equal(await f.controller.save(), null);
  f.controller.discardDraft(); assert.equal(f.state().dirty, false); assert.equal(f.state().base!.projectRevision, 3);
  f.controller.choose('square_1080'); assert.equal(format.timelineFormatCanSave(f.state()), true);
});

test('live owner change before React commit fences late read success and authentication error', async () => {
  for (const failure of [false, true]) {
    const f = fixture(), held = f.holdRead(), waiting = f.controller.load();
    f.set({ projectId: id(9), scope: 'other:2' }, false);
    if (failure) held!.reject!(Object.assign(Error('expired'), { code: 'UNAUTHORIZED' })); else held!.resolve!(metadata());
    await waiting;
    assert.equal(f.state().projectId, id(9)); assert.equal(f.state().saved, null); assert.equal(f.auth.length, 0);
  }
});

test('newer read wins; reconnect keeps draft but cannot revive an unverified save', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('square_1080');
  const held = f.holdRead(), older = f.controller.load(); await f.ready(); held!.resolve!(metadata({ projectRevision: 1 })); await older;
  assert.equal(f.state().saved!.projectRevision, 2);
  f.set({ connected: false }); assert.equal(format.timelineFormatCanSave(f.state()), false);
  f.set({ connected: true }); assert.equal(format.timelineFormatCanSave(f.state()), false);
  await f.ready(); assert.equal(f.state().draftPresetId, 'square_1080'); assert.equal(format.timelineFormatCanSave(f.state()), true);
});

test('save freezes both revisions and exact intent; double click never mints another request', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080');
  const saved = f.controller.save(); assert.equal(await f.controller.save(), null);
  assert.deepEqual(f.submits[0].input, { projectId, expectedProjectRevision: 2, expectedRevision: 0, requestId: 'format-request-1', presetId: 'landscape_1080' });
  assert.ok(Object.isFrozen(f.submits[0].input)); assert.equal(f.submits.length, 1);
  f.ack(); await saved; assert.equal(f.state().dirty, false); assert.equal(f.state().saved!.width, 1920);
  assert.equal(f.state().saved!.timelineRevision, 1); assert.equal(f.controller.hasUnsaved(), false);
  f.controller.choose('square_1080'); const second = f.controller.save(); assert.equal(f.submits[1].input.expectedRevision, 1); f.ack(1); await second;
});

for (const later of ['square_1080', 'portrait_1080']) test(`late ACK does not erase later ${later} draft while the panel is hidden`, async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080'); const saving = f.controller.save();
  f.controller.choose(later); f.controller.setVisible(false); f.ack(); await saving;
  assert.equal(f.state().draftPresetId, later); assert.equal(f.state().dirty, true); assert.equal(f.state().base!.timelineRevision, 1);
  assert.equal(f.state().saved!.presetId, 'landscape_1080'); assert.equal(f.submits.length, 1);
});

test('same project revisited in a newer epoch cannot receive an old save ACK', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080'); const saving = f.controller.save();
  f.set({ scope: `${projectId}:3` }); f.ack(); await saving;
  assert.equal(f.state().scope, `${projectId}:3`); assert.equal(f.state().saved, null); assert.equal(f.state().dirty, false);
});

test('unknown exact intent remains fenced after reads, hiding and reconnect; only explicit matching recovery releases it', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080'); const saving = f.controller.save();
  f.responses[0].resolve!({ status: 'unknown' }); await saving;
  const original = f.state().uncertain; assert.ok(original); assert.match(f.state().error, /同一请求/);
  f.controller.choose('square_1080'); f.controller.setVisible(false); await f.ready(); f.set({ connected: false }); f.set({ connected: true }); f.controller.setVisible(true); await f.ready();
  assert.equal(await f.controller.save(), null); assert.equal(f.submits.length, 1); assert.equal(f.state().uncertain, original);
  const task = { projectId, operation: 'timeline.format.set', requestId: original.input.requestId, input: { ...original.input }, status: 'not_applied' };
  f.controller.recovered({ ...task, input: { ...task.input, presetId: 'square_1080' } }); await tick(); assert.equal(f.state().uncertain, original);
  f.controller.recovered(task); await tick(); assert.equal(f.state().uncertain, null); assert.equal(f.state().draftPresetId, 'square_1080'); assert.equal(f.state().dirty, true);
  assert.equal(f.submits.length, 1);
});

test('historical applied recovery refreshes saved data without acknowledging or replacing the current draft', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('square_1080');
  f.server({ timelineId, timelineRevision: 1, presetId: 'landscape_1080', width: 1920, height: 1080 });
  f.controller.recovered({ projectId, operation: 'timeline.format.set', requestId: 'historical-request', input: {}, status: 'applied' }); await tick();
  assert.equal(f.state().draftPresetId, 'square_1080'); assert.equal(f.state().dirty, true); assert.equal(f.state().conflict, true); assert.equal(f.submits.length, 0);
});

test('malformed or misbound ACK never clears the draft or releases unknown intent', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080'); const saving = f.controller.save();
  f.responses[0].resolve!({ status: 'applied', timeline: timeline('square_1080') }); await saving;
  assert.equal(f.state().dirty, true); assert.ok(f.state().uncertain); assert.equal(format.timelineFormatCanSave(f.state()), false);
});

for (const patch of [{ extra: true }, { projectId: id(9) }, { timelineId, timelineRevision: 0 }, { presetId: 'landscape_1080', width: 1920, height: 1080 }, { width: 720 }, { blockedReasons: ['NEW_UNKNOWN_REASON'], eligible: false }, { blockedReasons: ['CLIPS_PRESENT'], eligible: true }]) {
  test(`format read fails closed: ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); f.server(patch); await f.ready(); assert.equal(f.state().phase, 'error'); assert.equal(f.state().saved, null);
  });
}

const element = (type: unknown, props: Record<string,unknown>|null, ...children: ElementTree[]) => ({ type, props: { ...props, children } });
const nodes = (tree: ElementTree): ElementNode[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const textOf = (tree: ElementTree) :string => Array.isArray(tree) ? tree.map(textOf).join('') : tree && typeof tree === 'object' ? textOf(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const read = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const primitive = new Proxy({ __esModule: true, default: 'Component' }, { get: (target, name) => (target as Record<PropertyKey,unknown>)[name] ?? String(name) });
function component(name:string,imports:Record<string,unknown> = {}) {
  const react = { createElement: element, useEffect() {}, useLayoutEffect() {}, useRef: (current: unknown) => ({ current }), useState: (value: () => unknown) => [typeof value === 'function' ? value() : value, () => {}] } as {createElement:typeof element;useEffect():void;useLayoutEffect():void;useRef(current:unknown):{current:unknown};useState(value:unknown):unknown[];default?:unknown}; (react as typeof react & {default: unknown}).default = react;
  const module = {exports:{}} as ComponentModule;
  Function('module', 'exports', 'require', transformSync(read(name), { loader: name.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code)(module, module.exports, (key: string) => key === './creation-i18n.ts' ? creationI18n : key === './i18n/I18nProvider.tsx' ? i18nTestModule() : key.endsWith('packages/i18n/src/index.ts') ? i18n : key === 'react' ? react : key === '@mioon/contracts' ? contracts : key === './timeline-format-state.ts' ? format : key === './export-settings-state.ts' ? exportSettings : key === './export-range-state.ts' ? exportRange : key === './export-delivery-state.ts' ? deliveryHistory : key === './clip-opacity-envelope-state.ts' ? opacityState : key === './clip-opacity-candidate-assembly.ts' ? opacityAssembly : key === './clip-volume-envelope-state.ts' ? volumeState : key === './clip-audio-role-state.ts' ? audioRoleState : key === './timeline-removal.ts' ? removalState : key === './timeline-view-geometry.ts' ? viewGeometry : key === './UiPreferencesProvider.tsx' ? {useUiPreferences:()=>({preferences:{timecodeFormat:'timecode'}})} : key === './ClipRemovalControls.tsx' ? component('ClipRemovalControls.tsx') : imports[key] || primitive);
  return module.exports;
}

test('actual format panel uses accessible shared controls and tells the truth about scope, fixed fps and blocked reasons', async () => {
  const f = fixture(); await f.ready(); const events: ("back" | "tasks")[] = [];
  const Panel = component('TimelineFormatPanel.tsx').default;
  let tree = Panel({ state: f.state(), controller: f.controller, onBack: () => events.push('back'), onOpenTasks: () => events.push('tasks') });
  const text = textOf(tree);
  for (const label of ['时间线输出规格', '返回属性', '源素材、生成比例不会改变', '分镜导出固定 9:16', '30 fps', '不进入片段撤销历史', '服务器会再次核对资格']) assert.ok(text.includes(label), label);
  assert.match(text, /默认时间线规格（尚未创建）/); assert.doesNotMatch(text, /已保存的时间线规格/);
  const persisted = Panel({ state: { ...f.state(), saved: metadata({ timelineId, timelineRevision: 1 }) }, controller: f.controller });
  assert.match(textOf(persisted), /已保存的时间线规格/); assert.doesNotMatch(textOf(persisted), /默认时间线规格（尚未创建）/);
  assert.equal(tree.props['aria-labelledby'], 'timeline-format-title');
  assert.equal(nodes(tree).find((node: ElementNode) => node.props.htmlFor === 'timeline-format-preset')!.type, 'Label');
  assert.equal(nodes(tree).find((node: ElementNode) => node.props.id === 'timeline-format-preset')!.type, 'WorkbenchSelect');
  assert.equal(nodes(tree).filter((node: ElementNode) => node.type === 'option').length, 3);
  assert.equal(nodes(tree).find((node: ElementNode) => node.props['data-testid'] === 'timeline-format-save')!.props.disabled, true);
  nodes(tree).find((node: ElementNode) => node.props['data-testid'] === 'timeline-format-back')!.props.onClick(); assert.deepEqual(events, ['back']);
  f.server({ eligible: false, blockedReasons: ['CLIPS_PRESENT', 'HISTORY_PRESENT', 'REQUEST_HISTORY', 'EXPORT_HISTORY', 'PENDING_EDIT'] }); await f.ready();
  tree = Panel({ state: f.state(), controller: f.controller });
  for (const reason of f.state().saved!.blockedReasons) assert.ok(textOf(tree).includes(format.timelineFormatReason(reason)));
  assert.equal(nodes(tree).find((node: ElementNode) => node.props.id === 'timeline-format-preset')!.props.disabled, true);
  assert.doesNotMatch(read('TimelineFormatPanel.tsx'), /<input|<select|<button|role="dialog"|\brpc\(|useEffect/);
});

test('retained format panel callbacks cannot edit, reset, read or submit a revisited project epoch', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080');
  const Panel = component('TimelineFormatPanel.tsx').default, old = Panel({ state: f.state(), controller: f.controller });
  f.set({ scope: `${projectId}:2` }); await f.ready(); f.controller.choose('square_1080');
  const count = f.reads.length;
  nodes(old).find((node: ElementNode) => node.props.id === 'timeline-format-preset')!.props.onChange({ target: { value: 'portrait_1080' } });
  for (const label of ['保存输出规格', '重新核对', '载入已保存规格']) await nodes(old).find((node: ElementNode) => node.type === 'Button' && textOf(node) === label)!.props.onClick();
  assert.equal(f.state().draftPresetId, 'square_1080'); assert.equal(f.state().dirty, true); assert.equal(f.submits.length, 0); assert.equal(f.reads.length, count);
});

test('actual preview labels legacy frozen job dimensions, never the new current timeline', () => {
  const Preview = component('Preview.tsx', { './workspace-visibility.tsx': { useWorkspaceVisibility: () => true }, './api.ts': { assetUrl: () => '', statusText: () => '成功' }, './Timeline.tsx': { assetKind: () => 'video', framesLabel: String } }).default;
  const tree = Preview({ kind: 'timeline', timeline: timeline('landscape_1080', 9), job: { id: id(7), status: 'succeeded', url: '/media/old', timelineRevision: 1, snapshot: { timeline: timeline('square_720', 1) } }, playhead: 30 });
  const label = nodes(tree).find((node: ElementNode) => node.props.className === 'edit-preview-format');
  assert.match(textOf(label), /720 × 720 · 30 fps/); assert.doesNotMatch(textOf(label), /1920/);
  const missing = Preview({ kind: 'timeline', timeline: timeline('landscape_1080', 9), job: { status: 'succeeded', url: '/media/old', timelineRevision: 1 }, playhead: 0 });
  assert.match(textOf(nodes(missing).find((node: ElementNode) => node.props.className === 'edit-preview-format')), /快照规格不可用/);
});

test('actual monitor header and preflight summary use their own saved dimensions', () => {
  const Preview = component('Preview.tsx', { './workspace-visibility.tsx': { useWorkspaceVisibility: () => true }, './api.ts': { assetUrl: () => '' }, './Timeline.tsx': { assetKind: () => 'video' } }).default;
  const tree = Preview({ kind: 'timeline', timeline: timeline('landscape_1080'), playhead: 0 });
  assert.equal(textOf(nodes(tree).find((node: ElementNode) => node.props.className === 'edit-preview-format')), '1920 × 1080 · 30 fps');
  const Panel = component('TimelineExportPreflight.tsx').default;
  const summary = { fps: 30, width: 1080, height: 1080, durationFrames: 90, trackCount: 1, clipCount: 1, assetCount: 1 };
  const report = Panel({ state: { phase: 'ready', report: { timelineRevision: 1, checkedAt: '2026-10-11T00:00:00Z', issues: [], summary, checks: { checkedAssets: 1, totalAssets: 1, bytesHashed: 0 } } } });
  assert.match(textOf(report), /1080 × 1080 · 30 fps/); assert.doesNotMatch(textOf(report), /1920/);
});

test('actual inspector bounds follow landscape and square timelines and reject odd or overflowing rectangles', () => {
  const Inspector = component('TimelineInspector.tsx', { './clip-audio-state.ts': audio, './Timeline.tsx': { assetKind: () => 'image', framesLabel: String }, '@mioon/ui/components/workbench-confirm': { useConfirmation: () => async () => true }, './workspace-visibility.tsx': { useWorkspaceVisibility: () => true }, './clip-draft-state.ts': clipDraft,
    './clip-draft-hook.ts': { useClipDraft: ({context}:{context:Parameters<typeof clipDraft.createClipDraftController>[0]["context"]}) => { const controller = clipDraft.createClipDraftController(({ context, client: { get: () => assert.fail('Static bounds inspection does not load persistence') } } as unknown as Parameters<typeof clipDraft.createClipDraftController>[0])); return { state: controller.getState(), controller }; } },
  }).default;
  for (const preset of ['landscape_1080', 'square_1080']) {
    const saved = timeline(preset), rect = { x: 0, y: 0, width: saved.width, height: saved.height };
    const tree = Inspector({ clip: { id: id(4), trackId: id(3), name: 'Image', rect, startFrame: 0, durationFrames: 30, sourceInFrame: 0, gain: 1 }, timeline: saved, asset: { mimeType: 'image/png' } });
    for (const key of ['x', 'width', 'y', 'height']) assert.equal(nodes(tree).find((node: ElementNode) => node.props.id === `clip-${key}`)!.props.max, ['x', 'width'].includes(key) ? saved.width : saved.height);
    assert.equal(format.timelineRectIssue(rect, (saved as unknown as Parameters<typeof format.timelineRectIssue>[1])), '');
    assert.match(format.timelineRectIssue({ ...rect, x: 2 }, (saved as unknown as Parameters<typeof format.timelineRectIssue>[1])), /超出/);
    assert.match(format.timelineRectIssue({ ...rect, width: 3 }, (saved as unknown as Parameters<typeof format.timelineRectIssue>[1])), /偶数/);
    assert.match(format.timelineRectIssue({ ...rect, height: 0 }, (saved as unknown as Parameters<typeof format.timelineRectIssue>[1])), /有效偶数/);
  }
});

const app = read('App.tsx');
function appFunction<S extends string>(name:S,end:string,env:Record<string,unknown>) {
  const start = app.indexOf(`  ${name}`), stop = app.indexOf(`  ${end}`, start);
  assert.ok(start >= 0 && stop > start, 'Actual App callback boundaries must remain present');
  assert.equal(app.indexOf(`  ${name}`, start + name.length + 2), -1, 'The extracted callback must have a unique owner');
  const scope = {msg: message, clipDraftRef: {current: null}, ...env};
  return Function(...Object.keys(scope), `${app.slice(start, stop)}; return ${name.replace(/^async function |^function /, '').split('(')[0]};`)(...Object.values(scope)) as ExtractedApp<S>;
}
test('actual project-leave guard checks the independent draft and only discards after accepted current-owner navigation', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080');
  let approved = false; const checks: { dirty: unknown; }[]|{ message: unknown; dirty: unknown; }[] = [];
  const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', { nativeWindow: null, timelineFormatRef: { current: f }, deliveryNameRef: { current: null }, localDeliveryRef: { current: null }, guardNavigation: async (message: unknown, dirty: unknown) => { checks.push({ message, dirty }); return approved; } });
  assert.equal(await guard('leave'), false); assert.equal(f.state().dirty, true); assert.equal(checks[0].dirty, true);
  approved = true; assert.equal(await guard('leave'), true); assert.equal(f.state().dirty, false);
  assert.match(app, /selectProject[\s\S]*?guardProjectNavigation\(draftMessage/);
  assert.match(app, /async function createProject[\s\S]*?guardProjectNavigation\(/);
  assert.match(app, /onPop = async[\s\S]*?selectProject\(id, false, true\)/);
  assert.match(app, /readLegacySnapshot:[\s\S]*format: timelineFormatRef\.current\?\.controller/);
});

test('actual navigation epoch guard prevents late confirmation from discarding a newer project draft', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080');
  let epoch = 1; const confirmation = deferred();
  const guardNavigation = appFunction('async function guardNavigation(', 'async function guardProjectNavigation(', { nativeWindow: null,
    shotTextRef: { current: null }, clipDraftRef: { current: null },
    subtitlesRef: { current: { controller: { getState: () => null, hasUnsaved: () => false, discardDraft() { assert.fail('Late confirmation must not discard subtitle drafts'); } } } }, setSubtitleDirty() { assert.fail('Late confirmation must not clear subtitle state'); },
    context: () => ({ projectId, epoch }), isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === projectId && captured.epoch === epoch,
    dirtyRef: { current: false }, confirm: () => confirmation.promise,
  });
  const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', { nativeWindow: null, timelineFormatRef: { current: f }, deliveryNameRef: { current: null }, localDeliveryRef: { current: null }, guardNavigation });
  const leaving = guard('leave'); epoch++; f.set({ scope: `${projectId}:2` }); await f.ready(); f.controller.choose('square_1080');
  confirmation.resolve!(true); assert.equal(await leaving, false); assert.equal(f.state().draftPresetId, 'square_1080'); assert.equal(f.state().dirty, true);
});

function deliveryNameController() {
  const live = { scope: context().scope, projectId, enabled: true };
  const controller = createTimelineDeliveryNameController({ getContext: () => live });
  controller.setContext(live);
  return controller;
}

for (const outcome of ['accepted unchanged', 'cancelled', 'newer name', 'name changed back', 'replacement controller', 'replacement local controller', 'newer project epoch', 'newer format', 'replacement format controller']) {
  test(`actual project guard preserves combined format and delivery-name drafts unless confirmation is current: ${outcome}`, async t => {
    const f = fixture(); await f.ready(); assert.equal(f.controller.choose('landscape_1080'), true);
    const delivery = deliveryNameController(); assert.equal(delivery.choose('First delivery', context().scope), true);
    const deliveryNameRef = { current: { controller: delivery } }, confirmation = deferred(), checks: (unknown)[] = [];
    let epoch = 1;
    const getLocalContext = () => ({ scope: `${projectId}:${epoch}`, projectId, timelineId, timelineRevision: 1,
      restored: false, connected: true, visible: true, busy: false,
      deliveryName: deliveryNameRef.current.controller.getName(context().scope),
      nameVersion: deliveryNameRef.current.controller.getVersion(context().scope), dirty: deliveryNameRef.current.controller.hasUnsaved() });
    const makeLocalController = () => {
      const controller = createLocalDeliveryController({ context: getLocalContext(), getContext: getLocalContext,
        isRenderInput: value => contracts.schemas['timeline.render'].safeParse(value).success,
        validateResponse: (input, result) => contracts.isTimelineMutationResponse('timeline.render', input, result) });
      t.after(() => controller.dispose()); return controller;
    };
    const local = makeLocalController(), localDeliveryRef = { current: { controller: local } }, timelineFormatRef = { current: f };
    const guardNavigation = appFunction('async function guardNavigation(', 'async function guardProjectNavigation(', { nativeWindow: null,
      shotTextRef: { current: null }, clipDraftRef: { current: null },
      context: () => ({ projectId, epoch }), isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === projectId && captured.epoch === epoch,
      subtitlesRef: { current: null }, dirtyRef: { current: false },
      confirm: (message: unknown) => { checks.push(message); return confirmation.promise; },
    });
    const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', { nativeWindow: null,
      timelineFormatRef, deliveryNameRef, localDeliveryRef, guardNavigation,
    });
    const leaving = guard('Discard both drafts?');
    assert.deepEqual(checks, ['Discard both drafts?']);
    assert.equal(f.controller.hasUnsaved(), true); assert.equal(delivery.hasUnsaved(), true);
    assert.equal(f.state().draftPresetId, 'landscape_1080'); assert.equal(delivery.getState().value, 'First delivery');
    if (outcome === 'newer name' || outcome === 'name changed back') {
      assert.equal(delivery.choose('Newer delivery', context().scope), true);
      if (outcome === 'name changed back') assert.equal(delivery.choose('First delivery', context().scope), true);
    }
    if (outcome === 'replacement controller') {
      const replacement = deliveryNameController(); assert.equal(replacement.choose('First delivery', context().scope), true);
      assert.deepEqual(replacement.getState(), delivery.getState());
      deliveryNameRef.current = { controller: replacement };
    }
    if (outcome === 'replacement local controller') localDeliveryRef.current = { controller: makeLocalController() };
    if (outcome === 'newer project epoch') epoch++;
    if (outcome === 'newer format') assert.equal(f.controller.choose('square_1080'), true);
    if (outcome === 'replacement format controller') {
      const replacement = fixture(); await replacement.ready(); assert.equal(replacement.controller.choose('landscape_1080'), true);
      assert.deepEqual(replacement.state(), f.state()); timelineFormatRef.current = replacement;
    }
    localDeliveryRef.current.controller.setContext(getLocalContext());
    const localDraft = local.getState(), currentLocal = localDeliveryRef.current.controller, currentLocalDraft = currentLocal.getState();
    const currentFormat = timelineFormatRef.current, currentFormatDraft = currentFormat.state();
    const formatDraft = f.state(), originalNameDraft = delivery.getState(), currentDelivery = deliveryNameRef.current.controller, currentNameDraft = currentDelivery.getState();
    confirmation.resolve!(outcome !== 'cancelled');
    const accepted = outcome === 'accepted unchanged';
    assert.equal(await leaving, accepted);
    assert.equal(f.controller.hasUnsaved(), !accepted); assert.equal(currentDelivery.hasUnsaved(), !accepted);
    if (accepted) {
      assert.equal(f.state().dirty, false); assert.equal(f.state().draftPresetId, 'portrait_1080');
      assert.equal(currentDelivery.getState().dirty, false); assert.equal(currentDelivery.getState().value, '');
      assert.equal(currentLocal.getState().leaveWithoutSaving, true); assert.equal(currentLocal.getState().autosavePaused, true);
    } else {
      assert.equal(f.state(), formatDraft); assert.equal(f.state().dirty, true);
      assert.equal(currentFormat.state(), currentFormatDraft); assert.equal(currentFormat.state().dirty, true);
      assert.equal(delivery.getState(), originalNameDraft); assert.equal(delivery.hasUnsaved(), true);
      assert.equal(currentDelivery.getState(), currentNameDraft); assert.equal(currentDelivery.getState().dirty, true);
      assert.equal(local.getState().leaveWithoutSaving, localDraft.leaveWithoutSaving);
      assert.equal(local.getState().autosavePaused, localDraft.autosavePaused);
      assert.equal(currentLocal.getState().leaveWithoutSaving, currentLocalDraft.leaveWithoutSaving);
      assert.equal(currentLocal.getState().autosavePaused, currentLocalDraft.autosavePaused);
      assert.equal(currentLocal.getState().dirty, true);
    }
    assert.equal(f.submits.length, 0); assert.equal(currentFormat.submits.length, 0);
  });
}

test('newer delivery title during joint confirmation preserves dirty inspector, format and local draft together', async t => {
  const f = fixture(); await f.ready(); assert.equal(f.controller.choose('landscape_1080'), true);
  const delivery = deliveryNameController(); assert.equal(delivery.choose('First delivery', context().scope), true);
  const getLocalContext = () => ({ scope: context().scope, projectId, timelineId, timelineRevision: 1,
    restored: false, connected: true, visible: true, busy: false, deliveryName: delivery.getName(context().scope),
    nameVersion: delivery.getVersion(context().scope), dirty: delivery.hasUnsaved() });
  const local = createLocalDeliveryController({ context: getLocalContext(), getContext: getLocalContext,
    isRenderInput: value => contracts.schemas['timeline.render'].safeParse(value).success,
    validateResponse: (input, result) => contracts.isTimelineMutationResponse('timeline.render', input, result) });
  t.after(() => local.dispose());
  const confirmation = deferred(), dirtyRef = { current: true }, resets: ("discard subjects" | string)[] = [], prompts: (unknown)[] = [];
  const guardNavigation = appFunction('async function guardNavigation(', 'async function guardProjectNavigation(', { nativeWindow: null,
    context: () => ({ projectId, epoch: 1 }), isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === projectId && captured.epoch === 1,
    shotTextRef: { current: null }, clipDraftRef: { current: null }, subtitlesRef: { current: null }, dirtyRef,
    subjectsRef: { current: { state: { scope: context().scope }, controller: { discardDrafts: () => resets.push('discard subjects') } } },
    confirm: (message: unknown) => { prompts.push(message); return confirmation.promise; },
    ...Object.fromEntries(['setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch'].map(name => [name, () => resets.push(name)])),
  });
  const guard = appFunction('async function guardProjectNavigation(', 'async function changeMode(', { nativeWindow: null,
    timelineFormatRef: { current: f }, deliveryNameRef: { current: { controller: delivery } }, localDeliveryRef: { current: { controller: local } }, guardNavigation,
  });
  const leaving = guard('Discard all current drafts?'); assert.deepEqual(prompts, ['Discard all current drafts?']);
  assert.equal(delivery.choose('Newer delivery', context().scope), true); local.setContext(getLocalContext());
  const formatDraft = f.state(), nameDraft = delivery.getState(), localDraft = local.getState();
  confirmation.resolve!(true); assert.equal(await leaving, false);
  assert.equal(dirtyRef.current, true); assert.deepEqual((resets as unknown), []);
  assert.equal(f.state(), formatDraft); assert.equal(f.controller.hasUnsaved(), true);
  assert.equal(delivery.getState(), nameDraft); assert.equal(delivery.hasUnsaved(), true);
  assert.equal(local.getState(), localDraft); assert.equal(local.hasUnsaved(), true);
  assert.equal(local.getState().leaveWithoutSaving, false); assert.equal(local.getState().autosavePaused, false);
  assert.equal(f.submits.length, 0);
});

test('actual format save callback uses only the existing durable timeline lane and exact frozen input', async () => {
  const f = fixture(); await f.ready(); f.controller.choose('landscape_1080'); const pending = f.controller.save(); const intent = f.submits[0];
  const calls: unknown[][] = [];
  const save = appFunction('async function saveTimelineFormat(', 'const timelineFormat =', { timelineFormatContext: () => context(), isDurableEditOperation: (value: string) => contracts.DURABLE_EDIT_OPERATIONS.includes(value as typeof contracts.DURABLE_EDIT_OPERATIONS[number]),
    runDurable: async (...args:{validateResponse:(timeline:FixtureTimeline)=>void}[]) => { calls.push(args); args[4].validateResponse(timeline()); return timeline(); }, timelineFormatAcknowledged: format.timelineFormatAcknowledged,
    tasksRef: { current: { blocked: () => false } } });
  assert.equal((await save(intent)).status, 'applied'); assert.equal(calls[0][0], 'timeline:mutation'); assert.equal(calls[0][1], 'timeline.format.set'); assert.equal(calls[0][2], intent.input);
  f.ack(); await pending;
});

test('App keeps both Properties subpages mounted and keeps format dirtiness outside inspector reset logic', () => {
  transformSync(app, { loader: 'tsx', format: 'esm' });
  for (const id of ['properties-inspector-pane', 'properties-format-pane', 'properties-subtitle-pane']) assert.ok(app.includes(`<AgentDockPane id="${id}"`));
  const {WorkbenchInspectorTabs}=component('WorkbenchShell.tsx');
  for(const [mode,expected] of [['canvas',['properties','versions','agent']],['editing',['properties','agent']]] as const) {
    const tabs=WorkbenchInspectorTabs({mode,value:'properties',onValueChange(){},agentDisabled:false,labels:{workspace:'Workspace',properties:'Properties',versions:'Versions',agent:'Agent'}});
    assert.deepEqual(nodes(tabs).filter((node: ElementNode)=>node.props['data-testid']?.startsWith('right-dock-tab-')).map((node: ElementNode)=>node.props.value),expected);
  }
  assert.match(app + readFileSync(new URL('../apps/web/src/TaskPopover.tsx', import.meta.url), 'utf8'), /data-testid="right-dock-tab-tasks"/);
  assert.match(app, /const inspectorDirty = shotDirty \|\| clipDirty \|\| sourceDirty \|\| subjectDirty \|\| subtitleDirty;/);
  assert.match(app, /visible=\{propertiesPage === 'inspector' \|\| propertiesPage === 'subtitle' && workspaceMode === 'canvas'\}/); assert.match(app, /visible=\{propertiesPage === 'format'\}/);
  const open = app.slice(app.indexOf('  function openTimelineFormat()'), app.indexOf('  function subtitleContext()'));
  assert.doesNotMatch(open, /guardNavigation|setInspectorEpoch|setSelected|setQuickAsset|setSourceDirty|discardDraft/);
  const wrapper = read('AgentWorkspace.tsx'); assert.match(wrapper, /hidden=\{!shown\} inert=\{!shown\}/);
  const controls = read('WorkspaceControls.tsx'); assert.match(controls, /if \(!visible\) \{ setOpen\(false\)/); assert.match(controls, /inert=\{!popup.visible\}/);
  const task = read('TaskCenter.tsx'); assert.match(task, /DURABLE_EDIT_OPERATIONS\.length/); assert.equal(contracts.DURABLE_EDIT_OPERATIONS.length, 21); assert.equal(contracts.DURABLE_EDIT_OPERATIONS.filter(operation => operation === 'timeline.clip.rippleRemove').length, 1); assert.equal(contracts.DURABLE_EDIT_OPERATIONS.at(-1), 'timeline.loudness.apply');
});

test('actual dock pane retains child identity while hidden and removes it from focus and accessibility navigation', () => {
  const { AgentDockPane } = component('AgentWorkspace.tsx', { './workspace-visibility.tsx': { useWorkspaceVisibility: () => true, WorkspaceVisibilityProvider: 'VisibilityProvider' } });
  const draftChild = {type:'Draft',props:{value:'retained'}} as unknown as ElementNode;
  for (const visible of [true, false, true]) {
    const tree = AgentDockPane({ visible, children: draftChild, id: 'format-pane', labelledBy: 'format-label', fallbackFocus: '#properties' });
    const pane = nodes(tree).find((node: ElementNode) => node.props.id === 'format-pane');
    assert.equal(pane!.props.hidden, !visible); assert.equal(pane!.props.inert, !visible); assert.equal(pane!.props['aria-hidden'], !visible || undefined);
    assert.equal(pane!.props.role, 'tabpanel'); assert.equal(pane!.props['aria-labelledby'], 'format-label'); assert.ok(pane!.props.children.includes(draftChild));
  }
});

test('actual unload callback sees synchronous format edits and in-flight saves through its independent owner', async () => {
  const f = fixture(); await f.ready();
  const dirtyRef = { current: false }, warn = actualAppCloseWarning(app, { dirtyRef, timelineFormatRef: { current: f }, deliveryNameRef: { current: null }, clipDraftRef: { current: null }, shotTextRef: { current: null } });
  const event = (): {prevented:boolean;returnValue?:string;preventDefault():void} => ({ prevented: false, preventDefault() { this.prevented = true; } });
  let e = event(); warn(e); assert.equal(e.prevented, false);
  f.controller.choose('landscape_1080'); e = event(); warn(e); assert.equal(e.prevented, true); assert.equal(e.returnValue, '');
  const saving = f.controller.save(); e = event(); warn(e); assert.equal(e.prevented, true);
  f.ack(); await saving; e = event(); warn(e); assert.equal(e.prevented, false);
  dirtyRef.current = true; e = event(); warn(e); assert.equal(e.prevented, true);
});

test('actual unload callback observes either current format or delivery-name controller without retaining replaced owners', async () => {
  const f = fixture(); await f.ready(); const delivery = deliveryNameController();
  const timelineFormatRef = { current: f }, deliveryNameRef = { current: { controller: delivery } };
  const warn = actualAppCloseWarning(app, { dirtyRef: { current: false }, timelineFormatRef, deliveryNameRef, clipDraftRef: { current: null }, shotTextRef: { current: null } });
  const check = (expected: boolean) => {
    const event:{prevented:boolean;returnValue?:string;preventDefault():void} = { prevented: false, preventDefault() { this.prevented = true; } }; warn(event);
    assert.equal(event.prevented, expected); assert.equal(event.returnValue, expected ? '' : undefined);
  };
  check(false);
  assert.equal(f.controller.choose('landscape_1080'), true); check(true);
  f.controller.discardDraft(); check(false);
  assert.equal(delivery.choose('First delivery', context().scope), true); check(true);
  assert.equal(delivery.discardDraft(), true); check(false);
  assert.equal(f.controller.choose('square_1080'), true); assert.equal(delivery.choose('Retained delivery', context().scope), true); check(true);
  const replacementFormat = fixture(); await replacementFormat.ready(); const replacementDelivery = deliveryNameController();
  timelineFormatRef.current = replacementFormat; deliveryNameRef.current = { controller: replacementDelivery };
  assert.equal(f.controller.hasUnsaved(), true); assert.equal(delivery.hasUnsaved(), true); check(false);
  assert.equal(replacementDelivery.choose('Current delivery', context().scope), true); check(true);
  assert.equal(replacementDelivery.discardDraft(), true); check(false);
  assert.equal(replacementFormat.controller.choose('landscape_1080'), true); check(true);
  replacementFormat.controller.discardDraft(); check(false);
  assert.equal(f.submits.length, 0); assert.equal(replacementFormat.submits.length, 0);
});

test('actual hook keeps the project draft across visibility and polling without creating a mutation', async () => {
  const slots: HookSlot[] = [], reads: (unknown)[] = [], submits: (unknown)[] = [];
  let cursor = 0, effects: number[] = [], props = { ...context(), visible: false, refreshKey: 0 };
  const react = {
    useRef(value: unknown) { return slots[cursor++] ||= { current: value }; },
    useState(value: unknown) { const i = cursor++; slots[i] ||= { value }; return [slots[i].value, (next: unknown) => { slots[i].value = next; }]; },
    useLayoutEffect(callback: () => void | (() => void), dependencies: unknown[]) { const i = cursor++, old = slots[i]; if (old && dependencies.every((value: unknown, index:number) => Object.is(value, old.dependencies![index]))) return; slots[i] = { dependencies, callback, cleanup: old?.cleanup }; effects.push(i); },
  };
  const module={exports:{}} as {exports:typeof import("../apps/web/src/use-timeline-format.ts")};
  Function('module', 'exports', 'require', transformSync(read('use-timeline-format.ts'), { loader: 'ts', format: 'cjs' }).code)(module, module.exports, (name: string) => name === 'react' ? react : format);
  function render(patch = {}) {
    props = { ...props, ...patch }; cursor = 0; effects = [];
    const value = module.exports.useTimelineFormat(({ ...props, getContext: () => props,
      read: async (input: unknown) => { reads.push(input); return metadata(); }, submit: async (intent: unknown) => { submits.push(intent); }, createRequestId:()=> 'format-hook-request'} as unknown as Parameters<typeof module.exports.useTimelineFormat>[0]));
    for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback!(); }
    return value;
  }
  let value = render(); assert.equal(reads.length, 0);
  value = render({ visible: true }); await tick(); value = render(); assert.equal(value.state!.saved!.presetId, 'portrait_1080');
  value.controller.choose('landscape_1080'); value = render({ visible: false });
  assert.equal(value.state!.draftPresetId, 'landscape_1080'); assert.equal(value.state!.dirty, true);
  const count = reads.length; value = render({ refreshKey: 1 }); await tick(); assert.equal(reads.length, count);
  value = render({ visible: true }); await tick(); value = render(); assert.equal(value.state!.draftPresetId, 'landscape_1080');
  assert.equal(value.state!.dirty, true); assert.equal(submits.length, 0);
  for (const slot of slots) slot.cleanup?.(); assert.equal(value.controller.getState().saved, null);
});
