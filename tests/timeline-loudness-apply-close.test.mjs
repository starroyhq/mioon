import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { isTimelineMutationResponse } from '@mioon/contracts';
import { createEditTaskClient, isDurableEditOperation } from '../apps/web/src/edit-task-client.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.ts';
import { createEditTaskController } from '../apps/web/src/edit-task-controller.ts';

import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import * as currentApplyState from '../apps/web/src/timeline-loudness-apply-state.ts';
import * as applyContracts from '@mioon/contracts/timeline-loudness-apply';
import * as mixState from '../apps/web/src/timeline-mix-loudness-state.ts';
import { timelineMixLoudnessViewState } from '../apps/web/src/timeline-mix-loudness-state.ts';
import { submitTimelineLoudnessApply } from '../apps/web/src/timeline-loudness-apply-submit.ts';
import { fixture, deferred, id, projectId, timelineId } from './helpers/timeline-mix-loudness-ui-fixture.mjs';
import { message as messageKey, renderMessage } from './helpers/i18n.ts';

// Frozen pre-fix sources exercise the identical causal test without changing
// the worktree. Only these four non-secret renderer files are substituted.
const sourcePath = filename => process.env.MIOON_LOUDNESS_CLOSE_SOURCE_ROOT
  ? pathToFileURL(resolve(process.env.MIOON_LOUDNESS_CLOSE_SOURCE_ROOT, filename)) : new URL(`../apps/web/src/${filename}`, import.meta.url);
