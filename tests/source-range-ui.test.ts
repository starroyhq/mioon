import type {SourceRangeControllerOptions, SourceRangeContext, SourceRangeSaveInput} from '../apps/web/src/source-range-state.ts';
import type {RootProps} from './helpers/strict-root-ui-types.ts';
import type {SourceRangeResponse} from '../packages/contracts/src/source-range.ts';
interface SourceBoundaryNode extends RootNode {props: RootProps & {children: SourceBoundaryNode[]; canRelease(): boolean}}
type RangeRun = (key: string, operation: string, input: unknown, message?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
import type {RootHook} from './helpers/strict-root-ui-types.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import { i18nTestModule, message, renderMessage, translate } from './helpers/i18n.ts';
import test from 'node:test';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createSourceRangeController, sourceFrameCount, sourcePositionFrame, sourceRangeIssue, sourceRangeMessage, sourceRangeAddPlan } from '../apps/web/src/source-range-state.ts';
import { assertMutationOwner, prepareMutation, validateMutationResponse, isMutationOperation, mutationNotApplied } from '../apps/web/src/mutation-submissions.ts';
import { readPending, clearPending, prepareSubmission, pendingForProject } from '../apps/web/src/submissions.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const taskIntentModule = { exports: {} as typeof import('../apps/web/src/task-workspace-intent.ts') };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const asset = (patch: { id?: string; projectId?: string; mimeType?: string; }|undefined = {}) => ({ id: 'asset-a', projectId: 'project-a', mimeType: 'video/mp4', name: 'Source', duration: 1200, ...patch });
const row = (revision = 0, range: {inFrame: number; outFrame: number} | null = null, source = asset()): SourceRangeResponse => ({ id: source.id, assetId: source.id, projectId: source.projectId, revision, range, sourceFrameCount: sourceFrameCount(source.duration)!, fps: 30 });
const context = (patch: Partial<SourceRangeContext> = {}): SourceRangeContext => ({ scope: 'project-a:1:asset-a:1', projectId: 'project-a', asset: asset(), ...patch });
const deferred = () => { let resolve!: (value?: unknown) => void, reject!: (error: unknown) => void; const promise = new Promise<unknown>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
async function controllerFixture({ initial = row(), read, save = async input => row(input.expectedRevision + 1, { inFrame: input.inFrame, outFrame: input.outFrame }), ctx = context() }: {initial?: unknown; read?: SourceRangeControllerOptions["read"]; save?: SourceRangeControllerOptions["save"]; ctx?: SourceRangeContext} = {}) {
  const controller = createSourceRangeController({ read: read || (async () => initial), save });
  controller.setContext(ctx); await flush();
  return controller;
}
const timeline = (patch: { clips?: { id: string; trackId: string; startFrame: number; durationFrames: number; }[]|{ trackId: string; startFrame: number; durationFrames: number; }[]; tracks?: never[]; }|undefined = {}) => ({ projectId: 'project-a', revision: 7, tracks: [{ id: 'video', kind: 'video' }, { id: 'audio', kind: 'audio' }], clips: [], ...patch });
function storage(t: test.TestContext) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index], getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key) } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete (globalThis as {sessionStorage?: unknown}).sessionStorage);
}

test('shared source frames are uncapped, positive, safe and deterministic at fractional boundaries', () => {
  assert.equal(sourceFrameCount(1200), 36000);
  assert.equal(sourceFrameCount(1 / 30), 1);
  assert.equal(sourceFrameCount(1.999), 59);
  for (const duration of [undefined, null, '20', 0, -1, NaN, Infinity, .01, Number.MAX_SAFE_INTEGER]) assert.equal(sourceFrameCount(duration), null);
  assert.equal(sourcePositionFrame(2.499, 36000), 74);
  assert.equal(sourcePositionFrame(1 / 30, 36000), 1);
  assert.equal(sourcePositionFrame(1201, 36000), 36000);
  for (const range of [{ inFrame: '', outFrame: 2 }, { inFrame: 0.5, outFrame: 2 }, { inFrame: 2, outFrame: 2 }, { inFrame: -1, outFrame: 2 }, { inFrame: 0, outFrame: 36001 }]) assert.ok(sourceRangeIssue(range, 36000));
  assert.equal(sourceRangeIssue({ inFrame: '20000', outFrame: '35999' }, 36000), '');
});

