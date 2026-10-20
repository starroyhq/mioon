import * as deliveryHistory from '../apps/web/src/export-delivery-state.ts';
import * as exportSettings from '../apps/web/src/export-settings-state.ts';
import { i18nTestModule, message, translate } from './helpers/i18n.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import * as preflightState from '../apps/web/src/export-preflight-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createExportPreflightController, preflightErrorMessage, preflightIssueMessage } from '../apps/web/src/export-preflight-state.ts';
import { rpc } from '../apps/web/src/api.ts';
import * as rangeState from '../apps/web/src/export-range-state.ts';
import * as rangeContracts from '@mioon/contracts/timeline-export-range';

import { lenientFunction } from './helpers/eval-source.ts';
interface AppEnv {
  dataRef: {current: {project: {id: string}; timeline: {id: string; revision: number; clips: Array<{id: string}>}}};
  currentProject: {current: string};
  [key: string]: unknown;
}
interface AppHarness {
  calls: unknown[]; notices: unknown[]; views: unknown[]; panels: unknown[]; pending: unknown[]; jobs: unknown[]; exports: unknown[];
  submitOptions: Array<{canExecute(): boolean; nameCapture?: unknown}>;
  env: AppEnv;
  render: (...args: unknown[]) => Promise<unknown>; renderUnchecked: (...args: unknown[]) => Promise<unknown>;
  check: () => Promise<unknown>; open: () => unknown;
}
const Function = lenientFunction;
type Pending<T = unknown> = {promise: Promise<T>; resolve: (value?: T) => void; reject: (reason?: unknown) => void};
interface Binding {projectId?: string; expectedRevision?: number; preflightSnapshotHash?: string}
interface PreflightStateLike {report: Record<string, unknown> & {snapshotHash?: unknown}; binding: Binding; phase: string; attempted: boolean; error: string; uncheckedIntent: Record<string, unknown> | null; [key: string]: unknown}
interface PreflightControllerLike {
  setContext(context: Record<string, unknown>): void; setVisible(value: boolean): void;
  getState(): PreflightStateLike; check(): Promise<void>; takeExportBinding(binding: unknown): Binding | null; takeUncheckedExportIntent(intent: unknown): Record<string, unknown> | null; dispose(): void;
}
const id = (n: number): string => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(2), hash = 'a'.repeat(64);
const context = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ scope: `${projectId}:1`, projectId, timelineId, revision: 4, connected: true, ...patch });
const report = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({ projectId, timelineId, timelineRevision: 4, expectedRevision: 4, snapshotHash: hash,
  checkedAt: '2026-10-10T04:00:00.000Z', status: 'ready', summary: { fps: 30, width: 720, height: 1280, durationFrames: 90, trackCount: 2, clipCount: 2, assetCount: 2, visualClipCount: 1, audibleClipCount: 1, mutedTrackCount: 0, hiddenVideoTrackCount: 0 },
  checks: { totalAssets: 2, checkedAssets: 2, bytesHashed: 256, fullDecode: false }, issues: [], ...patch });
function deferred<T = unknown>(): Pending<T> {
  let resolve!: (value?: T) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = value => { yes(value as T); }; reject = no; });
  return {promise, resolve, reject};
}
function fixture() {
  const calls: Array<{input: Record<string, unknown>; options: {signal: AbortSignal}}> = [], reads: Array<Pending<unknown>> = [], changes: Array<Record<string, unknown>> = [], auth: boolean[] = [];
  const controller = createExportPreflightController({ read: (input: unknown, options: unknown) => { calls.push({input: input as Record<string, unknown>, options: options as {signal: AbortSignal}}); const read = deferred(); reads.push(read); return read.promise; }, onChange: (state: unknown) => changes.push(state as Record<string, unknown>), onUnauthorized: () => { auth.push(false); } }) as unknown as PreflightControllerLike;
  controller.setContext(context()); controller.setVisible(true); // This fixture models an open delivery pane.
  return { controller, calls, reads, changes, auth, state: () => controller.getState(),
    async ready(value: Record<string, unknown> = report()): Promise<PreflightStateLike> { const waiting = controller.check(); reads.at(-1)!.resolve(value); await waiting; return controller.getState(); } };
}

test('mount, context, visibility and reconnect never check automatically; recreation holds no report', async () => {
  const f = fixture(); f.controller.setVisible(true); f.controller.setVisible(false);
  f.controller.setContext(context({ connected: false })); f.controller.setContext(context());
  assert.equal(f.calls.length, 0); assert.equal(f.state().report, null);
  await f.ready(); assert.equal(f.calls.length, 1);
  f.controller.dispose(); assert.equal(f.state().report, null);
  const next = fixture(); assert.equal(next.state().report, null); assert.equal(next.calls.length, 0);
});

test('explicit check reads only saved project/revision; report is not an export or application acknowledgement', async () => {
  const f = fixture(), draft = { shot: 'unsaved prompt', clip: { startFrame: 99 }, source: { inFrame: 22 } };
  const before = structuredClone(draft), state = await f.ready();
  assert.deepEqual(f.calls[0].input, { projectId, expectedRevision: 4 });
  assert.ok(f.calls[0].options.signal instanceof AbortSignal); assert.equal(f.calls.length, 1);
  assert.equal(state.phase, 'ready'); assert.equal(state.attempted, false); assert.deepEqual(draft, before);
  assert.deepEqual(state.binding, { projectId, expectedRevision: 4, preflightSnapshotHash: hash });
  assert.equal('applied' in state, false); assert.equal('requestId' in f.calls[0].input, false);
});

