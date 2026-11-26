import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCALES, catalogs, renderMessage, translate} from '../packages/i18n/src/index.ts';
import {ARK_SUBJECT_WARNING_MESSAGE} from '../apps/web/src/subject-video.ts';
import {providerAvailabilityDescriptor} from '../apps/web/src/generation-settings.ts';
import {
  DRAG_CONFLICT_PREVIEW_DELAY_MS,
  buildFormat5DragCommand,
  createDragConflictPreviewController,
  dragPreviewTargetKey,
  previewFormat5DragConflict,
} from '../apps/web/src/edit-ui/drag-conflict-preview.ts';
import type {DragConflictState, Format5DragPreviewTarget} from '../apps/web/src/edit-ui/drag-conflict-preview.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');

test('A1: no user-facing i18n catalog string in any of the 4 locales uses 工作台 / workbench / ワークベンチ', () => {
  const forbidden = /工作台|工作臺|workbench|ワークベンチ/iu;
  const leaks: string[] = [];
  for (const [key, entry] of Object.entries(catalogs)) {
    for (const locale of LOCALES) {
      const value = entry[locale];
      const texts = typeof value === 'string' ? [value] : [value.one, value.other];
      for (const text of texts) {
        if (forbidden.test(text)) leaks.push(`${key} [${locale}]: ${text}`);
      }
    }
  }
  assert.deepEqual(leaks, []);

  // Reassuring fine-print / unused legacy workbench keys were removed.
  assert.equal(Object.hasOwn(catalogs, 'agent.settings.saveScope'), false);
  assert.equal(Object.hasOwn(catalogs, 'shell.login.title'), false);
  assert.equal(Object.hasOwn(catalogs, 'shell.login.hint'), false);

  // Login keeps 「访问令牌」 while removing 「工作台」.
  assert.equal(translate('zh-Hans', 'shell.login.token'), '访问令牌');
  assert.equal(translate('zh-Hans', 'shell.login.placeholder'), '输入访问令牌');
  assert.equal(translate('zh-Hans', 'shell.login.enter'), '进入 Mioon');
  assert.equal(translate('zh-Hans', 'shell.login.invalidToken'), '访问令牌无效，请使用服务器配置的访问令牌');
  assert.equal(translate('zh-Hans', 'shell.connectFailed'), '暂时无法连接 Mioon');
  assert.equal(translate('zh-Hans', 'shell.title'), 'Mioon');
  assert.equal(translate('zh-Hans', 'app.title'), 'Mioon');
  for (const locale of LOCALES) {
    assert.doesNotMatch(renderMessage(locale, ARK_SUBJECT_WARNING_MESSAGE), forbidden);
    assert.doesNotMatch(renderMessage(locale, providerAvailabilityDescriptor(null)), forbidden);
  }
});

test('A2: paid generation confirmation dialog uses the exact updated billing and cancellation sentence across 4 locales', () => {
  assert.equal(
    translate('zh-Hans', 'shell.generationDataScope', {count: 1}),
    '将发送此镜头的提示词、参数与 1 张参考图。费用由服务商按你的账户计费，服务商那边的任务不一定能取消。',
  );
  assert.equal(
    translate('zh-Hans', 'shell.generationDataScope', {count: 3}),
    '将发送此镜头的提示词、参数与 3 张参考图。费用由服务商按你的账户计费，服务商那边的任务不一定能取消。',
  );
  for (const locale of LOCALES) {
    for (const count of [1, 2]) {
      const text = translate(locale, 'shell.generationDataScope', {count});
      assert.doesNotMatch(text, /工作台|工作臺|workbench|ワークベンチ/iu, `${locale}/${count}: ${text}`);
      assert.ok(text.includes(String(count)), `${locale}/${count}`);
    }
  }
});

