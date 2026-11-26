import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {readSequenceEditContext} from '../packages/business/src/sequence-edit.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';
import {translate} from '../packages/i18n/src/index.ts';
import {
  Format5EditSession,
  format5HistoryScope,
  format5TimelineHistoryState,
  format5UserUndoBlocked,
} from '../apps/web/src/edit-ui/session.ts';
import type {SequenceHistoryView, SequenceRpc} from '../apps/web/src/edit-ui/session.ts';
import {timelineHistoryState} from '../apps/web/src/timeline-history.ts';
import {timelineHistoryActionForKey, timelineSplitActionForKey} from '../apps/web/src/timeline-keyboard.ts';
import {createTimelinePlaybackClock} from '../apps/web/src/timeline-playback-clock.ts';
import {createChainWorld} from './helpers/sequence-edit-double.ts';
import type {ChainWorld} from './helpers/sequence-edit-double.ts';

const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');

const rootId = '20000000-0000-4000-8000-000000000001';
const shotA = '20000000-0000-4000-8000-000000000010';
const clipA = '20000000-0000-4000-8000-000000000020';
const versionA = '20000000-0000-4000-8000-000000000050';
const assetA = '20000000-0000-4000-8000-000000000060';

function format5World(t: test.TestContext): ChainWorld {
  return createChainWorld(t, {
    rootId,
    shots: [{id: shotA, title: '镜头 A', versionId: versionA}],
    versions: [{versionId: versionA, assetId: assetA, sha256: 'a'.repeat(64), durationSeconds: 4}],
    clips: [{nodeId: shotA, clipId: clipA, startFrame: 0, durationFrames: 120}],
    edges: [{id: '20000000-0000-4000-8000-000000000030', fromId: rootId, toId: shotA}],
  });
}

function commitSubtitle(
  chain: ChainWorld,
  service: ReturnType<typeof createFormat5SequenceEditService>,
  cue: {id: string; text: string; startFrame: number; durationFrames: number},
  origin: 'user' | 'mio',
): {status: string} {
  const preview = service.preview({
    projectId: chain.projectId,
    requestId: `${origin === 'mio' ? 'mio' : 'cli'}-${randomUUID()}`,
    origin,
    subtitlesIntent: {
      side: 'timeline',
      operation: {kind: 'subtitles', edits: [{kind: 'add', cue}]},
    },
  }) as {envelope?: unknown; planDigest?: string; ok?: boolean; code?: string};
  assert.ok(preview.envelope && preview.planDigest, `subtitle preview failed: ${JSON.stringify(preview)}`);
  return service.commit({
    projectId: chain.projectId,
    envelope: preview.envelope,
    expectedPlanDigest: preview.planDigest,
  }) as {status: string};
}