test('newer check invalidates old report immediately and fences late success, error and old confirmation', async () => {
  const f = fixture(), old = (await f.ready()).binding;
  const first = f.controller.check(), firstRead = f.reads.at(-1)!, firstSignal = f.calls.at(-1)!.options.signal;
  assert.equal(f.state().binding, null); assert.equal(f.state().phase, 'checking');
  const second = f.controller.check(), secondRead = f.reads.at(-1)!;
  assert.equal(firstSignal.aborted, true); secondRead.resolve(report({ snapshotHash: 'b'.repeat(64) })); await second;
  firstRead!.reject(Object.assign(Error('/private/late-auth'), { code: 'UNAUTHORIZED' })); await first;
  assert.equal(f.state().binding.preflightSnapshotHash, 'b'.repeat(64)); assert.equal(f.auth.length, 0);
  assert.equal(f.controller.takeExportBinding(old), null);
  const third = f.controller.check(), thirdRead = f.reads.at(-1)!;
  const fourth = f.controller.check(), fourthRead = f.reads.at(-1)!;
  fourthRead.resolve(report()); await fourth; thirdRead.resolve(report({ snapshotHash: 'c'.repeat(64) })); await third;
  assert.equal(f.state().binding.preflightSnapshotHash, hash);
});

for (const patch of [{ revision: 5 }, { timelineId: id(3) }, { projectId: id(4), scope: 'other:1' }, { scope: `${projectId}:2` }, { connected: false }]) {
  test(`context fence aborts pending response for ${JSON.stringify(patch)}`, async () => {
    const f = fixture(); await f.ready(); const waiting = f.controller.check(), latest = f.reads.at(-1)!;
    f.controller.setContext(context(patch)); assert.equal(f.calls.at(-1)!.options.signal.aborted, true);
    const before = f.state(); latest.resolve(report()); await waiting;
    assert.equal(f.state(), before); assert.equal(f.state().binding, null);
    if (patch.projectId || patch.scope) assert.equal(f.state().report, null);
    else assert.equal(f.state().phase, 'stale');
  });
}

test('a saved timeline draft invalidates the report; disconnect/reconnect cannot revive it', async () => {
  const f = fixture(), first = (await f.ready()).binding;
  f.controller.setContext(context({ revision: 5 })); assert.equal(f.state().phase, 'stale');
  assert.equal(f.controller.takeExportBinding(first), null); assert.equal(f.calls.length, 1);
  f.controller.setContext(context({ revision: 5, connected: false })); f.controller.setContext(context({ revision: 5 }));
  assert.equal(f.state().phase, 'stale'); assert.equal(f.state().binding, null); assert.equal(f.calls.length, 1);
});

test('same-revision newer check rejects previous binding identity and allows each report exactly once', async () => {
  const f = fixture(), before = (await f.ready()).binding, after = (await f.ready()).binding;
  assert.deepEqual(before, after); assert.notEqual(before, after);
  assert.equal(f.controller.takeExportBinding(before), null);
  assert.equal(f.controller.takeExportBinding({ ...after }), null);
  assert.equal(f.controller.takeExportBinding(after), after); assert.equal(f.state().attempted, true);
  assert.equal(f.controller.takeExportBinding(after), null); assert.equal(f.calls.length, 2);
});

for (const [label, value] of [
  ['wrong project', report({ projectId: id(9) })], ['wrong expected revision', report({ expectedRevision: 5 })],
  ['wrong actual revision', report({ timelineRevision: 5 })], ['wrong timeline', report({ timelineId: id(9) })],
  ['malformed hash', report({ snapshotHash: 'bad' })], ['missing summary', report({ summary: null })],
  ['unknown field', { ...report(), path: '/private/source.mp4' }], ['full decode claim', report({ checks: { ...(report().checks as Record<string, unknown>), fullDecode: true } })],
  ['ready with error', report({ issues: [{ code: 'MISSING_ASSET', severity: 'error', message: '素材不可用' }] })],
  ['ready missing checks', report({ checks: { ...(report().checks as Record<string, unknown>), checkedAssets: 1 } })],
]) test(`malformed or misbound ${label} fails closed`, async () => {
  const f = fixture(); await f.ready(value as Record<string, unknown>); assert.equal(f.state().phase, 'error'); assert.equal(f.state().binding, null);
  assert.match(f.state().error, /不完整或与当前快照不匹配/);
});

test('incomplete report is distinct, permits only bound warning-only explicit attempts; blocked/stale never bind', async () => {
  const f = fixture(); await f.ready(report({ status: 'incomplete', checks: { ...(report().checks as Record<string, unknown>), checkedAssets: 1 }, issues: [{ code: 'CHECK_BUDGET_EXCEEDED', severity: 'warning', message: '检查达到限额' }] }));
  assert.equal(f.state().phase, 'incomplete'); assert.ok(f.state().binding);
  for (const value of [report({ status: 'blocked' }), report({ status: 'stale' }), report({ status: 'incomplete', snapshotHash: null }), report({ status: 'incomplete', issues: [{ code: 'ASSET_MISSING', severity: 'error', message: '素材缺失' }] })]) {
    await f.ready(value); assert.equal(f.state().binding, null);
  }
});

test('hidden observer aborts late reads but completed report survives tab/mode visibility; no automatic export', async () => {
  const f = fixture(); f.controller.setVisible(true); await f.ready(); const binding = f.state().binding;
  f.controller.setVisible(false); f.controller.setVisible(true); assert.equal(f.state().binding, binding); assert.equal(f.calls.length, 1);
  const waiting = f.controller.check(), read = f.reads.at(-1)!; f.controller.setVisible(false);
  assert.equal(f.calls.at(-1)!.options.signal.aborted, true); read.resolve(report()); await waiting;
  assert.equal(f.state().binding, null); assert.equal(f.state().phase, 'stale'); f.controller.setVisible(true);
  assert.equal(f.calls.length, 2); assert.equal(f.state().attempted, false);
});

