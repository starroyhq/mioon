import type {AppFixtureTask, AppTaskArguments, AppTaskHooks, AppTaskState, AppTaskFunctions, UiComponentModule} from './helpers/strict-edit-task-app-types.ts';
import type {EditTaskClient} from '../apps/web/src/edit-task-client.ts';
import type {RootTree, RootNode} from './helpers/strict-root-ui-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { DURABLE_EDIT_OPERATIONS, editTaskLane } from '@mioon/contracts';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.ts';
import { isDurableEditOperation, taskInputKey } from '../apps/web/src/edit-task-client.ts';
import * as submissions from '../apps/web/src/submissions.ts';
import { message as messageKey, renderMessage, type DisplayMessage } from '../packages/i18n/src/index.ts';
import { isMutationOperation } from '../apps/web/src/mutation-submissions.ts';
import { creationParameter } from '../apps/web/src/creation-i18n.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const taskIntentModule = { exports: {} as typeof import('../apps/web/src/task-workspace-intent.ts') };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const actual = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end));
const source = actual('  async function run(', '  async function runSession(');
const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), other = id(2), taskId = id(3), instanceId = id(4), trackId = id(5);
const operation = 'timeline.track.update', stamp = '2026-10-10T00:00:00Z';
const input = { projectId, requestId: 'app-exact-original-request', expectedRevision: 1, trackId, patch: { muted: true } };
const makeTask = (patch: Partial<AppFixtureTask> = {}): AppFixtureTask => ({ id: taskId, projectId, operation, input: structuredClone(input), requestId: input.requestId, digest: 'a'.repeat(64), lane: 'timeline:mutation', status: 'prepared', revision: 1, createdAt: stamp, updatedAt: stamp, acknowledged: false, origin: 'new', ...patch });
const timeline = () => ({ id: id(6), projectId, revision: 2, fps: 30, width: 720, height: 1280, durationFrames: 0, clips: [], tracks: [{ id: trackId, name: 'Video', kind: 'video', orderIndex: 0, hidden: false, muted: true }], createdAt: stamp, updatedAt: stamp });
const deferred = () => { let resolve!: (value?: unknown) => void; const promise = new Promise<unknown>(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function storage(t: test.TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), removeItem: (key: string) => values.delete(key) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'sessionStorage', previous) : delete (globalThis as {sessionStorage?: unknown}).sessionStorage);
  return values;
}
async function harness(t: test.TestContext, hooks: AppTaskHooks = {}) {
  const storageValues = storage(t), busy = new Set(), currentProject = { current: projectId };
  const state: AppTaskState = { epoch: 0, notices: [], calls: [], refreshes: [], snapshots: [], pending: [], auth: true, jobs: false, draft: { muted: false }, recoveredTasks: [] };
  let task: AppFixtureTask | null = null;
  const client = {
    list: async (args: AppTaskArguments) => { state.calls.push(['list', args]); return hooks.list ? hooks.list(args) : { items: task && !task.acknowledged ? [task] : [], nextCursor: null, instanceId }; },
    prepare: async (args: AppTaskArguments) => { state.calls.push(['prepare', structuredClone(args)]); task = makeTask({ projectId: args.projectId, operation: args.operation, input: structuredClone(args.input), requestId: args.input.requestId, lane: editTaskLane(args.operation), origin: args.origin, status: args.origin === 'legacy_session' ? 'unknown' : 'prepared' }); return hooks.prepare ? hooks.prepare(args, task) : { task, instanceId }; },
    execute: async (args: AppTaskArguments) => { state.calls.push(['execute', args]); task = { ...task!, status: 'applied', revision: 3 }; return hooks.execute ? hooks.execute(args, task) : { task, instanceId, result: timeline() }; },
    get: async (args: AppTaskArguments) => { state.calls.push(['get', args]); return hooks.get ? hooks.get(args, task) : { task, instanceId }; },
    reconcile: async (args: AppTaskArguments) => { state.calls.push(['reconcile', args]); return { task, instanceId }; },
    acknowledge: async (args: AppTaskArguments) => { state.calls.push(['acknowledge', args]); task = { ...task!, status: args.status, acknowledged: true, revision: args.expectedRevision + 1 }; return hooks.acknowledge ? hooks.acknowledge(args, task) : { task, instanceId }; },
  };
  const controller = createEditTaskController({ client: client as unknown as EditTaskClient, onChange: (owner, snapshot) => { if (owner === currentProject.current) state.snapshots.push(snapshot); } });
  await controller.load(projectId);
  const dataRef = { current: { project: { id: projectId }, timeline: { ...timeline(), revision: 1 }, timelineHistory: { revision: 1 } } };
  const scope = { timelineLoudnessApplyRef: { current: null }, captureTaskWorkspaceIntent,
    msg: (key: string, ...args: unknown[]) => renderMessage('zh-Hans', (messageKey as (key: string, ...args: unknown[]) => DisplayMessage)(key, ...args)),
    readTaskRevealContext: () => ({ active: true, projectId: currentProject.current, projectEpoch: 0, navigationEpoch: state.epoch, panelIntent: 0, workspaceScope: 'test-workspace' }), subtitlesRef: { current: { controller: { recovered: (task: AppFixtureTask) => { (state.recoveredSubtitleTasks ||= []).push(structuredClone(task)); } } } }, timelineFormatRef: { current: { controller: { recovered: (task: AppFixtureTask) => state.recoveredTasks.push(structuredClone(task)) } } }, ...submissions, isMutationOperation, isDurableEditOperation, taskInputKey, tasksRef: { current: controller }, currentProject, dataRef,
    context: () => ({ projectId: currentProject.current, epoch: state.epoch }), isCurrent: (captured: { projectId: string; epoch: number; }) => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (key: unknown, owner: unknown = currentProject.current) => busy.has(`${owner}:${key}`), markBusy: (owner: unknown, key: unknown, value: boolean) => value ? busy.add(`${owner}:${key}`) : busy.delete(`${owner}:${key}`),
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, setData: (next: { project: { id: string; }; timeline: { revision: number; id: string; projectId: string; fps: number; width: number; height: number; durationFrames: number; clips: never[]; tracks: { id: string; name: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; createdAt: string; updatedAt: string; }; timelineHistory: { revision: number; }; }|((arg0: { project: { id: string; }; timeline: { revision: number; id: string; projectId: string; fps: number; width: number; height: number; durationFrames: number; clips: never[]; tracks: { id: string; name: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; createdAt: string; updatedAt: string; }; timelineHistory: { revision: number; }; }) => { project: { id: string; }; timeline: { revision: number; id: string; projectId: string; fps: number; width: number; height: number; durationFrames: number; clips: never[]; tracks: { id: string; name: string; kind: string; orderIndex: number; hidden: boolean; muted: boolean; }[]; createdAt: string; updatedAt: string; }; timelineHistory: { revision: number; }; })) => { dataRef.current = typeof next === 'function' ? next(dataRef.current) : next; },
    notify: (message: string, type: unknown) => state.notices.push({ message, type }), readableError: (error: Error) => error.message,
    setPending: (value: never[]) => { state.pending = value; }, openTasks: (canReveal: () => unknown = () => true) => { if (canReveal()) state.jobs = true; }, setAuth: (value: boolean) => { state.auth = value; }, setSubjectRefresh: (update: (value: Record<string, unknown>) => Record<string, unknown>) => { state.subjectRefresh = update(state.subjectRefresh || {}); },
    refresh: async (owner: unknown) => { state.refreshes.push(owner); }, runSession: async (...args: unknown[]) => { state.calls.push(['session', args]); return null; },
  };
  const functions = Function(...Object.keys(scope), `${source}; return { run, runDurable, recoverTask, adoptLegacyTask };`)(...Object.values(scope)) as AppTaskFunctions;
  return { ...functions, controller, state, currentProject, busy, dataRef, storageValues, client, setTask: (value: AppFixtureTask | null) => { task = value; } };
}

test('actual App routes only the twenty explicit writes into Task prepare/execute while excluded and legacy paths remain session based', async t => {
  const h = await harness(t);
  const saved = await h.run('timeline:mutation', operation, input);
  assert.deepEqual(saved, timeline()); assert.equal(h.storageValues.size, 0);
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list', 'prepare', 'execute', 'acknowledge']);
  assert.deepEqual((h.controller.getState(projectId).items as unknown), []);
  for (const op of ['shot.update', 'asset.range.set', 'asset.disposition.set', 'timeline.render', 'generation.submit', 'job.retry', 'export.create']) await h.run('other', op, {});
  for (const op of DURABLE_EDIT_OPERATIONS) await h.run('legacy', op, input, undefined, { replay: true });
  assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'session').length, 7 + DURABLE_EDIT_OPERATIONS.length);
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
  assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'prepare').length, 1);
  h.state.draft = { muted: false, gain: 0.75 };
  await h.recoverTask(original);
  assert.deepEqual(h.state.draft, { muted: false, gain: 0.75 }); assert.equal(oldAck, undefined);
  assert.deepEqual(h.state.recoveredSubtitleTasks![0].input, original.input); assert.equal(h.state.recoveredSubtitleTasks![0].requestId, original.requestId);
  assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'execute').length, 1);
  assert.deepEqual((h.controller.getState(projectId).items as unknown), []);
});

