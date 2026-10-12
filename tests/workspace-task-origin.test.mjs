import test from 'node:test';
import assert from 'node:assert/strict';
import { taskWorkspaceBinding, taskListWorkspaceBindings, requireTaskWorkspace } from '../apps/web/src/workspace-task-origin.js';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333', otherTask = '44444444-4444-4444-8444-444444444444';
const workspace = { restored: true, workspaceOrigin: a };
const current = { workspaceOrigin: a, executionEpoch: a, held: false };
const captured = { workspaceOrigin: a, executionEpoch: 'captured', held: true };

test('restore context remains outside original task and domain receipt', () => {
  const task = { id: taskId, origin: 'new', input: { requestId: 'original' }, status: 'applied' };
  const receipt = { id: otherTask }, envelope = { task, result: receipt, restore: captured };
  const before = JSON.stringify(envelope), binding = taskWorkspaceBinding(envelope, workspace);
  assert.deepEqual(binding, captured); assert.ok(Object.isFrozen(binding));
  assert.equal(JSON.stringify(envelope), before);
  assert.equal(envelope.task, task); assert.equal(envelope.result, receipt);
  assert.throws(() => requireTaskWorkspace(binding, workspace), { code: 'RESTORED_RECORD_HELD' });
});

test('held and mismatched task epochs never borrow a current inspection origin', () => {
  assert.deepEqual(requireTaskWorkspace(current, workspace), { expectedWorkspaceOrigin: a });
  for (const binding of [null, {}, captured, { workspaceOrigin: a, executionEpoch: b, held: true },
    { workspaceOrigin: a, executionEpoch: 'captured', held: false }, { ...current, workspaceOrigin: b }])
    assert.throws(() => requireTaskWorkspace(binding, workspace), { code: 'RESTORED_RECORD_HELD' });
  assert.throws(() => requireTaskWorkspace(current, { restored: true, workspaceOrigin: b }), { code: 'RESTORED_RECORD_HELD' });
  assert.throws(() => requireTaskWorkspace(current, { restored: false }), { code: 'RESTORED_RECORD_HELD' });
  assert.deepEqual(requireTaskWorkspace(null, { restored: false }), {});
});

test('task list restore metadata requires exactly one matching ordered context per row', () => {
  const items = [{ id: taskId }, { id: otherTask }];
  const restore = { workspaceOrigin: a, tasks: [{ taskId, executionEpoch: 'captured', held: true }, { taskId: otherTask, executionEpoch: a, held: false }] };
  const contexts = taskListWorkspaceBindings({ items, restore }, workspace);
  assert.deepEqual(contexts.get(taskId), captured); assert.deepEqual(contexts.get(otherTask), current);
  for (const broken of [undefined, { ...restore, workspaceOrigin: b }, { ...restore, tasks: restore.tasks.slice(0, 1) },
    { ...restore, tasks: [...restore.tasks].reverse() }, { ...restore, tasks: [restore.tasks[0], restore.tasks[0]] }])
    assert.throws(() => taskListWorkspaceBindings({ items, restore: broken }, workspace), { code: 'BACKEND_PROTOCOL_ERROR' });
});

test('ordinary task envelopes cannot silently become restored, and missing restored metadata fails closed', () => {
  assert.equal(taskWorkspaceBinding({ task: {} }, { restored: false }), null);
  assert.equal(taskListWorkspaceBindings({ items: [] }, { restored: false }).size, 0);
  assert.throws(() => taskWorkspaceBinding({ task: {}, restore: current }, { restored: false }), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.throws(() => taskWorkspaceBinding({ task: {} }, workspace), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.throws(() => taskWorkspaceBinding({ task: {}, restore: current }, null), { code: 'WORKSPACE_ORIGIN_UNVERIFIED' });
  assert.throws(() => taskListWorkspaceBindings({ items: [], restore: { workspaceOrigin: a, tasks: [] } }, null), { code: 'WORKSPACE_ORIGIN_UNVERIFIED' });
});