test('current auth and RPC errors are readable, path-free, fail closed; obsolete auth never logs out new project', async () => {
  const f = fixture(); let waiting = f.controller.check(); f.reads.at(-1)!.reject(Object.assign(Error('/private/password=bad'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.match(f.state().error, /会话已过期/); assert.equal(f.auth.length, 1);
  waiting = f.controller.check(); f.controller.setContext(context({ projectId: id(8), scope: 'new:1' })); f.reads.at(-1)!.reject(Object.assign(Error('Old auth'), { code: 'UNAUTHORIZED' })); await waiting;
  assert.equal(f.auth.length, 1); assert.equal(f.state().error, '');
  for (const error of [Error('/private/secret.mp4'), { message: 'ffprobe C:\\secret\\video.mp4' }, { code: 'BACKEND_PROTOCOL_ERROR' }, { code: 'REVISION_CONFLICT' }]) assert.doesNotMatch(preflightErrorMessage(error), /private|secret|ffprobe|C:/);
  for (const message of ['/private/source.mp4', 'C:\\Users\\file.mp4', 'https://private.example/video', 'token=secret']) assert.doesNotMatch(preflightIssueMessage({ severity: 'error', message }), /private|Users|secret|token/);
});

const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function appFunction(begin: string, end: string, scope: Record<string, unknown> = {}): ((...args: unknown[]) => unknown) {
  const start = appSource.indexOf(begin), stop = appSource.indexOf(end, start); assert.ok(start >= 0 && stop > start);
  return ((Function as (...args: string[]) => (...values: unknown[]) => unknown)(...Object.keys({ msg: message, ...scope }), `return (${appSource.slice(start, stop).trim()});`)(...Object.values({ msg: message, ...scope }))) as (...args: unknown[]) => unknown;
}
function appHarness(f: ReturnType<typeof fixture>, { restored = false, localState = { baselineConflict: false, candidate: null as unknown } }: {restored?: boolean; localState?: Record<string, unknown>} = {}) {
  const calls: unknown[] = [], notices: unknown[] = [], views: unknown[] = [], panels: unknown[] = [], pending: unknown[] = [], jobs: unknown[] = [], exports: unknown[] = [], submitOptions: unknown[] = [];
  const owner = context(), currentProject = { current: projectId }, dataRef = { current: { project: { id: projectId }, timeline: { id: timelineId, revision: 4, clips: [{ id: id(20) }] } } };
  const env: Record<string, unknown> = { clipDraftRef: { current: null }, markPanelIntent: () => {}, setShowTasks: (value: unknown) => panels.push(['tasks', value]), setShowImage: (value: unknown) => panels.push(['image', value]), setShowDelivery: (value: unknown) => panels.push(['delivery', value]), panelIntent: { current: 0 }, setDeliveryAttempt: (value: unknown) => exports.push(['attempt', value]), openExportHistory: () => exports.push(true), workspaceRef: { current: { restored } }, deliveryNameRef: { current: null }, dataRef, currentProject, exportPreflight: { controller: f.controller }, exportCheckContext: () => ({ ...owner, projectId: currentProject.current, timelineId: dataRef.current.timeline.id, revision: dataRef.current.timeline.revision }),
    isBusy: () => false, pendingForProject: () => pending, notify: (...args: unknown[]) => notices.push(args), openTasks: (canReveal: () => boolean = () => true) => { if (canReveal()) jobs.push(true); }, setShowExports: (value: unknown) => exports.push(value),
    context: () => ({ projectId: currentProject.current, scope: owner.scope }), isCurrent: (captured: {projectId?: string; scope?: unknown}) => captured.projectId === currentProject.current && captured.scope === owner.scope,
    localDeliveryRef: { current: { controller: { getState: () => localState, canPrepare: () => true, submit: async (input: unknown, options: unknown) => { calls.push(['local-delivery.submit', input]); submitOptions.push(options); return { id: id(30), status: 'queued' }; } } } },
    run: async (...args: unknown[]) => { calls.push(args); return { id: id(30), status: 'queued' }; }, requestId: () => 'stable-test-request',
    updateView: (...args: unknown[]) => views.push(args), setPreviewKind: (value: unknown) => views.push(['previewKind', value]),
    setRightDockTab: (value: unknown) => panels.push(['tab', value]), setPanelOpen: (...args: unknown[]) => panels.push(args),
  };
  const render = appFunction('  async function renderTimeline(', '  async function previewSource(', env);
  const check = appFunction('  function checkTimelineExport(', '  const exportLoudness =', env);
  const open = appFunction('  function openTimelineExport(', '  const historyState', { ...env, checkTimelineExport: check });
  const renderUnchecked = appFunction('  function renderUncheckedTimeline(', '  async function renderTimeline(', { renderTimeline: render });
  return { calls, notices, views, panels, pending, jobs, exports, submitOptions, env: env as unknown as AppEnv, render, renderUnchecked, check, open } as unknown as AppHarness;
}

test('actual topbar action opens the export overlay without probing; explicit check reads once without rendering or changing drafts', async () => {
  const f = fixture(), h = appHarness(f); h.open();
  assert.deepEqual(h.panels, [['tasks', false], ['image', false], ['delivery', true]]); assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
  const waiting = h.check(); assert.equal(f.calls.length, 1);
  f.reads.at(-1)!.resolve(report()); await waiting; assert.equal(h.calls.length, 0); assert.equal(h.views.length, 0);
});

test('actual export path pins exact checked tuple and request once; preview path retains original input', async () => {
  const f = fixture(), binding = (await f.ready()).binding, h = appHarness(f);
  await h.render('export', binding); await h.render('export', binding);
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0], ['local-delivery.submit', { projectId, expectedRevision: 4, preflightSnapshotHash: hash, requestId: 'stable-test-request', purpose: 'export' }]);
  assert.equal(h.submitOptions[0].canExecute(), true); assert.equal(h.submitOptions[0].nameCapture, undefined);
  assert.deepEqual(h.exports, [['attempt', { projectId, id: id(30) }], false]); assert.equal(h.views.length, 0);
  await h.render('preview'); assert.deepEqual(h.calls[1], ['timeline:render:preview', 'timeline.render', { projectId, expectedRevision: 4, requestId: 'stable-test-request', purpose: 'preview' }]);
  assert.deepEqual(h.views, [['activeMode', 'editing'], ['previewKind', 'timeline']]);
});

test('actual Check rejects unresolved local candidate and saved-baseline conflict before any preflight work', async () => {
  for (const localState of [{ baselineConflict: true, candidate: null }, { baselineConflict: false, candidate: { raw: { deliveryName: 'Retained draft' } } }]) {
    const f = fixture(), h = appHarness(f, { localState }), before = f.state();
    assert.equal(await h.check(), null);
    assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0); assert.equal(f.state(), before);
    assert.equal(h.submitOptions.length, 0);
  }
});