test('actual App format recovery notifies the current draft owner only after the exact durable request is confirmed', async t => {
  const h = await harness(t, { execute: async () => { throw Error('Lost format ACK'); } });
  const exact = { projectId, requestId: 'format-exact-original-request', expectedProjectRevision: 2, expectedRevision: 0, presetId: 'landscape_720' };
  let freshAck;
  assert.equal(await h.run('timeline:mutation', 'timeline.format.set', exact, undefined, { validateResponse: value => { freshAck = value; } }), null);
  const original = h.controller.getState(projectId).items[0];
  assert.equal(original.operation, 'timeline.format.set'); assert.deepEqual(original.input, exact); assert.deepEqual((h.state.recoveredTasks as unknown), []);
  h.state.draft = { presetId: 'square_720', dirty: true };
  await h.recoverTask(original);
  assert.equal(h.state.recoveredTasks.length, 1); assert.equal(h.state.recoveredTasks[0].status, 'applied');
  assert.equal(h.state.recoveredTasks[0].requestId, exact.requestId); assert.deepEqual(h.state.recoveredTasks[0].input, exact);
  assert.deepEqual(h.state.draft, { presetId: 'square_720', dirty: true }); assert.equal(freshAck, undefined);
  assert.deepEqual((h.controller.getState(projectId).items as unknown), []); assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'execute').length, 1);
  assert.match(h.state.notices.at(-1)!.message, /原请求已确认应用/);
  assert.equal(h.state.notices.some((notice: { message: string; }) => /not defined|ReferenceError/.test(notice.message)), false);
});

