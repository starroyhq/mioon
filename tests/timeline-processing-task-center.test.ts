import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {observeSpeedProcessingTasks, speedProcessingOverviewItems, speedProcessingTaskViews} from '../apps/web/src/timeline-processing-tasks.ts';
import type {SpeedProcessingItem} from '../packages/contracts/src/timeline-speed.ts';
import {createI18nTestContext} from './helpers/i18n.ts';

test('the processing observer reads the current project and ignores a late reply after switching', async t => {
  const oldProjectId = randomUUID(), newProjectId = randomUUID();
  const late = Promise.withResolvers<unknown>(), current = Promise.withResolvers<unknown>();
  const oldItem = {taskId: randomUUID(), clipId: randomUUID(), kind: 'reverse', status: 'queued'} as const;
  const newItem = {taskId: randomUUID(), clipId: randomUUID(), kind: 'preview', status: 'running', progress: 42} as const;
  const reads: {operation: string; projectId: string; signal: AbortSignal}[] = [];
  const seen: (readonly SpeedProcessingItem[])[] = [];
  const read = (operation: string, {projectId}: {projectId: string}, {signal}: {signal: AbortSignal}) => {
    reads.push({operation, projectId, signal});
    return (projectId === oldProjectId ? late : current).promise;
  };
  const stopOld = observeSpeedProcessingTasks(oldProjectId, read, items => seen.push(items));
  stopOld();
  const stopCurrent = observeSpeedProcessingTasks(newProjectId, read, items => seen.push(items));
  t.after(stopCurrent);
  late.resolve({items: [oldItem]});
  current.resolve({items: [newItem]});
  await Promise.resolve();
  assert.deepEqual(seen, [[newItem]]);
  assert.deepEqual(reads.map(({operation, projectId, signal}) => [operation, projectId, signal.aborted]), [
    ['timeline.processing.list', oldProjectId, true], ['timeline.processing.list', newProjectId, false],
  ]);
});

test('processing aliases share one task row and the Work popover reflects active tasks and failures', () => {
  const clips = [{id: randomUUID(), name: '第一段'}, {id: randomUUID(), name: '第二段'}];
  const taskId = randomUUID();
  const rows = speedProcessingTaskViews([
    {taskId, clipId: clips[0]!.id, kind: 'reverse', status: 'queued'},
    {taskId, clipId: clips[1]!.id, kind: 'reverse', status: 'queued'},
    {taskId: randomUUID(), clipId: clips[1]!.id, kind: 'optical', status: 'failed', reason: 'INTERPOLATION_UNAVAILABLE'},
    {taskId: randomUUID(), clipId: clips[0]!.id, kind: 'preview', status: 'running', progress: 42},
    {taskId: randomUUID(), clipId: clips[0]!.id, kind: 'preview', status: 'ready'},
  ], clips, createI18nTestContext().t);
  assert.deepEqual(rows.map(row => [row.label, row.status, row.progress, row.active]), [
    ['倒放代理 · 第一段 · 第二段', '排队中', undefined, true],
    ['光流补帧 · 第二段', '失败', undefined, false],
    ['变速预览 · 第一段', '处理中', 42, true],
    ['变速预览 · 第一段', '已完成', undefined, false],
  ]);
  assert.deepEqual(speedProcessingOverviewItems(rows).map(item => [item.id, item.phase, item.detail]), [
    [`processing:${taskId}`, 'active', undefined], [rows[1]!.key, 'attention', '当前补帧方式不可用'],
    [rows[2]!.key, 'active', undefined],
  ]);
});
