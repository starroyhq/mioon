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
import * as api from '../apps/web/src/api.js';
import * as submissions from '../apps/web/src/submissions.js';
import * as mutations from '../apps/web/src/mutation-submissions.js';
import * as editTasks from '../apps/web/src/edit-task-client.js';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.js';
import * as references from '../apps/web/src/reference-connections.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = file => readFileSync(path.join(root, 'apps/web/src', file), 'utf8');
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const id = n => `d9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T00:00:00.000Z';
const task = (n, status = 'unknown') => ({ id: id(n), requestId: `exact-original-request-${n}`, operation: 'timeline.track.update', createdAt: stamp, status, lane: 'timeline:mutation' });
const job = (n, status) => ({ id: id(n), shotId: id(50), providerId: 'mock', createdAt: stamp, status, progress: 25, snapshot: { duration: 4, aspectRatio: '9:16' } });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const find = (tree, testId) => nodes(tree).find(node => node.props['data-testid'] === testId);
const button = (tree, label) => nodes(tree).find(node => node.type === 'Button' && text(node) === label);
const defaults = () => ({ activeCount: 0, pending: [], busy: {}, jobs: [], data: { shots: [], assets: [], jobs: [] }, reconcileIds: {}, tasks: { phase: 'ready', items: [], uncertain: [], busy: [] } });

let rendered;
before(() => {
  const populated = { ...defaults(), activeCount: 1, jobs: [job(10, 'failed'), job(11, 'submission_unknown'), job(12, 'running')], tasks: { phase: 'ready', items: [{ ...task(1), requestId: 'original-request-'.repeat(24) }, task(2, 'applied')], uncertain: [], busy: [] } };
  const fixture = `import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server.browser';
    import TaskCenter from './src/TaskCenter.jsx';
    import {AgentDockPane} from './src/AgentWorkspace.jsx';
    const forbidden = () => { throw Error('Rendering may not capture a view or execute a task'); };
    const callbacks = { captureView: forbidden, run: forbidden, retryGeneration: forbidden, onInspectJob: forbidden, onRecover: forbidden, onReload: forbidden, onAdopt: forbidden, setReconcileIds: forbidden, context: forbidden, isCurrent: forbidden, confirm: forbidden };
    const populated = ${JSON.stringify(populated)};
    export const html = Object.fromEntries([['empty', ${JSON.stringify(defaults())}, true], ['normal', populated, true], ['hidden', populated, false]].map(([name, props, visible]) => [name, renderToStaticMarkup(
      <AgentDockPane id="right-dock-tasks" labelledBy="right-dock-tasks-tab" visible={visible} fallbackFocus="[data-testid=right-dock-tab-properties]">
        <TaskCenter {...props} {...callbacks} taskViewScope="project:1:tasks" />
      </AgentDockPane>)]));`;
  const script = `import {build} from 'esbuild';
    globalThis.fetch = () => { throw Error('Task presentation may not request data'); };
    const {outputFiles} = await build({stdin: {contents: ${JSON.stringify(fixture)}, loader: 'jsx', resolveDir: ${JSON.stringify(path.join(root, 'apps/web'))}}, bundle: true, format: 'esm', platform: 'browser', write: false, outfile: 'task-dock-fixture.js', define: {'process.env.NODE_ENV': '"production"'}});
    const javascript = outputFiles.find(file => file.path.endsWith('.js'));
    if (!javascript) throw Error('Task dock fixture did not emit JavaScript');
    const result = await import('data:text/javascript;base64,' + Buffer.from(javascript.text).toString('base64'));
    process.stdout.write(JSON.stringify(result.html)); process.exit(0);`;
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
function harness(languageStore) {
  const modules = new Map(), slots = [], calls = [];
  let cursor = 0, effects = [];
  const h = { visible: true, current: true, scope: 'project:1:tasks', captureCalls: 0, calls };
  const forbidden = () => assert.fail('Rendering/interaction must use supplied callbacks, not storage or network');
  const storage = new Proxy({}, { get: forbidden, set: forbidden });
  const react = {
    createElement(type, props, ...children) { const value = { ...props, children }; return typeof type === 'function' ? type(value) : { type, props: value }; },
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) slots[index] = { value: factory(), deps }; return slots[index].value; },
    useLayoutEffect(effect, deps) { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) { slots[index] = { effect, deps, cleanup: slots[index]?.cleanup }; effects.push(index); } },
  }; react.default = react;
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} };
    const resolve = name => {
    const i18nDependency = creationTestDependency(name, languageStore); if (i18nDependency) return i18nDependency;
      if (name === 'react') return react;
      if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => h.visible };
      if (name === './TaskWorkspace.css') return {};
      if (['./TaskWorkspace.tsx', './PendingSubmission.jsx', './RecoveryStorageDetails.tsx', './TaskRenderList.tsx'].includes(name)) return load(name.slice(2));
      const business = { '@mioon/contracts': contracts, './api.js': api, './submissions.js': submissions, './mutation-submissions.js': mutations, './edit-task-client.js': editTasks, './workspace-origin.js': workspaceOrigin, './reference-connections.js': references };
      if (business[name]) return business[name];
      if (['./icons.jsx', './SubjectVideoSummary.jsx'].includes(name)) return { __esModule: true, default: name };
      const primitives = { '@mioon/ui/components/workbench-controls': ['WorkbenchBadge', 'WorkbenchButton', 'WorkbenchProgress'], '@mioon/ui/components/badge': ['Badge'], '@mioon/ui/components/button': ['Button'], '@mioon/ui/components/input': ['Input'], '@mioon/ui/components/label': ['Label'] };
      if (primitives[name]) return Object.fromEntries(primitives[name].map(key => [key, key]));
      assert.fail(`Unexpected TaskCenter dependency: ${name}`);
    };
    Function('module', 'exports', 'require', 'fetch', 'localStorage', 'sessionStorage', transformSync(read(file), { loader: file.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code)(module, module.exports, resolve, forbidden, storage, storage);
    modules.set(file, module.exports); return module.exports;
  }
  const Component = load('TaskCenter.jsx').default;
  const callbacks = Object.fromEntries(['run', 'retryGeneration', 'onInspectJob', 'onRecover', 'onReload', 'onAdopt', 'setReconcileIds'].map(name => [name, (...args) => calls.push([name, ...args])]));
  h.render = (patch = {}) => {
    cursor = 0; effects = [];
    const tree = Component({ ...defaults(), ...callbacks, taskViewScope: h.scope, captureView: () => { h.captureCalls++; return h.current ? () => h.current : null; }, context: () => 'original-context', isCurrent: value => value === 'original-context', confirm: async () => true, ...patch });
    effects.forEach(index => { slots[index].cleanup?.(); slots[index].cleanup = slots[index].effect(); });
    return tree;
  };
  h.unmount = () => slots.forEach(slot => slot.cleanup?.());
  return h;
}

function actionFixture() {
  const unknown = task(1), applied = task(2, 'applied'), failed = job(10, 'failed'), uncertain = job(11, 'submission_unknown'), running = job(12, 'running');
  const entry = { projectId: id(90), key: 'timeline:mutation', operation: unknown.operation, input: { requestId: unknown.requestId }, createdAt: stamp };
  return { unknown, applied, failed, uncertain, running, entry, props: { tasks: { phase: 'error', items: [unknown, applied], uncertain: [], busy: [] }, pending: [entry], jobs: [failed, uncertain, running], reconcileIds: { [uncertain.id]: '  provider-original  ' } } };
}

function actions(tree, fixture) {
  return [
    () => find(tree, 'recover-durable-task').props.onClick(),
    () => find(tree, 'acknowledge-task').props.onClick(),
    () => find(tree, 'adopt-legacy-task').props.onClick(),
    () => find(tree, 'resume-pending').props.onClick(),
    () => find(tree, `reconcile-job-${fixture.uncertain.id}`).props.onClick(),
    () => find(tree, `retry-job-${fixture.failed.id}`).props.onClick(),
    () => button(tree, '查看镜头').props.onClick(),
    () => button(tree, '重新载入任务').props.onClick(),
    () => nodes(tree).find(node => node.type === 'Input').props.onChange({ target: { value: 'changed-provider-id' } }),
    () => button(tree, '停止等待').props.onClick(),
  ];
}

test('mount, rerender and disclosure expansion execute nothing; explicit current clicks retain exact operation inputs', async () => {
  const h = harness(), f = actionFixture();
  h.render(f.props); const tree = h.render(f.props);
  assert.deepEqual(h.calls, []); assert.equal(h.captureCalls, 0);
  const disclosure = find(tree, 'recovery-task-storage-disclosure'); disclosure.props.open = true;
  assert.deepEqual(h.calls, []); assert.equal(h.captureCalls, 0);
  for (const invoke of actions(tree, f)) await invoke();
  const durable = h.calls.filter(call => call[0] === 'onRecover');
  assert.equal(durable.length, 2);
  assert.deepEqual(durable.map(call => call.slice(0, 3)), [['onRecover', f.unknown, false], ['onRecover', f.applied, true]]);
  assert.ok(durable.every(call => call[3]() === true));
  assert.deepEqual(h.calls.find(call => call[0] === 'onAdopt'), ['onAdopt', f.entry]);
  assert.deepEqual(h.calls.filter(call => call[0] === 'run'), [
    ['run', f.entry.key, f.entry.operation, f.entry.input, message('tasks.center.originalRecovered'), { replay: true }],
    ['run', `reconcile:${f.uncertain.id}`, 'job.reconcile', { jobId: f.uncertain.id, providerJobId: 'provider-original' }, message('tasks.center.existingStatusChecked')],
    ['run', `cancel:${f.running.id}`, 'job.cancel', { jobId: f.running.id }, message('tasks.center.stopRequested')],
  ]);
  for (const name of ['retryGeneration', 'onInspectJob']) {
    const call = h.calls.find(call => call[0] === name); assert.equal(call[1], f.failed); assert.equal(call[2](), true);
  }
  const update = h.calls.find(call => call[0] === 'setReconcileIds')[1];
  assert.deepEqual(update({ retained: 'other' }), { retained: 'other', [f.uncertain.id]: 'changed-provider-id' });
});

test('all retained task actions reject hidden, unmounted, changed-scope and leave-return pane lifetimes', async () => {
  for (const mode of ['hidden', 'hidden-return', 'unmounted', 'scope-change', 'scope-return', 'live-view-invalid']) {
    const h = harness(), f = actionFixture(), tree = h.render(f.props);
    const handlers = actions(tree, f);
    button(tree, '查看镜头').props.onClick();
    const acceptedPredicate = h.calls.pop()[2]; assert.equal(acceptedPredicate(), true);
    if (mode === 'hidden' || mode === 'hidden-return') { h.visible = false; h.render(f.props); if (mode === 'hidden-return') { h.visible = true; h.render(f.props); } }
    if (mode === 'scope-change' || mode === 'scope-return') { h.scope = 'project:2:tasks'; h.render(f.props); if (mode === 'scope-return') { h.scope = 'project:1:tasks'; h.render(f.props); } }
    if (mode === 'unmounted') h.unmount();
    if (mode === 'live-view-invalid') h.current = false;
    assert.equal(acceptedPredicate(), false, mode);
    for (const invoke of handlers) await invoke();
    assert.deepEqual(h.calls, [], mode);
    if (mode === 'hidden-return' || mode === 'scope-return') { const fresh = h.render(f.props); find(fresh, 'recover-durable-task').props.onClick(); assert.equal(h.calls.length, 1, mode); }
  }
});

test('hidden initial render cannot admit clicks and a null or false App capture fails closed', async () => {
  const f = actionFixture();
  for (const patch of [{ hidden: true }, { captureView: () => null }, { captureView: () => () => false }]) {
    const h = harness(); if (patch.hidden) h.visible = false;
    const tree = h.render({ ...f.props, ...patch });
    for (const invoke of actions(tree, f)) await invoke();
    assert.deepEqual(h.calls, []);
  }
});

test('cancel confirmation admits only the current context and pane after the awaited decision', async () => {
  for (const mode of ['approved', 'declined', 'context-stale', 'hidden', 'hidden-return', 'unmounted', 'view-stale']) {
    const h = harness(), f = actionFixture(), decision = defer();
    const tree = h.render({ ...f.props, confirm: () => decision.promise, isCurrent: () => mode !== 'context-stale' });
    const cancelling = button(tree, '停止等待').props.onClick();
    if (mode.startsWith('hidden')) { h.visible = false; h.render(f.props); if (mode === 'hidden-return') { h.visible = true; h.render(f.props); } }
    if (mode === 'unmounted') h.unmount();
    if (mode === 'view-stale') h.current = false;
    decision.resolve(mode !== 'declined'); await cancelling;
    assert.equal(h.calls.length, mode === 'approved' ? 1 : 0, mode);
    if (mode === 'approved') assert.equal(h.calls[0][2], 'job.cancel');
  }
});

test('narrow-dock styles keep only the body scrollable and wrap long IDs and shared action buttons', () => {
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
  const shell = read('TaskWorkspace.tsx'), taskCenter = read('TaskCenter.jsx');
  assert.doesNotMatch(shell, /\bfetch\s*\(|\brpc\s*\(|sessionStorage|localStorage|setInterval|setTimeout|createPortal|Dialog|Modal|:\s*any\b|as\s+any\b|@ts-ignore|@ts-nocheck/);
  assert.doesNotMatch(shell, /workspace-visibility\.jsx|TaskWorkspace\.css/);
  assert.match(taskCenter, /useTaskWorkspaceInteraction\(captureView, taskViewScope, Boolean\(useWorkspaceVisibility\(\)\)\)/);
  assert.doesNotMatch(taskCenter, /components\/dialog|onClose|setShowJobs|\binspect\(/);
});

test('pending task confirmation relabels across four languages while retaining its exact original cancellation target', async () => {
  const store = createLanguageStore({ systemLanguages: ['zh-Hans'] }), h = harness(store), f = actionFixture();
  let resolve, descriptor; const waiting = new Promise(done => { resolve = done; });
  const props = { ...f.props, confirm: value => { descriptor = value; return waiting; } };
  const tree = h.render(props), action = button(tree, '停止等待').props.onClick();
  assert.deepEqual(descriptor, message('tasks.center.stopWaitConfirmation')); assert.deepEqual(h.calls, []);
  for (const locale of ['zh-Hant', 'en', 'ja', 'zh-Hans']) {
    await store.setPreference(locale); const next = h.render(props);
    assert.ok(JSON.stringify(next).includes(createI18nTestContext(locale).t('tasks.center.stopWaiting')));
    assert.equal(createI18nTestContext(locale).renderMessage(descriptor), createI18nTestContext(locale).t('tasks.center.stopWaitConfirmation'));
    assert.deepEqual(h.calls, []);
  }
  resolve(true); await action;
  assert.deepEqual(h.calls, [['run', `cancel:${f.running.id}`, 'job.cancel', { jobId: f.running.id }, message('tasks.center.stopRequested')]]);
  h.unmount(); store.dispose();
});


test('local task list error descriptors relabel without leaking raw diagnostics or reloading', async () => {
  const store = createLanguageStore({ storage: { getItem: () => null, setItem() {} }, systemLanguages: ['zh-Hans'] });
  const h = harness(store), error = { message: 'RAW PRIVATE DIAGNOSTIC', displayMessage: message('tasks.localError.taskProtocol') };
  const props = { tasks: { phase: 'error', error, items: [], uncertain: [], busy: [] } };
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja']) {
    await store.setPreference(locale);
    const tree = h.render(props), ctx = createI18nTestContext(locale);
    assert.equal(text(find(tree, 'task-list-error-detail')), ctx.renderMessage(error.displayMessage));
    assert.doesNotMatch(text(tree), /RAW PRIVATE DIAGNOSTIC/);
    assert.equal(h.calls.length, 0);
  }
  h.unmount(); store.dispose();
});