const { createNativeCloseAdmission, createNativeCloseRegistry } = await import(sourcePath('native-close-state.ts'));
let applyState = currentApplyState;
if (process.env.MIOON_LOUDNESS_CLOSE_SOURCE_ROOT) {
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(readFileSync(sourcePath('timeline-loudness-apply-state.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(module, module.exports, name => {
    if (name === '@mioon/contracts/timeline-loudness-apply') return applyContracts;
    if (name === './timeline-mix-loudness-state.ts') return mixState;
    throw Error(`Unexpected controller dependency ${name}`);
  });
  applyState = module.exports;
}
const app = readFileSync(sourcePath('App.tsx'), 'utf8');
const part = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const durable = part('  async function run(', '  async function runSession(');
const mutate = part('  async function mutateTimeline(', '  async function selectClip(');
const scopeReader = part('  function readTimelineLoudnessRecoveryScope()', '  const timelineLoudnessApply =');
const apply = part('  const timelineLoudnessApply = useTimelineLoudnessApply(', '  const effectivePlayhead =');
const stamp = '2026-10-14T00:00:00.000Z';
function hookHarness() {
  const hooks = [], effects = [], pending = []; let cursor = 0;
  const react = {
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useState(value) { const index = cursor++; hooks[index] ??= { value }; return [hooks[index].value, next => { hooks[index].value = next; }]; },
    useLayoutEffect(fn, deps) { const index = cursor++, old = effects[index]; if (!old || !deps || deps.some((value, i) => value !== old.deps?.[i])) pending.push(() => { old?.cleanup?.(); effects[index] = { deps, fn, cleanup: fn() }; }); },
  };
  const module = { exports: {} };
  const source = readFileSync(sourcePath('use-timeline-loudness-apply.ts'), 'utf8');
  Function('module', 'exports', 'require', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module, module.exports, name => {
    if (name === 'react') return react;
    if (name === './timeline-loudness-apply-state.ts') return applyState;
    throw Error(`Unexpected hook dependency ${name}`);
  });
  return {
    render(options) { cursor = 0; const result = module.exports.useTimelineLoudnessApply(options); while (pending.length) pending.shift()(); return result; },
    dispose() { effects.forEach(effect => effect?.cleanup?.()); },
    reattach() { effects.forEach(effect => { if (effect) effect.cleanup = effect.fn(); }); },
  };
}
async function harness(t, { lose = 'execute' } = {}) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const document = new EventTarget(), window = new EventTarget(); document.visibilityState = 'visible';
  globalThis.document = document; globalThis.window = window;
  const observation = fixture(); observation.edit(); await observation.ready();
  const calls = [], busy = new Set(), transitions = [], wireTasks = new Map(); let serial = 70, ackGate = null, confirmGate = null, contextReads = 0, requestKeys = 0;
  const confirms = [];
  const reply = data => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const instanceId = id(69);
  const fetcher = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path, body });
    if (path.startsWith('/api/tasks?')) return reply({ items: [...wireTasks.values()].filter(task => !task.acknowledged && task.projectId === new URL(path, 'http://localhost').searchParams.get('projectId')), nextCursor: null, instanceId });
    if (path === '/api/tasks/prepare') {
      const task = { id: id(serial++), digest: 'd'.repeat(64), projectId: body.projectId, operation: body.operation, input: structuredClone(body.input), requestId: body.input.requestId,
        lane: 'timeline:mutation', status: 'prepared', revision: 1, acknowledged: false, createdAt: stamp, updatedAt: stamp, origin: body.origin };
      wireTasks.set(task.id, task); if (lose === 'prepare') throw Error('Prepare response lost after persistence'); return reply({ task, instanceId });
    }
    const taskId = path.split('/')[3], task = wireTasks.get(taskId?.split('?')[0]);
    assert.ok(task, `Expected original task for ${path}`);
    if (path.endsWith('/execute')) { wireTasks.set(task.id, { ...task, status: 'applied', revision: 3 }); throw Object.assign(Error('Execute response timed out after commit'), { code: 'REQUEST_TIMEOUT' }); }
    if (path.endsWith('/acknowledge')) { const ack = { ...task, acknowledged: true, revision: task.revision + 1 }; wireTasks.set(task.id, ack); if (ackGate) { const gate = ackGate; ackGate = null; gate.started.resolve(ack); await gate.wait.promise; } return reply({ task: ack, instanceId }); }
    return reply({ task, instanceId });
  };
  const tasks = createEditTaskController({ client: createEditTaskClient({ fetcher }) }); await tasks.load(projectId);
  const registry = createNativeCloseRegistry(), hook = hookHarness();
  const currentProject = { current: projectId }, dataRef = { current: { project: { id: projectId }, timeline: { id: timelineId, revision: 4 }, timelineHistory: { revision: 4 } } };
  let keys = 0, epoch = 0;
  const env = {
    application: null, clipDraftRef: { current: null }, setSubjectRefresh: () => undefined, msg: messageKey,
    localizedError: value => Object.assign(new Error(renderMessage('zh-Hans', value)), { displayMessage: value }),
    workspaceOriginScope, workspaceRef: { current: { restored: false } }, preferenceScope: { current: 'a'.repeat(64) },
    lastProjectRef: { current: { getState: () => ({ identityBlocked: false }) } }, timelineLoudnessApplyRecoveryScope: currentApplyState.timelineLoudnessApplyRecoveryScope, isDurableEditOperation, isTimelineMutationResponse, submitTimelineLoudnessApply, tasksRef: { current: tasks }, currentProject, dataRef,
    nativeCloseRegistry: { current: registry }, timelineLoudnessApplyRef: { current: null },
    timelineMixLoudness: { controller: observation.controller }, timelineMixLoudnessContext: () => { contextReads++; return observation.live(); }, timelineMixLoudnessViewState,
    timelinePending: false, requestId: () => { requestKeys++; return `close-original-key-${++keys}`; }, context: () => ({ projectId: currentProject.current, epoch }), isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === epoch,
    captureTaskWorkspaceIntent: () => () => false, readTaskRevealContext: () => ({}), pendingForProject: () => [], isMutationOperation: () => false,
    isBusy: key => busy.has(key), markBusy: (_owner, key, value) => { if (value) busy.add(key); else busy.delete(key); observation.set({ pending: value }); transitions.push(value); },
    requestCounter: { current: 0 }, clipConnectionBlocked: { current: false }, setData: update => { dataRef.current = update(dataRef.current); }, refresh: async () => undefined,
    notify: () => undefined, openTasks: () => undefined, setAuth: () => undefined, readableError: error => error.message,
    runSession: () => assert.fail('No legacy session mutation'), timelineFormatRef: { current: null }, subtitlesRef: { current: null },
    useTimelineLoudnessApply: options => hook.render(options), confirm: async message => { confirms.push(message); if (confirmGate) { const gate = confirmGate; confirmGate = null; gate.started.resolve(); return gate.wait.promise; } return true; },
  };
  const execute = () => Function(...Object.keys(env), `${durable}\n${mutate}\n${scopeReader}\n${apply}\nreturn { view: timelineLoudnessApply, recoverTask };`)(...Object.values(env));
  let actual = execute();
  const admission = createNativeCloseAdmission({ registry, settings: createSettingsNavigationRegistry(), readScope: () => `${currentProject.current}:${epoch}`, readLegacyDirty: () => false,
    readAdditionalSnapshot: () => ({ dirty: false, busy: busy.size > 0, unknown: false, identity: [currentProject.current, epoch] }), now: () => 1000, newToken: () => `close-${++keys}` });
  const h = { registry, admission, observation, document, window, calls, busy, transitions, wireTasks, tasks, hook,
    view: () => actual.view, render() { actual = execute(); return actual.view; },
    async apply() { return actual.view.controller.review(timelineMixLoudnessViewState(observation.state(), observation.live())); },
    recover(task) { return actual.recoverTask(task); },
    holdAcknowledgement() { ackGate = { started: deferred(), wait: deferred() }; return ackGate; },
    reads: () => contextReads, confirms, requestKeys: () => requestKeys,
    holdConfirmation() { confirmGate = { started: deferred(), wait: deferred() }; return confirmGate; },
    scope: () => currentApplyState.timelineLoudnessApplyRecoveryScope(env.preferenceScope.current, workspaceOriginScope(env.workspaceRef.current)),
    setStorage(scope, blocked = false) { env.preferenceScope.current = scope; env.lastProjectRef.current = { getState: () => ({ identityBlocked: blocked }) }; },
    async navigate(nextProject = id(90), scope = `${nextProject}:2:normal`) { currentProject.current = nextProject; epoch++; observation.set({ projectId: nextProject, scope, pending: false }); dataRef.current = { ...dataRef.current, project: { id: nextProject } }; await tasks.load(nextProject); return h.render(); },
    unload() { let prevented = false; const event = { preventDefault() { prevented = true; }, returnValue: undefined }; return { allowed: admission.beforeUnload(event), prevented }; },
  };
  t.after(() => { try { hook.dispose(); } finally { globalThis.document = previous.document; globalThis.window = previous.window; } }); return h;
}