test('restored export retains the original preflight-bound session runner', async () => {
  const f = fixture(), binding = (await f.ready()).binding, h = appHarness(f, { restored: true });
  await h.render('export', binding);
  assert.deepEqual(h.calls, [['timeline:render:export', 'timeline.render', { projectId, expectedRevision: 4, preflightSnapshotHash: hash, requestId: 'stable-test-request', purpose: 'export' }]]);
  assert.equal(h.submitOptions.length, 0); assert.deepEqual(h.exports, [['attempt', { projectId, id: id(30) }], false]);
});

test('actual export never auto-replays an unknown receipt or replaces an old binding with current revision', async () => {
  const f = fixture(), h = appHarness(f); let binding = (await f.ready()).binding;
  h.pending.push({ key: 'timeline:render:export', operation: 'timeline.render', input: { requestId: 'original-receipt' } });
  await h.render('export', binding); assert.equal(h.calls.length, 0); assert.deepEqual(h.jobs, [true]);
  assert.equal(f.state().attempted, false); h.pending.length = 0;
  h.env.dataRef.current.timeline.revision = 5; await h.render('export', binding);
  assert.equal(h.calls.length, 0); assert.equal(f.state().phase, 'stale');
  f.controller.setContext(context()); binding = (await f.ready()).binding; h.env.currentProject.current = id(99);
  await h.render('export', binding); assert.equal(h.calls.length, 0);
});

