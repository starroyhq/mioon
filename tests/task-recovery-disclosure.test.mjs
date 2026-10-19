import { message } from './helpers/i18n.ts';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import * as api from '../apps/web/src/api.ts';
import * as submissions from '../apps/web/src/submissions.ts';
import * as mutations from '../apps/web/src/mutation-submissions.ts';
import * as editTasks from '../apps/web/src/edit-task-client.ts';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.ts';
import * as references from '../apps/web/src/reference-connections.ts';

const read = file => readFileSync(new URL(`../apps/web/src/${file}`, import.meta.url), 'utf8');
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const id = n => `d9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-12T00:00:00.000Z';
const task = (n, status) => ({ id: id(n), requestId: `exact-request-${n}`, operation: 'timeline.track.update', createdAt: stamp, status, lane: 'timeline:mutation' });
const job = (n, status) => ({ id: id(n), shotId: id(50), providerId: 'mock', createdAt: stamp, status, progress: 25, snapshot: { duration: 4, aspectRatio: '9:16' } });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Real TaskCenter, durable cards, pending cards and shared disclosure; only the
// external visual primitives are replaced. Unexpected imports fail closed.
function harness(operations = contracts.DURABLE_EDIT_OPERATIONS) {
  const modules = new Map(), disclosureProps = [], calls = [], slots = [];
  let cursor = 0, layouts = [];
  const h = { visible: true, current: true };
  const equalDeps = (left, right) => left?.length === right.length && right.every((value, index) => value === left[index]);
  const forbidden = () => assert.fail('Passive rendering must not use browser storage or network');
  const storage = new Proxy({}, { get: forbidden, set: forbidden });
  const react = { createElement(type, props, ...children) {
    const properties = { ...props, children };
    if (type === modules.get('RecoveryStorageDetails.tsx')?.default) disclosureProps.push(properties);
    return typeof type === 'function' ? type(properties) : { type, props: properties };
  },
    useRef(current) { const index = cursor++; return slots[index] ||= { current }; },
    useMemo(factory, deps) { const index = cursor++; if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { value: factory(), deps }; return slots[index].value; },
    useLayoutEffect(callback, deps) { const index = cursor++, old = slots[index]; if (old && equalDeps(old.deps, deps)) return; slots[index] = { callback, deps, cleanup: old?.cleanup }; layouts.push(index); },
  }; react.default = react;
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const module = { exports: {} };
    const resolve = name => {
    const i18nDependency = creationTestDependency(name); if (i18nDependency) return i18nDependency;
      if (name === 'react') return react;
      if (file === 'RecoveryStorageDetails.tsx') assert.fail(`Unexpected disclosure dependency: ${name}`);
      if (name === '@mioon/contracts') return { ...contracts, DURABLE_EDIT_OPERATIONS: operations };
      if (name === './RecoveryStorageDetails.tsx') return load('RecoveryStorageDetails.tsx');
      if (name === './TaskWorkspace.tsx') return load('TaskWorkspace.tsx');
      if (name === './TaskRenderList.tsx') return load('TaskRenderList.tsx');
      if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => h.visible };
      if (name === './TaskWorkspace.css') return {};
      if (name === './PendingSubmission.jsx') return load('PendingSubmission.jsx');
      if (name === './api.js') return api;
      if (name === './submissions.js') return submissions;
      if (name === './mutation-submissions.js') return mutations;
      if (name === './edit-task-client.js') return editTasks;
      if (name === './workspace-origin.js') return workspaceOrigin;
      if (name === './reference-connections.js') return references;
      if (name === './icons.jsx' || name === './SubjectVideoSummary.jsx') return { __esModule: true, default: name };
      const primitives = { '@mioon/ui/components/workbench-controls': ['WorkbenchBadge', 'WorkbenchButton', 'WorkbenchProgress'], '@mioon/ui/components/badge': ['Badge'], '@mioon/ui/components/button': ['Button'], '@mioon/ui/components/input': ['Input'], '@mioon/ui/components/label': ['Label'], '@mioon/ui/components/dialog': ['Dialog', 'DialogContent', 'DialogTitle', 'DialogDescription'] };
      if (primitives[name]) return Object.fromEntries(primitives[name].map(key => [key, key]));
      assert.fail(`Unexpected TaskCenter dependency: ${name}`);
    };
    Function('module', 'exports', 'require', 'fetch', 'localStorage', 'sessionStorage', transformSync(read(file), { loader: file.endsWith('.tsx') ? 'tsx' : 'jsx', format: 'cjs' }).code)(module, module.exports, resolve, forbidden, storage, storage);
    modules.set(file, module.exports); return module.exports;
  }
  const Component = load('TaskCenter.jsx').default;
  const callbacks = Object.fromEntries(['run', 'retryGeneration', 'onInspectJob', 'onRecover', 'onReload', 'onAdopt'].map(name => [name, (...args) => calls.push([name, ...args])]));
  const defaults = { captureView: () => () => h.current, taskViewScope: 'original-task-view', activeCount: 0, pending: [], busy: {}, jobs: [], data: { shots: [], assets: [], jobs: [] }, reconcileIds: {}, tasks: { phase: 'ready', items: [], uncertain: [], busy: [] }, context: () => 'original-context', isCurrent: () => true, confirm: async () => true, ...callbacks };
  return Object.assign(h, { calls, disclosureProps, render(patch) {
    cursor = 0; layouts = []; const tree = Component({ ...defaults, ...patch });
    for (const index of layouts) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].callback(); }
    return tree;
  }, unmount() { for (const slot of slots) slot.cleanup?.(); } });
}

test('TaskCenter passes the current contract operation count to the real shared disclosure', () => {
  for (const operations of [contracts.DURABLE_EDIT_OPERATIONS, contracts.DURABLE_EDIT_OPERATIONS.slice(0, 3)]) {
    const h = harness(operations), tree = h.render();
    assert.equal(h.disclosureProps.length, 1);
    assert.deepEqual(h.disclosureProps[0], { domain: 'task-center', durableOperationCount: operations.length, children: [] });
    const details = nodes(tree).filter(node => node.type === 'details');
    assert.equal(details.length, 1); assert.match(text(details[0]), new RegExp(`${operations.length} 类`));
    assert.match(text(details[0]), /4096/);
    assert.equal(nodes(details[0]).filter(node => node.type === 'summary').length, 1);
    assert.deepEqual(h.calls, []);
  }
});

test('opening or rerendering the disclosure adds no actions, event handlers, storage writes or task mutations', () => {
  const h = harness(), props = freeze({ tasks: { phase: 'ready', items: [task(1, 'unknown'), task(2, 'applied')], uncertain: [], busy: [] } });
  const before = JSON.stringify(props);
  for (let pass = 0; pass < 3; pass++) {
    const tree = h.render(props), details = nodes(tree).find(node => node.type === 'details');
    for (const node of nodes(details)) {
      assert.equal(['Button', 'button', 'Input', 'input', 'form', 'a', 'select', 'textarea'].includes(node.type), false);
      assert.equal(node.props.role === 'button', false);
      assert.deepEqual(Object.keys(node.props).filter(key => /^on[A-Z]/.test(key)), []);
    }
    details.props.open = true; // Native disclosure expansion has no application callback.
    assert.deepEqual(h.calls, []); assert.equal(JSON.stringify(props), before);
  }
});

test('existing TaskCenter explicit recover, acknowledge, legacy replay, reconcile and retry controls retain exact arguments', async () => {
  const h = harness(), unknown = task(1, 'unknown'), applied = task(2, 'applied');
  const entry = { projectId: id(90), key: 'timeline:mutation', operation: unknown.operation, input: { requestId: unknown.requestId }, createdAt: stamp };
  const failed = job(10, 'failed'), uncertain = job(11, 'submission_unknown');
  const tree = h.render(freeze({ tasks: { phase: 'ready', items: [unknown, applied], uncertain: [], busy: [] }, pending: [entry], jobs: [failed, uncertain], reconcileIds: { [uncertain.id]: '  provider-original  ' } }));
  const all = nodes(tree), find = testId => all.find(node => node.props['data-testid'] === testId);
  assert.equal(all.filter(node => node.type === 'Button').length, 8, 'The existing task, pending and job controls remain; pane collapse belongs to the shared dock');
  assert.deepEqual(h.calls, []);
  find('recover-durable-task').props.onClick(); find('acknowledge-task').props.onClick();
  find('adopt-legacy-task').props.onClick(); find('resume-pending').props.onClick();
  find(`reconcile-job-${uncertain.id}`).props.onClick(); find(`retry-job-${failed.id}`).props.onClick();
  const unknownFence = h.calls[0][3], appliedFence = h.calls[1][3], retryFence = h.calls[5][2];
  for (const fence of [unknownFence, appliedFence, retryFence]) { assert.equal(typeof fence, 'function'); assert.equal(fence(), true); }
  assert.deepEqual(h.calls, [
    ['onRecover', unknown, false, unknownFence], ['onRecover', applied, true, appliedFence], ['onAdopt', entry],
    ['run', entry.key, entry.operation, entry.input, message('tasks.center.originalRecovered'), { replay: true }],
    ['run', `reconcile:${uncertain.id}`, 'job.reconcile', { jobId: uncertain.id, providerJobId: 'provider-original' }, message('tasks.center.existingStatusChecked')],
    ['retryGeneration', failed, retryFence],
  ]);
  assert.equal(all.some(node => ['Dialog', 'DialogContent', 'DialogTitle'].includes(node.type) || node.props.role === 'dialog' || node.props['aria-modal']), false);
  assert.equal(all.some(node => node.props['aria-label'] === '关闭任务中心'), false);
  assert.equal(all.filter(node => node.props['data-testid'] === 'task-workspace').length, 1);
  assert.equal(all.filter(node => node.props['data-testid'] === 'task-workspace-body').length, 1);
  h.visible = false; h.render();
  for (const fence of [unknownFence, appliedFence, retryFence]) assert.equal(fence(), false);
  const count = h.calls.length; find('recover-durable-task').props.onClick(); find(`retry-job-${failed.id}`).props.onClick();
  assert.equal(h.calls.length, count, 'Retained handlers cannot run after the shared Tasks pane is hidden');
});

test('restored and busy TaskCenter guards remain intact with the shared disclosure present', () => {
  const h = harness(), unknown = task(1, 'unknown'), applied = task(2, 'applied'), failed = job(10, 'failed'), uncertain = job(11, 'submission_unknown'), running = job(12, 'running');
  const pending = [{ projectId: id(90), key: 'timeline:mutation', operation: unknown.operation, input: { requestId: unknown.requestId }, createdAt: stamp }];
  const restored = h.render({ workspace: { restored: true, workspaceOrigin: id(99) }, pending, jobs: [failed, uncertain, running], tasks: { phase: 'error', items: [unknown, applied], uncertain: [], busy: [], heldIds: [unknown.id, applied.id] } });
  const all = nodes(restored), find = testId => all.find(node => node.props['data-testid'] === testId);
  for (const testId of ['recover-durable-task', 'acknowledge-task', 'adopt-legacy-task', 'resume-pending', `retry-job-${failed.id}`, `reconcile-job-${uncertain.id}`]) assert.equal(find(testId).props.disabled, true, testId);
  assert.equal(all.find(node => node.type === 'Input').props.disabled, true);
  assert.equal(all.some(node => node.type === 'Button' && text(node) === '停止等待'), false);
  assert.ok(find('task-list-unavailable')); assert.equal(find('no-durable-tasks'), undefined);
  assert.equal(find(`durable-task-${unknown.id}`).props['data-task-state'], 'unknown');
  const busy = nodes(h.render({ busy: { [`task:${unknown.id}`]: true }, tasks: { phase: 'loading', items: [unknown, applied], uncertain: [], busy: [applied.lane] } }));
  for (const testId of ['recover-durable-task', 'acknowledge-task']) assert.equal(busy.find(node => node.props['data-testid'] === testId).props.disabled, true);
  assert.equal(busy.find(node => node.type === 'Button' && text(node) === '重新载入任务').props.disabled, true);
  assert.deepEqual(h.calls, []);
});

test('existing cancellation and inspect callbacks still honor confirmation and current-view guards', async () => {
  const h = harness(), running = job(12, 'running');
  for (const [approved, current, executed] of [[false, true, false], [true, false, false], [true, true, true]]) {
    const tree = h.render({ jobs: [running], confirm: async () => approved, isCurrent: captured => { assert.equal(captured, 'original-context'); return current; } });
    const before = h.calls.length;
    await nodes(tree).find(node => node.type === 'Button' && text(node) === '停止等待').props.onClick();
    assert.equal(h.calls.length - before, executed ? 1 : 0);
    if (executed) assert.deepEqual(h.calls.at(-1), ['run', `cancel:${running.id}`, 'job.cancel', { jobId: running.id }, message('tasks.center.stopRequested')]);
  }
  const inspected = [], tree = h.render({ jobs: [running], onInspectJob: (...args) => inspected.push(args) });
  const inspect = nodes(tree).find(node => node.type === 'Button' && text(node) === '查看镜头').props.onClick;
  inspect(); assert.equal(inspected.length, 1); assert.equal(inspected[0].length, 2);
  assert.equal(inspected[0][0], running); assert.equal(typeof inspected[0][1], 'function'); assert.equal(inspected[0][1](), true);
  h.render({ jobs: [running], taskViewScope: 'replacement-view' });
  assert.equal(inspected[0][1](), false); inspect(); assert.equal(inspected.length, 1);
  h.unmount(); inspect(); assert.equal(inspected.length, 1);
});


test('hiding Tasks while cancel confirmation is pending never cancels from the obsolete pane', async () => {
  const h = harness(), running = job(12, 'running');
  let resolve; const approval = new Promise(done => { resolve = done; });
  const tree = h.render({ jobs: [running], confirm: () => approval });
  const cancel = nodes(tree).find(node => node.type === 'Button' && text(node) === '停止等待').props.onClick;
  const pending = cancel(); h.visible = false; h.render({ jobs: [running] });
  resolve(true); await pending; assert.deepEqual(h.calls, []);
  h.visible = true; h.render({ jobs: [running] }); await cancel(); assert.deepEqual(h.calls, []);
});
