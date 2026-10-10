import { EDIT_TASK_LIMITS } from '@mioon/contracts';
import { createEditTaskClient, isDurableEditOperation, taskInputKey, taskProtocolError, validateTaskEnvelope, validateTaskList } from './edit-task-client.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const terminal = task => ['applied', 'not_applied'].includes(task.status);
const laneFor = operation => operation.startsWith('timeline.') ? 'timeline:mutation' : 'reference:mutation';
const immutableFields = ['id', 'projectId', 'operation', 'requestId', 'digest', 'lane', 'origin', 'createdAt'];
function frozen(value) {
  const copy = structuredClone(value);
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(copy);
}

// No renderer storage is the authority for these twelve operations. Loading is
// read-only, and the project remains fenced until every bounded page is known.
export function createEditTaskController({ client = createEditTaskClient(), onChange = () => {} } = {}) {
  const projects = new Map();
  function state(projectId) {
    if (!projects.has(projectId)) projects.set(projectId, { phase: 'idle', tasks: new Map(), uncertain: new Set(), busy: new Set(), epoch: 0, error: null });
    return projects.get(projectId);
  }
  function getState(projectId) {
    const value = state(projectId);
    return { phase: value.phase, error: value.error, items: [...value.tasks.values()].filter(task => !task.acknowledged),
      uncertain: [...value.uncertain], busy: [...value.busy] };
  }
  const publish = projectId => onChange(projectId, getState(projectId));
  function merge(task) {
    const value = state(task.projectId), prior = value.tasks.get(task.id);
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
  function receive(response, expected) {
    validateTaskEnvelope(response, expected);
    const task = merge(response.task);
    publish(task.projectId);
    // An older response must not supply the outcome for a newer acknowledgment.
    return task.revision === response.task.revision ? { ...response, task } : { task, instanceId: response.instanceId };
  }
  function invalidate(projectId, error) {
    const value = state(projectId); value.epoch++; value.phase = 'error'; value.error = error; publish(projectId);
  }
  async function load(projectId) {
    const value = state(projectId), epoch = ++value.epoch;
    value.phase = 'loading'; value.error = null; publish(projectId);
    try {
      const items = [], cursors = new Set(); let cursor, instanceId;
      do {
        const page = validateTaskList(await client.list({ projectId, limit: 50, ...(cursor ? { cursor } : {}) }), projectId);
        if (epoch !== value.epoch) return getState(projectId);
        if (instanceId && instanceId !== page.instanceId) throw fail('TASK_SERVER_CHANGED', '服务已重启，请重新载入任务列表后再编辑。');
        instanceId = page.instanceId; items.push(...page.items);
        if (items.length > EDIT_TASK_LIMITS.rows || cursors.size >= Math.ceil(EDIT_TASK_LIMITS.rows / 50) + 1) throw taskProtocolError();
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw taskProtocolError();
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(items.map(task => task.id)).size !== items.length) throw taskProtocolError();
      for (const task of items) merge(task);
      // Absence from a pending-only page cannot prove that a local unknown was
      // rejected, nor may a reordered list resurrect an acknowledged task.
      value.phase = 'ready'; value.error = null; publish(projectId);
    } catch (error) {
      if (epoch === value.epoch) { value.phase = 'error'; value.error = error; publish(projectId); }
    }
    return getState(projectId);
  }
  function blocked(projectId, lane) {
    const value = state(projectId);
    return value.phase !== 'ready' || value.busy.has(lane) || [...value.tasks.values()].some(task => !task.acknowledged && (!lane || task.lane === lane));
  }
  function assertReady(projectId, lane) {
    if (state(projectId).phase !== 'ready') throw fail('TASK_LIST_UNAVAILABLE', '任务恢复列表尚未核对完成。请先在任务中心重新载入，再继续编辑。');
    if (blocked(projectId, lane)) throw fail('MUTATION_PENDING', '此类编辑有请求待确认。草稿仍保留，请先在任务中心恢复原请求。');
  }
  async function execute(response) {
    const task = response.task, value = state(task.projectId);
    value.uncertain.add(task.id); publish(task.projectId);
    try {
      return receive(await client.execute({ projectId: task.projectId, taskId: task.id, digest: task.digest, instanceId: response.instanceId }), taskIdentity(task));
    } catch (error) { publish(task.projectId); throw error; }
  }
  async function submit({ projectId, operation, input }, { canExecute = () => true } = {}) {
    if (!isDurableEditOperation(operation) || input.projectId !== projectId) throw fail('MUTATION_PROJECT_MISMATCH', '项目或请求已变化，已阻止提交。');
    const lane = laneFor(operation), exact = frozen(input), value = state(projectId);
    assertReady(projectId, lane); value.busy.add(lane); publish(projectId);
    let prepared;
    try {
      try { prepared = receive(await client.prepare({ projectId, operation, input: exact, origin: 'new' }), { projectId, operation, input: exact, origin: 'new' }); }
      catch (error) { invalidate(projectId, error); throw error; }
      // Navigating away during preparation leaves a recoverable prepared task.
      // It never authorizes a late callback to dispatch from another workspace.
      if (!canExecute() || terminal(prepared.task) || prepared.task.acknowledged) return prepared;
      return await execute(prepared);
    } finally { value.busy.delete(lane); publish(projectId); }
  }
  async function recover(expected, { canExecute = () => true } = {}) {
    const value = state(expected.projectId);
    if (value.busy.has(expected.id)) return null;
    value.busy.add(expected.id); publish(expected.projectId);
    try {
      // Always lookup first. After a server restart only this explicit action
      // may obtain its new nonce and execute the original persisted parameters.
      let response = receive(await client.get({ projectId: expected.projectId, taskId: expected.id }), taskIdentity(expected));
      if (response.task.acknowledged || terminal(response.task)) return response;
      if (response.task.status === 'dispatching') response = receive(await client.reconcile({ projectId: expected.projectId, taskId: expected.id, digest: expected.digest }), taskIdentity(expected));
      else if (canExecute()) response = await execute(response);
      return response;
    } finally { value.busy.delete(expected.id); publish(expected.projectId); }
  }
  async function acknowledge(expected) {
    if (!terminal(expected)) throw taskProtocolError();
    const response = await client.acknowledge({ projectId: expected.projectId, taskId: expected.id, digest: expected.digest,
      expectedRevision: expected.revision, status: expected.status });
    validateTaskEnvelope(response, taskIdentity(expected));
    if (!response.task.acknowledged || response.task.status !== expected.status || response.task.revision <= expected.revision) throw taskProtocolError();
    return receive(response, taskIdentity(expected));
  }
  async function adopt(entry) {
    if (!isDurableEditOperation(entry.operation) || entry.input.projectId !== entry.projectId) throw taskProtocolError();
    // Adoption only writes recovery metadata. It never executes or reconciles.
    return receive(await client.prepare({ projectId: entry.projectId, operation: entry.operation, input: frozen(entry.input), origin: 'legacy_session' }),
      { projectId: entry.projectId, operation: entry.operation, input: entry.input, origin: 'legacy_session' });
  }
  return { getState, load, blocked, assertReady, submit, recover, acknowledge, adopt };
}
function taskIdentity(task) { return { projectId: task.projectId, taskId: task.id, digest: task.digest, operation: task.operation, input: task.input, origin: task.origin }; }