test('actual App timeout clears generic busy, but apply unknown remains a native hard block through exact recovery', async t => {
  const h = await harness(t);
  assert.equal(h.admission.inspect().disposition, 'clean');
  assert.equal((await h.apply()).status, 'unknown');
  assert.equal(h.view().controller.getState().phase, 'unknown');
  assert.equal(h.busy.size, 0); assert.deepEqual(h.transitions, [true, false]);
  // This is the causal regression: no rerender is needed to report the unknown.
  assert.equal(h.admission.inspect().disposition, 'blocked');
  assert.deepEqual(h.unload(), { allowed: false, prevented: true });
  const saved = h.tasks.getState(projectId).items[0]; await h.recover(saved);
  assert.equal(h.wireTasks.get(saved.id).acknowledged, true);
  assert.equal(h.view().controller.getState().phase, 'applied');
  assert.equal(h.admission.inspect().disposition, 'clean');
  assert.deepEqual(h.unload(), { allowed: true, prevented: false });
  assert.equal(h.calls.filter(call => call.path === '/api/tasks/prepare').length, 1);
  assert.equal(h.calls.filter(call => call.path.endsWith('/execute')).length, 1);
});


test('only the exact original acknowledged terminal task can release close; stale or malformed recovery is passive', async t => {
  const h = await harness(t); await h.apply();
  const original = [...h.wireTasks.values()][0], ack = { ...original, acknowledged: true, revision: original.revision + 1 };
  const capture = h.registry.capture(), state = h.view().controller.getState();
  for (const candidate of [
    { ...ack, acknowledged: false }, { ...ack, status: 'prepared' }, { ...ack, status: 'unknown' },
    { ...ack, projectId: id(90) }, { ...ack, requestId: 'different-original-request' },
    { ...ack, id: id(99) }, { ...ack, digest: 'e'.repeat(64) }, { ...ack, revision: 1 },
    { ...ack, operation: 'timeline.clip.update' }, { ...ack, input: { ...ack.input, expectedRevision: 5 } },
    { ...ack, input: { ...ack.input, candidateDigest: 'timeline-loudness-candidate-v1:' + 'f'.repeat(64) } },
    { ...ack, input: { ...ack.input, target: { ...ack.input.target, integratedLufs: -18 } } },
    { operation: original.operation, projectId, requestId: original.requestId, status: 'applied', acknowledged: true },
  ]) {
    h.view().controller.recovered(candidate, h.scope());
    assert.equal(h.registry.isCurrent(capture), true); assert.equal(h.view().controller.getState(), state);
    assert.equal(h.admission.inspect().disposition, 'blocked');
  }
  for (const scope of [null, undefined, 'restored:' + id(55), 'another-workspace']) {
    h.view().controller.recovered(ack, scope); assert.equal(h.registry.isCurrent(capture), true);
  }
  await h.recover(original); assert.equal(h.admission.inspect().disposition, 'clean');
});