const element = (type: unknown, props: Record<string, unknown>, ...children: unknown[]): Record<string, unknown> => ({ type, props: { ...props, children } });
type RenderNode = {type?: unknown; props: Record<string, unknown> & {children?: unknown}};
const findNode = (tree: unknown, testId: string): RenderNode => { const node = nodes(tree).find(item => item.props['data-testid'] === testId); assert.ok(node); return node; };
// This panel fixture retains Workflow's real named presentation slots. Their
// actual fixed-footer placement is exercised by export-workflow.test.ts.
const nodes = (tree: unknown): RenderNode[] => Array.isArray(tree) ? (tree as unknown[]).flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [{type: (tree as {type?: unknown}).type, props: ((tree as {props?: Record<string, unknown>}).props ?? {}) as RenderNode['props']}, ...nodes(((tree as {props?: RenderNode['props']}).props ?? {}).children),...nodes(((tree as {props?:RenderNode['props']}).props??{}).checkAction),...nodes(((tree as {props?:RenderNode['props']}).props??{}).settingsEstimate)];
const textOf = (tree: unknown): string => Array.isArray(tree) ? (tree as unknown[]).map(textOf).join('') : tree && typeof tree === 'object' ? textOf(((tree as {props?: RenderNode['props']}).props ?? {}).children) : tree === null || tree === undefined ? '' : String(tree);
const panelSource = readFileSync(new URL('../apps/web/src/TimelineExportPreflight.tsx', import.meta.url), 'utf8');
function renderPanel(props: Record<string, unknown>): RenderNode {
  const module: {exports: {default?: unknown}} = { exports: {} }; const react: Record<string, unknown> = { createElement: element }; react.default = react;
  Function('module', 'exports', 'require', transformSync(panelSource, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, (name: string) => name === './i18n/I18nProvider.tsx' ? i18nTestModule() : name === 'react' ? react : name.endsWith('export-preflight-state.ts') ? preflightState : name.endsWith('export-delivery-state.ts') ? deliveryHistory : name.endsWith('export-settings-state.ts') ? exportSettings : name.endsWith('export-range-state.ts') ? rangeState : name.endsWith('icons.tsx') ? { __esModule: true, default: 'Icon' } : { Button: 'Button' });
  return ((module.exports as {default: (props: Record<string, unknown>) => RenderNode}).default)({ canCheck: true, onCheck() {}, onExport() {}, ...props });
}

test('primary settings precede optional recovery while recovery needing attention remains open',()=>{
  const normal=renderPanel({recovery:'local recovery controls',recoveryRequired:false,loudness:'real loudness controls'});
  assert.equal(findNode(normal,'export-recovery-details').props.open,false);
  assert.equal(textOf(findNode(normal,'export-loudness-row')),'响度real loudness controls');
  const all=nodes(normal),primary=all.findIndex(node=>node.props.className==='export-settings-primary'),recovery=all.findIndex(node=>node.props.className==='export-settings-recovery');
  assert.ok(primary>=0&&recovery>primary);
  for(const recoveryRequired of [true,undefined])assert.equal(findNode(renderPanel({recoveryRequired,recovery:'original unknown request'}),'export-recovery-details').props.open,true,'Unknown, conflicting or legacy callers must not hide their recovery controls');
  assert.ok(normal.props.checkAction);assert.ok(normal.props.settingsEstimate);
});

test('accessible topbar export action opens recovery even when a candidate, baseline conflict or invalid name blocks Check', () => {
  const first = appSource.indexOf('  const canOpenExport ='), last = appSource.indexOf('  const pendingTimelineExport =', first);
  assert.ok(first >= 0 && last > first, 'Opening and checking must have explicit independent gates');
  const buttonSource = appSource.match(/<WorkbenchButton\b[^>]*data-testid="export-timeline"[^>]*>[\s\S]*?<\/WorkbenchButton>/)?.[0];
  assert.ok(buttonSource); assert.match(buttonSource, /disabled=\{!canOpenExport\}/); assert.match(buttonSource, /onClick=\{openTimelineExport\}/);
  const gate = (patch: Record<string, unknown> = {}): {canOpenExport: boolean; canCheckExport: boolean} => {
    const env = { data: { project: { id: projectId } }, timeline: { id: timelineId, revision: 4 }, loading: false,
      online: true, auth: true, deliveryName: { error: '' }, exportRange: { error: '' }, restored: false, localDelivery: { state: { candidate: null, baselineConflict: false } }, ...patch };
    return ((Function as (...args: string[]) => (...values: unknown[]) => unknown)(...Object.keys(env), `${appSource.slice(first, last)};return { canOpenExport, canCheckExport };`)(...Object.values(env))) as {canOpenExport: boolean; canCheckExport: boolean};
  };
  for (const patch of [{ localDelivery: { state: { candidate: { raw: { deliveryName: 'Saved draft' } }, baselineConflict: false } } },
    { localDelivery: { state: { candidate: null, baselineConflict: true } } }, { deliveryName: { error: 'Invalid name' } }, { exportRange: { error: 'Invalid range' } }, { online: false }]) {
    const flags = gate(patch); assert.deepEqual(flags, { canOpenExport: true, canCheckExport: false });
    const f = fixture(), h = appHarness(f), module = { exports: {} };
    Function('module', 'React', 'WorkbenchButton', 'Icon', 'canOpenExport', 'openTimelineExport', 't', transformSync(`module.exports = (${buttonSource});`, { loader: 'tsx', format: 'cjs' }).code)(module, { createElement: element }, 'WorkbenchButton', 'Icon', flags.canOpenExport, h.open, (key: string, params: Record<string, unknown>) => translate('zh-Hans', key as Parameters<typeof translate>[1], params as never));
    const button = module.exports as RenderNode; assert.equal(button.type, 'WorkbenchButton'); assert.equal(button.props.disabled, false); assert.equal(textOf(button), '导出');
    (button.props.onClick as () => void)(); assert.deepEqual(h.panels, [['tasks', false], ['image', false], ['delivery', true]]); assert.deepEqual(h.exports, [false]);
    assert.equal(f.calls.length, 0); assert.equal(h.calls.length, 0);
  }
  for (const patch of [{ data: { project: null } }, { timeline: null }, { loading: true }]) assert.equal(gate(patch).canOpenExport, false);
});

test('blocked Check retains accessible recovery controls and pending copy points to the original request entry', () => {
  const recoverySource = readFileSync(new URL('../apps/web/src/DeliveryDraftRecovery.tsx', import.meta.url), 'utf8');
  const module = { exports: {} }, disclosure = { exports: {} }, rangeSummary = { exports: {} };
  const react: Record<string, unknown> = { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => [(disclosure.exports as {default?: unknown}).default, (rangeSummary.exports as {default?: unknown}).default].includes(type) ? (type as (props: Record<string, unknown>) => unknown)({ ...props, children }) : element(type, props, ...children) }; react.default = react;
  Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/RecoveryStorageDetails.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(disclosure, disclosure.exports, (name: string) => {
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name.endsWith('packages/i18n/src/index.ts')) return i18n;
    assert.equal(name, 'react'); return react;
  });
  Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/ExportRangeSummary.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(rangeSummary, rangeSummary.exports, (name: string) => {
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name.endsWith('packages/i18n/src/index.ts')) return i18n;
    if (name === 'react') return react;
    if (name === '@mioon/contracts/timeline-export-range') return rangeContracts;
    assert.equal(name, './export-range-state.ts'); return rangeState;
  });
  Function('module', 'exports', 'require', transformSync(recoverySource, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports, (name: string) => {
    if (name === './i18n/I18nProvider.tsx') return i18nTestModule();
    if (name.endsWith('packages/i18n/src/index.ts')) return i18n;
    if (name === 'react') return react;
    if (name === './RecoveryStorageDetails.tsx') return disclosure.exports;
    if (name === './ExportRangeSummary.tsx') return rangeSummary.exports;
    assert.equal(name, '@mioon/ui/components/button'); return { Button: 'Button' };
  });
  const events: string[] = [], recovery = ((module.exports as {default: (props: Record<string, unknown>) => unknown}).default)(({ state: { phase: 'ready', busy: false,
    candidate: { draftId: id(41), timelineId, baseRevision: 4, raw: { deliveryName: 'Saved draft' }, updatedAt: '2026-10-12T00:00:00.000Z' },
    intent: { intentId: id(40), timelineId, baseRevision: 4, input: { requestId: 'original-request', deliveryName: 'Original delivery' }, outcome: { status: 'pending' } } },
    controller: { restore: () => events.push('restore'), recover: () => events.push('recover') } } as Record<string, unknown>));
  const tree = renderPanel({ recovery, canCheck: false, deliveryNameError: 'Invalid name', pendingExport: true });
  assert.equal(findNode(tree, 'delivery-draft-recovery').props['aria-label'], '本地交付草稿与原导出请求');
  const restore = findNode(tree, 'restore-delivery-draft');
  const recover = findNode(tree, 'recover-original-delivery');
  assert.equal(restore.type, 'Button'); assert.equal(restore.props.type, 'button'); assert.equal(restore.props.disabled, false);
  assert.equal(recover.type, 'Button'); assert.equal(recover.props.type, 'button'); assert.equal(recover.props.disabled, false);
  assert.equal(textOf(recover), '确认恢复同一原请求'); assert.equal(findNode(tree, 'preflight-check').props.disabled, true);
  assert.equal(findNode(tree, 'preflight-export').props.disabled, true);
  assert.match(textOf(tree), /请使用原请求旁的恢复入口核对同一请求；重新检查不会重发导出/);
  assert.doesNotMatch(textOf(tree), /请在任务面板恢复同一请求/); assert.deepEqual(events, []);
});