test('default full source is never treated as explicitly saved, even when untouched', async () => {
  const controller = await controllerFixture();
  assert.deepEqual(controller.getState().draft, { inFrame: 0, outFrame: 36000 });
  assert.equal(controller.getState().dirty, false); assert.equal(controller.snapshot(), null);
  await controller.save();
  assert.equal((controller.getState().row)!.revision, 1); assert.equal((controller.snapshot())!.outFrame, 36000);
  assert.match(sourceRangeAddPlan({ snapshot: controller.snapshot(), asset: asset(), timeline: timeline() }).reason, /18000/);
});

test('edits during an acknowledged save remain dirty and use its next CAS revision', async () => {
  const hold = deferred(), inputs: SourceRangeSaveInput[] = [];
  const controller = await controllerFixture({ save: input => { inputs.push(structuredClone(input)); return hold.promise; } });
  controller.edit('inFrame', '20000'); controller.edit('outFrame', '20120');
  const save = controller.save(); controller.edit('outFrame', '20240');
  (hold.resolve)!(row(1, { inFrame: 20000, outFrame: 20120 })); await save;
  assert.deepEqual(inputs[0], { projectId: 'project-a', assetId: 'asset-a', expectedRevision: 0, inFrame: 20000, outFrame: 20120 });
  assert.equal((controller.getState().draft)!.outFrame, '20240'); assert.equal(controller.getState().dirty, true);
  assert.equal(controller.getState().baseRevision, 1); assert.equal(controller.snapshot(), null);
  controller.discard(); assert.equal((controller.snapshot())!.outFrame, 20120);
});

test('null, throwing, or malformed save never clears the editable draft or automatically retries POST', async () => {
  for (const response of [null, 'throw', row(1, { inFrame: 0, outFrame: 40 }), row(9, { inFrame: 30, outFrame: 60 })]) {
    let calls = 0;
    const controller = await controllerFixture({ save: async () => { calls++; if (response === 'throw') throw Error('Offline'); return response; } });
    controller.edit('inFrame', 30); controller.edit('outFrame', 60);
    await controller.save(); await flush();
    assert.equal(calls, 1); assert.deepEqual(controller.getState().draft, { inFrame: 30, outFrame: 60 });
    assert.equal(controller.getState().dirty, true); assert.equal(controller.snapshot(), null);
  }
});

test('late GET, older revision, and late ACK cannot downgrade confirmed state or erase a newer draft', async () => {
  const oldGet = deferred(), saveAck = deferred(); let calls = 0;
  const controller = await controllerFixture({ initial: row(1, { inFrame: 10, outFrame: 100 }), read: async () => ++calls === 1 ? row(1, { inFrame: 10, outFrame: 100 }) : calls === 2 ? oldGet.promise : row(3, { inFrame: 30, outFrame: 130 }), save: () => saveAck.promise });
  const pendingGet = controller.read();
  (oldGet.resolve)!(row(0)); await pendingGet; assert.equal((controller.getState().row)!.revision, 1);
  controller.edit('outFrame', 110); const pendingSave = controller.save();
  await controller.read(); assert.equal((controller.getState().row)!.revision, 3);
  controller.edit('outFrame', 150);
  (saveAck.resolve)!(row(2, { inFrame: 10, outFrame: 110 })); await pendingSave;
  assert.equal((controller.getState().row)!.revision, 3); assert.equal((controller.getState().draft)!.outFrame, 150);
  assert.equal(controller.getState().conflict, true); assert.equal(controller.snapshot(), null);
});