test('format rejected recovery also notifies its owner, while an unconfirmed acknowledgment never releases its draft fence', async t => {
  const exact = { projectId, requestId: 'format-rejected-original-request', expectedProjectRevision: 2, expectedRevision: 1, presetId: 'square_720' };
  const terminal = makeTask({ operation: 'timeline.format.set', input: exact, requestId: exact.requestId, status: 'not_applied', revision: 3, errorCode: 'REVISION_CONFLICT' });
  const h = await harness(t); h.setTask(terminal); await h.controller.load(projectId); await h.recoverTask(terminal, true);
  assert.equal(h.state.recoveredTasks.length, 1); assert.equal(h.state.recoveredTasks[0].status, 'not_applied');
  assert.deepEqual(h.state.recoveredTasks[0].input, exact); assert.match(h.state.notices.at(-1)!.message, /原请求已确认未应用/);
  const g = await harness(t, { acknowledge: async () => { throw Error('Acknowledgment result unknown'); } });
  g.setTask(terminal); await g.controller.load(projectId); await g.recoverTask(terminal, true);
  assert.deepEqual((g.state.recoveredTasks as unknown), []); assert.equal(g.controller.getState(projectId).items.length, 1);
  assert.equal(g.state.calls.some((call: [string, unknown]) => call[0] === 'execute'), false);
});

test('actual App preserves fresh-save navigation fences and only refreshes the current project', async t => {
  const hold = deferred(); const h = await harness(t, { execute: async (_args, task) => { await hold.promise; return { task, instanceId, result: timeline() }; } });
  const saving = h.run('timeline:mutation', operation, input, 'Must not appear', { returnAfterNavigation: true }); await flush();
  h.currentProject.current = other; h.state.epoch++; (hold.resolve)!();
  assert.equal(await saving, null); assert.deepEqual((h.state.refreshes as unknown), []); assert.deepEqual((h.state.notices as unknown), []);
  assert.equal(h.busy.size, 0); assert.deepEqual((h.controller.getState(projectId).items as unknown), []);
});

test('actual App same-project fresh save may acknowledge its mounted editor but suppresses old navigation message', async t => {
  const hold = deferred(); const h = await harness(t, { execute: async (_args, task) => { await hold.promise; return { task, instanceId, result: timeline() }; } });
  const saving = h.run('timeline:mutation', operation, input, 'Old success', { returnAfterNavigation: true }); await flush();
  h.state.epoch++; (hold.resolve)!(); assert.deepEqual(await saving, timeline()); assert.deepEqual((h.state.notices as unknown), []);
});

