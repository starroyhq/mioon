import type {UseFrameExtractionOptions,UseFrameExtractionResult} from '../apps/web/src/use-frame-extraction.ts';
import type {FrameTaskResponse} from '../packages/contracts/src/frame-extraction.ts';
type HookValue<E extends string>=E extends 'useFrameExtraction'?UseFrameExtractionResult:ElementNode;
import type {ElementTree, ElementNode, HookSlot} from './helpers/strict-timeline-audio-harness-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as frame from '../apps/web/src/frame-extraction.ts';
import * as ranges from '../apps/web/src/source-range-state.ts';
import { lenientFunction } from './helpers/eval-source.ts';
import { translate } from '../packages/i18n/src/index.ts';
const Function = lenientFunction;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), sourceId = id(2), taskId = id(3), resultId = id(4), sha256 = 'a'.repeat(64);
const sourceAsset = { id: sourceId, projectId, name: 'Source', sha256, mimeType: 'video/mp4', duration: 10, width: 1920, height: 1080, sizeBytes: 1000 };
const sourceScope = 'project-1:source-2:1';
const task = (patch:Partial<FrameTaskResponse> = {}):FrameTaskResponse => ({ id: taskId, projectId, requestId: 'capture-original-key', sourceAssetId: sourceId, sourceHash: sha256, sourceFrame: 56, fps: 30, profileId: 'local-png-1024-v1', state: 'queued', revision: 1, started: false, result: null, errorCode: null, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', ...patch });
const success = () => task({ state: 'succeeded', revision: 4, started: true, result: { assetId: resultId, sha256: 'b'.repeat(64), mimeType: 'image/png', width: 1024, height: 576, byteLength: 1000 } });
const page = <T=unknown>(items:T[] = [], owner = projectId) => ({ projectId: owner, items, nextCursor: null });
const deferred = <T = unknown>() => { let resolve!: (value?: T | PromiseLike<T>) => void; const promise = new Promise<T>(yes => { resolve = (yes as (value?: T | PromiseLike<T>) => void); }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const text = (name: string) => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
const nodes = (value: ElementTree): ElementNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];

function hooksHarness<E extends string='default'>(source:string, imports:Record<string,unknown>, exportName:E = 'default' as E, extra:Record<string,unknown> = {}) {
  const slots: HookSlot[] = []; let cursor = 0, layouts: number[] = [], effects: number[] = [], dirty = false, currentProps:Record<string,unknown>|undefined, value:HookValue<E>, stateWrites = 0;
  const effect = (queue: number[], fn:()=>void|(()=>void), deps: readonly unknown[] | undefined) => { const i = cursor++, previous = slots[i]; if (previous && deps!.every((item: unknown, j: number) => Object.is(item, previous.deps![j]))) return; slots[i] = { deps, cleanup: previous?.cleanup, fn }; queue.push(i); };
  const react = {
    createElement: (type: unknown, props: Record<string,unknown>|null, ...children: ElementTree[]) => ({ type, props: { ...props, children } }),
    useRef: (value: unknown) => slots[cursor++] ||= { current: value },
    useState: (value: () => unknown) => { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof value === 'function' ? value() : value }; return [slots[i].value, (update: (arg0: unknown) => unknown) => { const next = typeof update === 'function' ? update(slots[i].value) : update; if (!Object.is(next, slots[i].value)) { stateWrites++; slots[i].value = next; dirty = true; } }]; },
    useMemo: (fn: () => unknown, deps: readonly unknown[] | undefined) => { const i = cursor++, previous = slots[i]; if (!previous || !deps!.every((item: unknown, j: number) => Object.is(item, previous.deps![j]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useLayoutEffect: (fn:()=>void|(()=>void), deps: readonly unknown[] | undefined) => effect(layouts, fn, deps), useEffect: (fn:()=>void|(()=>void), deps: readonly unknown[] | undefined) => effect(effects, fn, deps),
  }; (react as typeof react & {default: unknown}).default = react;
  const module = { exports: {} } as {exports:Record<string,(props:Record<string,unknown>|undefined)=>HookValue<E>>}, code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
  Function('require', 'module', 'exports', ...Object.keys(extra), code)((key: string) => key === 'react' ? react : imports[key] || new Proxy({}, { get: (_, key) => String(key) }), module, module.exports, ...Object.values(extra));
  const flush = (queue: number[]) => { for (const i of queue) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].fn!(); } };
  return {
    render(props = currentProps) { currentProps = props; let count = 0; do { assert.ok(++count < 20, 'hook render settles'); dirty = false; cursor = 0; layouts = []; effects = []; value = module.exports[exportName](props); flush(layouts); flush(effects); } while (dirty); return value; },
    get value() { return value; }, get stateWrites() { return stateWrites; }, unmount() { slots.forEach(slot => slot.cleanup?.()); },
  };
}
function hookFixture(rpc: (operation:string,input:{projectId:string;[key:string]:unknown})=>unknown) {
  const calls:{operation:string;input:unknown}[] = [], configurations: (frame.FrameExtractionConfiguration|undefined)[] = [];
  const imports = { './frame-extraction.ts': { ...frame, createFrameExtractionController: (options: frame.FrameExtractionOptions) => {
    const controller = frame.createFrameExtractionController(options), configure = controller.configure;
    controller.configure = config => { configurations.push(config); return configure(config); }; return controller;
  } } };
  const h = hooksHarness(text('use-frame-extraction.ts'), imports, 'useFrameExtraction');
  const props = { projectId, sourceScope, sourceAsset, assets: [sourceAsset], visible: true, blocked: false,
    rpc: (operation:string,input:{projectId:string;[key:string]:unknown}) => { calls.push({ operation, input }); return rpc(operation, input); }, createRequestId: () => 'capture-original-key' };
  return { h, props, calls, configurations };
}

test('real hook bootstraps read-only history without a Properties panel and never polls or writes by itself', async () => {
  const f = hookFixture((_operation: unknown, input: { projectId: string|undefined; }) => page([], input.projectId));
  f.h.render({ ...f.props, visible: false }); assert.deepEqual((f.calls as unknown), []);
  f.h.render(f.props); await tick(); f.h.render();
  assert.deepEqual(f.calls.map(call => call.operation), ['frame.task.list']); assert.equal(f.h.value.state.historyLoaded, true);
  for (let i = 0; i < 3; i++) f.h.render({ ...f.props, sourceAsset: { ...sourceAsset }, assets: [{ ...sourceAsset }] });
  assert.equal(f.calls.length, 1); assert.equal(f.configurations.length, 2, 'only hidden/visible configuration changes');
  f.h.render({ ...f.props, visible: false }); await f.h.value.controller.refreshActive(); assert.equal(f.calls.length, 1); f.h.unmount();
});

test('semantic polling refresh preserves in-flight identity and latest callbacks receive result without automatic navigation', async () => {
  const hold = deferred(), resultCalls: unknown[][] = [], reveals: (unknown[])[] = [];
  const f = hookFixture((operation: string) => operation === 'frame.task.list' ? page() : operation === 'frame.extract' ? hold.promise : success());
  f.h.render({ ...f.props, onResult: () => assert.fail('old callback'), revealAsset: (...args: unknown[]) => reveals.push(args) }); await tick(); f.h.render();
  const capture = f.h.value.controller.capture({ sourceScope, sourceAssetId: sourceId, sourceHash: sha256, sourceFrame: 56 });
  f.h.render({ ...f.props, sourceAsset: { ...sourceAsset }, assets: [{ ...sourceAsset }], onResult: (...args: unknown[]) => resultCalls.push(args), revealAsset: (...args: unknown[]) => reveals.push(args) });
  assert.equal(f.configurations.length, 1); assert.equal(f.h.value.state.phase, 'submitting');
  f.h.render({ ...f.props, sourceAsset: { ...sourceAsset, name: 'Renamed' }, assets: [{ ...sourceAsset, name: 'Renamed' }], onResult: (...args: unknown[]) => resultCalls.push(args), revealAsset: (...args: unknown[]) => reveals.push(args) });
  assert.equal(f.configurations.length, 2); assert.equal(f.h.value.state.phase, 'submitting', 'metadata updates do not invalidate acceptance');
  hold.resolve!(task()); await capture; f.h.render();
  assert.equal(f.h.value.state.pending, null); assert.equal(f.h.value.state.tasks[0].state, 'succeeded'); assert.equal(resultCalls.length, 1); assert.equal(resultCalls[0][0], projectId); assert.deepEqual((reveals as unknown), []);
  f.h.unmount();
});

test('hook project switch/unmount reject late result callbacks without cancelling accepted backend work', async () => {
  for (const change of ['project', 'unmount']) {
    const hold = deferred(), results: (unknown[])[] = [];
    const f = hookFixture((operation: string) => operation === 'frame.task.list' ? page() : operation === 'frame.extract' ? hold.promise : success());
    f.h.render({ ...f.props, onResult: (...args: unknown[]) => results.push(args) }); await tick(); f.h.render();
    const capture = f.h.value.controller.capture({ sourceScope, sourceAssetId: sourceId, sourceHash: sha256, sourceFrame: 56 });
    if (change === 'project') f.h.render({ ...f.props, projectId: id(9), sourceScope: 'other-project', sourceAsset: { ...sourceAsset, projectId: id(9) }, visible: false });
    else f.h.unmount();
    const writes = f.h.stateWrites; hold.resolve!(task()); await capture;
    assert.deepEqual((results as unknown), []); assert.equal(f.h.stateWrites, writes); assert.equal(f.calls.filter(call => call.operation === 'frame.extract').length, 1); assert.ok(f.calls.every(call => !/cancelQueued|recoverResult/.test(call.operation)));
    if (change === 'project') f.h.unmount();
  }
});

test('actual App hook connects capture/rpc/reveal with source or narrow Properties visibility', async () => {
  const app = text('App.tsx'), start = app.indexOf('  const frameExtraction = useFrameExtraction('), end = app.indexOf('\n\n', start);
  assert.ok(start > 0 && end > start);
  const calls:(Omit<UseFrameExtractionOptions,"onResult">&{onResult?:(projectId:string,task?:FrameTaskResponse)=>unknown})[] = [], controller = { capture: () => {} }, state = { visible: true }, refreshes: (unknown)[] = [];
  const env = { workbenchReady: true, application: null, data: { project: { id: projectId }, assets: [sourceAsset] }, sourceRangeScope: sourceScope, rangeAsset: sourceAsset, workspaceMode: 'editing', rightDockTab: 'agent', panelVisible: (name: string):boolean => name === 'canvas', quickAssetId: sourceId, restored: false, sourceRangeBlocked: false, busy: {}, rpc: () => {}, requestId: () => 'stable-request-key', currentProject: { current: projectId }, refresh: (pid: unknown) => refreshes.push(pid), revealImageAsset: () => {}, useFrameExtraction: (input:Omit<UseFrameExtractionOptions,"onResult">&{onResult?:(projectId:string,task?:FrameTaskResponse)=>unknown}) => { calls.push(input); return { controller, state }; } };
  const evaluate = () => (Function(...Object.keys(env), `${app.slice(start, end)}; return frameExtraction;`)(...Object.values(env))) as {controller:{capture():void};state:{visible:boolean}};
  assert.equal(evaluate().controller, controller); const configured = calls.at(-1);
  assert.equal(configured!.visible, true); assert.equal(configured!.blocked, false); assert.equal(configured!.rpc, env.rpc); assert.equal(configured!.sourceScope, sourceScope); assert.equal(configured!.revealAsset, env.revealImageAsset);
  env.workbenchReady = false; evaluate();
  const homeConfig = calls.at(-1); assert.equal(homeConfig!.projectId, null); assert.equal(homeConfig!.visible, false);
  const homeCalls: (unknown[])[] = [], home = hooksHarness(text('use-frame-extraction.ts'), { './frame-extraction.ts': frame }, 'useFrameExtraction');
  home.render({ ...homeConfig, rpc: (...args: unknown[]) => { homeCalls.push(args); return page(); } }); await tick(); home.render();
  await home.value.controller.refreshTasks(); await home.value.controller.refreshActive();
  assert.deepEqual((homeCalls as unknown), [], 'Retained source metadata on home must not start project frame observation'); home.unmount();
  env.workbenchReady = true;
  configured!.onResult!(projectId); env.currentProject.current = id(9); configured!.onResult!(projectId); assert.deepEqual(refreshes, [projectId]);
  env.busy = { 'canvas:mutation': true }; evaluate(); assert.equal(calls.at(-1)!.blocked, true);
  env.panelVisible = name => name === 'inspector'; env.rightDockTab = 'properties'; evaluate(); assert.equal(calls.at(-1)!.visible, true, 'narrow Properties can read and recover with canvas hidden');
  env.rightDockTab = 'agent'; evaluate(); assert.equal(calls.at(-1)!.visible, false, 'all frame surfaces are hidden');
  env.panelVisible = () => false; env.rightDockTab = 'properties'; evaluate(); assert.equal(calls.at(-1)!.visible, false);
  env.restored = true; env.busy = {}; env.panelVisible = name => name === 'canvas'; evaluate();
  assert.equal(calls.at(-1)!.visible, true); assert.equal(calls.at(-1)!.blocked, true, 'a restored source remains blocked without other busy work');
  const rpcCalls: ({ operation: unknown; input: unknown; })[] = [], h = hooksHarness(text('use-frame-extraction.ts'), { './frame-extraction.ts': frame }, 'useFrameExtraction');
  h.render({ ...calls.at(-1), rpc: (operation: unknown, input: unknown) => { rpcCalls.push({ operation, input }); return page(); } }); await tick(); h.render();
  assert.equal(await h.value.controller.capture({ sourceScope, sourceAssetId: sourceId, sourceHash: sha256, sourceFrame: 56 }), null);
  await h.value.controller.refreshTasks(); await h.value.controller.refreshActive();
  assert.equal(await h.value.controller.cancelQueued(task()), null);
  assert.equal(await h.value.controller.recoverResult(task({ state: 'interrupted' })), null);
  assert.deepEqual((rpcCalls as unknown), [], 'restored mode neither reads live frame history nor starts or controls a task');
  assert.equal(h.value.controller.getSnapshot().pending, null); h.unmount();
  assert.match(app, /onCaptureFrame=\{application \? undefined :/); assert.match(app, /frameExtraction\.controller as unknown as \{capture\(\): unknown\}\)\.capture\(\)/); assert.match(app, /captureBusy=\{frameCaptureBusy\(frameExtraction\.state\)\}/);
  assert.match(app, /quickAssetId && sourceAsset \? application \?/); assert.match(app, /<SourceRangeInspector[^>]+>\{restored \? <RestoredUnavailable[^>]+\/> : <FrameExtractionPanel controller=\{frameExtraction\.controller(?: as never)?\} revealTask=\{agentRecovery\?\.kind === 'frame' \? agentRecovery : null\} \/>\}<\/SourceRangeInspector>/);
});

test('actual App source inspector keeps the normal frame panel and replaces it with the restored hold notice', () => {
  const app = text('App.tsx'), start = app.indexOf('<SourceRangeInspector '), end = app.indexOf('</SourceRangeInspector>', start) + '</SourceRangeInspector>'.length;
  assert.ok(start > 0 && end > start);
  const controller = {}, rangeState = { dirty: true, draft: { inFrame: 12, outFrame: 88 } }, rangeController = {};
  for (const restored of [false, true]) for (const recoveryKind of [null, 'image', 'frame']) {
    const agentRecovery = recoveryKind ? {kind: recoveryKind, projectId, taskId, key: 'fixed-reveal', current: () => true} : null;
    const h = hooksHarness(`import React from 'react'; export default function Fixture() { return (${app.slice(start, end)}); }`, {}, 'default', {
      SourceRangeInspector: 'SourceRangeInspector', FrameExtractionPanel: 'FrameExtractionPanel', RestoredUnavailable: 'RestoredUnavailable', t: (key: unknown) => translate('zh-Hans', (key as unknown as Parameters<typeof translate>[1])),
      restored, sourceAsset, sourceRanges: { state: rangeState, controller: rangeController }, timeline: { projectId }, sourceRangeBlocked: false,
      addSavedSourceRange() {}, frameExtraction: { controller }, agentRecovery, sceneSummary: () => null,
    });
    const tree = h.render(), all = nodes(tree), panel = all.find((node: ElementNode) => node.type === 'FrameExtractionPanel'), notice = all.find((node: ElementNode) => node.type === 'RestoredUnavailable');
    assert.equal(tree.type, 'SourceRangeInspector'); assert.equal(tree.props.asset, sourceAsset);
    assert.equal(tree.props.state, rangeState); assert.equal(tree.props.controller, rangeController);
    assert.equal(Boolean(panel), !restored); assert.equal(Boolean(notice), restored);
    if (restored) assert.equal(notice!.props.title, '抽帧任务保留，执行暂不可用');
    else { assert.equal(panel!.props.controller, controller); assert.equal(panel!.props.revealTask, recoveryKind === 'frame' ? agentRecovery : null, 'only an exact frame recovery intent reaches the retained panel'); }
    assert.deepEqual(rangeState, { dirty: true, draft: { inFrame: 12, outFrame: 88 } }); h.unmount();
  }
});

test('actual source inspector children slot exposes frame history for video and image while preserving range draft controls', () => {
  for (const mimeType of ['video/mp4', 'image/png']) {
    const child = { type: 'FrameHistory', props: { 'data-testid': 'retained-frame-history' } } as unknown as ElementNode, asset = { ...sourceAsset, mimeType };
    const controller = { snapshot: () => null, getState: () => ({ scope: sourceScope }) };
    const h = hooksHarness(text('SourceRangeInspector.tsx'), { './source-range-state.ts': ranges, './workspace-visibility.tsx': { useWorkspaceVisibility: () => true }, './i18n/I18nProvider.tsx': { useI18n: () => ({ t: (key: unknown) => key, renderMessage: (value: { key: unknown; }) => (value && typeof value === 'object' ? String(value.key ?? '') : String(value ?? '')), formatNumber: (value: unknown) => String(value), formatDate: (value: unknown) => String(value) }) } });
    const tree = h.render({ asset, state: { scope: sourceScope, row: null, draft: { inFrame: 20, outFrame: 60 }, dirty: true, position: 30 }, controller, timeline: { projectId, tracks: [], clips: [] }, children: child });
    const all = nodes(tree), scroll = all.find((node: ElementNode) => node.type === 'ScrollArea');
    assert.ok(nodes(scroll).includes(child)); assert.equal(all.filter((node: ElementNode) => node.props?.['data-testid'] === 'source-range-save').length, mimeType.startsWith('video') ? 1 : 0);
    h.unmount();
  }
});

test('actual App reveal only locates the library, keeps source-range draft, and rechecks supplied guard after await', async () => {
  const app = text('App.tsx'), start = app.indexOf('  async function revealImageAsset('), end = app.indexOf('  async function selectProject(', start), source = app.slice(start, end).trim();
  for (const fail of [null, 'before', 'after', 'project', 'navigation', 'panel', 'missing']) {
    const hold = deferred(), actions: (unknown[])[] = [], draft = { dirty: true, inFrame: 12, outFrame: 88 }, selected = { quickAssetId: sourceId, selectedClipId: null }; let current = fail !== 'before';
    const env = { currentProject: { current: projectId }, projectEpoch: { current: 1 }, navigationEpoch: { current: 1 }, panelIntent: { current: 1 }, dataRef: { current: { assets: [] } }, refresh: () => hold.promise,
      updateView: (section: unknown, patch: unknown) => { assert.equal(section, 'shared'); actions.push(['filter', patch]); }, setPanelOpen: (...args: unknown[]) => actions.push(['panel', ...args]), setMobilePanel: (value: unknown) => actions.push(['mobile', value]) };
    const reveal = (Function(...Object.keys(env), `return (${source});`)(...Object.values(env))) as (assetId:string,projectId:string,guard:()=>boolean)=>Promise<boolean>;
    const pending = reveal(resultId, projectId, () => current);
    if (fail === 'after') current = false; if (fail === 'project') env.currentProject.current = id(9); if (fail === 'navigation') env.navigationEpoch.current++; if (fail === 'panel') env.panelIntent.current++;
    hold.resolve!({ assets: fail === 'missing' ? [] : [{ id: resultId, projectId, name: 'Frame.png' }] });
    assert.equal(await pending, fail === null); assert.equal(actions.length, fail ? 0 : 3);
    assert.deepEqual(draft, { dirty: true, inFrame: 12, outFrame: 88 }); assert.deepEqual(selected, { quickAssetId: sourceId, selectedClipId: null });
  }
  assert.doesNotMatch(source, /setSourceDirty|setQuickAssetId|discard\(|previewSource\(|setPreviewAsset|frame\.extract/);
});

test('hidden Properties unsubscribes and cancels its read timer while source controller stays usable', async () => {
  const calls: { operation: string; input: unknown; }[] = [], controller = frame.createFrameExtractionController({ rpc: async (operation, input) => { calls.push({ operation, input }); return operation === 'frame.task.list' ? page([task()]) : task(); } });
  controller.configure({ projectId, sourceScope, sourceAsset, assets: [sourceAsset], visible: true }); await controller.refreshTasks();
  let visible = true, serial = 0, subscriptions = 0; const timers = new Map<number,()=>void>(), subscribe = controller.subscribe;
  controller.subscribe = listener => { subscriptions++; const release = subscribe(listener); return () => { subscriptions--; release(); }; };
  const h = hooksHarness(text('FrameExtractionPanel.tsx'), { './frame-extraction.ts': frame, './workspace-visibility.tsx': { useWorkspaceVisibility: () => visible }, './i18n/I18nProvider.tsx': { useI18n: () => ({ t: (key: unknown) => key, renderMessage: (value: { key: unknown; }) => (value && typeof value === 'object' ? String(value.key ?? '') : String(value ?? '')), formatNumber: (value: unknown) => String(value), formatDate: (value: unknown) => String(value) }) } }, 'default', {
    setTimeout: (fn:()=>void) => { const id = ++serial; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id),
  });
  h.render({ controller }); await tick(); h.render(); assert.equal(timers.size, 1); assert.equal(subscriptions, 1);
  const retained = [...timers.values()][0], handlers = nodes(h.value).filter((node: ElementNode) => node.props?.onClick).map((node: ElementNode) => node.props.onClick), before = calls.length;
  visible = false; h.render(); assert.equal(timers.size, 0); assert.equal(subscriptions, 0); assert.equal(controller.getSnapshot().visible, true);
  retained(); for (const click of handlers) click(); await tick(); assert.equal(calls.length, before); assert.ok(calls.every(call => !/cancelQueued|recoverResult|frame\.extract/.test(call.operation)));
  h.unmount(); controller.dispose();
});