test('buildFormat5DragCommand emits exact main-track, off-track, and insert-asset commands', () => {
  const timeline = {
    mainTrack: {trackId: 'v1'},
    clips: [
      {id: 'clip-a', trackId: 'v1', startFrame: 0},
      {id: 'clip-b', trackId: 'v1', startFrame: 60},
      {id: 'clip-c', trackId: 'v1', startFrame: 120},
    ],
  };

  assert.deepEqual(
    buildFormat5DragCommand(
      {projectId: 'p1', revision: 1, kind: 'clip', id: 'clip-a', trackId: 'v1', startFrame: 90},
      timeline,
    ),
    {kind: 'clip-move', clipId: 'clip-a', beforeClipId: 'clip-c'},
  );
  assert.deepEqual(
    buildFormat5DragCommand(
      {projectId: 'p1', revision: 1, kind: 'clip', id: 'clip-a', trackId: 'v1', startFrame: 180},
      timeline,
    ),
    {kind: 'clip-move', clipId: 'clip-a', beforeClipId: null},
  );
  assert.deepEqual(
    buildFormat5DragCommand(
      {projectId: 'p1', revision: 1, kind: 'clip', id: 'clip-a', trackId: 'v2', startFrame: 10},
      timeline,
    ),
    {kind: 'clip-move-off-track', clipId: 'clip-a', trackId: 'v2', startFrame: 10},
  );
  assert.deepEqual(
    buildFormat5DragCommand(
      {projectId: 'p1', revision: 1, kind: 'asset', id: 'asset-1', trackId: 'v1', startFrame: 60},
      timeline,
    ),
    {kind: 'insert-asset', assetId: 'asset-1', trackId: null, startFrame: 60},
  );
  assert.deepEqual(
    buildFormat5DragCommand(
      {projectId: 'p1', revision: 1, kind: 'asset', id: 'asset-1', trackId: 'v2', startFrame: 45},
      timeline,
    ),
    {kind: 'insert-asset', assetId: 'asset-1', trackId: 'v2', startFrame: 45},
  );
});