test('lost prepare retains original scalar binding and clears only after explicit terminal recovery without another prepare', async t => {
  const h = await harness(t, { lose: 'prepare' });
  assert.equal((await h.apply()).status, 'unknown'); assert.equal(h.busy.size, 0);
  assert.equal(h.admission.inspect().disposition, 'blocked');
  const original = [...h.wireTasks.values()][0];
  h.view().controller.recovered({ ...original, input: { ...original.input, snapshotSha256: 'c'.repeat(64) }, status: 'not_applied', revision: 2, acknowledged: true }, h.scope());
  assert.equal(h.admission.inspect().disposition, 'blocked');
  h.wireTasks.set(original.id, { ...original, status: 'not_applied', revision: 2 });
  await h.tasks.load(projectId); await h.recover(h.tasks.getState(projectId).items[0]);
  assert.equal(h.view().controller.getState().phase, 'error'); assert.equal(h.admission.inspect().disposition, 'clean');
  assert.equal(h.calls.filter(call => call.path === '/api/tasks/prepare').length, 1);
  assert.equal(h.calls.some(call => call.path.endsWith('/execute')), false);
});

test('hiding, navigation and a late old-project ACK retain the new owner and its hard block', async t => {
  const h = await harness(t); await h.apply(); const original = [...h.wireTasks.values()][0];
  for (const event of ['blur', 'pagehide']) { h.window.dispatchEvent(new Event(event)); assert.equal(h.admission.inspect().disposition, 'blocked'); }
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange')); h.render();
  assert.equal(h.admission.inspect().disposition, 'blocked');
  h.document.visibilityState = 'visible'; h.document.dispatchEvent(new Event('visibilitychange'));
  const gate = h.holdAcknowledgement(), recovering = h.recover(original); await gate.started.promise;
  await h.navigate(); assert.equal(h.admission.inspect().disposition, 'blocked');
  h.observation.edit(); await h.observation.ready(); h.render(); await h.apply();
  const next = [...h.wireTasks.values()].find(task => task.id !== original.id), state = h.view().controller.getState();
  assert.equal(state.requestId, next.requestId); assert.equal(state.phase, 'unknown');
  gate.wait.resolve(); await recovering;
  assert.equal(h.view().controller.getState(), state, 'Old ACK must not replace the new owner UI');
  assert.equal(h.admission.inspect().disposition, 'blocked', 'Old ACK cannot clear the new pending owner');
  h.view().controller.recovered(h.wireTasks.get(original.id), h.scope()); assert.equal(h.view().controller.getState(), state);
  await h.recover(next); assert.equal(h.admission.inspect().disposition, 'clean');
});