test('actual App preparation finishing after navigation is durable but does not execute from the obsolete view', async t => {
  const hold = deferred(); const h = await harness(t, { prepare: async (_args, task) => { await hold.promise; return { task, instanceId }; } });
  const saving = h.run('timeline:mutation', operation, input); await flush(); h.state.epoch++; (hold.resolve)!(); await saving;
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list', 'prepare']);
  assert.equal(h.controller.getState(projectId).items[0].status, 'prepared');
});

test('actual App respects a replaced subject draft fence after durable prepare without dispatching it', async t => {
  const hold = deferred(); let currentDraft = true;
  const h = await harness(t, { prepare: async (_args, task) => { await hold.promise; return { task, instanceId }; } });
  const saving = h.run('timeline:mutation', operation, input, undefined, { canExecute: () => currentDraft });
  await flush(); currentDraft = false; (hold.resolve)!(); await saving;
  assert.deepEqual(h.state.calls.map(call => call[0]), ['list', 'prepare']);
  assert.equal(h.controller.getState(projectId).items[0].status, 'prepared');
  assert.equal(h.controller.getState(projectId).items[0].requestId, input.requestId);
});

test('actual App recovery finishing lookup after project change leaves unknown untouched and does not execute', async t => {
  const hold = deferred(); const h = await harness(t, { get: async () => { await hold.promise; return { task: makeTask({ status: 'unknown', revision: 2 }), instanceId }; } });
  h.setTask(makeTask({ status: 'unknown', revision: 2 })); await h.controller.load(projectId);
  const recovering = h.recoverTask(h.controller.getState(projectId).items[0]); await flush();
  h.currentProject.current = other; h.state.epoch++; (hold.resolve)!(); await recovering;
  assert.equal(h.state.calls.some((call: [string, unknown]) => call[0] === 'execute'), false); assert.deepEqual((h.state.notices as unknown), []); assert.deepEqual((h.state.refreshes as unknown), []);
  assert.deepEqual((h.state.recoveredTasks as unknown), []);
  assert.equal(h.controller.getState(projectId).items[0].status, 'unknown');
});

test('actual App acknowledges only fresh bound not_applied state; ordinary 4xx cannot clear unknown', async t => {
  const h = await harness(t, { execute: async (_args, task) => ({ task: { ...task!, status: 'not_applied', errorCode: 'REVISION_CONFLICT' }, instanceId }) });
  let failure;
  await h.run('timeline:mutation', operation, input, undefined, { onFailure: (_error, details) => { failure = details; } });
  assert.deepEqual(failure, { dispatched: true, rejected: true }); assert.deepEqual((h.controller.getState(projectId).items as unknown), []);
  const g = await harness(t, { execute: async () => { throw Object.assign(Error('Missing target'), { code: 'NOT_FOUND', definitive: true }); } });
  await g.run('timeline:mutation', operation, input);
  assert.equal(g.controller.getState(projectId).items.length, 1); assert.equal(g.state.calls.some((call: [string, unknown]) => call[0] === 'acknowledge'), false);
});

test('actual App terminal close rereads after a dropped ACK and releases the lane without retrying stale acknowledgment', async t => {
  const h = await harness(t, { acknowledge: async () => { throw Error('ACK committed but response lost'); } });
  await h.run('timeline:mutation', operation, input);
  const visible = h.controller.getState(projectId).items[0];
  assert.equal(visible.status, 'applied'); assert.equal(visible.acknowledged, false);
  await h.recoverTask(visible, true);
  assert.deepEqual((h.controller.getState(projectId).items as unknown), []);
  assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'acknowledge').length, 1);
  assert.equal(h.state.calls.at(-1)![0], 'get');
});

test('actual App terminal close observes another window ACK and never executes a changed nonterminal response', async t => {
  const h = await harness(t, { acknowledge: async () => { throw Error('No response'); } });
  await h.run('timeline:mutation', operation, input);
  const visible = h.controller.getState(projectId).items[0];
  h.setTask(makeTask({ status: 'applied', revision: 5, acknowledged: true }));
  await h.recoverTask(visible, true);
  assert.deepEqual((h.controller.getState(projectId).items as unknown), []);
  assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'execute').length, 1);
  assert.equal(h.state.calls.filter((call: [string, unknown]) => call[0] === 'acknowledge').length, 1);
  const g = await harness(t, { get: async () => ({ task: makeTask({ status: 'unknown', revision: 2 }), instanceId }) });
  await g.recoverTask(makeTask({ status: 'applied', revision: 3 }), true);
  assert.equal(g.state.calls.some((call: [string, unknown]) => call[0] === 'execute'), false);
});