test('older GET generations are ignored and project/asset epochs reject late reads, saves and source positions', async () => {
  const first = deferred(), second = deferred(), saveAck = deferred(); let reads = 0;
  const controller = createSourceRangeController({ read: () => ++reads === 1 ? first.promise : second.promise, save: () => saveAck.promise });
  controller.setContext(context()); const reread = controller.read();
  (second.resolve)!(row(2, { inFrame: 20, outFrame: 100 })); await reread;
  (first.resolve)!(row(1, { inFrame: 0, outFrame: 100 })); await flush(); assert.equal((controller.getState().row)!.revision, 2);
  controller.edit('outFrame', 120); const saving = controller.save();
  controller.setContext(context({ scope: 'project-b:1:asset-b:1', projectId: 'project-b', asset: asset({ id: 'asset-b', projectId: 'project-b' }) }));
  (saveAck.resolve)!(row(3, { inFrame: 20, outFrame: 120 })); await saving;
  controller.position(100, 'project-a:1:asset-a:1'); assert.equal(controller.getState().position, 0);
  assert.equal(controller.getState().row, null); assert.equal(controller.getState().dirty, false);
});

test('explicit recovery reread preserves a changed draft until explicit discard', async () => {
  let remote = row(0);
  const controller = await controllerFixture({ read: async () => remote, save: async () => { remote = row(1, { inFrame: 30, outFrame: 60 }); return null; } });
  controller.edit('inFrame', 30); controller.edit('outFrame', 60); await controller.save();
  controller.edit('outFrame', 75); await controller.read();
  assert.equal((controller.getState().row)!.revision, 1); assert.equal((controller.getState().draft)!.outFrame, 75);
  assert.equal(controller.getState().conflict, true); assert.equal(controller.snapshot(), null);
  controller.discard(); assert.equal((controller.snapshot())!.outFrame, 60);
});

test('saved range creates an immutable bounded timeline plan; later range saves cannot rewrite it', async () => {
  const controller = await controllerFixture({ initial: row(1, { inFrame: 20000, outFrame: 20120 }) });
  const snapshot = controller.snapshot(), tl = timeline({ clips: [{ id: 'before', trackId: 'video', startFrame: 20, durationFrames: 40 }] });
  const plan = sourceRangeAddPlan({ snapshot, asset: asset(), timeline: tl });
  assert.equal(plan.valid, true); assert.equal(plan.expectedRevision, 7);
  assert.deepEqual(plan.input, { trackId: 'video', assetId: 'asset-a', name: 'Source', startFrame: 60, durationFrames: 120, sourceInFrame: 20000 });
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(plan.input), true);
  controller.edit('inFrame', 21000); controller.edit('outFrame', 21300); await controller.save();
  assert.equal(plan.input.sourceInFrame, 20000); assert.equal(plan.input.durationFrames, 120); assert.equal(tl.clips.length, 1);
  for (const patch of [{ blocked: true }, { snapshot: null }, { timeline: timeline({ tracks: [] }) }, { timeline: timeline({ clips: [{ trackId: 'video', startFrame: 17900, durationFrames: 50 }] }) }, { asset: asset({ projectId: 'other' }) }]) assert.equal(sourceRangeAddPlan({ snapshot, asset: asset(), timeline: tl, ...patch }).valid, false);
  const audio = asset({ mimeType: 'audio/wav' }); assert.equal((sourceRangeAddPlan({ snapshot, asset: audio, timeline: tl }).input)!.trackId, 'audio');
});