test('unknown survives owner navigation and back, effect cleanup/reattach, and exact old recovery', async t => {
  const h = await harness(t); await h.apply(); const original = [...h.wireTasks.values()][0], scope = h.observation.live().scope;
  await h.navigate(); assert.equal(h.admission.inspect().disposition, 'blocked');
  await h.navigate(projectId, scope); assert.equal(h.view().controller.getState().phase, 'unknown');
  await h.navigate(projectId, `${projectId}:3:normal`); assert.equal(h.admission.inspect().disposition, 'blocked');
  h.hook.dispose(); assert.equal(h.registry.capture().length, 0);
  h.hook.reattach(); assert.equal(h.registry.capture().length, 1); assert.equal(h.admission.inspect().disposition, 'blocked');
  await h.recover(original); assert.equal(h.admission.inspect().disposition, 'clean');
  const clean = h.admission.inspect(); assert.equal(h.admission.commit(clean.token, { discardDirty: false, allowDrainFailure: false, expiresAt: 1500 }), true);
  h.hook.dispose(); h.hook.reattach();
  assert.deepEqual(h.unload(), { allowed: false, prevented: true }, 'Replacement owner invalidates an old close ticket');
});

test('dirty discard and import-unknown risk permission cannot bypass an apply hard block', async t => {
  const h = await harness(t); await h.apply();
  const admission = createNativeCloseAdmission({ registry: h.registry, settings: createSettingsNavigationRegistry(), readScope: () => 'same',
    readLegacyDirty: () => true, readAdditionalSnapshot: () => ({ dirty: true, busy: false, unknown: true, identity: ['separate-import-owner'] }), now: () => 1000, newToken: () => 'risk-close' });
  for (const discardDirty of [false, true]) for (const allowUnknown of [false, true]) {
    const ticket = admission.inspect(); assert.equal(ticket.disposition, 'blocked');
    assert.equal(admission.commit(ticket.token, { discardDirty, allowUnknown, allowDrainFailure: true, expiresAt: 1500 }), false);
    let prevented = false; const event = { preventDefault() { prevented = true; }, returnValue: '' };
    admission.prepareBeforeUnload(event); assert.equal(admission.beforeUnload(event), false); assert.equal(prevented, true);
    assert.equal(admission.suppressLifecycleFlush(), false);
  }
});

test('close inspection and final beforeunload are pure cached reads with no context, timers, writes or RPC', async t => {
  const h = await harness(t); await h.apply();
  const state = h.view().controller.getState(), close = h.view().controller.getCloseState(), capture = h.registry.capture();
  const calls = h.calls.length, reads = h.reads(); let timers = 0, writes = 0;
  t.mock.method(globalThis, 'setTimeout', () => { timers++; throw Error('No lifecycle timers'); });
  t.mock.method(globalThis, 'setInterval', () => { timers++; throw Error('No lifecycle intervals'); });
  t.mock.method(h.tasks, 'submit', () => { writes++; throw Error('No close submission'); });
  t.mock.method(h.tasks, 'acknowledge', () => { writes++; throw Error('No close acknowledgment'); });
  t.mock.method(h.tasks, 'recover', () => { writes++; throw Error('No close recovery'); });
  for (let i = 0; i < 3; i++) {
    const ticket = h.admission.inspect(); assert.equal(ticket.disposition, 'blocked');
    assert.equal(h.admission.commit(ticket.token, { discardDirty: true, allowUnknown: true, allowDrainFailure: true, expiresAt: 1500 }), false);
    assert.deepEqual(h.unload(), { allowed: false, prevented: true });
  }
  assert.equal(h.reads(), reads); assert.equal(h.calls.length, calls); assert.equal(timers, 0); assert.equal(writes, 0);
  assert.equal(h.view().controller.getState(), state); assert.equal(h.view().controller.getCloseState(), close); assert.equal(h.registry.isCurrent(capture), true);
  assert.deepEqual(Object.keys(capture[0]).sort(), ['blocked', 'busy', 'dirty', 'owner', 'slot', 'version']);
});