test('previewFormat5DragConflict reports anchor conflict ids, retries read-only on COPY_NODE_REQUIRED, and stays silent on errors', async () => {
  const timeline = {
    mainTrack: {trackId: 'v1'},
    clips: [
      {id: 'clip-a', trackId: 'v1', startFrame: 0},
      {id: 'clip-b', trackId: 'v1', startFrame: 60},
    ],
  };
  const target: Format5DragPreviewTarget = {
    projectId: 'p1',
    revision: 3,
    kind: 'clip',
    id: 'clip-a',
    trackId: 'v2',
    startFrame: 0,
  };

  // 1) Resolved {ok: false, code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT', ids}
  const seenOps: string[] = [];
  const res1 = await previewFormat5DragConflict(
    async (op, input, opts) => {
      seenOps.push(op);
      assert.equal((input as {projectId: string}).projectId, 'p1');
      assert.ok(opts?.signal instanceof AbortSignal);
      return {ok: false, code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT', ids: ['ov-1', 'ov-2']};
    },
    target,
    timeline,
    new AbortController().signal,
  );
  assert.deepEqual(seenOps, ['sequence.preview']);
  assert.deepEqual(res1, {conflict: true, ids: ['ov-1', 'ov-2']});

  // 2) Thrown error with details.ids
  const res2 = await previewFormat5DragConflict(
    async () => {
      throw Object.assign(new Error('conflict'), {
        code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT',
        details: {ids: ['cue-1']},
      });
    },
    target,
    timeline,
    new AbortController().signal,
  );
  assert.deepEqual(res2, {conflict: true, ids: ['cue-1']});

  // 3) COPY_NODE_REQUIRED retries preview once with a copyNodeId and reports anchor conflict
  const intentCopyIds: Array<unknown> = [];
  const res3 = await previewFormat5DragConflict(
    async (_op, input) => {
      const intent = ((input as {intents: Array<{operation?: {edit?: {copyNodeId?: unknown}}}>}).intents)[0];
      intentCopyIds.push(intent?.operation?.edit?.copyNodeId);
      if (intentCopyIds.length === 1) return {ok: false, code: 'COPY_NODE_REQUIRED'};
      return {ok: false, code: 'SEQUENCE_EDIT_ANCHOR_CONFLICT', ids: ['ov-3']};
    },
    target,
    timeline,
    new AbortController().signal,
  );
  assert.equal(intentCopyIds.length, 2);
  assert.equal(intentCopyIds[0], undefined);
  assert.equal(typeof intentCopyIds[1], 'string');
  assert.deepEqual(res3, {conflict: true, ids: ['ov-3']});

  // 4) Success or network failure returns null silently (no throw)
  const okRes = await previewFormat5DragConflict(
    async () => ({planDigest: 'digest', envelope: {}, warnings: []}),
    target,
    timeline,
    new AbortController().signal,
  );
  assert.equal(okRes, null);

  const errRes = await previewFormat5DragConflict(
    async () => { throw new Error('network down'); },
    target,
    timeline,
    new AbortController().signal,
  );
  assert.equal(errRes, null);
});

test('A3/A4: drag conflict controller debounces 150ms, ignores repeated same-target dragover, aborts stale requests, and discards late replies', async () => {
  assert.equal(DRAG_CONFLICT_PREVIEW_DELAY_MS, 150);

  let nextTimerId = 1;
  const timers = new Map<number, {fn: () => void; ms: number}>();
  const scheduledMs: number[] = [];
  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const id = nextTimerId++;
    scheduledMs.push(ms);
    timers.set(id, {fn, ms});
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as unknown as typeof clearTimeout;
  const fireFirstTimer = () => {
    const entry = timers.entries().next().value as [number, {fn: () => void; ms: number}] | undefined;
    assert.ok(entry, 'expected a scheduled timer');
    timers.delete(entry[0]);
    entry[1].fn();
  };

  const pending: Array<{
    target: Format5DragPreviewTarget;
    signal: AbortSignal;
    resolve: (value: {conflict: true; ids: readonly string[]} | null) => void;
  }> = [];
  const states: Array<DragConflictState | null> = [];

  const controller = createDragConflictPreviewController({
    setTimeoutFn,
    clearTimeoutFn,
    preview: (target, signal) => new Promise(resolve => {
      pending.push({target, signal, resolve});
    }),
    onConflict: next => states.push(next),
  });

  const t0: Format5DragPreviewTarget = {projectId: 'p1', revision: 1, kind: 'clip', id: 'c1', trackId: 'v2', startFrame: 0};
  const t1: Format5DragPreviewTarget = {projectId: 'p1', revision: 1, kind: 'clip', id: 'c1', trackId: 'v2', startFrame: 30};
  const t2: Format5DragPreviewTarget = {projectId: 'p1', revision: 1, kind: 'clip', id: 'c1', trackId: 'v2', startFrame: 90};

  // Repeated dragover at the exact same target must NOT reschedule the 150ms timer.
  controller.update(t0);
  controller.update({...t0});
  controller.update({...t0});
  assert.deepEqual(scheduledMs, [150]);
  assert.equal(timers.size, 1);

  // Fire timer -> first preview request starts.
  fireFirstTimer();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.signal.aborted, false);

  // Move quickly to t1 (aborts t0) and then immediately to t2 before t1's debounce fires.
  controller.update(t1);
  assert.equal(pending[0]!.signal.aborted, true, 'moving to new target must abort earlier in-flight preview');
  controller.update(t2);
  assert.equal(timers.size, 1);

  // Late response from stale t0 arrives -> must be discarded (no flash!).
  pending[0]!.resolve({conflict: true, ids: ['old-blocker']});
  await Promise.resolve();
  assert.deepEqual(states, [], 'stale conflict reply must never flash');

  // Fire t2 timer and resolve with conflict -> conflict highlights t2 blockers!
  fireFirstTimer();
  assert.equal(pending.length, 2);
  assert.equal(pending[1]!.target.startFrame, 90);
  pending[1]!.resolve({conflict: true, ids: ['ov-1', 'ov-2']});
  await Promise.resolve();
  assert.equal(states.length, 1);
  const firstConflict = states[0] as DragConflictState | null;
  assert.equal(firstConflict?.key, dragPreviewTargetKey(t2));
  assert.deepEqual([...(firstConflict?.ids ?? [])], ['ov-1', 'ov-2']);

  // Leaving or changing drop target clears immediately.
  controller.clear();
  assert.equal(states.length, 2);
  assert.equal(states[1], null);

  // Dispose aborts any active request and ignores subsequent updates.
  controller.update(t0);
  fireFirstTimer();
  assert.equal(pending.length, 3);
  controller.dispose();
  assert.equal(pending[2]!.signal.aborted, true);
  pending[2]!.resolve({conflict: true, ids: ['late-after-dispose']});
  await Promise.resolve();
  assert.equal(states.length, 2);
});

test('A5/A6: Timeline wires danger drop preview & conflict clip highlighting without blocking drop, and leaves Format 3/4 untouched', () => {
  const timelineSrc = read('apps/web/src/Timeline.tsx');
  const appSrc = read('apps/web/src/App.tsx');

  // Format 3/4 does not pass onPreviewDropConflict.
  assert.match(appSrc, /onPreviewDropConflict=\{format5 \? previewFormat5DropConflict : undefined\}/);

  // Timeline marks drop preview, snap guide, and clips/subtitles using dragConflictActive while keeping drop submission intact.
  assert.match(timelineSrc, /createDragConflictPreviewController/);
  assert.match(timelineSrc, /data-conflict=\{dragConflictActive \? 'true' : undefined\}/);
  assert.match(timelineSrc, /conflictCueIds=\{effectiveConflictIds\}/);
  assert.match(timelineSrc, /effectiveConflictIds\?\.has\(clip\.id\)/);
  // Drop still depends on preview.valid (not !dragConflictActive) so releasing still submits and triggers the conflict toast.
  assert.match(timelineSrc, /const allowed = !busy && !lockedTrackIds\.has\(track\.id\) && value\?\.valid && value\.trackId === track\.id/);
});