test('actual App explicit adoption alone removes exact old session receipt only after strict server ACK', async t => {
  const h = await harness(t);
  const entry = submissions.prepareSubmission({ projectId, key: 'timeline:mutation', operation, input, createdAt: stamp });
  await h.adoptLegacyTask(entry);
  assert.equal(submissions.readPending(projectId, entry.key), null);
  assert.equal(h.controller.getState(projectId).items[0].origin, 'legacy_session');
  assert.equal(h.controller.getState(projectId).items[0].status, 'unknown');
  assert.equal(h.state.calls.some((call: [string, unknown]) => call[0] === 'execute'), false);
});

test('actual App malformed adoption and race with a newer receipt never clear original or newer storage', async t => {
  const h = await harness(t, { prepare: async () => ({ task: {}, instanceId }) });
  const entry = submissions.prepareSubmission({ projectId, key: 'timeline:mutation', operation, input, createdAt: stamp });
  await h.adoptLegacyTask(entry); assert.deepEqual(submissions.readPending(projectId, entry.key), entry);
  const hold = deferred(); h.client.prepare = async () => { await hold.promise; return { task: makeTask({ origin: 'legacy_session', status: 'unknown' }), instanceId }; };
  const adopting = h.adoptLegacyTask(entry); await flush();
  submissions.clearPending(projectId, entry.key);
  const newer = submissions.prepareSubmission({ ...entry, input: { ...input, requestId: 'new-receipt-in-same-lane' } });
  (hold.resolve)!(); await adopting;
  assert.deepEqual(submissions.readPending(projectId, entry.key), newer);
  assert.equal(h.controller.getState(projectId).items.length, 1);
});

