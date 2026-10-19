import test from 'node:test';
import { transformSync } from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {timelineHistoryState} from '../apps/web/src/timeline-history.js';
import {timelineHistoryActionForKey} from '../apps/web/src/timeline-keyboard.js';
import {message as msg, renderMessage} from '../packages/i18n/src/index.ts';

// No application, HTTP server, browser, worker, media process or provider is started.
// The first group executes unchanged ordinary-JS App functions, extracted exactly
// as the existing edit-task-app tests do, against an explicitly synthetic task port.
// This does NOT execute React, createEditTaskController, its validators or SQLite.
const taskIntentModule = { exports: {} };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
function section(start, end) {
  const at = app.indexOf(start), until = app.indexOf(end, at + start.length);
  assert.ok(at >= 0 && until > at, `App extraction boundary missing: ${start}`);
  assert.equal(app.indexOf(start, at + start.length), -1, `Ambiguous boundary: ${start}`);
  return app.slice(at, until);
}
const actual = [
  section('function localizedError(', 'function Modal('),
  section('  async function run(', '  async function adoptLegacyTask('),
  section('  function changeTimelineHistory(', '  useEffect('),
  section('  async function mutateTimeline(', '  async function selectClip('),
].join('\n');
const id = n => `93000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), stamp = '2026-10-10T00:00:00.000Z';
const copy = value => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const timeline = revision => ({id:id(2), projectId, revision, fps:30, width:720, height:1280,
  tracks:[{id:id(3), kind:'video', name:'Synthetic', orderIndex:0, hidden:false, muted:false}],
  clips:[], durationFrames:0, createdAt:stamp, updatedAt:stamp});
const history = revision => ({projectId, timelineId:id(2), revision, cursor:1, length:2,
  canUndo:true, canRedo:true, undoEntry:{id:id(4), operation:'timeline.track.add'}, redoEntry:{id:id(5), operation:'timeline.track.update'}});

function taskPort({beforeDispatch, outcome = 'applied'} = {}) {
  const calls = []; let saved, waiting = false;
  const port = {
    calls, get task() { return copy(saved); },
    blocked: () => waiting,
    async submit(request, {canExecute}) {
      calls.push(['submit', copy(request)]);
      saved = {id:id(6), projectId, operation:request.operation, input:copy(request.input), requestId:request.input.requestId,
        digest:'a'.repeat(64), lane:'timeline:mutation', revision:1, status:'prepared', acknowledged:false};
      waiting = true;
      await beforeDispatch?.();
      if (!canExecute()) return {task:copy(saved)};
      calls.push(['dispatch', copy(saved.input)]);
      if (outcome === 'ordinary409') throw Object.assign(Error('Synthetic ambiguous 409'), {code:'REVISION_CONFLICT', definitive:true});
      saved = {...saved, revision:3, status:outcome === 'not_applied' ? 'not_applied' : 'applied',
        ...(outcome === 'not_applied' ? {errorCode:'REVISION_CONFLICT'} : {})};
      if (outcome === 'lostACK') throw Error('Synthetic committed response loss');
      return {task:copy(saved), ...(saved.status === 'applied' ? {result:timeline(request.input.expectedRevision + 1)} : {})};
    },
    async acknowledge(task) { calls.push(['acknowledge', copy(task)]); waiting = false; saved = {...saved, acknowledged:true}; },
    async recover(task, {canExecute}) {
      calls.push(['recover', copy(task), canExecute()]);
      return {task:copy(saved), ...(saved.status === 'applied' ? {result:timeline(saved.input.expectedRevision + 1)} : {})};
    },
  };
  return port;
}
function appHarness(port, {revision = 7, refreshedRevision = 9, subtitleDirty = false} = {}) {
  const currentProject = {current:projectId}, busy = new Set();
  const dataRef = {current:{project:{id:projectId}, timeline:timeline(revision), timelineHistory:history(revision)}};
  const state = {epoch:0, ids:0, notices:[], refreshes:[], jobs:false, recoveredFormats:[], recoveredSubtitles:[]};
  const scope = { msg, renderCoreMessage: renderMessage, application: null, clipConnectionBlocked: {current:false}, clipDraftRef: {current:null}, shotTextRef: {current:null}, captureTaskWorkspaceIntent,
    readTaskRevealContext: () => ({ active: true, projectId: currentProject.current, projectEpoch: 0, navigationEpoch: state.epoch, panelIntent: 0, workspaceScope: 'test-workspace' }),
    timelineFormatRef:{current:{controller:{recovered:task=>state.recoveredFormats.push(copy(task))}}}, subtitlesRef:{current:{controller:{recovered:task=>state.recoveredSubtitles.push(copy(task))}}},
    currentProject, dataRef, tasksRef:{current:port}, requestCounter:{current:0}, timelineHistoryState,
    workspaceMode:'editing', timelinePending:false, clipDirty:false, subtitleDirty, online:true, auth:true, loading:false,
    // Deliberately a task-boundary double, not a substituted contracts validator.
    isDurableEditOperation: operation => ['timeline.undo', 'timeline.redo'].includes(operation),
    pendingForProject: () => [], isMutationOperation: () => false,
    context: () => ({projectId:currentProject.current, epoch:state.epoch}),
    isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === state.epoch,
    isBusy: (key, owner = currentProject.current) => busy.has(`${owner}:${key}`),
    markBusy: (owner, key, value) => value ? busy.add(`${owner}:${key}`) : busy.delete(`${owner}:${key}`),
    requestId: () => `audit-user-intent-${++state.ids}`,
    setData: update => { dataRef.current = update(dataRef.current); },
    notify: (message, type) => state.notices.push({message:renderMessage('zh-Hans',message), type}),
    openTasks: (canReveal = () => true) => { if (canReveal()) state.jobs = true; }, setAuth: value => { state.auth = value; },
    setSubjectRefresh: () => assert.fail('Undo/Redo must not refresh subject bindings'),
    refresh: async owner => {
      state.refreshes.push(owner);
      dataRef.current = {project:{id:owner}, timeline:timeline(refreshedRevision), timelineHistory:history(refreshedRevision)};
    },
    runSession: () => assert.fail('A fresh history action must not use the legacy session path'),
  };
  const functions = Function(...Object.keys(scope), `${actual}\nreturn {changeTimelineHistory, recoverTask};`)(...Object.values(scope));
  return {...functions, state, dataRef, busy, currentProject, requestCounter:scope.requestCounter};
}

test('App unsaved subtitle blocks both history directions before minting or dispatching an intent', async () => {
  const port = taskPort(), h = appHarness(port, {subtitleDirty:true});
  assert.equal(await h.changeTimelineHistory('undo'), null); assert.equal(await h.changeTimelineHistory('redo'), null);
  assert.equal(h.state.ids, 0); assert.deepEqual(port.calls, []); assert.equal(h.busy.size, 0);
});

for (const direction of ['undo', 'redo']) {
  test(`App ${direction}: held prepare and repeated shortcut/click create one exact intent`, async () => {
    const entered = deferred(), release = deferred();
    const port = taskPort({beforeDispatch:async () => { entered.resolve(); await release.promise; }}), h = appHarness(port);
    const key = {key:'z', ctrlKey:true, shiftKey:direction === 'redo', metaKey:false};
    assert.equal(timelineHistoryActionForKey(key), direction);
    const first = h.changeTimelineHistory(direction); await entered.promise;
    assert.equal(h.changeTimelineHistory(direction), null);
    assert.equal(h.changeTimelineHistory(direction === 'undo' ? 'redo' : 'undo'), null);
    assert.equal(h.state.ids, 1); assert.equal(port.calls.length, 1);
    assert.deepEqual(port.calls[0][1], {projectId, operation:`timeline.${direction}`,
      input:{projectId, expectedRevision:7, requestId:'audit-user-intent-1'}});
    release.resolve(); const ack = await first;
    assert.equal(ack.revision, 8); assert.equal(h.dataRef.current.timeline.revision, 9);
    assert.deepEqual(port.calls.map(([kind]) => kind), ['submit', 'dispatch', 'acknowledge']);
    assert.equal(h.busy.size, 0); assert.ok(h.requestCounter.current >= 2);
  });

  test(`App ${direction}: bound not_applied conflict closes the task and refreshes current state`, async () => {
    const port = taskPort({outcome:'not_applied'}), h = appHarness(port);
    assert.equal(await h.changeTimelineHistory(direction), null);
    assert.deepEqual(port.calls.map(([kind]) => kind), ['submit', 'dispatch', 'acknowledge']);
    assert.deepEqual(h.state.refreshes, [projectId]); assert.equal(h.dataRef.current.timeline.revision, 9);
    const message = h.state.notices.at(-1).message;
    // Execute the real readableError; a new Error.message does not by itself
    // make the historical browser assertion obsolete.
    assert.equal(message, '保存冲突：内容已在其他窗口更新。已刷新最新状态，请检查后再保存');
    const browser = readFileSync(new URL('../tests/browser_timeline_history.mjs', import.meta.url), 'utf8');
    assert.ok(browser.includes(`getByText('${message}',{exact:true})`));
  });

  test(`App ${direction}: ordinary 409 retains the original intent without automatic retry`, async () => {
    const port = taskPort({outcome:'ordinary409'}), h = appHarness(port);
    await h.changeTimelineHistory(direction);
    const original = port.task;
    assert.equal(await h.changeTimelineHistory(direction), null);
    assert.deepEqual(port.calls.map(([kind]) => kind), ['submit', 'dispatch']);
    assert.deepEqual(port.task.input, original.input); assert.equal(port.task.acknowledged, false);
    assert.equal(h.state.ids, 1); assert.match(h.state.notices[0].message, /原请求已保留/);
  });

  test(`App ${direction}: recreated function scope explicitly recovers a historical ACK without installing it`, async () => {
    const port = taskPort({outcome:'lostACK'}), first = appHarness(port);
    await first.changeTimelineHistory(direction); const original = port.task, count = port.calls.length;
    const reopened = appHarness(port, {revision:20, refreshedRevision:21});
    assert.equal(port.calls.length, count, 'Recreating this App function scope does no automatic dispatch');
    assert.equal(await reopened.changeTimelineHistory(direction), null);
    assert.equal(reopened.state.ids, 0, 'The unresolved task blocks a new request key');
    await reopened.recoverTask(original);
    assert.deepEqual(port.calls.map(([kind]) => kind), ['submit', 'dispatch', 'recover', 'acknowledge']);
    assert.deepEqual(port.calls[2][1].input, original.input);
    assert.deepEqual(reopened.state.recoveredSubtitles[0].input, original.input); assert.equal(reopened.state.recoveredSubtitles[0].requestId, original.requestId);
    assert.equal(reopened.state.recoveredFormats[0].requestId, original.requestId);
    assert.equal(reopened.dataRef.current.timeline.revision, 21, 'Historical r8 cannot replace refreshed r21');
  });

  test(`App ${direction}: closing Tasks during lookup revokes the passed execution callback`, async () => {
    const port = taskPort({outcome:'ordinary409'}), h = appHarness(port);
    await h.changeTimelineHistory(direction);
    const entered = deferred(), release = deferred(); let allowed;
    port.recover = async (_task, {canExecute}) => {
      entered.resolve(); await release.promise; allowed = canExecute(); return {task:{...port.task, status:'unknown'}};
    };
    let taskPaneCurrent = true;
    const recovery = h.recoverTask(port.task, false, () => taskPaneCurrent); await entered.promise;
    taskPaneCurrent = false; // Shared-pane hide revokes the captured Tasks view without changing the project.
    const notices = h.state.notices.length; release.resolve(); await recovery;
    assert.equal(allowed, false); assert.equal(h.state.notices.length, notices);
    assert.equal(h.busy.size, 0);
    assert.match(app, /canExecute: \(\) => !clipConnectionBlocked\.current && !acknowledgeOnly && isCurrent\(captured\) && canExecute\(\)/);
    assert.match(app, /<TaskCenter taskViewScope=\{taskViewScope\}[^>]*captureView=\{captureTaskView\}/);
  });
}

test('actual history state stays blocked across stale aggregate/history arrival order and pending recovery', () => {
  const before = {projectId, timeline:timeline(7), history:history(7)};
  const stable = copy(before);
  for (const snapshot of [
    {...before, busy:true}, {...before, pending:true}, {...before, online:false},
    {...before, history:null}, {...before, timeline:timeline(8)}, {...before, history:history(8)},
  ]) {
    const value = timelineHistoryState(snapshot);
    assert.equal(value.canUndo, false); assert.equal(value.canRedo, false);
  }
  assert.equal(timelineHistoryState({...before, timeline:timeline(8), history:history(8)}).canUndo, true);
  assert.deepEqual(before, stable, 'The real state helper must not rewrite inputs');
});

// Optional, REAL business/SQLite checks. Missing installation is an explicit
// skip; import/fixture errors after prerequisites resolve MUST fail the tests.
// Never replace contracts, database or mutation implementations with stubs.
const requireHere = createRequire(import.meta.url);
const requireContracts = createRequire(new URL('../packages/contracts/package.json', import.meta.url));
const missing = [];
for (const [name, resolver] of [['@mioon/contracts', requireHere], ['zod', requireContracts]]) {
  try { resolver.resolve(name); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; missing.push(name); }
}
const businessOptions = {skip:missing.length ? `Not initialized: missing installed ${missing.join(', ')}; no installation performed` : false};
async function businessFixture(t, direction) {
  const [{openStore}, {createServices}, {createEditTasks}, {AppError}] = await Promise.all([
    import('../packages/business/src/db.mjs'), import('../packages/business/src/services.mjs'),
    import('../packages/business/src/edit-tasks.mjs'), import('@mioon/contracts'),
  ]);
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-timeline-audit-'));
  let store, services, tasks, fault = () => {}, dispatches = 0;
  t.after(() => { store?.close(); rmSync(root, {recursive:true, force:true}); });
  const start = () => {
    store = openStore(root); services = createServices(store, new Map());
    tasks = createEditTasks({store, services:{call(operation, input) {dispatches++; return services.call(operation, input);}}, fault:point => fault(point)});
  };
  start();
  const project = await services.call('project.create', {name:'Synthetic Undo/Redo audit'});
  let current = await services.call('timeline.get', {projectId:project.id});
  current = await services.call('timeline.track.add', {projectId:project.id, expectedRevision:current.revision, requestId:randomUUID(), kind:'audio'});
  if (direction === 'redo') current = await services.call('timeline.undo', {projectId:project.id, expectedRevision:current.revision, requestId:randomUUID()});
  const input = {projectId:project.id, expectedRevision:current.revision, requestId:randomUUID()}, operation = `timeline.${direction}`;
  const state = () => Object.fromEntries(['timelines', 'timeline_history', 'timeline_history_cursors', 'timeline_requests'].map(table =>
    [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return {
    operation, input, AppError, createServices,
    get store() {return store;}, get services() {return services;}, get tasks() {return tasks;}, get dispatches() {return dispatches;},
    state, setFault(fn) {fault = fn;}, restart() {store.close(); start();},
    history: () => services.call('timeline.history.get', {projectId:project.id}),
    call: () => services.call(operation, input),
    count: () => store.db.prepare('SELECT COUNT(*) n FROM timeline_requests WHERE requestId=?').get(input.requestId).n,
    execute: response => tasks.execute({projectId:project.id, taskId:response.task.id, digest:response.task.digest, instanceId:response.instanceId}),
    prepare: () => tasks.prepare({projectId:project.id, operation, input, origin:'new'}),
    get: task => tasks.get({projectId:project.id, taskId:task.id}),
  };
}
for (const direction of ['undo', 'redo']) {
  const delta = direction === 'undo' ? -1 : 1;
  test(`SQLite ${direction}: receipt insertion failure then same-key reopen recovery moves once`, businessOptions, async t => {
    const f = await businessFixture(t, direction), before = f.state(), historyBefore = await f.history();
    f.store.db.exec("CREATE TRIGGER audit_receipt_failure BEFORE INSERT ON timeline_requests BEGIN SELECT RAISE(ABORT,'audit receipt failure');END;");
    await assert.rejects(f.call(), error => /audit receipt failure/.test(error.message) && error.details?.mutationOutcome === undefined);
    assert.deepEqual(f.state(), before); assert.equal(f.count(), 0);
    f.store.db.exec('DROP TRIGGER audit_receipt_failure'); f.restart();
    assert.deepEqual(f.state(), before);
    const response = await f.call(), historyAfter = await f.history(), applied = f.state();
    assert.equal(response.revision, f.input.expectedRevision + 1);
    assert.equal(historyAfter.cursor, historyBefore.cursor + delta); assert.equal(historyAfter.length, historyBefore.length); assert.equal(f.count(), 1);
    assert.deepEqual(await f.call(), response); assert.deepEqual(f.state(), applied);
  });

  test(`SQLite ${direction}: post-COMMIT exception never claims not_applied and reopens exact receipt`, businessOptions, async t => {
    const f = await businessFixture(t, direction), historyBefore = await f.history();
    const failing = f.createServices({...f.store, tx:callback => {f.store.tx(callback); throw new f.AppError('REVISION_CONFLICT', 'Synthetic after commit', 409);}}, new Map());
    await assert.rejects(failing.call(f.operation, f.input), error => error.code === 'REVISION_CONFLICT' && error.details?.mutationOutcome === undefined);
    assert.equal(f.count(), 1);
    const response = JSON.parse(f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(f.input.requestId).response);
    const committed = f.state(); f.restart();
    assert.deepEqual(await f.call(), response); assert.deepEqual(f.state(), committed);
    const current = await f.history(); assert.equal(current.cursor, historyBefore.cursor + delta);
    assert.equal(current.revision, f.input.expectedRevision + 1);
  });

  for (const point of ['afterClaim', 'beforeDispatch', 'afterBusinessCommit', 'beforeOutcomePersist', 'afterOutcomePersist']) {
    test(`Durable ${direction}: ${point}, reopen and exact recovery preserve a single traversal`, businessOptions, async t => {
      const f = await businessFixture(t, direction), before = await f.history(), prepared = f.prepare();
      f.setFault(label => {if (label === point) throw Error('Synthetic audit interruption');});
      await assert.rejects(f.execute(prepared), {code:'EDIT_TASK_STORAGE_UNAVAILABLE'});
      const committed = !['afterClaim', 'beforeDispatch'].includes(point), during = await f.history();
      assert.equal(f.count(), committed ? 1 : 0);
      assert.equal(during.cursor, before.cursor + (committed ? delta : 0));
      f.setFault(() => {}); f.restart();
      const stored = f.state(), calls = f.dispatches;
      await f.tasks.reconcileStartup(); assert.equal(f.dispatches, calls); assert.deepEqual(f.state(), stored);
      await assert.rejects(f.execute(prepared), {code:'EDIT_TASK_STALE_INSTANCE'});
      const current = f.get(prepared.task);
      assert.deepEqual(current.task.input, f.input); assert.equal(current.task.status, committed ? 'applied' : 'unknown');
      const result = await f.execute(current);
      assert.equal(result.task.status, 'applied'); assert.equal(result.task.requestId, f.input.requestId);
      assert.equal(f.dispatches, calls + (committed ? 0 : 1)); assert.equal(f.count(), 1);
      const after = await f.history(), applied = f.state();
      assert.equal(after.cursor, before.cursor + delta); assert.equal(after.revision, before.revision + 1); assert.equal(after.length, before.length);
      assert.deepEqual(await f.execute(current), result); assert.deepEqual(f.state(), applied);
    });
  }
}
