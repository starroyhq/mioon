import type {RootTree, RootNode, RootHook} from './helpers/strict-root-ui-types.ts';
import { createLanguageStore } from '../apps/web/src/i18n/language-store.ts';
import { message, createI18nTestContext } from './helpers/i18n.ts';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import * as api from '../apps/web/src/api.ts';
import * as submissions from '../apps/web/src/submissions.ts';
import * as mutations from '../apps/web/src/mutation-submissions.ts';
import * as editTasks from '../apps/web/src/edit-task-client.ts';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.ts';
import * as references from '../apps/web/src/reference-connections.ts';
import type { Locale } from '../packages/i18n/src/types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(path.join(root, 'apps/web/src', file), 'utf8');
const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = (value: RootTree) : string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const id = (n: number) => `d9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T00:00:00.000Z';
const task = (n: number, status: string|undefined = 'unknown') => ({ id: id(n), requestId: `exact-original-request-${n}`, operation: 'timeline.track.update', createdAt: stamp, status, lane: 'timeline:mutation' });
const job = (n: number, status: string) => ({ id: id(n), shotId: id(50), providerId: 'mock', createdAt: stamp, status, progress: 25, snapshot: { duration: 4, aspectRatio: '9:16' } });
const defer = () => { let resolve!: (value: boolean) => void; const promise = new Promise<boolean>(done => { resolve = done; }); return { promise, resolve }; };
const find = (tree: RootTree, testId: string) => nodes(tree).find(node => node.props['data-testid'] === testId);
const button = (tree: RootTree, label: string) => nodes(tree).find((node: RootNode) => node.type === 'Button' && text(node) === label);
const defaults = () => ({ activeCount: 0, pending: [], busy: {}, jobs: [], data: { shots: [], assets: [], jobs: [] }, reconcileIds: {}, tasks: { phase: 'ready', items: [], uncertain: [], busy: [] } });

let rendered: Record<string, string>;
before(() => {
  const populated = { ...defaults(), activeCount: 1, jobs: [job(10, 'failed'), job(11, 'submission_unknown'), job(12, 'running')], tasks: { phase: 'ready', items: [{ ...task(1), requestId: 'original-request-'.repeat(24) }, task(2, 'applied')], uncertain: [], busy: [] } };
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import TaskCenter from './src/TaskCenter.tsx';
    import {AgentDockPane} from './src/AgentWorkspace.tsx';
    const forbidden = () => { throw Error('Rendering may not capture a view or execute a task'); };
    const callbacks = { captureView: forbidden, run: forbidden, retryGeneration: forbidden, onInspectJob: forbidden, onRecover: forbidden, onReload: forbidden, onAdopt: forbidden, setReconcileIds: forbidden, context: forbidden, isCurrent: forbidden, confirm: forbidden };
    const populated = ${JSON.stringify(populated)};
    export const html = Object.fromEntries([['empty', ${JSON.stringify(defaults())}, true], ['normal', populated, true], ['hidden', populated, false]].map(([name, props, visible]) => [name, renderToStaticMarkup(
      <AgentDockPane id="right-dock-tasks" labelledBy="right-dock-tasks-tab" visible={visible} fallbackFocus="[data-testid=right-dock-tab-properties]">
        <TaskCenter {...props} {...callbacks} taskViewScope="project:1:tasks" />
      </AgentDockPane>)]));`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => { throw Error('Task presentation may not request data'); };
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, outfile: 'task-dock-fixture.js', define: {'process.env.NODE_ENV': '"production"'}});
    const javascript = outputFiles.find(file => file.path.endsWith('.js'));
    if (!javascript) throw Error('Task dock fixture did not emit JavaScript');
    const result = await import('data:text/javascript;base64,' + Buffer.from(javascript.text).toString('base64'));
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result.html), error => error ? reject(error) : resolve())); process.exit(0);`;
  rendered = JSON.parse(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }));
});

test('actual TaskCenter renders an inline named dock with keyboard-scrollable body and no modal controls', () => {
  for (const html of Object.values(rendered)) {
    assert.match(html, /id="right-dock-tasks"[^>]*role="tabpanel"[^>]*aria-labelledby="right-dock-tasks-tab"/);
    assert.match(html, /<section class="task-workspace" data-testid="task-workspace" aria-labelledby="task-workspace-heading"/);
    assert.match(html, /<h2 id="task-workspace-heading">任务中心<\/h2>/);
    assert.match(html, /class="task-workspace-body"[^>]*role="region"[^>]*aria-label="任务记录"[^>]*tabindex="0"/);
    assert.match(html, /<footer class="task-workspace-note">/);
    assert.doesNotMatch(html, /role="dialog"|aria-modal=|data-slot="dialog|jobs-drawer|关闭任务中心|drawer-backdrop/);
  }
  assert.match(rendered.empty, /没有待确认的本地编辑请求/); assert.match(rendered.empty, /还没有生成任务/);
  assert.match(rendered.normal, /1 个任务正在处理/);
  assert.match(rendered.normal, /data-slot="button"/); assert.match(rendered.normal, /data-slot="input"/);
  assert.match(rendered.normal, /服务商可能已接受任务并计费/);
  assert.match(rendered.normal, /<details[^>]*data-testid="recovery-task-storage-disclosure"/);
  assert.match(rendered.normal, /<summary>保存范围与容量说明<\/summary>/);
  assert.ok(rendered.normal.indexOf('recovery-task-storage-disclosure') > rendered.normal.indexOf('task-workspace-body'));
  assert.ok(rendered.normal.indexOf('recovery-task-storage-disclosure') < rendered.normal.indexOf('task-workspace-note'));
  assert.match(rendered.hidden, /id="right-dock-tasks"[^>]*hidden=""[^>]*inert=""[^>]*aria-hidden="true"/);
  assert.match(rendered.hidden, /exact-original-request-2/);
});

// Render the real TaskCenter, TSX hook/shell, durable and pending cards. Hook
// slots model commit/cleanup so retained handlers can be invoked after hiding.
function harness(languageStore?: Parameters<typeof creationTestDependency>[1]) {
  const modules = new Map<string, Record<string, (props: unknown) => RootTree>>(), slots: unknown[] = [], calls: [string, ...unknown[]][] = [];
  let cursor = 0, effects: number[] = [];
  const h = { visible: true, current: true, scope: 'project:1:tasks', captureCalls: 0, calls } as {visible: boolean; current: boolean; scope: string; captureCalls: number; calls: typeof calls; render(patch?: Record<string, unknown>): RootTree; unmount(): void};
  const forbidden = () => assert.fail('Rendering/interaction must use supplied callbacks, not storage or network');
  const storage = new Proxy({}, { get: forbidden, set: forbidden });
  const react = {
    createElement(type: string | ((props: unknown) => RootTree), props: Record<string, unknown>, ...children: RootTree[]) { const value = { ...props, children }; return typeof type === 'function' ? type(value) : { type, props: value }; },
    useState(value: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? (value as () => unknown)() : value; return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? (next as (prior: unknown) => unknown)(slots[index]) : next; }]; },
    useRef(value: unknown) { const index = cursor++; return slots[index] ||= { current: value }; },
    useMemo(factory: () => unknown, deps: readonly unknown[]) { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== (slots[index] as RootHook).deps![i])) slots[index] = { value: factory(), deps }; return (slots[index] as RootHook).value; },
    useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]) { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== (slots[index] as RootHook).deps![i])) { slots[index] = { effect, deps, cleanup: (slots[index] as RootHook | undefined)?.cleanup }; effects.push(index); } },
  }; (react as typeof react & {default: typeof react}).default = react;
  function load(file: string) {
    if (modules.has(file)) return modules.get(file)!;
    const module = { exports: {} as Record<string, (props: unknown) => RootTree> };
    const resolve = (name: string) => {
    const i18nDependency = creationTestDependency(name, languageStore); if (i18nDependency) return i18nDependency;
      if (name === 'react') return react;
      if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => h.visible };
      if (name === './TaskWorkspace.css') return {};
      if (['./TaskWorkspace.tsx', './PendingSubmission.tsx', './RecoveryStorageDetails.tsx', './TaskRenderList.tsx'].includes(name)) return load(name.slice(2));
      const business = { '@mioon/contracts': contracts, './api.ts': api, './submissions.ts': submissions, './mutation-submissions.ts': mutations, './edit-task-client.ts': editTasks, './workspace-origin.ts': workspaceOrigin, './reference-connections.ts': references };
      if (business[name as keyof typeof business]) return business[name as keyof typeof business];
      if (['./icons.tsx', './SubjectVideoSummary.tsx'].includes(name)) return { __esModule: true, default: name };
      const primitives = { '@mioon/ui/components/workbench-controls': ['WorkbenchBadge', 'WorkbenchButton', 'WorkbenchProgress'], '@mioon/ui/components/badge': ['Badge'], '@mioon/ui/components/button': ['Button'], '@mioon/ui/components/input': ['Input'], '@mioon/ui/components/label': ['Label'] };
      if (primitives[name as keyof typeof primitives]) return Object.fromEntries(primitives[name as keyof typeof primitives].map(key => [key, key]));
      assert.fail(`Unexpected TaskCenter dependency: ${name}`);
    };
    Function('module', 'exports', 'require', 'fetch', 'localStorage', 'sessionStorage', transformSync(read(file), { loader: file.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code)(module, module.exports, resolve, forbidden, storage, storage);
    modules.set(file, module.exports); return module.exports;
  }
  const Component = load('TaskCenter.tsx').default;
  const callbacks = Object.fromEntries(['run', 'retryGeneration', 'onInspectJob', 'onRecover', 'onReload', 'onAdopt', 'setReconcileIds'].map(name => [name, (...args: unknown[]) => calls.push([name, ...args])]));
  h.render = (patch: Record<string, unknown> = {}) => {
    cursor = 0; effects = [];
    const tree = Component({ ...defaults(), ...callbacks, taskViewScope: h.scope, captureView: () => { h.captureCalls++; return h.current ? () => h.current : null; }, context: () => 'original-context', isCurrent: (value: string) => value === 'original-context', confirm: async () => true, ...patch });
    effects.forEach(index => { (slots[index] as RootHook).cleanup?.(); (slots[index] as RootHook).cleanup = (slots[index] as RootHook).effect!(); });
    return tree;
  };
  h.unmount = () => slots.forEach(slot => (slot as RootHook | undefined)?.cleanup?.());
  return h;
}

function actionFixture() {
  const unknown = task(1), applied = task(2, 'applied'), failed = job(10, 'failed'), uncertain = job(11, 'submission_unknown'), running = job(12, 'running');
  const entry = { projectId: id(90), key: 'timeline:mutation', operation: unknown.operation, input: { requestId: unknown.requestId }, createdAt: stamp };
  return { unknown, applied, failed, uncertain, running, entry, props: { tasks: { phase: 'error', items: [unknown, applied], uncertain: [], busy: [] }, pending: [entry], jobs: [failed, uncertain, running], reconcileIds: { [uncertain.id]: '  provider-original  ' } } };
}

function actions(tree: RootTree, fixture: ReturnType<typeof actionFixture>) {
  return [
    () => (find(tree, 'recover-durable-task'))!.props.onClick(),
    () => (find(tree, 'acknowledge-task'))!.props.onClick(),
    () => (find(tree, 'adopt-legacy-task'))!.props.onClick(),
    () => (find(tree, 'resume-pending'))!.props.onClick(),
    () => (find(tree, `reconcile-job-${fixture.uncertain.id}`))!.props.onClick(),
    () => (find(tree, `retry-job-${fixture.failed.id}`))!.props.onClick(),
    () => (button(tree, '查看镜头'))!.props.onClick(),
    () => (button(tree, '重新载入任务'))!.props.onClick(),
    () => (nodes(tree).find((node: RootNode) => node.type === 'Input'))!.props.onChange({ target: { value: 'changed-provider-id' } }),
    () => (button(tree, '停止等待'))!.props.onClick(),
  ];
}

test('mount, rerender and disclosure expansion execute nothing; selected tasks retain exact operation inputs', async () => {
  const h = harness(), f = actionFixture();
  h.render(f.props); let tree = h.render(f.props);
  assert.deepEqual((h.calls as unknown), []); assert.equal(h.captureCalls, 0);
  const disclosure = find(tree, 'recovery-task-storage-disclosure'); (disclosure)!.props.open = true;
  assert.deepEqual((h.calls as unknown), []); assert.equal(h.captureCalls, 0);
  const selected = (key: string) => h.render({ ...f.props, selectedTaskId: key });
  (find(selected(`local:${f.unknown.id}`), 'recover-durable-task'))!.props.onClick();
  const unknownFence = (h.calls.at(-1))![3] as () => boolean; assert.equal(unknownFence(), true);
  (find(selected(`local:${f.applied.id}`), 'acknowledge-task'))!.props.onClick();
  const appliedFence = (h.calls.at(-1))![3] as () => boolean; assert.equal(appliedFence(), true); assert.equal(unknownFence(), false);
  tree = selected(`pending:legacy:${f.entry.key}`); (find(tree, 'adopt-legacy-task'))!.props.onClick(); (find(tree, 'resume-pending'))!.props.onClick();
  tree = selected(f.uncertain.id); (find(tree, `reconcile-job-${f.uncertain.id}`))!.props.onClick();
  (nodes(find(tree, `job-${f.uncertain.id}`)).find((node: RootNode) => node.type === 'Input'))!.props.onChange({ target: { value: 'changed-provider-id' } });
  tree = selected(f.failed.id); (find(tree, `retry-job-${f.failed.id}`))!.props.onClick(); (button(tree, '查看镜头'))!.props.onClick();
  for (const name of ['retryGeneration', 'onInspectJob']) { const call: [string, ...unknown[]] | undefined = h.calls.find(call => call[0] === name); assert.equal((call)![1], f.failed); assert.equal((call![2] as () => boolean)(), true); }
  tree = selected(f.running.id); await (button(find(tree, `job-${f.running.id}`), '停止等待'))!.props.onClick();
  (button(tree, '重新载入任务'))!.props.onClick();
  assert.deepEqual(h.calls.filter(call => call[0] === 'onRecover').map(call => call.slice(0, 3)), [['onRecover', f.unknown, false], ['onRecover', f.applied, true]]);
  assert.deepEqual(h.calls.find(call => call[0] === 'onAdopt'), ['onAdopt', f.entry]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'run'), [
    ['run', f.entry.key, f.entry.operation, f.entry.input, message('tasks.center.originalRecovered'), { replay: true }],
    ['run', `reconcile:${f.uncertain.id}`, 'job.reconcile', { jobId: f.uncertain.id, providerJobId: 'provider-original' }, message('tasks.center.existingStatusChecked')],
    ['run', `cancel:${f.running.id}`, 'job.cancel', { jobId: f.running.id }, message('tasks.center.stopRequested')],
  ]);
  const update = (h.calls.find(call => call[0] === 'setReconcileIds'))![1] as (prior: Record<string, string>) => Record<string, string>;
  assert.deepEqual(update({ retained: 'other' }), { retained: 'other', [f.uncertain.id]: 'changed-provider-id' });
});

test('task list selects one full detail, prioritizes unknown outcomes and preserves visible reconciliation identities', () => {
  const h = harness(), uncertain = { ...job(11, 'submission_unknown'), requestId: 'original-generation-request' }, running = job(12, 'running');
  let tree = h.render({jobs:[running,uncertain]});
  const panes = () => nodes(tree).filter((node: RootNode) => node.props?.className === 'task-center-detail-pane');
  assert.equal(panes().filter(node => !node.props.hidden).length, 1);
  assert.equal((panes().find(node => !node.props.hidden))!.props['data-task-detail-key'], uncertain.id);
  const unknownCard = find(tree, `job-${uncertain.id}`), details = nodes(unknownCard).filter((node: RootNode) => node.type === 'details');
  assert.equal(details.length, 1); assert.equal(details[0].props.open, undefined);
  assert.equal(find(details[0], `reconcile-job-${uncertain.id}`), undefined);
  assert.ok(find(unknownCard, `reconcile-job-${uncertain.id}`));
  assert.match(text(unknownCard), /original-generation-request/); assert.doesNotMatch(text(details[0]), /original-generation-request/);
  assert.ok(nodes(unknownCard).some((node: RootNode) => node.props?.className === 'notice warning'));
  (find(tree, `task-select-${running.id}`))!.props.onClick();
  tree = h.render({jobs:[running,uncertain]});
  assert.equal((panes().find(node => !node.props.hidden))!.props['data-task-detail-key'], running.id);
  assert.equal((find(tree, `task-select-${running.id}`))!.props['aria-pressed'], true);
  assert.deepEqual((h.calls as unknown), []);
});

test('switching task details revokes retained actions and pending confirmations without dispatching on selection', async () => {
  const h = harness(), uncertain = job(11, 'submission_unknown'), running = job(12, 'running'), decision = defer();
  const props = { jobs: [uncertain, running], confirm: () => decision.promise };
  let tree = h.render(props); const retained = (find(tree, `reconcile-job-${uncertain.id}`))!.props.onClick;
  (find(tree, `task-select-${running.id}`))!.props.onClick(); retained(); assert.deepEqual((h.calls as unknown), [], 'Selection revokes the previous detail before commit');
  tree = h.render(props); const waiting = (button(find(tree, `job-${running.id}`), '停止等待'))!.props.onClick();
  (find(tree, `task-select-${uncertain.id}`))!.props.onClick(); h.render(props); (decision.resolve)!(true); await waiting;
  retained(); assert.deepEqual((h.calls as unknown), [], 'An old selected card cannot revive after a leave-return');
});

test('local search and status filters use loaded entries only, keep cards mounted and revoke hidden detail actions', () => {
  const h = harness(), f = actionFixture(), complete = job(13, 'succeeded');
  const props = { ...f.props, jobs: [f.running, f.uncertain, f.failed, complete], selectedTaskId: f.uncertain.id };
  let tree = h.render(props); const oldReconcile = (find(tree, `reconcile-job-${f.uncertain.id}`))!.props.onClick;
  const visibleKey = () => nodes(tree).find(node => node.props?.className === 'task-center-detail-pane' && !node.props.hidden)?.props['data-task-detail-key'];
  const rows = () => nodes(find(tree, 'task-center-list')).filter((node: RootNode) => node.props?.className === 'task-center-row');
  (find(tree, 'task-filter-active'))!.props.onClick(); oldReconcile(); assert.deepEqual((h.calls as unknown), []);
  tree = h.render(props); assert.deepEqual(rows().map(node => node.props['data-testid']), [`task-select-${f.running.id}`]); assert.equal(visibleKey(), f.running.id);
  assert.ok(find(tree, `job-${f.uncertain.id}`), 'Filtered details remain mounted');
  (find(tree, 'task-filter-finished'))!.props.onClick(); tree = h.render(props);
  assert.deepEqual(rows().map(node => node.props['data-testid']), [`task-select-local:${f.applied.id}`, `task-select-${f.failed.id}`, `task-select-${complete.id}`]); assert.equal(visibleKey(), `local:${f.applied.id}`);
  (find(tree, 'task-filter-uncertain'))!.props.onClick(); tree = h.render(props);
  assert.deepEqual(rows().map(node => node.props['data-testid']), [`task-select-local:${f.unknown.id}`, `task-select-pending:legacy:${f.entry.key}`, `task-select-${f.uncertain.id}`]);
  (find(tree, 'task-filter-all'))!.props.onClick(); tree = h.render(props);
  (find(tree, 'task-center-search'))!.props.onChange({target:{value:f.applied.requestId}}); tree = h.render(props);
  assert.deepEqual(rows().map(node => node.props['data-testid']), [`task-select-local:${f.applied.id}`]); assert.equal(visibleKey(), `local:${f.applied.id}`);
  const staleSearch = (find(tree, 'task-center-search'))!.props.onChange;
  staleSearch({target:{value:'no matching loaded task'}}); tree = h.render(props);
  assert.equal(rows().length, 0); assert.ok(find(tree, 'task-center-filter-empty')); assert.equal(visibleKey(), undefined);
  assert.ok(nodes(tree).filter((node: RootNode) => node.props?.className === 'task-center-detail-pane').every(node => node.props.hidden && node.props.inert));
  oldReconcile(); staleSearch({target:{value:''}}); assert.deepEqual((h.calls as unknown), []);
  tree = h.render(props); assert.equal((find(tree, 'task-center-search'))!.props.value, 'no matching loaded task');
  tree = h.render({ ...props, selectedTaskId: complete.id }); assert.equal((find(tree, 'task-center-search'))!.props.value, ''); assert.equal(visibleKey(), complete.id); assert.equal(rows().length, 7);
});

test('search, filters and no-match state relabel in four languages without fetching or changing task data', async () => {
  const store = createLanguageStore({systemLanguages:['zh-Hans']}), h = harness(store), props = {jobs:[job(11,'submission_unknown')]};
  let tree=h.render(props); (find(tree,'task-center-search'))!.props.onChange({target:{value:'missing-local-item'}});
  for(const locale of ['zh-Hans','zh-Hant','en','ja'] as const) {
    await store.setPreference(locale);tree=h.render(props);const ctx=createI18nTestContext(locale);
    assert.equal((find(tree,'task-center-search'))!.props['aria-label'],ctx.t('redesign.tasks.search'));
    for(const filter of ['all','active','uncertain','finished'] as const) assert.equal(text(find(tree,`task-filter-${filter}`)),ctx.t(`redesign.tasks.${filter}`));
    assert.match(text(find(tree,'task-center-filter-empty')),new RegExp(ctx.t('redesign.tasks.noMatch')));
    assert.equal((find(tree,'task-center-search'))!.props.value,'missing-local-item');assert.deepEqual((h.calls as unknown),[]);
  }
  h.unmount();store.dispose();
});

test('all retained task actions reject hidden, unmounted, changed-scope and leave-return pane lifetimes', async () => {
  for (const mode of ['hidden', 'hidden-return', 'unmounted', 'scope-change', 'scope-return', 'live-view-invalid']) {
    const h = harness(), f = actionFixture(), tree = h.render({ ...f.props, selectedTaskId: f.failed.id });
    const handlers = actions(tree, f);
    (button(tree, '查看镜头'))!.props.onClick();
    const acceptedPredicate = (h.calls.pop())![2] as () => boolean; assert.equal(acceptedPredicate(), true);
    if (mode === 'hidden' || mode === 'hidden-return') { h.visible = false; h.render({ ...f.props, selectedTaskId: f.failed.id }); if (mode === 'hidden-return') { h.visible = true; h.render({ ...f.props, selectedTaskId: f.failed.id }); } }
    if (mode === 'scope-change' || mode === 'scope-return') { h.scope = 'project:2:tasks'; h.render(f.props); if (mode === 'scope-return') { h.scope = 'project:1:tasks'; h.render(f.props); } }
    if (mode === 'unmounted') h.unmount();
    if (mode === 'live-view-invalid') h.current = false;
    assert.equal(acceptedPredicate(), false, mode);
    for (const invoke of handlers) await invoke();
    assert.deepEqual((h.calls as unknown), [], mode);
    if (mode === 'hidden-return' || mode === 'scope-return') { const fresh = h.render(f.props); (find(fresh, 'recover-durable-task'))!.props.onClick(); assert.equal(h.calls.length, 1, mode); }
  }
});

test('hidden initial render cannot admit clicks and a null or false App capture fails closed', async () => {
  const f = actionFixture();
  for (const patch of [{ hidden: true }, { captureView: () => null }, { captureView: () => () => false }]) {
    const h = harness(); if (patch.hidden) h.visible = false;
    const tree = h.render({ ...f.props, ...patch });
    for (const invoke of actions(tree, f)) await invoke();
    assert.deepEqual((h.calls as unknown), []);
  }
});

test('cancel confirmation admits only the current context and pane after the awaited decision', async () => {
  for (const mode of ['approved', 'declined', 'context-stale', 'hidden', 'hidden-return', 'unmounted', 'view-stale']) {
    const h = harness(), f = actionFixture(), decision = defer();
    const tree = h.render({ ...f.props, selectedTaskId: f.running.id, confirm: () => decision.promise, isCurrent: () => mode !== 'context-stale' });
    const cancelling = (button(tree, '停止等待'))!.props.onClick();
    if (mode.startsWith('hidden')) { h.visible = false; h.render({ ...f.props, selectedTaskId: f.failed.id }); if (mode === 'hidden-return') { h.visible = true; h.render({ ...f.props, selectedTaskId: f.failed.id }); } }
    if (mode === 'unmounted') h.unmount();
    if (mode === 'view-stale') h.current = false;
    (decision.resolve)!(mode !== 'declined'); await cancelling;
    assert.equal(h.calls.length, mode === 'approved' ? 1 : 0, mode);
    if (mode === 'approved') assert.equal(h.calls[0][2], 'job.cancel');
  }
});

test('task list and details scroll independently while narrow docks wrap and retain action controls', () => {
  const css = read('TaskWorkspace.css');
  assert.match(css, /\.task-workspace\{[^}]*min-width:0[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(css, /\.task-workspace-heading\{[^}]*flex:none/);
  assert.match(css, /\.task-workspace-note\{[^}]*flex:none/);
  assert.match(css, /\.task-workspace-body\{[^}]*min-width:0[^}]*min-height:0[^}]*overflow:auto[^}]*overscroll-behavior:contain[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.task-workspace \.job-actions\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.task-workspace \.job-title strong\{[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.task-workspace \.job-actions>button[^}]*max-width:100%[^}]*height:auto[^}]*white-space:normal[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.inspector-region-heading>\.right-dock-tabs\{[^}]*flex:1[^}]*min-width:0[^}]*overflow-x:auto/);
  assert.match(css, /\.inspector-region-heading>\.right-dock-tabs \[data-slot="tabs-list"\]\{[^}]*width:max-content/);
  assert.match(css, /\.inspector-region-heading>\[data-testid="toggle-inspector"\]\{[^}]*flex:none/);
  assert.doesNotMatch(css, /position:fixed|min-width:(240|310|420)px/);
  assert.match(css, /\.task-center-browser\{[^}]*grid-template-columns:280px minmax\(0,1fr\)/);
  assert.match(css, /\.task-center-sidebar,\.task-center-detail\{[^}]*overflow:auto/);
  assert.match(css, /@container task-center \(max-width:620px\)/);
  const shell = read('TaskWorkspace.tsx'), taskCenter = read('TaskCenter.tsx');
  assert.doesNotMatch(shell, /\bfetch\s*\(|\brpc\s*\(|sessionStorage|localStorage|setInterval|setTimeout|createPortal|Dialog|Modal|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck/);
  assert.doesNotMatch(shell, /workspace-visibility\.jsx|TaskWorkspace\.css/);
  assert.match(taskCenter, /useTaskWorkspaceInteraction\(pass\(captureView\), taskViewScope, visible\)/);
  assert.doesNotMatch(taskCenter, /components\/dialog|onClose|setShowJobs|\binspect\(/);
});

test('pending task confirmation relabels across four languages while retaining its exact original cancellation target', async () => {
  const store = createLanguageStore({ systemLanguages: ['zh-Hans'] }), h = harness(store), f = actionFixture();
  let resolve!: (value: boolean) => void, descriptor: Parameters<ReturnType<typeof createI18nTestContext>["renderMessage"]>[0]; const waiting = new Promise<boolean>(done => { resolve = done; });
  const props = { ...f.props, confirm: (value: typeof descriptor) => { descriptor = value; return waiting; } };
  const tree = h.render({ ...props, selectedTaskId: f.running.id }), action = (button(tree, '停止等待'))!.props.onClick();
  assert.deepEqual(descriptor, message('tasks.center.stopWaitConfirmation')); assert.deepEqual((h.calls as unknown), []);
  for (const locale of ['zh-Hant', 'en', 'ja', 'zh-Hans'] as const) {
    await store.setPreference(locale); const next = h.render({ ...props, selectedTaskId: f.running.id });
    assert.ok(JSON.stringify(next).includes(createI18nTestContext(locale).t('tasks.center.stopWaiting')));
    assert.equal(createI18nTestContext(locale).renderMessage(descriptor), createI18nTestContext(locale).t('tasks.center.stopWaitConfirmation'));
    assert.deepEqual((h.calls as unknown), []);
  }
  (resolve)!(true); await action;
  assert.deepEqual(h.calls, [['run', `cancel:${f.running.id}`, 'job.cancel', { jobId: f.running.id }, message('tasks.center.stopRequested')]]);
  h.unmount(); store.dispose();
});


test('local task list error descriptors relabel without leaking raw diagnostics or reloading', async () => {
  const store = createLanguageStore({ storage: { getItem: () => null, setItem() {} } as unknown as NonNullable<Parameters<typeof createLanguageStore>[0]>['storage'], systemLanguages: ['zh-Hans'] });
  const h = harness(store), error = { message: 'RAW PRIVATE DIAGNOSTIC', displayMessage: message('tasks.localError.taskProtocol') };
  const props = { tasks: { phase: 'error', error, items: [], uncertain: [], busy: [] } };
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    await store.setPreference(locale);
    const tree = h.render(props), ctx = createI18nTestContext(locale);
    assert.equal(text(find(tree, 'task-list-error-detail')), ctx.renderMessage(error.displayMessage));
    assert.doesNotMatch(text(tree), /RAW PRIVATE DIAGNOSTIC/);
    assert.equal(h.calls.length, 0);
  }
  h.unmount(); store.dispose();
});

test('local dispositions preserve unknown reconciliation and require confirmation before a current mark-failed action', async () => {
  const h=harness(),uncertain={...job(11,'submission_unknown'),requestId:'original-generation-request'},done=job(12,'succeeded'),calls: unknown[]=[];
  const saved={projectId:id(90),kind:'generation',taskId:uncertain.id,revision:0,markedFailed:false,archived:false,updatedAt:null,sourceStatus:'submission_unknown',sourceRequestId:uncertain.requestId,canMarkFailed:true,canArchive:false};
  const archived={...saved,taskId:done.id,sourceStatus:'succeeded',canMarkFailed:false,canArchive:true,archived:true,revision:1,updatedAt:stamp};
  const dispositions={phase:'ready',items:[saved,archived],busy:false,mutationUncertain:false,markFailed:(item: typeof saved)=>calls.push(['mark',item]),archiveCompleted:(items: typeof saved[])=>calls.push(['archive',items]),reload(){},retry(){}};
  let tree=h.render({jobs:[uncertain,done],dispositions,confirm:async()=>false});assert.equal(find(tree,`task-select-${done.id}`),undefined);assert.ok(find(tree,`reconcile-job-${uncertain.id}`));await (find(tree,'task-mark-failed'))!.props.onClick();assert.deepEqual((calls as unknown),[]);
  tree=h.render({jobs:[uncertain,done],dispositions,confirm:async()=>true});await (find(tree,'task-mark-failed'))!.props.onClick();assert.deepEqual(calls,[['mark',saved]]);
  const gate=defer();tree=h.render({jobs:[uncertain,done],dispositions,confirm:()=>gate.promise});const waiting=(find(tree,'task-mark-failed'))!.props.onClick();h.visible=false;h.render({jobs:[uncertain,done],dispositions});(gate.resolve)!(true);await waiting;assert.equal(calls.length,1);
  h.visible=true;tree=h.render({jobs:[uncertain],dispositions:{...dispositions,items:[{...saved,markedFailed:true,revision:1,updatedAt:stamp}]}});assert.ok(find(tree,'task-local-failed-marker'));assert.ok(find(tree,`reconcile-job-${uncertain.id}`));assert.equal(find(tree,'task-mark-failed'),undefined);
});

test('generation details name the diagnostic section and group reconciliation with the explicit mark-failed button', async () => {
  const store = createLanguageStore({ systemLanguages: ['zh-Hans'] }), h = harness(store);
  const uncertain = { ...job(11, 'submission_unknown'), requestId: 'unchanged-original-generation-request' };
  const saved = { projectId: id(90), kind: 'generation', taskId: uncertain.id, revision: 0, markedFailed: false, archived: false, updatedAt: null, sourceStatus: uncertain.status, sourceRequestId: uncertain.requestId, canMarkFailed: true, canArchive: false };
  const dispositions = { phase: 'ready', items: [saved], busy: false, mutationUncertain: false, markFailed: () => assert.fail('Presentation must not mutate'), archiveCompleted() {}, reload() {}, retry() {} };
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
    await store.setPreference(locale);
    const tree = h.render({ jobs: [uncertain], dispositions }), ctx = createI18nTestContext(locale);
    const card = find(tree, `job-${uncertain.id}`);
    const heading = nodes(card).find((node: RootNode) => node.props?.className === 'job-title');
    assert.match(text(heading), new RegExp(ctx.t('round4.tasks.statusAndDiagnostics')));
    assert.match(text(heading), /mock/);
    const footer = nodes(card).find((node: RootNode) => node.props?.className === 'job-actions');
    assert.ok(find(footer, `reconcile-job-${uncertain.id}`));
    assert.equal((find(footer, 'task-mark-failed'))!.props.variant, 'outline');
    assert.equal((find(footer, `reconcile-job-${uncertain.id}`))!.props.variant, 'outline');
    assert.equal(find(find(tree, 'task-detail-summary'), 'task-mark-failed'), undefined);
    const reconcileFields = nodes(card).find((node: RootNode) => node.props?.className === 'reconcile-job');
    assert.equal(find(reconcileFields, `reconcile-job-${uncertain.id}`), undefined);
    assert.ok(nodes(reconcileFields).some((node: RootNode) => node.type === 'Input'));
    assert.match(text(card), /unchanged-original-generation-request/);
    assert.deepEqual((h.calls as unknown), []);
  }
  h.unmount(); store.dispose();
});

test('unknown durable edits keep mark-failed in the same footer as exact-request recovery', () => {
  const h = harness(), unknown = task(1);
  const saved = { projectId: id(90), kind: 'edit', taskId: unknown.id, revision: 0, markedFailed: false, archived: false, updatedAt: null, sourceStatus: unknown.status, sourceRequestId: unknown.requestId, canMarkFailed: true, canArchive: false };
  const dispositions = { phase: 'ready', items: [saved], busy: false, mutationUncertain: false, markFailed: () => assert.fail('Presentation must not mutate'), archiveCompleted() {}, reload() {}, retry() {} };
  const tree = h.render({ tasks: { phase: 'ready', items: [unknown], uncertain: [], busy: [] }, dispositions });
  const footer = nodes(find(tree, `durable-task-${unknown.id}`)).find((node: RootNode) => node.props?.className === 'job-actions');
  assert.ok(find(footer, 'recover-durable-task'));
  assert.equal((find(footer, 'task-mark-failed'))!.props.variant, 'outline');
  assert.equal(find(find(tree, 'task-detail-summary'), 'task-mark-failed'), undefined);
  assert.deepEqual((h.calls as unknown), []);
});

test('task identifier copy uses the real clipboard result and exposes failures without changing task state', async () => {
  const h=harness(),uncertain={...job(11,'submission_unknown'),requestId:'original-generation-request'},prior=Object.getOwnPropertyDescriptor(navigator,'clipboard'),writes: unknown[]=[];
  try {Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (value: unknown)=>{writes.push(value);}}});let tree=h.render({jobs:[uncertain]});await (find(tree,'task-copy-id'))!.props.onClick();tree=h.render({jobs:[uncertain]});assert.deepEqual(writes,[uncertain.id]);assert.match(text(find(tree,'task-copy-result')),/已复制/);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});await (find(tree,'task-copy-id'))!.props.onClick();tree=h.render({jobs:[uncertain]});assert.match(text(find(tree,'task-copy-result')),/复制失败/);assert.deepEqual((h.calls as unknown),[]);
  } finally {if(prior)Object.defineProperty(navigator,'clipboard',prior);else delete (navigator as unknown as {clipboard?: Clipboard}).clipboard;}
});


test('session pending copies its original request ID and never fabricates a backend task ID',async()=>{
 const h=harness(),requestId='original-pending-request-id',entry={projectId:id(90),key:'timeline:mutation',operation:'timeline.track.update',input:{requestId},createdAt:stamp},prior=Object.getOwnPropertyDescriptor(navigator,'clipboard'),writes: unknown[]=[];
 try{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (value: unknown)=>writes.push(value)}});let tree=h.render({pending:[entry]});assert.match(text(find(tree,'task-detail-summary')),/原请求 ID/);await (find(tree,'task-copy-id'))!.props.onClick();assert.deepEqual(writes,[requestId]);assert.doesNotMatch(text(find(tree,'task-detail-summary')),/pending:legacy/);
  tree=h.render({pending:[{...entry,input:{}}]});assert.equal((find(tree,'task-copy-id'))!.props.disabled,true);assert.match(text(find(tree,'task-detail-summary')),/无后台任务 ID/);await (find(tree,'task-copy-id'))!.props.onClick();assert.deepEqual(writes,[requestId]);
 }finally{if(prior)Object.defineProperty(navigator,'clipboard',prior);else delete (navigator as unknown as {clipboard?: Clipboard}).clipboard;}
});