test('actual dock view names saved-only scope, excludes all drafts and never performs reads itself', async () => {
  const f = fixture(); await f.ready(); const tree = renderPanel({ state: f.state(), projectName: '片名', dirty: true });
  const text = textOf(tree); for (const expected of ['仅检查已保存', '镜头、片段和源范围', '未保存修改', '未进行完整解码', '实际导出仍会重新验证', '不是导出成功凭据', '720 × 1280', '30 fps']) assert.ok(text.includes(expected), expected);
  assert.equal(findNode(tree, 'preflight-export').props.disabled, false);
  assert.doesNotMatch(panelSource, /useEffect|useState|\bfetch\s*\(|\brpc\s*\(|localStorage|sessionStorage|role="dialog"/);
});

test('actual dock view separates ready, incomplete, stale, error, pending receipt and export-in-progress', async () => {
  const f = fixture(); await f.ready(report({ status: 'incomplete' })); let tree = renderPanel({ state: f.state() });
  assert.match(textOf(tree), /检查未完成，仍尝试导出/); assert.match(textOf(tree), /不代表通过/);
  const exportButton = (tree: unknown): RenderNode => findNode(tree, 'preflight-export');
  assert.equal(exportButton(tree).props.disabled, false);
  for (const props of [{ exportBusy: true }, { pendingExport: true }, { state: { ...f.state(), phase: 'stale' } }, { state: { ...f.state(), phase: 'error' } }, { state: { ...f.state(), binding: null } }]) assert.equal(exportButton(renderPanel({ state: f.state(), ...props })).props.disabled, true);
});

test('third dock integrates with original keep-mounted/inert panes, existing mode guard, and no storage or selection switch', () => {
  assert.match(appSource, /data-testid="export-timeline"[^>]+onClick={openTimelineExport}/);
  for (const tab of ['properties', 'agent', 'delivery']) { const shell = readFileSync(new URL('../apps/web/src/WorkbenchShell.tsx', import.meta.url), 'utf8'); assert.ok((appSource + shell).includes(`data-testid="right-dock-tab-${tab}"`)); assert.ok(appSource.includes(`<AgentDockPane id="right-dock-${tab}"`)); }
  assert.match(appSource, /<CollapsibleContent keepMounted className="inspector-region-content">/);
  assert.match(appSource, /async function changeMode\(mode: WorkspaceMode\)[\s\S]*?if \(!await guardNavigation\(\)\) return;/);
  const inspect = appSource.slice(appSource.indexOf('  async function inspect('), appSource.indexOf('  async function addShot(')); assert.doesNotMatch(inspect, /setRightDockTab/);
  const controllerSource = readFileSync(new URL('../apps/web/src/export-preflight-state.ts', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../apps/web/src/use-export-preflight.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(controllerSource + hook, /localStorage|sessionStorage|setInterval|setTimeout|timeline\.render/);
  assert.doesNotMatch(hook, /\.check\(|takeExportBinding|visibilitychange/);
  assert.match(hook, /controller\.current!\.setVisible\(visible\)/);
});

test('rpc optional signal preserves exact existing call shape and only attaches observer signal on request', async t => {
  const previous = globalThis.fetch, calls: Array<[unknown, RequestInit]> = []; globalThis.fetch = (async (...args: [unknown, RequestInit]) => { calls.push(args); return { ok: true, json: async () => ({ ok: true, data: { ok: 1 } }) }; }) as unknown as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  await rpc('timeline.render', { purpose: 'preview' }); assert.equal(Object.hasOwn(calls[0]![1], 'signal'), false);
  const controller = new AbortController(); await rpc('timeline.export.preflight', { projectId, expectedRevision: 4 }, { signal: controller.signal });
  assert.equal(calls[1]![1].signal, controller.signal); assert.deepEqual(JSON.parse(String(calls[1]![1].body)), { operation: 'timeline.export.preflight', input: { projectId, expectedRevision: 4 } });
});

function hookHarness() {
  const slots: Array<Record<string, unknown>> = [], tasks: Array<Pending<unknown> & {input: unknown; options: {signal: AbortSignal}}> = []; let cursor = 0, effects: number[] = [];
  const react = {
    useRef(value: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: value }; return slots[index] as {current: unknown}; },
    useState(initial: unknown): [unknown, (value: unknown) => void] { const i = cursor++; if (!(i in slots)) slots[i] = { value: initial }; return [slots[i].value, (value: unknown) => { slots[i].value = value; }]; },
    useLayoutEffect(callback: () => void, dependencies: unknown[]) { const i = cursor++, old = slots[i]; const oldDependencies = (old as {dependencies?: unknown[]} | undefined)?.dependencies; if (old && dependencies.length === oldDependencies?.length && dependencies.every((value, j) => value === oldDependencies![j])) return; slots[i] = { dependencies, callback, cleanup: (old as {cleanup?: unknown} | undefined)?.cleanup }; effects.push(i); },
  };
  const module: {exports: {useExportPreflight?: (props: Record<string, unknown>) => {controller: {check(): Promise<void>; getState(): PreflightStateLike}}; default?: unknown}} = { exports: {} }, source = readFileSync(new URL('../apps/web/src/use-export-preflight.ts', import.meta.url), 'utf8');
  Function('module', 'exports', 'require', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module, module.exports, (name: string) => name === 'react' ? react : { createExportPreflightController });
  return {
    tasks,
    render(patch: Record<string, unknown> = {}): {controller: {check(): Promise<void>; getState(): PreflightStateLike}} { cursor = 0; effects = []; const props = { ...context(), projectId, visible: false, read: (input: unknown, options: unknown) => { const task = deferred(); tasks.push({ ...task, input, options: options as {signal: AbortSignal} }); return task.promise; }, ...patch }; const result = module.exports.useExportPreflight!(props); for (const i of effects) { (slots[i].cleanup as (() => void) | undefined)?.(); slots[i].cleanup = (slots[i].callback as () => unknown)(); } return result; },
    unmount() { for (const slot of slots) (slot.cleanup as (() => void) | undefined)?.(); },
  };
}

test('actual hook has no mount/visibility/reconnect request and detaches on unmount without late state', async () => {
  const h = hookHarness(); let state = h.render(); h.render({ visible: true }); h.render({ visible: false });
  h.render({ connected: false }); state = h.render({ connected: true, visible: true });
  assert.equal(h.tasks.length, 0); const pending = state.controller.check(); assert.equal(h.tasks.length, 1);
  h.unmount(); assert.equal(h.tasks[0].options.signal.aborted, true); h.tasks[0].resolve(report()); await pending;
  assert.equal(state.controller.getState().report, null);
  const recreated = hookHarness(); const restored = recreated.render({ visible: true }); assert.equal(recreated.tasks.length, 0); assert.equal(restored.controller.getState().report, null);
});

test('live project/revision refs fence responses before the next React context effect', async () => {
  for (const rejected of [false, true]) {
    let live = context(); const held = deferred(), auth = [];
    const controller = createExportPreflightController({ read: () => held.promise, getContext: () => live, onUnauthorized: () => auth.push(false) });
    controller.setContext(live); const waiting = controller.check();
    live = context({ projectId: id(99), scope: 'new-project:2' });
    // Deliberately do not call setContext: App navigation refs change first.
    if (rejected) held.reject(Object.assign(Error('Old authorization'), { code: 'UNAUTHORIZED' })); else held.resolve(report());
    await waiting; assert.equal(controller.getState().projectId, live.projectId); assert.equal(controller.getState().report, null); assert.equal(auth.length, 0);
  }
  let live = context(); const held = deferred(), controller = createExportPreflightController({ read: () => held.promise, getContext: () => live });
  controller.setContext(live); const waiting = controller.check(); live = context({ revision: 5 }); held.resolve(report()); await waiting;
  assert.equal(controller.getState().binding, null); assert.equal(controller.getState().revision, 5);
});

test('disposed live-context observer cannot reattach itself or publish late state', async () => {
  const held = deferred(), changes = [];
  const controller = createExportPreflightController({ read: () => held.promise, getContext: () => context(), onChange: state => changes.push(state) });
  controller.setContext(context()); const waiting = controller.check(), count = changes.length;
  controller.dispose(); held.resolve(report()); await waiting;
  assert.equal(changes.length, count); assert.equal(controller.getState().projectId, null); assert.equal(controller.getState().report, null);
});

test('owned issue source is identified compactly with Chinese known-code messages and safe unknown fallback', async () => {
  const f = fixture(); await f.ready(report({ status: 'blocked', issues: [{ code: 'PREFLIGHT_SOURCE_CHANGED', severity: 'error', message: 'A source changed.', assetId: id(20) }] }));
  const text = textOf(renderPanel({ state: f.state() })); assert.match(text, /源素材已变化/); assert.match(text, /素材 70000000/); assert.doesNotMatch(text, /A source changed/);
  assert.doesNotMatch(preflightIssueMessage({ code: 'UNKNOWN', severity: 'error', message: 'private bare secret' }), /private|bare|secret/);
});

test('snapshot-budget report stays incomplete with separate explicit unchecked export intent', async () => {
  const f = fixture(); await f.ready(report({ status: 'incomplete', timelineId: null, timelineRevision: null, snapshotHash: null, summary: null,
    checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false },
    issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'The ownership graph exceeded the bounded read budget.' }] }));
  assert.equal(f.state().phase, 'incomplete'); assert.equal(f.state().error, ''); assert.equal(f.state().binding, null);
  const tree = renderPanel({ state: f.state() }); assert.match(textOf(tree), /关联资料超出本次安全检查上限/); assert.match(textOf(tree), /仍尝试导出会使用当前已保存的时间线版本/);
  assert.equal(nodes(tree).find(node => node.props['data-testid'] === 'preflight-export'), undefined);
  assert.equal(findNode(tree, 'preflight-export-unchecked').props.disabled, false);
  assert.deepEqual(f.state().uncheckedIntent, { projectId, expectedRevision: 4 });
  assert.equal(f.controller.takeExportBinding(null), null);
});

for (const mismatch of [{ timelineId: id(99), timelineRevision: null }, { timelineId: null, timelineRevision: 5 }]) {
  test(`incomplete report rejects non-null mismatched context ${JSON.stringify(mismatch)}`, async () => {
    const f = fixture(); await f.ready(report({ status: 'incomplete', snapshotHash: null, summary: null, ...mismatch }));
    assert.equal(f.state().phase, 'error'); assert.equal(f.state().binding, null); assert.match(f.state().error, /不完整或与当前快照不匹配/);
  });
}

const uncheckedReport = (patch: Record<string, unknown> = {}): Record<string, unknown> => report({ status: 'incomplete', timelineId: null, timelineRevision: null, snapshotHash: null, summary: null,
  checks: { totalAssets: 0, checkedAssets: 0, bytesHashed: 0, fullDecode: false },
  issues: [{ code: 'PREFLIGHT_SNAPSHOT_BUDGET', severity: 'warning', message: 'Ownership graph budget reached.' }], ...patch });

test('unchecked intent is distinct, one-use, cannot be forged, and never enters checked-binding path', async () => {
  const f = fixture(); await f.ready(uncheckedReport()); const intent = f.state().uncheckedIntent;
  assert.equal(f.state().binding, null); assert.equal(f.state().report.snapshotHash, null); assert.equal(Object.hasOwn(intent as object, 'preflightSnapshotHash'), false);
  assert.equal(f.controller.takeExportBinding(intent), null); assert.equal(f.controller.takeUncheckedExportIntent({ ...intent }), null);
  assert.equal(f.controller.takeUncheckedExportIntent(intent), intent); assert.equal(f.controller.takeUncheckedExportIntent(intent), null);
  assert.equal(f.state().attempted, true); assert.equal(f.state().binding, null);
});

test('actual unchecked export is explicit, uses current saved revision without hash, and dispatches only once', async () => {
  const f = fixture(), h = appHarness(f); h.open(); const pending = h.check(); f.reads.at(-1)!.resolve(uncheckedReport()); await pending;
  assert.equal(h.calls.length, 0); const intent = f.state().uncheckedIntent;
  const calls: unknown[] = [], tree = renderPanel({ state: f.state(), onExport: () => assert.fail('Unchecked action cannot use checked export callback'), onUncheckedExport: (value: unknown) => calls.push(value) });
  const button = findNode(tree, 'preflight-export-unchecked');
  assert.match(textOf(button), /未完成快照核验，仍尝试导出/); (button.props.onClick as () => void)(); assert.deepEqual(calls, [intent]);
  await h.renderUnchecked(intent); await h.renderUnchecked(intent);
  assert.deepEqual(h.calls, [['local-delivery.submit', { projectId, expectedRevision: 4, requestId: 'stable-test-request', purpose: 'export' }]]);
  assert.equal(f.state().report.snapshotHash, null); assert.equal(f.state().binding, null);
});

test('unchecked intent expires on newer checks and cannot skip stale, blocked, known-error or ready outcomes', async () => {
  const f = fixture(); await f.ready(uncheckedReport()); const old = f.state().uncheckedIntent;
  await f.ready(uncheckedReport()); assert.equal(f.controller.takeUncheckedExportIntent(old), null);
  for (const value of [report(), report({ status: 'blocked' }), report({ status: 'stale' }), report({ status: 'incomplete' }), uncheckedReport({ issues: [{ code: 'PREFLIGHT_SOURCE_INVALID', severity: 'error', message: 'Known invalid source' }] })]) {
    await f.ready(value); assert.equal(f.state().uncheckedIntent, null); assert.equal(f.controller.takeUncheckedExportIntent(old), null);
    assert.equal(nodes(renderPanel({ state: f.state() })).some(node => node.props['data-testid'] === 'preflight-export-unchecked'), false);
  }
});

test('actual unchecked export rejects changed project/revision and protects original pending receipts', async () => {
  const f = fixture(), h = appHarness(f); await f.ready(uncheckedReport()); let intent = f.state().uncheckedIntent;
  h.pending.push({ key: 'timeline:render:export', operation: 'timeline.render', input: { requestId: 'original-receipt', expectedRevision: 2 } });
  await h.renderUnchecked(intent); assert.equal(h.calls.length, 0); assert.deepEqual(h.jobs, [true]); assert.equal(f.state().attempted, false);
  h.pending.length = 0; h.env.dataRef.current.timeline.revision = 5; await h.renderUnchecked(intent); assert.equal(h.calls.length, 0);
  f.controller.setContext(context()); await f.ready(uncheckedReport()); intent = f.state().uncheckedIntent;
  h.env.dataRef.current.timeline.revision = 4; h.env.currentProject.current = id(99); await h.renderUnchecked(intent); assert.equal(h.calls.length, 0);
});

test('unchecked intent rechecks live context before React effect and cannot revive after disconnect/dispose', async () => {
  let live = context(); const controller = createExportPreflightController({ read: async () => uncheckedReport(), getContext: () => live });
  controller.setContext(live); await controller.check(); let intent = controller.getState().uncheckedIntent;
  live = context({ revision: 5 }); assert.equal(controller.takeUncheckedExportIntent(intent), null);
  live = context(); controller.setContext(live); await controller.check(); intent = controller.getState().uncheckedIntent;
  controller.setContext(context({ connected: false })); assert.equal(controller.takeUncheckedExportIntent(intent), null);
  controller.setContext(live); await controller.check(); intent = controller.getState().uncheckedIntent;
  controller.dispose(); assert.equal(controller.takeUncheckedExportIntent(intent), null); assert.equal(controller.getState().projectId, null);
});

test('unchecked export control respects pending receipt and submission busy states without changing its warning', async () => {
  const f = fixture(); await f.ready(uncheckedReport());
  for (const props of [{ exportBusy: true }, { pendingExport: true }, { state: { ...f.state(), attempted: true } }]) {
    const tree = renderPanel({ state: f.state(), ...props }); assert.match(textOf(tree), /当前已保存的时间线版本/);
    assert.equal(findNode(tree, 'preflight-export-unchecked').props.disabled, true);
  }
});

test('compact dock exposes saved-snapshot scope and dirty warning while showing blocking issues before statistics', async () => {
  const f = fixture(); await f.ready(report({ status: 'blocked', issues: [{ code: 'PREFLIGHT_SOURCE_INVALID', severity: 'error', message: 'Missing managed source', assetId: id(20) }] }));
  const tree = renderPanel({ state: f.state(), dirty: true, projectName: 'Missing media project' }), all = nodes(tree);
  const disclosure = all.find(node => node.props['data-testid'] === 'preflight-scope-details')!;
  assert.equal(disclosure.type, 'details'); assert.equal(disclosure.props.open, undefined);
  assert.match(textOf(nodes(disclosure).find(node => node.type === 'summary')), /仅检查已保存的时间线快照/);
  assert.match(textOf(disclosure), /镜头、片段和源范围/);
  const dirty = all.find(node => node.props['data-testid'] === 'preflight-unsaved')!; assert.ok(dirty);
  assert.equal(nodes(disclosure).includes(dirty), false, 'Draft warning must remain visible while disclosure is closed');
  assert.match(textOf(dirty), /本次不包含/);
  const issues = all.findIndex(node => node.props['data-testid'] === 'preflight-issues');
  assert.ok(issues > 0); assert.ok(issues < all.findIndex(node => node.props.className === 'export-preflight-checked'));
  assert.ok(issues < all.findIndex(node => node.props.className === 'export-preflight-summary'));
  assert.match(textOf(all[issues]), /源素材缺失/);
  const body = all.find(node => node.props.className === 'export-preflight-body')!, footer = all.find(node => node.type === 'footer')!;
  assert.equal(nodes(body).includes(footer), false, 'Actions stay outside report scroll');
  const css = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.export-preflight-actions\{display:flex;flex:none;/);
  assert.match(css, /\.export-preflight-body\{min-height:0;flex:1;overflow:auto;/);
});

test('passive check instructions are collapsed while current state and explicit check remain visible', () => {
  let checks = 0;
  const tree = renderPanel({ state: { phase: 'idle' }, canCheck: true, exportBusy: false, onCheck: () => { checks++; } });
  const help = findNode(tree, 'preflight-help-details');
  assert.equal(help.type, 'details');
  assert.equal(help.props.open, undefined);
  assert.match(textOf(nodes(help).find(node => node.type === 'summary')), /说明/);
  assert.match(textOf(help), /打开面板不会开始检查/);
  assert.match(textOf(help), /短时合成编码与 MP4 封装/);
  assert.match(textOf(help), /100 个片段/);
  assert.match(textOf(findNode(tree, 'export-check-result')), /尚未检查/);
  const check = findNode(tree, 'preflight-check');
  assert.equal(nodes(help).some(node => node.props['data-testid'] === 'preflight-check'), false);
  assert.equal(check.props.disabled, false);
  assert.equal(checks, 0);
  (check.props.onClick as () => void)();
  assert.equal(checks, 1);
  const readyHelp = findNode(renderPanel({ state: { phase: 'ready' } }), 'preflight-help-details');
  assert.doesNotMatch(textOf(readyHelp), /打开面板不会开始检查/);
  assert.match(textOf(readyHelp), /短时合成编码与 MP4 封装/);
});