function createShortcutHarness(chain: ChainWorld, options: {
  mode?: 'editing' | 'canvas';
  projectFormatVersion?: 3 | 4 | 5;
  busy?: boolean;
  dirty?: boolean;
  online?: boolean;
  modalOpen?: boolean;
  inText?: boolean;
} = {}) {
  const service = createFormat5SequenceEditService(chain.store);
  const rpcCalls: Array<{operation: string; input: unknown}> = [];
  const rpc: SequenceRpc = async (operation, input) => {
    rpcCalls.push({operation, input});
    switch (operation) {
      case 'sequence.preview': return service.preview(input);
      case 'sequence.commit': return service.commit(input);
      case 'sequence.history.get': return service.history(input as {projectId: string});
      case 'sequence.board.get': return service.board(input as {projectId: string});
      case 'sequence.undo': return service.undo(input);
      case 'sequence.redo': return service.redo(input);
      default: throw new Error(`unexpected operation: ${operation}`);
    }
  };
  const session = new Format5EditSession(rpc, () => chain.projectId);
  let mode: 'editing' | 'canvas' = options.mode ?? 'editing';
  const projectFormatVersion = options.projectFormatVersion ?? 5;
  let format5History: SequenceHistoryView | null = null;
  let format5SessionBusy = Boolean(options.busy);
  let dirty = Boolean(options.dirty);
  let online = options.online ?? true;
  let modalOpen = Boolean(options.modalOpen);
  let inText = Boolean(options.inText);
  let legacyHistoryState = {canUndo: false, canRedo: false};
  const notifications: Array<{message: string; tone: string}> = [];
  const legacyCalls: string[] = [];

  const changeHistoryStart = appSource.indexOf('  async function format5ChangeHistory(');
  const changeHistoryEnd = appSource.indexOf('  async function format5TrackAdd(', changeHistoryStart);
  assert.ok(changeHistoryStart > 0 && changeHistoryEnd > changeHistoryStart);
  const changeHistoryCode = transformSync(appSource.slice(changeHistoryStart, changeHistoryEnd), {loader: 'ts', format: 'cjs'}).code;

  const keyStart = appSource.indexOf('    const onKeyDown = (event: KeyboardEvent) => {', appSource.indexOf('  function changeTimelineHistory('));
  const keyEnd = appSource.indexOf("    window.addEventListener('keydown', onKeyDown);", keyStart);
  assert.ok(keyStart > 0 && keyEnd > keyStart);
  const keyCode = transformSync(appSource.slice(keyStart, keyEnd), {loader: 'ts', format: 'cjs'}).code;

  const refreshHistory = async () => {
    format5History = await session.history();
    return format5History;
  };

  let pendingPromise: Promise<unknown> | null = null;

  const runFormat5ChangeHistory = (direction: 'undo' | 'redo'): Promise<unknown> => {
    const fn = Function(
      'format5', 'format5SessionBusy', 'setFormat5SessionBusy', 'format5Session', 'updateFormat5History',
      'format5UserUndoBlocked', 'notify', 't', 'notifyFormat5CommandFailure', 'clearFormat5ConflictToast',
      'setFormat5Notice', 'setFormat5NoticeActionId', 'refresh', 'currentProject', 'format5RefreshHistory', 'format5LoadBoard',
      `${changeHistoryCode}\nreturn format5ChangeHistory;`,
    )(
      projectFormatVersion === 5,
      format5SessionBusy,
      (value: boolean) => { format5SessionBusy = value; },
      () => session,
      (view: SequenceHistoryView | null) => { format5History = view; },
      format5UserUndoBlocked,
      (message: string, tone: string) => notifications.push({message, tone}),
      (key: Parameters<typeof translate>[1]) => translate('zh-Hans', key),
      (result: {code?: string}) => notifications.push({message: String(result.code ?? 'GENERIC'), tone: 'error'}),
      () => {},
      () => {},
      () => {},
      async () => {},
      {current: chain.projectId},
      refreshHistory,
      async () => {},
    ) as (dir: 'undo' | 'redo') => Promise<unknown>;
    pendingPromise = fn(direction);
    return pendingPromise;
  };

  const currentFormat5HistoryState = () => format5TimelineHistoryState({
    projectId: chain.projectId,
    history: format5History,
    busy: format5SessionBusy,
    dirty,
    online,
  });

  const pressKey = async (key: string, patch: Record<string, unknown> = {}) => {
    pendingPromise = null;
    const format5HistoryState = currentFormat5HistoryState();
    const onKeyDown = Function(
      'nativeMenuBridge', 'viewRef', 'hasOpenWorkbenchModal', 'document', 'canvasShortcutInText',
      'timelineSplitActionForKey', 'getSplitStateAt', 'playbackClock', 'effectivePlayhead',
      'splitTimelineClip', 'timelineHistoryActionForKey', 'historyState', 'format5HistoryState',
      'changeTimelineHistory', 'dataRef', 'format5Clipboard', 'format5CopyTimelineClip', 'format5PasteTimelineClip',
      `${keyCode}\nreturn onKeyDown;`,
    )(
      null,
      {current: {activeMode: mode}},
      () => modalOpen,
      {activeElement: null},
      () => inText,
      timelineSplitActionForKey,
      () => ({canSplit: false}),
      createTimelinePlaybackClock(),
      0,
      () => {},
      timelineHistoryActionForKey,
      legacyHistoryState,
      format5HistoryState,
      (direction: 'undo' | 'redo') => {
        if (projectFormatVersion === 5) return runFormat5ChangeHistory(direction);
        legacyCalls.push(direction);
        return null;
      },
      {current: {projectFormatVersion}},
      {current: null},
      () => {},
      () => {},
    ) as (event: Record<string, unknown>) => void;

    const event = {
      key,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      keyCode: 0,
      target: null,
      preventDefault() { this.defaultPrevented = true; },
      ...patch,
    };
    onKeyDown(event);
    if (pendingPromise) await pendingPromise;
    return event;
  };

  return {
    service,
    session,
    rpcCalls,
    notifications,
    legacyCalls,
    refreshHistory,
    currentFormat5HistoryState,
    runFormat5ChangeHistory,
    pressKey,
    setMode(next: 'editing' | 'canvas') { mode = next; },
    setDirty(next: boolean) { dirty = next; },
    setOnline(next: boolean) { online = next; },
    setModalOpen(next: boolean) { modalOpen = next; },
    setInText(next: boolean) { inText = next; },
    setLegacyHistoryState(next: {canUndo: boolean; canRedo: boolean}) { legacyHistoryState = next; },
    cues: () => readSequenceEditContext(chain.store).timeline.subtitles?.cues ?? [],
  };
}