test('range receipts reuse the local mutation protocol with exact asset ownership and replay binding', t => {
  storage(t);
  const entry = { projectId: 'project-a', key: 'source-range:asset-a', operation: 'asset.range.set', input: { projectId: 'project-a', assetId: 'asset-a', expectedRevision: 0, inFrame: 20000, outFrame: 20120 } };
  const snapshot = { project: { id: 'project-a' }, assets: [asset()] };
  assert.doesNotThrow(() => assertMutationOwner(entry, snapshot));
  for (const value of [{ ...entry, input: { ...entry.input, assetId: 'wrong' } }, { ...entry, input: { ...entry.input, assetId: undefined } }, { ...entry, projectId: 'other' }]) assert.throws(() => assertMutationOwner(value, snapshot), { code: 'MUTATION_PROJECT_MISMATCH' });
  const stored = prepareMutation(entry, { requestId: () => 'original-range-request' });
  entry.input.outFrame = 22000; assert.equal(stored.input.outFrame, 20120);
  assert.throws(() => prepareMutation(entry), { code: 'MUTATION_PENDING' });
  assert.deepEqual(prepareMutation(stored, { replay: true, requestId: () => { throw Error('No new ID'); } }), stored);
  assert.doesNotThrow(() => validateMutationResponse(stored, row(1, { inFrame: 20000, outFrame: 20120 })));
  for (const invalid of [row(2, { inFrame: 20000, outFrame: 20120 }), row(1, { inFrame: 20000, outFrame: 22000 }), { ...row(1, { inFrame: 20000, outFrame: 20120 }), assetId: 'wrong' }]) assert.throws(() => validateMutationResponse(stored, invalid), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.deepEqual(readPending(entry.projectId, entry.key), stored); clearPending(entry.projectId, entry.key);
  const plan = sourceRangeAddPlan({ snapshot: { ...context(), assetId: 'asset-a', revision: 1, inFrame: 20000, outFrame: 20120 }, asset: asset(), timeline: timeline() });
  const pending = prepareSubmission({ projectId: 'project-a', key: 'timeline:mutation', operation: 'timeline.clip.add', input: { projectId: 'project-a', expectedRevision: plan.expectedRevision, requestId: 'fixed-add-request', ...plan.input } });
  assert.equal(prepareSubmission({ ...pending, input: { ...pending.input, sourceInFrame: 21000 } }).input.sourceInFrame, 20000);
});

test('App guards dirty clip before source selection, clears clip selection, and rereads after replay', async () => {
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function previewSource('), app.indexOf('async function addSavedSourceRange('));
  const updates: unknown[] = [], calls: string[] = []; let accept = false;
  const scope = { msg: message, subtitlesRef: { current: { controller: { hasUnsaved: () => false } } }, setPropertiesPage: () => {}, viewRef: { current: { activeMode: 'editing', editing: { quickAssetId: null } } }, setPreviewAsset: () => {}, context: () => ({ projectId: 'project-a' }), guardNavigation: async () => { calls.push('guard'); return accept; }, isCurrent: () => true, dataRef: { current: { assets: [asset()] } }, navigationEpoch: { current: 0 }, updateView: (...args: unknown[]) => updates.push(args) };
  const preview = Function(...Object.keys(scope), `${source};return previewSource`)(...Object.values(scope)) as (asset: unknown) => Promise<void>;
  await preview(asset()); assert.equal(calls.length, 1); assert.deepEqual((updates as unknown), []);
  accept = true; await preview(asset()); assert.deepEqual(updates, [['editing', { quickAssetId: 'asset-a', selectedClipId: null, previewKind: 'source' }]]);
  assert.doesNotMatch(source, /setRightDockTab/);
  assert.match(app, /replay && operation === 'asset.range.set'/); assert.match(app, /setSourceRangeRefresh/);
  assert.match(app, /shotDirty \|\| clipDirty \|\| sourceDirty/);
  const branchStart=app.indexOf('quickAssetId && sourceAsset ? <AgentEditingBoundary'),branchEnd=app.indexOf(': displayedClipInspector ?',branchStart);
  assert.ok(branchStart>=0&&branchEnd>branchStart,'exercise the complete actual source-inspector branch');
  const renderCode=transformSync(`function render(){return ${app.slice(branchStart,branchEnd)} : null;}`,{loader:'tsx',format:'cjs',jsx:'transform'}).code;
  let discards=0,ownerScope='source:1';
  const environment={React:{createElement:(type: string,props: Record<string, unknown> | null,...children: RootTree[])=>({type,props:{...props,children}})},
    quickAssetId:'asset-a',sourceAsset:asset(),AgentEditingBoundary:'AgentEditingBoundary',SourceRangeInspector:'SourceRangeInspector',
    workspaceOriginScope:()=> 'normal',workspace:{restored:false},restored:false,data:{project:{id:'project-a'}},sourceDirty:true,
    sourceRanges:{state:{scope:'source:1'},controller:{getState:()=>({scope:ownerScope}),discard:()=>{discards++;}}},
    timeline:timeline(),sourceRangeBlocked:false,addSavedSourceRange:()=>{},FrameExtractionPanel:'FrameExtractionPanel',frameExtraction:{controller:{}},agentRecovery:null as {kind: string; projectId: string; taskId: string; key: string; current(): boolean} | null,sceneSummary:()=>null,
  };
  const render=Function('env',`with(env){${renderCode};return render;}`)(environment) as () => SourceBoundaryNode,boundary=render();
  assert.equal(boundary.type,'AgentEditingBoundary');assert.equal(boundary.props.disabled,false);assert.equal(boundary.props.projectId,'project-a');
  assert.deepEqual(boundary.props.targets,[{kind:'asset_range',id:'asset-a',revision:0}]);
  assert.equal(boundary.props.children[0].type,'SourceRangeInspector');assert.equal(boundary.props.children[0].props.asset,environment.sourceAsset);
  assert.equal(boundary.props.children[0].props.children[0].props.revealTask,null);
  const recovery={kind:'frame',projectId:'project-a',taskId:'frame-a',key:'fixed-original-frame',current:()=>true};environment.agentRecovery=recovery;
  assert.equal(render().props.children[0].props.children[0].props.revealTask,recovery,'retain the exact read-only recovery intent without changing range ownership');
  environment.agentRecovery={...recovery,kind:'image'};assert.equal(render().props.children[0].props.children[0].props.revealTask,null);environment.agentRecovery=null;
  assert.equal(boundary.props.canRelease(),false,'an unsaved range retains its exact target claim');
  environment.sourceDirty=false;assert.equal(render().props.canRelease(),true);
  ownerScope='source:2';boundary.props.onDiscard();assert.equal(discards,0,'a retained callback cannot discard another source scope');
  ownerScope='source:1';boundary.props.onDiscard();assert.equal(discards,1);
  assert.match(app, /sourceInFrame: 0/); // Existing whole-asset route is retained.
});

test('source range controls use full source bounds and retain timeline caps separately', () => {
  const source = readFileSync(new URL('../apps/web/src/SourceRangeInspector.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
  const createElement = (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } });
  const module = { exports: {} as Record<string, (props: unknown) => RootTree> };
  const hooks = { createElement, useRef: (value: unknown) => ({ current: value }), useLayoutEffect: (fn: () => void | (() => void)) => fn() };
  const require = (id: string) => id === './i18n/I18nProvider.tsx' ? i18nTestModule() : id === 'react' ? { ...hooks, default: hooks } : id.endsWith('workspace-visibility.tsx') ? { useWorkspaceVisibility: () => true } : id.endsWith('.css') ? {} : id.endsWith('icons.tsx') ? { default: 'Icon', __esModule: true } : id.endsWith('source-range-state.ts') ? { SOURCE_RANGE_FPS: 30, sourceFrameCount, sourceRangeIssue, sourceRangeMessage, sourceRangeAddPlan, supportsSourceRange: () => true } : new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const rendered = module.exports.default({ asset: asset(), state: { scope: 'source-a', row: row(1, { inFrame: 20000, outFrame: 20120 }), draft: { inFrame: 20000, outFrame: 20120 }, position: 20000 }, controller: { getState: () => ({ scope: 'source-a' }), snapshot: () => ({ projectId: 'project-a', assetId: 'asset-a', revision: 1, inFrame: 20000, outFrame: 20120 }) }, timeline: timeline() });
  const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const all = nodes(rendered), find = (id: string) => all.find((node: RootNode) => node.props?.['data-testid'] === id);
  assert.equal((find('source-range-in'))!.props.max, 35999); assert.equal((find('source-range-out'))!.props.max, 36000);
  assert.equal((find('source-range-add'))!.props.disabled, false);
  assert.match(source, /timeline.range.timebase/); assert.match(translate('zh-Hans', 'timeline.range.timebase', { fps: 30 }), /不是原生帧率或 VFR/); assert.match(source, /timeline.range.recovery/); assert.match(translate('zh-Hans', 'timeline.range.recovery'), /关闭并重建原生窗口可能丢失凭据/);
  const inspector = readFileSync(new URL('../apps/web/src/TimelineInspector.tsx', import.meta.url), 'utf8');
  assert.match(inspector, /data-testid="clip-source-in"[^>]*sourceFrameCount/);
  assert.match(inspector, /data-testid="clip-start"[^>]*max="17999"/);
  assert.match(inspector, /data-testid="clip-duration"[^>]*max="18000"/);
});

test('retained source inspector handlers reject another asset epoch, hidden panes and unmount', async () => {
  const source = readFileSync(new URL('../apps/web/src/SourceRangeInspector.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code;
  const slots: RootHook[] = []; let cursor = 0, visible = true, scope = 'asset-a:1', cleanups: RootHook[] = [], tree: string|number|boolean|RootNode|RootTree[]|null|undefined;
  const react = { createElement: (type: string, props: Record<string, unknown> | null, ...children: RootTree[]) => ({ type, props: { ...props, children } }), useRef: (value: unknown) => { const i = cursor++; return slots[i] ||= { current: value }; }, useLayoutEffect: (fn: () => void | (() => void), deps: readonly unknown[] | undefined) => { const i = cursor++, prior = slots[i]; if (!prior || deps!.some((value, n) => value !== prior.deps![n])) { prior?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; cleanups.push(slots[i]); } } };
  const module = { exports: {} as Record<string, (props: unknown) => RootTree> }, actions: unknown[] = [];
  const require = (id: string) => id === './i18n/I18nProvider.tsx' ? i18nTestModule() : id === 'react' ? { ...react, default: react } : id.endsWith('.css') ? {} : id.endsWith('workspace-visibility.tsx') ? { useWorkspaceVisibility: () => visible } : id.endsWith('icons.tsx') ? { default: 'Icon', __esModule: true } : id.endsWith('source-range-state.ts') ? { SOURCE_RANGE_FPS: 30, sourceFrameCount, sourceRangeIssue, sourceRangeMessage, sourceRangeAddPlan, supportsSourceRange: () => true } : new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const controller = { getState: () => ({ scope }), snapshot: () => ({ scope, projectId: 'project-a', assetId: 'asset-a', revision: 1, inFrame: 20, outFrame: 120 }), ...Object.fromEntries(['edit', 'save', 'discard', 'read', 'seek'].map(name => [name, (...args: unknown[]) => actions.push([name, ...args])])) };
  const props = () => ({ asset: asset(), state: { scope, row: row(1, { inFrame: 20, outFrame: 120 }), draft: { inFrame: 20, outFrame: 120 }, position: 50, dirty: true }, controller, timeline: timeline(), onAdd: (snapshot: unknown) => actions.push(['add', snapshot]) });
  const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const render = () => { cursor = 0; tree = module.exports.default(props()); };
  const handlers = () => nodes(tree).flatMap(node => [node.props?.onClick && (() => node.props.onClick()), node.props?.onChange && (() => node.props.onChange({ target: { value: '22' } }))].filter(Boolean));
  render(); const old = handlers(); assert.ok(old.length >= 9);
  scope = 'asset-b:2'; render(); old.forEach(fn => fn()); assert.deepEqual((actions as unknown), []);
  const current = handlers(); visible = false; render(); current.forEach(fn => fn()); assert.deepEqual((actions as unknown), []);
  visible = true; render(); (handlers().find(Boolean))!(); assert.ok(actions.length > 0); actions.length = 0;
  const retained = handlers(); for (const item of cleanups) item.cleanup?.(); retained.forEach(fn => fn()); assert.deepEqual((actions as unknown), []);
});

test('exact snapshot comparison admits a clicked saved range before freezing, never a superseded callback', async () => {
  const { sameSourceSnapshot } = await import('../apps/web/src/source-range-state.ts');
  const snapshot = { scope: 'source:1', projectId: 'project-a', assetId: 'asset-a', revision: 1, inFrame: 20, outFrame: 120 };
  assert.equal(sameSourceSnapshot(snapshot, { ...snapshot }), true);
  for (const patch of [{ scope: 'source:2' }, { assetId: 'asset-b' }, { projectId: 'project-b' }, { revision: 2 }, { inFrame: 30 }, { outFrame: 130 }]) assert.equal(sameSourceSnapshot(snapshot, { ...snapshot, ...patch }), false);
  assert.equal(sameSourceSnapshot(snapshot, null), false);
});

test('actual App range replay uses its original request and triggers latest scoped reread without installing historical ACK', async t => {
  storage(t);
  const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('async function runSession('), app.indexOf('async function inspect(')).replace('async function runSession(', 'async function run(');
  let remote = row(), historical: SourceRangeResponse, generation = {}, controller: Awaited<ReturnType<typeof controllerFixture>>;
  const calls: {operation: string; input: SourceRangeSaveInput}[] = [], busy = new Set(), notices: unknown[][] = [];
  const currentProject = { current: 'project-a' };
  const scope = { msg: message,
    shotTextRef: { current: null }, currentProject, context: () => ({ projectId: currentProject.current, epoch: 1 }), isCurrent: (owner: { projectId: string; }) => owner.projectId === currentProject.current,
    isBusy: (key: unknown, project: unknown) => busy.has(`${project}:${key}`), markBusy: (project: unknown, key: unknown, value: boolean) => value ? busy.add(`${project}:${key}`) : busy.delete(`${project}:${key}`),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse, prepareSubmission, clearPending, pendingForProject,
    isReferenceOperation: () => false, setPending: () => {}, openTasks: () => {}, setAuth: () => {}, readableError: (error: Error) => error.message,
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, dataRef: { current: { project: { id: 'project-a' }, assets: [asset()] } }, setData: () => {},
    rpc: async (operation: string, input: SourceRangeSaveInput) => { calls.push({ operation, input: structuredClone(input) }); if (calls.length === 1) { historical = row(1, { inFrame: input.inFrame, outFrame: input.outFrame }); remote = historical; throw Error('Lost response after commit'); } return historical; },
    refresh: async () => {}, notify: (...args: unknown[]) => notices.push(args),
    setSourceRangeRefresh: (update: (arg0: {}) => {}) => { generation = update(generation); void controller.read(); },
  };
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify((captured as {workspace?: unknown}).workspace || 'test-workspace') }; } });
  const run = Function(...Object.keys(scope), `${code};return run`)(...Object.values(scope)) as RangeRun;
  controller = await controllerFixture({ read: async () => remote, save: input => run('source-range:asset-a', 'asset.range.set', input, undefined, { returnAfterNavigation: true }) });
  controller.edit('inFrame', 30); controller.edit('outFrame', 60); await controller.save();
  const stored = readPending('project-a', 'source-range:asset-a'); assert.ok(stored); assert.equal(calls.length, 1);
  controller.edit('outFrame', 75);
  assert.equal(await run(stored.key, stored.operation, { ...stored.input, outFrame: 75 }), null); assert.equal(calls.length, 1);
  remote = row(2, { inFrame: 100, outFrame: 200 });
  assert.equal(await run(stored.key, stored.operation, stored.input, 'Recovered', { replay: true }), null); await flush();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(readPending('project-a', stored.key), null);
  assert.deepEqual(generation, { 'project-a:asset-a': 1 });
  assert.equal((controller.getState().row)!.revision, 2); assert.equal((controller.getState().draft)!.outFrame, 75); assert.equal(controller.getState().conflict, true);
  assert.equal(controller.snapshot(), null); assert.equal(busy.size, 0);
});