test('actual App recovery scope rejects copied tasks in another normal workspace or blocked identity, but permits original workspace after UI epoch change', async t => {
  const h = await harness(t); await h.apply(); const original = [...h.wireTasks.values()][0];
  for (const [scope, blocked] of [['b'.repeat(64), false], ['a'.repeat(64), true], [null, false], ['invalid', false]]) {
    h.setStorage(scope, blocked); await h.recover(original);
    assert.equal(h.admission.inspect().disposition, 'blocked', 'A copied terminal task from a different or unverified database cannot settle the original');
  }
  h.setStorage('a'.repeat(64)); await h.navigate(projectId, `${projectId}:44:normal`); await h.recover(original);
  assert.equal(h.admission.inspect().disposition, 'clean');
});

test('retired hook listeners and cleanup cannot publish into or release a newer fixed-slot owner', async t => {
  const h = await harness(t); await h.apply();
  const next = h.registry.register('timeline-loudness-apply'); next.update({ dirty: false, busy: false, blocked: true, version: 1 });
  const capture = h.registry.capture(), original = [...h.wireTasks.values()][0];
  h.hook.dispose(); const reads = h.reads();
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
  h.window.dispatchEvent(new Event('blur')); h.window.dispatchEvent(new Event('pagehide'));
  h.view().controller.recovered({ ...original, acknowledged: true, revision: 4 }, h.scope());
  assert.equal(h.reads(), reads); assert.equal(h.registry.isCurrent(capture), true);
  assert.equal(h.admission.inspect().disposition, 'blocked');
});


for (const [name, scope, blocked] of [['missing', null, false], ['malformed', 'invalid', false], ['blocked', 'a'.repeat(64), true]]) {
  test(`actual App ${name} recovery identity cannot confirm, mint a request or create a pending apply`, async t => {
    const h = await harness(t); h.setStorage(scope, blocked); h.render();
    assert.equal(await h.apply(), null);
    assert.equal(h.confirms.length, 0); assert.equal(h.requestKeys(), 0);
    assert.equal(h.calls.some(call => call.path === '/api/tasks/prepare'), false); assert.equal(h.wireTasks.size, 0);
    assert.equal(h.view().controller.getCloseState().blocked, false); assert.equal(h.view().controller.getCloseState().busy, false);
    assert.equal(h.admission.inspect().disposition, 'clean');
    assert.match(h.view().controller.getState().error, /工作区身份.*未.*核验|身份尚未核验/);
    h.setStorage('a'.repeat(64)); h.observation.edit(); await h.observation.ready(); h.render();
    assert.equal((await h.apply()).status, 'unknown'); assert.equal(h.confirms.length, 1); assert.ok(h.requestKeys() > 0);
    assert.equal(h.calls.filter(call => call.path === '/api/tasks/prepare').length, 1);
    const original = [...h.wireTasks.values()][0]; await h.recover(original); assert.equal(h.admission.inspect().disposition, 'clean');
  });
}

for (const notify of [false, true]) for (const [name, scope, blocked] of [['changed', 'b'.repeat(64), false], ['unverified', null, false], ['blocked', 'a'.repeat(64), true]]) {
  test(`actual App ${name} recovery identity during confirmation exits busy without POST, with${notify ? '' : 'out'} render`, async t => {
    const h = await harness(t), gate = h.holdConfirmation(), reviewing = h.apply(); await gate.started.promise;
    assert.equal(h.view().controller.getState().phase, 'confirming');
    h.setStorage(scope, blocked); if (notify) h.render(); gate.wait.resolve(true); assert.equal(await reviewing, null);
    const state = h.view().controller.getState(); assert.ok(['stale', 'error'].includes(state.phase)); assert.match(state.error, /身份/);
    assert.equal(h.wireTasks.size, 0); assert.equal(h.calls.some(call => call.path === '/api/tasks/prepare'), false);
    assert.equal(h.view().controller.getCloseState().busy, false); assert.equal(h.view().controller.getCloseState().blocked, false);
    assert.equal(h.admission.inspect().disposition, 'clean');
    h.setStorage('a'.repeat(64)); h.observation.edit(); await h.observation.ready(); h.render();
    assert.equal((await h.apply()).status, 'unknown'); const original = [...h.wireTasks.values()][0]; await h.recover(original);
    assert.equal(h.admission.inspect().disposition, 'clean');
  });
}