test('A1: external CLI subtitle commit on format 5 is undone with Cmd+Z and redone with Shift+Cmd+Z and Ctrl+Y after refresh', async t => {
  const chain = format5World(t);
  const h = createShortcutHarness(chain, {mode: 'editing', projectFormatVersion: 5});

  // Initial state: no history yet; Cmd+Z does nothing.
  await h.refreshHistory();
  assert.equal(h.currentFormat5HistoryState().canUndo, false);
  const initialKey = await h.pressKey('z');
  assert.equal(initialKey.defaultPrevented, false);

  // External CLI commits a subtitle change (origin: user) while legacy format 3/4 historyState stays empty.
  const cueId = randomUUID();
  const receipt = commitSubtitle(chain, h.service, {
    id: cueId, text: '命令行字幕', startFrame: 15, durationFrames: 45,
  }, 'user');
  assert.equal(receipt.status, 'applied');
  assert.equal(h.cues().length, 1);

  // Periodic refresh pulls fresh sequence.history.get; shortcut uses the refreshed history, not initial snapshot.
  await h.refreshHistory();
  assert.equal(h.currentFormat5HistoryState().canUndo, true);
  assert.equal(h.currentFormat5HistoryState().canRedo, false);

  const undoEvent = await h.pressKey('z');
  assert.equal(undoEvent.defaultPrevented, true);
  assert.equal(h.cues().length, 0, 'Cmd+Z must undo the external CLI subtitle');
  assert.equal(h.rpcCalls.filter(call => call.operation === 'sequence.undo').length, 1);
  assert.equal(h.currentFormat5HistoryState().canUndo, false);
  assert.equal(h.currentFormat5HistoryState().canRedo, true);

  // Shift+Cmd+Z redoes the subtitle.
  const redoEvent = await h.pressKey('z', {shiftKey: true});
  assert.equal(redoEvent.defaultPrevented, true);
  assert.equal(h.cues().length, 1);
  assert.equal(h.cues()[0]!.text, '命令行字幕');
  assert.equal(h.rpcCalls.filter(call => call.operation === 'sequence.redo').length, 1);

  // Undo again, then Windows/Web Ctrl+Y also redoes through the unified format-5 stack.
  await h.pressKey('z', {metaKey: false, ctrlKey: true});
  assert.equal(h.cues().length, 0);
  const ctrlYEvent = await h.pressKey('y', {metaKey: false, ctrlKey: true});
  assert.equal(ctrlYEvent.defaultPrevented, true);
  assert.equal(h.cues().length, 1);
  assert.equal(h.rpcCalls.filter(call => call.operation === 'sequence.redo').length, 2);
});