test('TaskCenter separates durable, legacy and generation details, retains generation recovery/cancel/retry controls', () => {
  const source = readFileSync(new URL('../apps/web/src/TaskCenter.tsx', import.meta.url), 'utf8');
  const pending = readFileSync(new URL('../apps/web/src/PendingSubmission.tsx', import.meta.url), 'utf8');
  assert.match(source, /<TaskWorkspace activeCount=\{activeCount\}>/);
  assert.doesNotMatch(source, /Dialog(?:Content|Title|Description)?|aria-modal|关闭任务中心/);
  const workspaceSource = readFileSync(new URL('../apps/web/src/TaskWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspaceSource, /<h2 id="task-workspace-heading">\{t\('tasks\.workspace\.heading'\)\}<\/h2>/);
  assert.equal(renderMessage('zh-Hans', messageKey('tasks.workspace.heading')), '任务中心');
  const rendered = (key: string, params?: { readonly [x: string]: string|number; }|undefined) => renderMessage('zh-Hans', (messageKey as (key: string, params?: unknown) => DisplayMessage)(key, params));
  assert.match(source, /t\('tasks\.center\.localEditRequests'\)/); assert.equal(rendered('tasks.center.localEditRequests'), '本地编辑请求');
  assert.match(source, /t\('tasks\.center\.generationTasks'\)/); assert.equal(rendered('tasks.center.generationTasks'), '生成任务');
  const durableStorage = rendered('tasks.center.durableStorage', {length: DURABLE_EDIT_OPERATIONS.length});
  assert.match(durableStorage, /明文 SQLite/); assert.match(durableStorage, /未经保险库加密/); assert.match(durableStorage, /不会自动执行/);
  assert.match(source, /import RecoveryStorageDetails from '\.\/RecoveryStorageDetails\.tsx'/);
  assert.match(source, /<RecoveryStorageDetails domain="task-center" durableOperationCount=\{DURABLE_EDIT_OPERATIONS\.length\} \/>/);
  assert.doesNotMatch(source, /其他 8 类画板\/素材编辑、时间线渲染及生成\/导出提交的待确认参数仍依赖当前浏览器会话/);
  for (const text of ['submission_unknown', 'providerJobId', 'outputReviewRequired', 'retryGeneration', 'job.cancel']) assert.ok(source.includes(text), text);
  assert.match(rendered('tasks.center.unknownSubmissionWarning'), /服务商可能已接受任务并计费/);
  assert.match(rendered('tasks.pending.mutationStorage'), /恢复记录仅存于当前浏览器会话/); assert.match(pending, /adopt-legacy-task/); assert.match(pending, /legacy-task-duplicate/);
  assert.match(app, /void tasksRef\.current!?\.load\(id\)/);
  assert.match(app, /taskState.phase !== 'ready'/);
});

test('actual TaskCenter does not render an empty-list claim when loading or error and keeps unknown card visible', () => {
  const source = readFileSync(new URL('../apps/web/src/TaskCenter.tsx', import.meta.url), 'utf8');
  const module: UiComponentModule = { exports: {} }, react = { createElement: (type: string, props: Record<string, unknown>, ...children: RootTree[]) => ({ type, props: { ...props, children } }),
    useMemo: (factory: () => unknown) => factory(), useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [initial, () => {}], useLayoutEffect: (callback: () => void) => callback() };
  const workspace: UiComponentModule = { exports: {} };
  const i18n = { useI18n: () => ({ t: (key: string, ...args: unknown[]) => renderMessage('zh-Hans', (messageKey as (key: string, ...args: unknown[]) => DisplayMessage)(key, ...args)),
    renderMessage: (value?: string|DisplayMessage|null|undefined) => renderMessage('zh-Hans', value), formatDate: (value: unknown) => String(value), formatNumber: (value: unknown) => String(value) }) };
  Function('require', 'module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/TaskWorkspace.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)((name: string) => {
    if (name === 'react') return { ...react, default: react };
    if (name === './i18n/I18nProvider.tsx') return i18n;
    if (name === './creation-i18n.ts') return { creationParameter };
    assert.fail(`Unexpected TaskWorkspace dependency: ${name}`);
  }, workspace, workspace.exports);
  const disclosure: UiComponentModule = { exports: {} };
  Function('require', 'module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/RecoveryStorageDetails.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)((name: unknown) => {
    if (name === './i18n/I18nProvider.tsx') return i18n;
    assert.equal(name, 'react'); return { ...react, default: react };
  }, disclosure, disclosure.exports);
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)((name: string) => name === 'react' ? { ...react, default: react }
    : name === './i18n/I18nProvider.tsx' ? i18n
    : name === './creation-i18n.ts' ? { creationParameter }
    : name === '@mioon/contracts' ? { DURABLE_EDIT_OPERATIONS }
    : name === './RecoveryStorageDetails.tsx' ? disclosure.exports
    : name === './TaskWorkspace.tsx' ? workspace.exports
    : name === './workspace-visibility.tsx' ? { useWorkspaceVisibility: () => true }
    : name === './TaskWorkspace.css' ? {}
    : name.endsWith('mutation-submissions.ts') ? { isMutationOperation } : name.endsWith('edit-task-client.ts') ? { isDurableEditOperation }
      : new Proxy({}, { get: (_object, property) => String(property) }), module, module.exports);
  const nodes = (value: RootTree) : RootNode[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const props = { captureView: () => () => true, taskViewScope: 'current-task-view', activeCount: 0, pending: [], busy: {}, jobs: [], data: { shots: [] }, reconcileIds: {} };
  for (const phase of ['loading', 'error', 'ready']) {
    const rendered = nodes(module.exports.default({ ...props, tasks: { phase, items: [], uncertain: [], busy: [] } }));
    const details = rendered.find(node => (node.type as unknown) === disclosure.exports.default);
    assert.equal((details)!.props.domain, 'task-center'); assert.equal((details)!.props.durableOperationCount, DURABLE_EDIT_OPERATIONS.length);
    assert.match((rendered.find((node: RootNode) => node.props?.['data-testid'] === 'durable-task-storage'))!.props.children.join(''), new RegExp(`^${DURABLE_EDIT_OPERATIONS.length} 类时间线元数据（含输出规格）`));
    assert.equal(rendered.some((node: RootNode) => node.props?.['data-testid'] === 'no-durable-tasks'), phase === 'ready');
    assert.equal(rendered.some((node: RootNode) => node.props?.['data-testid'] === 'task-list-unavailable'), phase !== 'ready');
  }
  const rendered = nodes(module.exports.default({ ...props, tasks: { phase: 'error', items: [makeTask({ status: 'unknown' })], uncertain: [], busy: [] } }));
  assert.equal(rendered.filter((node: RootNode) => (node.props?.task as {id: string} | undefined)?.id === taskId).length, 1);
});
