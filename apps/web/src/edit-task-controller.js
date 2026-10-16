import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import { workspaceOriginScope, workspaceOriginOptions, assertWorkspaceIntent } from './workspace-origin.js';
import { taskWorkspaceBinding, taskListWorkspaceBindings, requireTaskWorkspace } from './workspace-task-origin.js';
import { EDIT_TASK_LIMITS, editTaskLane } from '@mioon/contracts';
import { createEditTaskClient, editTaskClientValidation, isDurableEditOperation, taskInputKey, taskProtocolError } from './edit-task-client.js';

const fail = (code, message, displayMessage) => Object.assign(new Error(message), { code, displayMessage });
const terminal = task => ['applied', 'not_applied'].includes(task.status);
const laneFor = editTaskLane;
const immutableFields = ['id', 'projectId', 'operation', 'requestId', 'digest', 'lane', 'origin', 'createdAt'];
function frozen(value) {
  const copy = structuredClone(value);
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy);
}

// No renderer storage is the authority for these fifteen operations. Loading is
// read-only, and the project remains fenced until every bounded page is known.
export function createEditTaskController({ client = createEditTaskClient(), onChange = () => {}, getWorkspace = () => ({ restored: false }) } = {}) {
  const {validateTaskEnvelope, validateTaskList} = editTaskClientValidation(client);
  const projects = new Map();
  function state(projectId, workspace = getWorkspace()) {
    const scope = workspaceOriginScope(workspace), key = JSON.stringify([scope, projectId]);
    if (!projects.has(key)) projects.set(key, { phase: 'idle', tasks: new Map(), restore: new Map(), uncertain: new Set(), busy: new Set(), epoch: 0, error: null,
      workspace: workspace ? frozen(workspace) : null });
    return projects.get(key);
  }
  function snapshot(value) {
    const heldIds = [...value.restore].filter(([, binding]) => binding.held).map(([id]) => id);
    return { phase: value.phase, error: value.error, items: [...value.tasks.values()].filter(task => !task.acknowledged || heldIds.includes(task.id)),
      uncertain: [...value.uncertain], busy: [...value.busy], ...(value.workspace?.restored ? { heldIds } : {}) };
  }
  function getState(projectId) { return snapshot(state(projectId)); }
  const publish = (projectId, value = state(projectId)) => { if (value === state(projectId)) onChange(projectId, snapshot(value)); };
  function merge(task, value, binding) {
    const prior = value.tasks.get(task.id), priorBinding = value.restore.get(task.id);
    if (prior && taskInputKey(priorBinding) !== taskInputKey(binding ?? undefined)) throw taskProtocolError();
    if (binding) value.restore.set(task.id, binding);
    if (prior) {
      if (immutableFields.some(field => prior[field] !== task[field]) || taskInputKey(prior.input) !== taskInputKey(task.input)) throw taskProtocolError();
      if (task.revision < prior.revision) return prior;
      if (task.revision === prior.revision) {
        if (taskInputKey(prior) !== taskInputKey(task)) throw taskProtocolError();
        return prior;
      }
      if ((terminal(prior) && prior.status !== task.status) || (prior.acknowledged && !task.acknowledged)) throw taskProtocolError();
      if (prior.status === 'unknown' && task.status === 'prepared') throw taskProtocolError();
    }
    const saved = frozen(task); value.tasks.set(task.id, saved);
    if (terminal(task)) value.uncertain.delete(task.id);
    return saved;
  }
  function receive(response, expected, value = state(response.task.projectId)) {
    validateTaskEnvelope(response, expected);
    const binding = taskWorkspaceBinding(response, value.workspace);
    const task = merge(response.task, value, binding);
    publish(task.projectId, value);
    // An older response must not supply the outcome for a newer acknowledgment.
    return task.revision === response.task.revision ? { ...response, task } : { task, instanceId: response.instanceId, ...(binding ? { restore: binding } : {}) };
  }
  function invalidate(projectId, error, value = state(projectId)) {
    value.epoch++; value.phase = 'error'; value.error = error; publish(projectId, value);
  }
  async function load(projectId) {
    const value = state(projectId), epoch = ++value.epoch;
    value.phase = 'loading'; value.error = null; publish(projectId, value);
    try {
      const items = [], contexts = new Map(), cursors = new Set(); let cursor, instanceId;
      const pendingOnly = !value.workspace?.restored;
      do {
        const page = validateTaskList(await client.list({ projectId, limit: 50, ...(pendingOnly ? {} : { pendingOnly: false }), ...(cursor ? { cursor } : {}) }), projectId, { pendingOnly });
        const bindings = taskListWorkspaceBindings(page, value.workspace);
        for (const [id, binding] of bindings) contexts.set(id, binding);
        if (epoch !== value.epoch) return getState(projectId);
        if (instanceId && instanceId !== page.instanceId) throw fail('TASK_SERVER_CHANGED', '服务已重启，请重新载入任务列表后再编辑。', localizedMessage('tasks.localError.serverChanged'));
        instanceId = page.instanceId; items.push(...page.items);
        if (items.length > EDIT_TASK_LIMITS.rows || cursors.size >= Math.ceil(EDIT_TASK_LIMITS.rows / 50) + 1) throw taskProtocolError();
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw taskProtocolError();
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(items.map(task => task.id)).size !== items.length) throw taskProtocolError();
      for (const task of items) merge(task, value, contexts.get(task.id));
      // Absence from a pending-only page cannot prove that a local unknown was
      // rejected, nor may a reordered list resurrect an acknowledged task.
      value.phase = 'ready'; value.error = null; publish(projectId, value);
    } catch (error) {
      if (epoch === value.epoch) { value.phase = 'error'; value.error = error; publish(projectId, value); }
    }
    return getState(projectId);
  }
  function blocked(projectId, lane) {
    const value = state(projectId);
    return value.phase !== 'ready' || value.busy.has(lane) || [...value.tasks.values()].some(task => !task.acknowledged && !value.restore.get(task.id)?.held && (!lane || task.lane === lane));
  }
  function assertReady(projectId, lane) {
    if (state(projectId).phase !== 'ready') throw fail('TASK_LIST_UNAVAILABLE', '任务恢复列表尚未核对完成。请先在任务中心重新载入，再继续编辑。', localizedMessage('tasks.localError.listUnverified'));
    if (blocked(projectId, lane)) throw fail('MUTATION_PENDING', '此类编辑有请求待确认。草稿仍保留，请先在任务中心恢复原请求。', localizedMessage('tasks.localError.lanePending'));
  }
  async function execute(response, value = state(response.task.projectId)) {
    const task = response.task, invocation = requireTaskWorkspace(value.restore.get(task.id), value.workspace);
    value.uncertain.add(task.id); publish(task.projectId, value);
    try {
      return receive(await client.execute({ projectId: task.projectId, taskId: task.id, digest: task.digest, instanceId: response.instanceId }, { ...invocation, ...(task.operation === 'timeline.loudness.apply' ? { operation: task.operation } : {}) }), taskIdentity(task), value);
    } catch (error) { publish(task.projectId, value); throw error; }
  }
  async function submit({ projectId, operation, input, expectedWorkspaceOrigin }, { canExecute = () => true } = {}) {
    if (!isDurableEditOperation(operation) || input.projectId !== projectId) throw fail('MUTATION_PROJECT_MISMATCH', '项目或请求已变化，已阻止提交。', localizedMessage('tasks.localError.requestChanged'));
    const lane = laneFor(operation), exact = frozen(input), value = state(projectId);
    assertReady(projectId, lane);
    const invocation = assertWorkspaceIntent(workspaceOriginOptions(expectedWorkspaceOrigin), value.workspace);
    value.busy.add(lane); publish(projectId, value);
    let prepared;
    try {
      try { prepared = receive(await client.prepare({ projectId, operation, input: exact, origin: 'new' }, invocation), { projectId, operation, input: exact, origin: 'new' }, value); }
      catch (error) { invalidate(projectId, error, value); throw error; }
      // Navigating away during preparation leaves a recoverable prepared task.
      // It never authorizes a late callback to dispatch from another workspace.
      if (!(operation === 'timeline.loudness.apply' ? canExecute(prepared.task) : canExecute()) || terminal(prepared.task) || prepared.task.acknowledged) return prepared;
      return await execute(prepared, value);
    } finally { value.busy.delete(lane); publish(projectId, value); }
  }
  async function recover(expected, { canExecute = () => true } = {}) {
    const value = state(expected.projectId);
    const invocation = requireTaskWorkspace(value.restore.get(expected.id), value.workspace);
    if (value.busy.has(expected.id)) return null;
    value.busy.add(expected.id); publish(expected.projectId, value);
    try {
      // Always lookup first. After a server restart only this explicit action
      // may obtain its new nonce and execute the original persisted parameters.
      let response = receive(await client.get({ projectId: expected.projectId, taskId: expected.id, ...(expected.operation === 'timeline.loudness.apply' ? { operation: expected.operation } : {}) }), taskIdentity(expected), value);
      if (response.task.acknowledged || terminal(response.task)) return response;
      if (response.task.status === 'dispatching') response = receive(await client.reconcile({ projectId: expected.projectId, taskId: expected.id, digest: expected.digest }, { ...invocation, ...(expected.operation === 'timeline.loudness.apply' ? { operation: expected.operation } : {}) }), taskIdentity(expected), value);
      else if (canExecute()) response = await execute(response, value);
      return response;
    } finally { value.busy.delete(expected.id); publish(expected.projectId, value); }
  }
  async function acknowledge(expected) {
    if (!terminal(expected)) throw taskProtocolError();
    const value = state(expected.projectId), invocation = requireTaskWorkspace(value.restore.get(expected.id), value.workspace);
    const response = await client.acknowledge({ projectId: expected.projectId, taskId: expected.id, digest: expected.digest,
      expectedRevision: expected.revision, status: expected.status }, { ...invocation, ...(expected.operation === 'timeline.loudness.apply' ? { operation: expected.operation } : {}) });
    validateTaskEnvelope(response, taskIdentity(expected));
    if (!response.task.acknowledged || response.task.status !== expected.status || response.task.revision <= expected.revision) throw taskProtocolError();
    return receive(response, taskIdentity(expected), value);
  }
  async function adopt(entry) {
    if (!isDurableEditOperation(entry.operation) || entry.input.projectId !== entry.projectId) throw taskProtocolError();
    const value = state(entry.projectId), invocation = assertWorkspaceIntent(entry, value.workspace);
    // Adoption only writes recovery metadata. It never executes or reconciles.
    return receive(await client.prepare({ projectId: entry.projectId, operation: entry.operation, input: frozen(entry.input), origin: 'legacy_session' }, invocation),
      { projectId: entry.projectId, operation: entry.operation, input: entry.input, origin: 'legacy_session' }, value);
  }
  return { getState, load, blocked, assertReady, submit, recover, acknowledge, adopt };
}
function taskIdentity(task) { return { projectId: task.projectId, taskId: task.id, digest: task.digest, operation: task.operation, input: task.input, origin: task.origin }; }