test('A2 & A5: user edits in editing and canvas modes undo and redo via unified format-5 history and respect dirty/modal/text guards', async t => {
  const chain = format5World(t);
  const h = createShortcutHarness(chain, {mode: 'editing', projectFormatVersion: 5});

  // User commits a subtitle edit through Format5EditSession (same path as UI panel).
  const cueId = randomUUID();
  const outcome = await h.session.runPayload({
    subtitlesIntent: {
      side: 'timeline',
      operation: {kind: 'subtitles', edits: [{kind: 'add', cue: {id: cueId, text: '用户字幕', startFrame: 0, durationFrames: 30}}]},
    },
  });
  assert.equal(outcome.ok, true);
  await h.refreshHistory();
  assert.equal(h.cues().length, 1);

  // Dirty inspector draft blocks undo; clearing dirty enables it.
  h.setDirty(true);
  assert.equal(h.currentFormat5HistoryState().canUndo, false);
  assert.equal((await h.pressKey('z')).defaultPrevented, false);
  h.setDirty(false);

  // Switch to canvas mode: unified format-5 history still allows Cmd+Z / Shift+Cmd+Z (A5),
  // while text focus and open modals remain guarded.
  h.setMode('canvas');
  h.setInText(true);
  assert.equal((await h.pressKey('z')).defaultPrevented, false);
  h.setInText(false);
  h.setModalOpen(true);
  assert.equal((await h.pressKey('z')).defaultPrevented, false);
  h.setModalOpen(false);

  assert.equal((await h.pressKey('z')).defaultPrevented, true);
  assert.equal(h.cues().length, 0, 'format-5 canvas Cmd+Z undoes through unified history');
  assert.equal((await h.pressKey('z', {shiftKey: true})).defaultPrevented, true);
  assert.equal(h.cues().length, 1, 'format-5 canvas Shift+Cmd+Z redoes through unified history');
});

test('A3: Mio action at stack top does not undo on Cmd+Z and shows the same warning as clicking the toolbar Undo button', async t => {
  const chain = format5World(t);
  const h = createShortcutHarness(chain, {mode: 'editing', projectFormatVersion: 5});
  const expectedWarning = translate('zh-Hans', 'editUi.error.mioUndoBlocked');

  // Case 1: Fresh project where Mio makes the very first edit (0 prior user actions).
  const firstMioCue = randomUUID();
  commitSubtitle(chain, h.service, {
    id: firstMioCue, text: 'Mio 首条字幕', startFrame: 0, durationFrames: 30,
  }, 'mio');
  const firstHistory = await h.refreshHistory();
  assert.equal(format5UserUndoBlocked(firstHistory), true);
  assert.equal(h.currentFormat5HistoryState().canUndo, true);
  assert.equal(h.currentFormat5HistoryState().synced, true);

  const firstKey = await h.pressKey('z');
  assert.equal(firstKey.defaultPrevented, true);
  assert.equal(h.rpcCalls.filter(call => call.operation === 'sequence.undo').length, 0);
  assert.equal(h.cues().length, 1, 'Mio action must stay intact');
  assert.deepEqual(h.notifications.at(-1), {message: expectedWarning, tone: 'warning'});

  // Case 2: User commits an edit, then Mio commits an edit on top (undoBlockedBy === 'mio').
  commitSubtitle(chain, h.service, {
    id: randomUUID(), text: '用户字幕', startFrame: 30, durationFrames: 30,
  }, 'user');
  commitSubtitle(chain, h.service, {
    id: randomUUID(), text: 'Mio 栈顶字幕', startFrame: 60, durationFrames: 30,
  }, 'mio');
  const stackedHistory = await h.refreshHistory();
  assert.equal(stackedHistory?.undoBlockedBy, 'mio');
  assert.equal(format5UserUndoBlocked(stackedHistory), true);

  const state = h.currentFormat5HistoryState();
  assert.equal(state.synced, true, 'Mio blocking must not corrupt toolbar history into syncing state');
  assert.equal(state.canUndo, true, 'toolbar Undo button stays clickable to surface the Mio warning');

  // Pressing Cmd+Z produces the exact same warning as clicking the toolbar Undo button, with zero sequence.undo RPCs.
  const notificationsBefore = h.notifications.length;
  await h.pressKey('z');
  await h.runFormat5ChangeHistory('undo'); // toolbar Undo button click handler
  assert.equal(h.rpcCalls.filter(call => call.operation === 'sequence.undo').length, 0);
  assert.equal(h.cues().length, 3, 'neither Mio nor user subtitle is undone while Mio is on top');
  assert.deepEqual(h.notifications.slice(notificationsBefore), [
    {message: expectedWarning, tone: 'warning'},
    {message: expectedWarning, tone: 'warning'},
  ]);
});

