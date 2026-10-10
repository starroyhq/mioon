import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { DURABLE_EDIT_OPERATIONS } from '@mioon/contracts';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.js';
import { isDurableEditOperation, taskInputKey } from '../apps/web/src/edit-task-client.js';
import * as submissions from '../apps/web/src/submissions.js';
import { isMutationOperation } from '../apps/web/src/mutation-submissions.js';
const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const actual = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const source = actual('  async function run(', '  async function runSession(');
const id = n => `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), other = id(2), taskId = id(3), instanceId = id(4), trackId = id(5);
const operation = 'timeline.track.update', stamp = '2026-10-10T00:00:00Z';
const input = { projectId, requestId: 'app-exact-original-request', expectedRevision: 1, trackId, patch: { muted: true } };
const makeTask = (patch = {}) => ({ id: taskId, projectId, operation, input: structuredClone(input), requestId: input.requestId, digest: 'a'.repeat(64), lane: 'timeline:mutation', status: 'prepared', revision: 1, createdAt: stamp, updatedAt: stamp, acknowledged: false, origin: 'new', ...patch });
const timeline = () => ({ id: id(6), projectId, revision: 2, fps: 30, width: 720, height: 1280, durationFrames: 0, clips: [], tracks: [{ id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: true }], createdAt: stamp, updatedAt: stamp });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function storage(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete globalThis.sessionStorage);
  return values;
}
async function harness(t, hooks = {}) {
  const storageValues = storage(t), busy = new Set(), currentProject = { current: projectId };
  const state = { epoch: 0, notices: [], calls: [], refreshes: [], snapshots: [], pending: [], auth: true, jobs: false, draft: { muted: false } };
  let task = null;
  const client = {
    list: async args => { state.calls.push(['list', args]); return hooks.list ? hooks.list(args) : { items: task && !task.acknowledged ? [task] : [], nextCursor: null, instanceId }; },
    prepare: async args => { state.calls.push(['prepare', structuredClone(args)]); task = makeTask({ origin: args.origin, status: args.origin === 'legacy_session' ? 'unknown' : 'prepared' }); return hooks.prepare ? hooks.prepare(args, task) : { task, instanceId }; },
    execute: async args => { state.calls.push(['execute', args]); task = { ...task, status: 'applied', revision: 3 }; return hooks.execute ? hooks.execute(args, task) : { task, instanceId, result: timeline() }; },
    get: async args => { state.calls.push(['get', args]); return hooks.get ? hooks.get(args, task) : { task, instanceId }; },
    reconcile: async args => { state.calls.push(['reconcile', args]); return { task, instanceId }; },
    acknowledge: async args => { state.calls.push(['acknowledge', args]); task = { ...task, status: args.status, acknowledged: true, revision: args.expectedRevision + 1 }; return hooks.acknowledge ? hooks.acknowledge(args, task) : { task, instanceId }; },
  };
  const controller = createEditTaskController({ client, onChange: (owner, snapshot) => { if (owner === currentProject.current) state.snapshots.push(snapshot); } });
  await controller.load(projectId);
  const dataRef = { current: { project: { id: projectId }, timeline: { ...timeline(), revision: 1 }, timelineHistory: { revision: 1 } } };
  const scope = { ...submissions, isMutationOperation, isDurableEditOperation, taskInputKey, tasksRef: { current: controller }, currentProject, dataRef,
    context: () => ({ projectId: currentProject.current, epoch: state.epoch }), isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (key, owner = currentProject.current) => busy.has(`${owner}:${key}`), markBusy: (owner, key, value) => value ? busy.add(`${owner}:${key}`) : busy.delete(`${owner}:${key}`),
    requestCounter: { current: 0 }, setData: next => { dataRef.current = typeof next === 'function' ? next(dataRef.current) : next; },
    notify: (message, type) => state.notices.push({ message, type }), readableError: error => error.message,
    setPending: value => { state.pending = value; }, setShowJobs: value => { state.jobs = value; }, setAuth: value => { state.auth = value; }, setSubjectRefresh: update => { state.subjectRefresh = update(state.subjectRefresh || {}); },
    refresh: async owner => { state.refreshes.push(owner); }, runSession: async (...args) => { state.calls.push(['session', args]); return null; },
  };
  const functions = Function(...Object.keys(scope), `${source}; return { run, runDurable, recoverTask, adoptLegacyTask };`)(...Object.values(scope));
  return { ...functions, controller, state, currentProject, busy, dataRef, storageValues, client, setTask: value => { task = value; } };
}

test('actual App routes only the fifteen explicit writes into Task prepare/execute while excluded and legacy paths remain session based', async t => {
  const h = await harness(t);
  const saved = await h.run('timeline:mutation', operation, input);
  assert.deepEqual(saved, timeline()); assert.equal(h.storageValues.size, 0);
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list', 'prepare', 'execute', 'acknowledge']);
  assert.deepEqual(h.controller.getState(projectId).items, []);
  for (const op of ['shot.update', 'asset.range.set', 'asset.disposition.set', 'timeline.render', 'generation.submit', 'job.retry', 'export.create']) await h.run('other', op, {});
  for (const op of DURABLE_EDIT_OPERATIONS) await h.run('legacy', op, input, undefined, { replay: true });
  assert.equal(h.state.calls.filter(call => call[0] === 'session').length, 7 + DURABLE_EDIT_OPERATIONS.length);
  assert.equal(h.busy.size, 0);
  assert.doesNotMatch(actual('  async function runDurable(', '  async function recoverTask('), /await rpc\(|prepareSubmission\(|sessionStorage/);
});

test('actual App rejects stale owner and existing legacy lane before creating any new identity', async t => {
  const h = await harness(t);
  await h.run('timeline:mutation', operation, { ...input, projectId: other });
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list']);
  const entry = submissions.prepareSubmission({ projectId, key: 'timeline:mutation', operation, input, createdAt: stamp });
  await h.run('timeline:mutation', operation, { ...input, requestId: 'new-user-intent-request' });
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list']);
  assert.deepEqual(submissions.readPending(projectId, entry.key), entry);
});

test('actual App keeps drafts and durable identity after unknown loss, and recovery never installs historical ACK into Inspector', async t => {
  const h = await harness(t, { execute: async () => { throw Error('Lost committed ACK'); } });
  let oldAck;
  assert.equal(await h.run('timeline:mutation', operation, input, 'Old success', { validateResponse: value => { oldAck = value; } }), null);
  assert.equal(oldAck, undefined); assert.equal(h.state.jobs, true); assert.equal(h.storageValues.size, 0);
  const original = h.controller.getState(projectId).items[0];
  await h.run('timeline:mutation', operation, { ...input, patch: { muted: false }, requestId: 'new-unsaved-draft' });
  assert.equal(h.state.calls.filter(call => call[0] === 'prepare').length, 1);
  h.state.draft = { muted: false, gain: 0.75 };
  await h.recoverTask(original);
  assert.deepEqual(h.state.draft, { muted: false, gain: 0.75 }); assert.equal(oldAck, undefined);
  assert.equal(h.state.calls.filter(call => call[0] === 'execute').length, 1);
  assert.deepEqual(h.controller.getState(projectId).items, []);
});

test('actual App preserves fresh-save navigation fences and only refreshes the current project', async t => {
  const hold = deferred(); const h = await harness(t, { execute: async (_args, task) => { await hold.promise; return { task, instanceId, result: timeline() }; } });
  const saving = h.run('timeline:mutation', operation, input, 'Must not appear', { returnAfterNavigation: true }); await flush();
  h.currentProject.current = other; h.state.epoch++; hold.resolve();
  assert.equal(await saving, null); assert.deepEqual(h.state.refreshes, []); assert.deepEqual(h.state.notices, []);
  assert.equal(h.busy.size, 0); assert.deepEqual(h.controller.getState(projectId).items, []);
});

test('actual App same-project fresh save may acknowledge its mounted editor but suppresses old navigation message', async t => {
  const hold = deferred(); const h = await harness(t, { execute: async (_args, task) => { await hold.promise; return { task, instanceId, result: timeline() }; } });
  const saving = h.run('timeline:mutation', operation, input, 'Old success', { returnAfterNavigation: true }); await flush();
  h.state.epoch++; hold.resolve(); assert.deepEqual(await saving, timeline()); assert.deepEqual(h.state.notices, []);
});

test('actual App preparation finishing after navigation is durable but does not execute from the obsolete view', async t => {
  const hold = deferred(); const h = await harness(t, { prepare: async (_args, task) => { await hold.promise; return { task, instanceId }; } });
  const saving = h.run('timeline:mutation', operation, input); await flush(); h.state.epoch++; hold.resolve(); await saving;
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list', 'prepare']);
  assert.equal(h.controller.getState(projectId).items[0].status, 'prepared');
});

test('actual App respects a replaced subject draft fence after durable prepare without dispatching it', async t => {
  const hold = deferred(); let currentDraft = true;
  const h = await harness(t, { prepare: async (_args, task) => { await hold.promise; return { task, instanceId }; } });
  const saving = h.run('timeline:mutation', operation, input, undefined, { canExecute: () => currentDraft });
  await flush(); currentDraft = false; hold.resolve(); await saving;
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list', 'prepare']);
  assert.equal(h.controller.getState(projectId).items[0].status, 'prepared');
  assert.equal(h.controller.getState(projectId).items[0].requestId, input.requestId);
});

test('actual App recovery finishing lookup after project change leaves unknown untouched and does not execute', async t => {
  const hold = deferred(); const h = await harness(t, { get: async () => { await hold.promise; return { task: makeTask({ status: 'unknown', revision: 2 }), instanceId }; } });
  h.setTask(makeTask({ status: 'unknown', revision: 2 })); await h.controller.load(projectId);
  const recovering = h.recoverTask(h.controller.getState(projectId).items[0]); await flush();
  h.currentProject.current = other; h.state.epoch++; hold.resolve(); await recovering;
  assert.equal(h.state.calls.some(call => call[0] === 'execute'), false); assert.deepEqual(h.state.notices, []); assert.deepEqual(h.state.refreshes, []);
  assert.equal(h.controller.getState(projectId).items[0].status, 'unknown');
});

test('actual App acknowledges only fresh bound not_applied state; ordinary 4xx cannot clear unknown', async t => {
  const h = await harness(t, { execute: async (_args, task) => ({ task: { ...task, status: 'not_applied', errorCode: 'REVISION_CONFLICT' }, instanceId }) });
  let failure;
  await h.run('timeline:mutation', operation, input, undefined, { onFailure: (_error, details) => { failure = details; } });
  assert.deepEqual(failure, { dispatched: true, rejected: true }); assert.deepEqual(h.controller.getState(projectId).items, []);
  const g = await harness(t, { execute: async () => { throw Object.assign(Error('Missing target'), { code: 'NOT_FOUND', definitive: true }); } });
  await g.run('timeline:mutation', operation, input);
  assert.equal(g.controller.getState(projectId).items.length, 1); assert.equal(g.state.calls.some(call => call[0] === 'acknowledge'), false);
});

test('actual App terminal close rereads after a dropped ACK and releases the lane without retrying stale acknowledgment', async t => {
  const h = await harness(t, { acknowledge: async () => { throw Error('ACK committed but response lost'); } });
  await h.run('timeline:mutation', operation, input);
  const visible = h.controller.getState(projectId).items[0];
  assert.equal(visible.status, 'applied'); assert.equal(visible.acknowledged, false);
  await h.recoverTask(visible, true);
  assert.deepEqual(h.controller.getState(projectId).items, []);
  assert.equal(h.state.calls.filter(call => call[0] === 'acknowledge').length, 1);
  assert.equal(h.state.calls.at(-1)[0], 'get');
});

test('actual App terminal close observes another window ACK and never executes a changed nonterminal response', async t => {
  const h = await harness(t, { acknowledge: async () => { throw Error('No response'); } });
  await h.run('timeline:mutation', operation, input);
  const visible = h.controller.getState(projectId).items[0];
  h.setTask(makeTask({ status: 'applied', revision: 5, acknowledged: true }));
  await h.recoverTask(visible, true);
  assert.deepEqual(h.controller.getState(projectId).items, []);
  assert.equal(h.state.calls.filter(call => call[0] === 'execute').length, 1);
  assert.equal(h.state.calls.filter(call => call[0] === 'acknowledge').length, 1);
  const g = await harness(t, { get: async () => ({ task: makeTask({ status: 'unknown', revision: 2 }), instanceId }) });
  await g.recoverTask(makeTask({ status: 'applied', revision: 3 }), true);
  assert.equal(g.state.calls.some(call => call[0] === 'execute'), false);
});

test('actual App explicit adoption alone removes exact old session receipt only after strict server ACK', async t => {
  const h = await harness(t);
  const entry = submissions.prepareSubmission({ projectId, key: 'timeline:mutation', operation, input, createdAt: stamp });
  await h.adoptLegacyTask(entry);
  assert.equal(submissions.readPending(projectId, entry.key), null);
  assert.equal(h.controller.getState(projectId).items[0].origin, 'legacy_session');
  assert.equal(h.controller.getState(projectId).items[0].status, 'unknown');
  assert.equal(h.state.calls.some(call => call[0] === 'execute'), false);
});

test('actual App malformed adoption and race with a newer receipt never clear original or newer storage', async t => {
  const h = await harness(t, { prepare: async () => ({ task: {}, instanceId }) });
  const entry = submissions.prepareSubmission({ projectId, key: 'timeline:mutation', operation, input, createdAt: stamp });
  await h.adoptLegacyTask(entry); assert.deepEqual(submissions.readPending(projectId, entry.key), entry);
  const hold = deferred(); h.client.prepare = async () => { await hold.promise; return { task: makeTask({ origin: 'legacy_session', status: 'unknown' }), instanceId }; };
  const adopting = h.adoptLegacyTask(entry); await flush();
  submissions.clearPending(projectId, entry.key);
  const newer = submissions.prepareSubmission({ ...entry, input: { ...input, requestId: 'new-receipt-in-same-lane' } });
  hold.resolve(); await adopting;
  assert.deepEqual(submissions.readPending(projectId, entry.key), newer);
  assert.equal(h.controller.getState(projectId).items.length, 1);
});

test('TaskCenter separates durable, legacy and generation details, retains generation recovery/cancel/retry controls', () => {
  const source = readFileSync(new URL('../apps/web/src/TaskCenter.jsx', import.meta.url), 'utf8');
  const pending = readFileSync(new URL('../apps/web/src/PendingSubmission.jsx', import.meta.url), 'utf8');
  assert.match(source, /<DialogTitle>任务中心<\/DialogTitle>/); assert.match(source, /本地编辑请求/); assert.match(source, /<h3>生成任务<\/h3>/);
  assert.match(source, /明文 SQLite/); assert.match(source, /未经保险库加密/); assert.match(source, /不会自动执行/);
  assert.match(source, /其他 8 类画板\/素材编辑、时间线渲染/); assert.match(source, /4096/);
  for (const text of ['submission_unknown', 'providerJobId', 'outputReviewRequired', 'retryGeneration', 'job.cancel', '服务商可能已接受任务并计费']) assert.ok(source.includes(text), text);
  assert.match(pending, /恢复记录仅存于当前浏览器会话/); assert.match(pending, /adopt-legacy-task/); assert.match(pending, /legacy-task-duplicate/);
  assert.match(app, /void tasksRef.current.load\(id\)/);
  assert.match(app, /taskState.phase !== 'ready'/);
});

test('actual TaskCenter does not render an empty-list claim when loading or error and keeps unknown card visible', () => {
  const source = readFileSync(new URL('../apps/web/src/TaskCenter.jsx', import.meta.url), 'utf8');
  const module = { exports: {} }, react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  Function('require', 'module', 'exports', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(name => name === 'react' ? { ...react, default: react }
    : name.endsWith('mutation-submissions.js') ? { isMutationOperation } : name.endsWith('edit-task-client.js') ? { isDurableEditOperation }
      : new Proxy({}, { get: (_object, property) => String(property) }), module, module.exports);
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const props = { activeCount: 0, pending: [], busy: {}, jobs: [], data: { shots: [] }, reconcileIds: {} };
  for (const phase of ['loading', 'error', 'ready']) {
    const rendered = nodes(module.exports.default({ ...props, tasks: { phase, items: [], uncertain: [], busy: [] } }));
    assert.equal(rendered.some(node => node.props?.['data-testid'] === 'no-durable-tasks'), phase === 'ready');
    assert.equal(rendered.some(node => node.props?.['data-testid'] === 'task-list-unavailable'), phase !== 'ready');
  }
  const rendered = nodes(module.exports.default({ ...props, tasks: { phase: 'error', items: [makeTask({ status: 'unknown' })], uncertain: [], busy: [] } }));
  assert.equal(rendered.filter(node => node.props?.task?.id === taskId).length, 1);
});