test('A6 & floor edge case: format 3/4 shortcuts keep legacy historyState and format-5 atEarliest preserves Redo', async t => {
  const chain = format5World(t);
  for (const version of [3, 4] as const) {
    const h = createShortcutHarness(chain, {mode: 'editing', projectFormatVersion: version});
    h.setLegacyHistoryState({canUndo: true, canRedo: true});
    assert.equal((await h.pressKey('z')).defaultPrevented, true);
    assert.equal((await h.pressKey('z', {shiftKey: true})).defaultPrevented, true);
    assert.deepEqual(h.legacyCalls, ['undo', 'redo']);
    assert.equal(h.rpcCalls.length, 0, `format ${version} must never call format-5 sequence RPCs`);

    // Legacy timelineHistoryState contract remains unchanged.
    const legacyState = timelineHistoryState({
      projectId: chain.projectId,
      timeline: {id: 'tl-1', revision: 2},
      history: {
        projectId: chain.projectId, timelineId: 'tl-1', revision: 2,
        cursor: 1, length: 2, canUndo: true, canRedo: true,
        undoEntry: {id: 'u1', operation: 'timeline.subtitle.add'},
        redoEntry: {id: 'r1', operation: 'timeline.subtitle.remove'},
      },
    });
    assert.equal(legacyState.synced, true);
    assert.equal(legacyState.canUndo, true);
    assert.equal(legacyState.canRedo, true);
  }

  // Format-5 history floor (evicted oldest entries, cursor at floor - 1, atEarliest: true):
  // synced stays true so Redo remains enabled while Undo is disabled.
  const floorView: SequenceHistoryView = {
    projectId: chain.projectId,
    epoch: 'epoch-floor',
    position: 5,
    revision: 12,
    earliestPosition: 6,
    atEarliest: true,
    undo: null,
    redo: {actionId: 'action-6', operation: 'timeline.subtitle.edit', affected: 1},
    undoConflict: false,
    redoConflict: false,
    undoBlockedBy: null,
    redoBlockedBy: null,
  };
  const floorState = format5TimelineHistoryState({projectId: chain.projectId, history: floorView});
  assert.equal(floorState.synced, true);
  assert.equal(floorState.canUndo, false);
  assert.equal(floorState.canRedo, true);
  assert.equal(floorState.cursor, 5);
  assert.equal(floorState.length, 6);
  assert.notEqual(format5HistoryScope(floorView), format5HistoryScope({...floorView, revision: 13}));
});

test('App.tsx refresh keeps format5History synced on periodic 2.5s polls', () => {
  const refreshStart = appSource.indexOf('  const refresh = useCallback(async (');
  const refreshEnd = appSource.indexOf('  async function revealImageAsset(', refreshStart);
  assert.ok(refreshStart > 0 && refreshEnd > refreshStart);
  const refreshBody = appSource.slice(refreshStart, refreshEnd);
  assert.match(refreshBody, /setLastSync\(new Date\(\)\)/u);

  const effectStart = appSource.indexOf('  async function format5RefreshHistory(');
  const effectEnd = appSource.indexOf('  function format5ClipName(', effectStart);
  assert.ok(effectStart > 0 && effectEnd > effectStart);
  const effectBody = appSource.slice(effectStart, effectEnd);
  assert.match(effectBody, /format5Session\(\)\.history\(\)/u);
  assert.match(effectBody, /updateFormat5History\(/u);
  assert.match(effectBody, /\[format5,\s*data\.project\?\.id,\s*timeline\?\.id,\s*timeline\?\.revision,\s*lastSync\]/u);
});
