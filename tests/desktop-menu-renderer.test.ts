import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {createMenuCommandHost} from '../apps/desktop/src/menu-command-host.ts';
import {createMenuCommandBridge} from '../apps/desktop/src/menu-command-preload.ts';
import type {MenuCommandId, MenuCommandIntent, MenuDocumentIdentity} from '../apps/desktop/src/menu-command-protocol.ts';
import {createDesktopMenuController, readDesktopMenuBridge, workbenchMenuView, launcherMenuView, nativeMenuTextFocus, nativeMenuSpaceShortcut, nativeMenuSpaceTarget} from '../apps/web/src/desktop-menu-client.ts';
import type {WorkbenchMenuAvailability, MenuPlaybackControl} from '../apps/web/src/desktop-menu-client.ts';
import {timelineHistoryActionForKey, timelineSplitActionForKey} from '../apps/web/src/timeline-keyboard.ts';
import {timelineAudioPreviewPosition} from '../apps/web/src/use-timeline-audio-preview.ts';

const flush = async () => {for (let index = 0; index < 20; index++) await Promise.resolve();};
const availability = (patch: Partial<WorkbenchMenuAvailability> = {}): WorkbenchMenuAvailability => ({
  ready: true, visible: true, modalOpen: false, composing: false, textFocus: false, mode: 'editing',
  assetsVisible: true, inspectorVisible: true, timelineVisible: true, canImport: true, canExport: true, canChangeMode: true,
  canUndo: true, canRedo: true, canSplit: true, canRemove: true, canRippleRemove: true, canPlay: true, ...patch,
});
const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
function appFunction(name: string, next: string, bindings: Record<string, unknown>) {
  const start = appSource.indexOf(`  function ${name}(`), end = appSource.indexOf(next, start);
  assert.ok(start > 0 && end > start);
  const code = transformSync(appSource.slice(start, end), {loader: 'ts', format: 'cjs'}).code;
  return Function(...Object.keys(bindings), `${code}\nreturn ${name};`)(...Object.values(bindings)) as (...args: unknown[]) => unknown;
}

async function fixture(execute?: (command: MenuCommandId) => unknown, scopeFor?: (command: MenuCommandId) => string, readView?: () => ReturnType<typeof workbenchMenuView>) {
  const identity: MenuDocumentIdentity = {version: 1, windowId: crypto.randomUUID(), backendId: crypto.randomUUID(), contextId: crypto.randomUUID(), role: 'editor'};
  const frame = {}, contents = {}, listeners = new Set<(event: unknown, value: unknown) => void>(), actions: MenuCommandId[] = [], sent: MenuCommandIntent[] = [];
  let snapshot = availability(), current = true, allowed = true, held = false, scope = 'initial';
  const queued: MenuCommandIntent[] = [];
  const document = {...identity, frame, isCurrent: () => current};
  const host = createMenuCommandHost({getDocument: () => current ? document : null, isAllowed: () => allowed,
    send: (_owner, intent) => {sent.push(intent); if (held) queued.push(intent); else for (const listener of listeners) listener({}, intent);}});
  const preload = createMenuCommandBridge({invoke: async (_channel, request) => host.dispatch({sender: contents, senderFrame: frame}, request),
    on: (_channel, listener) => {listeners.add(listener);}, removeListener: (_channel, listener) => {listeners.delete(listener);}});
  const bridge = readDesktopMenuBridge({__mioonMenuCommands: preload}); assert.ok(bridge);
  const controller = createDesktopMenuController({bridge, identity, read: () => readView ? readView() : workbenchMenuView(snapshot), current: () => current, scope: command => scopeFor ? scopeFor(command) : scope,
    execute: command => {actions.push(command); return execute?.(command);}});
  assert.equal(await controller.start, true); await flush();
  return {host, controller, bridge, identity, contents, actions, sent,
    state: () => host.stateFor(contents),
    set(patch: Partial<WorkbenchMenuAvailability>, publish = true) {snapshot = {...snapshot, ...patch}; if (publish) controller.refresh();},
    setCurrent(value: boolean) {current = value;}, setAllowed(value: boolean) {allowed = value;},
    setScope(value: string, publish = true) {scope = value; if (publish) controller.refresh();},
    holdMessages(value = true) {held = value;}, deliver() {held = false; for (const intent of queued.splice(0)) for (const listener of listeners) listener({}, intent);},
    emit(value: unknown) {for (const listener of listeners) listener({}, value);},
    dispose() {controller.dispose(); host.dispose();},
  };
}

test('real host, preload and web controller dispatch one fixed command once and reject foreign or replayed events', async () => {
  const f = await fixture();
  try {
    assert.equal(f.host.send(f.contents, 'clip-split'), true); assert.deepEqual(f.actions, ['clip-split']);
    const event = f.sent[0]; f.emit(event); f.emit({...event, sequence: event.sequence + 1, contextId: crypto.randomUUID()});
    f.emit({...event, sequence: event.sequence + 2, command: 'generation.submit'}); f.emit({...event, sequence: event.sequence + 3, input: {path: '/private/synthetic'}});
    assert.deepEqual(f.actions, ['clip-split']);
    f.setCurrent(false); f.emit({...event, sequence: event.sequence + 4}); assert.deepEqual(f.actions, ['clip-split']);
    assert.equal(f.host.send(f.contents, 'export'), false);
  } finally {f.dispose();}
});

test('cached native availability cannot execute after a modal, IME, hidden document or project readiness changes', async () => {
  for (const patch of [{modalOpen: true}, {composing: true}, {visible: false}, {ready: false}] as const) {
    const f = await fixture();
    try {
      f.set(patch, false); assert.equal(f.host.send(f.contents, 'export'), true, 'host still has the old display hint');
      assert.deepEqual(f.actions, []); const denied = f.sent.at(-1)!;
      f.set(availability()); await flush(); f.emit(denied); assert.deepEqual(f.actions, [], 'a denied sequence stays consumed after the guard clears');
      assert.equal(f.host.send(f.contents, 'export'), true); assert.deepEqual(f.actions, ['export']);
    } finally {f.dispose();}
  }
});

test('text editing keeps timeline mutations and playback unavailable while contextual view commands remain usable', async () => {
  const f = await fixture();
  try {
    f.set({textFocus: true}); await flush();
    assert.equal(f.state()?.editingContext, 'text');
    for (const command of ['edit-undo', 'edit-redo', 'clip-split', 'clip-remove', 'clip-ripple-remove', 'playback-toggle'] as const) assert.equal(f.host.send(f.contents, command), false);
    assert.equal(f.host.send(f.contents, 'show-help'), true); assert.deepEqual(f.actions, ['show-help']);
    f.set({textFocus: false, mode: 'canvas'}); await flush();
    assert.equal(f.state()?.workspaceMode, 'canvas'); assert.equal(f.host.send(f.contents, 'clip-split'), false); assert.equal(f.host.send(f.contents, 'toggle-timeline'), false);
    assert.equal(f.host.send(f.contents, 'workspace-editing'), true);
    f.controller.dispose(); f.emit({...f.sent.at(-1)!, sequence: 1000}); assert.deepEqual(f.actions, ['show-help', 'workspace-editing']);
  } finally {f.dispose();}
});

test('canvas Undo is opt-in and never exposes timeline Redo or text-field mutations', () => {
  assert.equal(workbenchMenuView(availability({mode: 'canvas'})).commands['edit-undo'], false);
  const canvas = availability({mode: 'canvas', canUndoCanvas: true});
  assert.equal(workbenchMenuView(canvas).editingContext, 'none');
  assert.equal(workbenchMenuView(canvas).commands['edit-undo'], true);
  assert.equal(workbenchMenuView(canvas).commands['edit-redo'], false);
  for (const patch of [{textFocus: true}, {modalOpen: true}, {visible: false}, {composing: true}, {ready: false}, {canUndoCanvas: false}]) {
    assert.equal(workbenchMenuView({...canvas, ...patch}).commands['edit-undo'], false);
  }
});

function canvasStoryboardApp() {
  const view = {current: {activeMode: 'canvas', editing: {selectedClipId: null, timelineCollapsed: false, playhead: 0, quickAssetId: null, previewKind: 'source'}}};
  const toast = {current: {value: {projectId: 'project', taskId: 'batch-a', count: 1} as {projectId: string; taskId: string; count: number} | null, version: 1}};
  const scene = {projectId: 'project', phase: 'idle', readOnly: false, pending: null as unknown,
    tasks: ['batch-a', 'batch-b'].map(id => ({id, projectId: 'project', kind: 'shots', revision: 1, state: 'succeeded', shots: [{shotId: `shot-${id}`}]})),
    undo: Object.fromEntries(['batch-a', 'batch-b'].map(id => [id, {phase: 'ready', revision: 1, undo: {available: true, blockers: [] as unknown[]}}]))};
  const document = {visibilityState: 'visible', activeElement: null as unknown}, calls: string[] = [];
  const bindings: Record<string, unknown> = {
    viewRef: view, importSession: {current: {active: true}}, workbenchReady: true, currentProject: {current: 'project'},
    dataRef: {current: {project: {id: 'project'}, timeline: {id: 'timeline', revision: 1, clips: []}}},
    clipDraftRef: {current: null}, trackLocksRef: {current: {}}, document, webSettingsOpen: false, nativeWindow: {context: {settingsModalOpen: false}},
    hasOpenWorkbenchModal: () => false, comparisonId: null, sceneTarget: null, nativeMenuComposing: {current: false}, nativeMenuTextFocus,
    assetsCollapsed: false, inspectorCollapsed: false, application: null, opacityRestored: false, isBusy: () => false, online: true, auth: true,
    canOpenExport: false, historyState: {canUndo: true, canRedo: true}, splitState: {canSplit: false},
    menuRemoval: {current: null}, menuPlayback: {current: null}, workbenchMenuView,
    storyboardToastLifetime: toast, toastBlocked: false, scenes: {controller: {getState: () => scene}},
    projectEpoch: {current: 1}, navigationEpoch: {current: 1}, panelIntent: {current: 1},
    propertiesPage: 'inspector', menuPlaybackEpoch: {current: 1}, menuRemovalEpoch: {current: 1},
    audioPreview: {state: {plan: null, continuousPlan: null, phase: 'idle', positionFrame: null}}, timelineAudioPreviewPosition,
  };
  const read = () => appFunction('readNativeMenuView', '  function executeNativeMenuCommand(', bindings)() as ReturnType<typeof workbenchMenuView>;
  const scope = (command: MenuCommandId) => appFunction('nativeMenuScope', '  function executeNativeMenuCommand(', bindings)(command) as string;
  const execute = (command: MenuCommandId) => appFunction('executeNativeMenuCommand', '  nativeMenuActions.current', {...bindings,
    readNativeMenuView: read, undoStoryboard: (taskId: string) => calls.push(taskId), changeTimelineHistory: () => assert.fail('Canvas must not mutate timeline history'),
  })(command);
  return {read, scope, execute, bindings, scene, toast, document, calls,
    show(taskId: string | null) {toast.current = {value: taskId ? {projectId: 'project', taskId, count: 1} : null, version: toast.current.version + 1};}};
}

test('actual canvas App dispatches one batch undo through host/preload and never mutates timeline history', async () => {
  const app = canvasStoryboardApp(), f = await fixture(app.execute, app.scope, app.read);
  try {
    assert.equal(f.state()?.editingContext, 'none'); assert.equal(f.host.send(f.contents, 'edit-redo'), false);
    assert.equal(f.host.send(f.contents, 'edit-undo'), true); f.emit(f.sent[0]);
    assert.deepEqual(app.calls, ['batch-a']); assert.deepEqual(f.actions, ['edit-undo']);
    assert.doesNotMatch(JSON.stringify([f.state(), f.sent]), /batch-a|shot-batch-a|"timeline"/);
    app.show('batch-b'); f.controller.refresh(); await flush();
    assert.equal(f.host.send(f.contents, 'edit-undo'), true); assert.deepEqual(app.calls, ['batch-a', 'batch-b']);
  } finally {f.dispose();}
});

for (const change of ['batch', 'revision', 'proof', 'lifetime', 'closed', 'terminal', 'pending', 'text', 'modal'] as const) test(`a delayed canvas undo cannot cross a ${change} change`, async () => {
  const app = canvasStoryboardApp(), f = await fixture(app.execute, app.scope, app.read);
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, 'edit-undo'), true);
    if (change === 'batch') app.show('batch-b');
    if (change === 'revision') app.scene.tasks[0].revision++;
    if (change === 'proof') app.scene.undo['batch-a'].revision++;
    if (change === 'lifetime') app.show('batch-a');
    if (change === 'closed') app.show(null);
    if (change === 'terminal') app.scene.tasks[0].state = 'undone';
    if (change === 'pending') {app.scene.phase = 'submitting'; app.scene.pending = {};}
    if (change === 'text') app.document.activeElement = {closest: () => ({})};
    if (change === 'modal') app.bindings.webSettingsOpen = true;
    // Simulate an intent arriving before the changed display report reaches main.
    f.deliver(); assert.deepEqual(app.calls, []); assert.deepEqual(f.actions, []);
  } finally {f.dispose();}
});

test('actual canvas availability requires the current project, live batch and unblocked undo proof', () => {
  const app = canvasStoryboardApp(); assert.equal(app.read().commands['edit-undo'], true);
  for (const key of ['toastBlocked', 'webSettingsOpen', 'application']) {
    app.bindings[key] = true; assert.equal(app.read().commands['edit-undo'], false); app.bindings[key] = key === 'application' ? null : false;
  }
  app.bindings.online = false; assert.equal(app.read().commands['edit-undo'], false); app.bindings.online = true;
  app.scene.readOnly = true; assert.equal(app.read().commands['edit-undo'], false); app.scene.readOnly = false;
  app.scene.undo['batch-a'].undo.available = false; assert.equal(app.read().commands['edit-undo'], false); app.scene.undo['batch-a'].undo.available = true;
  app.scene.projectId = 'other-project'; assert.equal(app.read().commands['edit-undo'], false); app.scene.projectId = 'project';
  app.toast.current.value!.projectId = 'other-project'; assert.equal(app.read().commands['edit-undo'], false);
});

test('desktop canvas shortcuts have one native owner while Web retains the storyboard key handler', () => {
  const start = appSource.indexOf('  useEffect(() => {', appSource.indexOf('  // ⌘Z / Ctrl+Z undoes the storyboard'));
  const end = appSource.indexOf('  const storyboardPanel', start); assert.ok(start > 0 && end > start);
  const code = transformSync(appSource.slice(start, end), {loader: 'ts', format: 'cjs'}).code;
  const calls: string[] = [];
  for (const desktop of [true, false]) {
    const listeners = new Map<string, (event: unknown) => void>(); let cleanup: unknown;
    Function('useEffect', 'storyboardToast', 'nativeMenuBridge', 'workspaceMode', 'toastBlocked', 'timelineHistoryActionForKey', 'hasOpenWorkbenchModal', 'document', 'undoStoryboard', 'window', code)(
      (effect: () => unknown) => {cleanup = effect();}, {taskId: 'batch-a'}, desktop ? {} : null, 'canvas', false,
      timelineHistoryActionForKey, () => false, {}, (id: string) => calls.push(id),
      {addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name)},
    );
    assert.equal(listeners.size, desktop ? 0 : 1);
    const event = {key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, isComposing: false, keyCode: 0, target: null, preventDefault() {this.defaultPrevented = true;}};
    listeners.get('keydown')?.(event);
    if (typeof cleanup === 'function') cleanup();
    assert.equal(listeners.size, 0);
  }
  assert.deepEqual(calls, ['batch-a']);
});

test('remounting a menu consumer in the same document publishes after its prior accepted state', async () => {
  const f = await fixture();
  try {
    f.set({canSplit: false}); await flush(); const previous = f.state()!.reportVersion;
    f.controller.dispose();
    const next = createDesktopMenuController({bridge: f.bridge, identity: f.identity, current: () => true,
      read: () => workbenchMenuView(availability({canExport: false})), execute: command => {f.actions.push(command);}});
    try {
      assert.equal(await next.start, true); await flush();
      assert.ok(f.state()!.reportVersion > previous); assert.equal(f.host.send(f.contents, 'export'), false);
      assert.equal(f.host.send(f.contents, 'clip-split'), true); assert.deepEqual(f.actions, ['clip-split']);
    } finally {next.dispose();}
  } finally {f.dispose();}
});

for (const command of ['clip-split', 'playback-toggle'] as const) for (const publish of [false, true]) test(`a delayed ${command} cannot act on a new local selection even when availability stays identical (publish=${publish})`, async () => {
  let selected = 'old-clip'; const targets: string[] = [], f = await fixture(() => targets.push(selected));
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, command), true);
    const before = f.state()!.reportVersion; selected = 'new-clip'; f.setScope('new-clip:revision:10:frame:40', publish);
    if (publish) {await flush(); assert.ok(f.state()!.reportVersion > before, 'a semantic owner change publishes despite identical booleans');}
    f.deliver(); assert.deepEqual(targets, [], 'old intent cannot inherit the newly selected clip');
    f.controller.refresh(); await flush(); assert.equal(f.host.send(f.contents, command), true); assert.deepEqual(targets, ['new-clip']);
    assert.doesNotMatch(JSON.stringify([f.state(), f.sent]), /new-clip|old-clip|revision:10/, 'local target scope never crosses the bridge');
  } finally {f.dispose();}
});

function actualAppScope() {
  const view = {current: {activeMode: 'editing', canvas: {selectedId: null}, editing: {selectedClipId: 'clip-a', quickAssetId: null, previewKind: 'source', playhead: 60}}};
  const data = {current: {timeline: {id: 'timeline-a', revision: 1, clips: [{id: 'clip-a', sourceInFrame: 0, startFrame: 0, durationFrames: 300}]}}}, epoch = {current: 1}, removalEpoch = {current: 1}; let media = 'media-a';
  const audioPreview = {state: {plan: null, continuousPlan: null, phase: 'idle', positionFrame: null}} as Parameters<typeof timelineAudioPreviewPosition>[0];
  const scope = appFunction('nativeMenuScope', '  function executeNativeMenuCommand(', {
    viewRef: view, dataRef: data, currentProject: {current: 'project-a'}, projectEpoch: {current: 1}, navigationEpoch: {current: 1}, panelIntent: {current: 1},
    propertiesPage: 'inspector', menuPlaybackEpoch: epoch, menuRemovalEpoch: removalEpoch, audioPreview, timelineAudioPreviewPosition,
    menuPlayback: {current: {scope: () => media}},
  }) as (command?: MenuCommandId) => string;
  return {scope, view, data, epoch, removalEpoch, audioPreview, changeMedia(value: string) {media = value;}};
}

for (const command of ['playback-toggle', 'import-media', 'show-help', 'toggle-assets', 'clip-remove', 'edit-undo'] as const) test(`passive playback progress cannot discard a normal ${command} on the unchanged target`, async () => {
  const app = actualAppScope(), f = await fixture(undefined, app.scope);
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, command), true);
    app.view.current.editing.playhead++; f.controller.refresh(); await flush();
    f.deliver(); assert.deepEqual(f.actions, [command]);
  } finally {f.dispose();}
});

test('a delayed split stays bound to its original frame even when passive playback is allowed to continue', async () => {
  const app = actualAppScope(), f = await fixture(undefined, app.scope);
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, 'clip-split'), true);
    app.view.current.editing.playhead++; f.controller.refresh(); await flush(); f.deliver(); assert.deepEqual(f.actions, []);
    assert.equal(f.host.send(f.contents, 'clip-split'), true); assert.deepEqual(f.actions, ['clip-split']);
  } finally {f.dispose();}
});

for (const command of ['clip-split', 'playback-toggle', 'import-media'] as const) for (const publish of [false, true]) test(`effective audio-preview frame owns delayed ${command} independently of the saved playhead (publish=${publish})`, async () => {
  const app = actualAppScope(), frames: number[] = [];
  app.audioPreview.state.phase = 'preparing'; app.audioPreview.state.positionFrame = 60;
  const f = await fixture(() => frames.push(timelineAudioPreviewPosition(app.audioPreview, app.view.current.editing.playhead)), app.scope);
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, command), true);
    app.audioPreview.state.positionFrame = 61;
    assert.equal(app.view.current.editing.playhead, 60, 'audio progress does not rewrite the saved playhead');
    if (publish) {f.controller.refresh(); await flush();}
    f.deliver();
    assert.deepEqual(frames, command === 'clip-split' ? [] : [61], 'only split is bound to the effective frame');
    f.controller.refresh(); await flush(); assert.equal(f.host.send(f.contents, command), true);
    assert.deepEqual(frames, command === 'clip-split' ? [61] : [61, 61]);
  } finally {f.dispose();}
});

for (const change of ['selection', 'media', 'revision', 'track-lock', 'modal'] as const) test(`old menu intent cannot revive after ${change} changes away and returns`, async () => {
  const app = actualAppScope(), command = change === 'media' || change === 'modal' ? 'playback-toggle' : change === 'revision' ? 'edit-undo' : 'clip-split';
  const f = await fixture(undefined, app.scope);
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, command), true);
    if (change === 'selection') app.view.current.editing.selectedClipId = 'clip-b';
    if (change === 'media') app.changeMedia('media-b');
    if (change === 'revision') app.data.current.timeline.revision++;
    if (change === 'track-lock') f.set({canSplit: false});
    if (change === 'modal') f.set({modalOpen: true});
    f.controller.refresh(); await flush();
    if (change === 'selection') app.view.current.editing.selectedClipId = 'clip-a';
    if (change === 'media') app.changeMedia('media-a');
    if (change === 'revision') app.data.current.timeline.revision--;
    if (change === 'track-lock') f.set({canSplit: true});
    if (change === 'modal') f.set({modalOpen: false});
    f.controller.refresh(); await flush(); f.deliver(); assert.deepEqual(f.actions, []);
    const old = f.sent[0]; f.emit(old); assert.deepEqual(f.actions, []);
    assert.equal(f.host.send(f.contents, command), true); f.emit(f.sent.at(-1)); assert.deepEqual(f.actions, [command]);
  } finally {f.dispose();}
});

test('missing local report snapshots reject old intents after bounded playback updates without retry', async () => {
  const app = actualAppScope(), f = await fixture(undefined, app.scope);
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, 'playback-toggle'), true);
    for (let index = 0; index < 70; index++) {app.view.current.editing.playhead++; f.controller.refresh(); await flush();}
    f.deliver(); assert.deepEqual(f.actions, [], 'the evicted report cannot mint an unbounded late action');
    assert.equal(f.host.send(f.contents, 'playback-toggle'), true); assert.deepEqual(f.actions, ['playback-toggle']);
  } finally {f.dispose();}
});

test('actual App menu routing opens the existing export review and import picker without rendering or generating', async () => {
  const calls: unknown[] = [], data = {composing: false};
  const openTimelineExport = appFunction('openTimelineExport', '  const historyState', {
    clipDraftRef: {current: {hasPendingComposition: () => data.composing}}, markPanelIntent: () => calls.push('intent'),
    setShowTasks: (value: unknown) => calls.push(['tasks', value]), setShowImage: (value: unknown) => calls.push(['image', value]),
    setShowExports: (value: unknown) => calls.push(['history', value]), setShowDelivery: (value: unknown) => calls.push(['review', value]),
    exportPreflight: {controller: {setVisible: (value: unknown) => calls.push(['review-visible', value])}},
  });
  const snapshot = availability();
  const execute = appFunction('executeNativeMenuCommand', '  nativeMenuActions.current', {
    readNativeMenuView: () => workbenchMenuView(snapshot), fileInput: {current: {click: () => calls.push('picker')}}, openTimelineExport,
    changeMode: (mode: unknown) => calls.push(['mode', mode]), setPanelOpen: (panel: unknown, open: unknown) => calls.push([panel, open]),
    assetsCollapsed: false, inspectorCollapsed: true, toggleTimelinePanel: () => calls.push('timeline-panel'), openTasks: () => calls.push('tasks'),
    setShowGuide: (value: unknown) => calls.push(['guide', value]), changeTimelineHistory: (direction: unknown) => calls.push(['history-action', direction]),
    splitTimelineClip: () => calls.push('split'), menuRemoval: {current: {request: (mode: unknown) => calls.push(['confirm-removal', mode])}},
    menuPlayback: {current: {toggle: () => calls.push('toggle-current-media')}},
  });
  const f = await fixture(command => execute(command));
  try {
    assert.equal(f.host.send(f.contents, 'export'), true);
    assert.deepEqual(calls, ['intent', ['tasks', false], ['image', false], ['history', false], ['review', true], ['review-visible', true]]);
    f.host.send(f.contents, 'import-media'); assert.equal(calls.at(-1), 'picker');
    f.host.send(f.contents, 'clip-remove'); f.host.send(f.contents, 'clip-ripple-remove');
    assert.deepEqual(calls.slice(-2), [['confirm-removal', 'remove'], ['confirm-removal', 'ripple']]);
    f.host.send(f.contents, 'playback-toggle'); assert.equal(calls.at(-1), 'toggle-current-media');
    snapshot.composing = true; const before = calls.length; execute('clip-split'); assert.equal(calls.length, before);
    assert.ok(!calls.some(value => typeof value === 'string' && /render|generate|rpc/.test(value)));
  } finally {f.dispose();}
});

test('actual App availability retains live candidate import and follows restored mode, text focus and track locks', () => {
  const trackLocks = {current: {project: [] as string[]}}, document = {visibilityState: 'visible', activeElement: null as unknown};
  const bindings = {
    viewRef: {current: {activeMode: 'editing', editing: {selectedClipId: 'clip', timelineCollapsed: false}}},
    importSession: {current: {active: true}}, workbenchReady: true, currentProject: {current: 'project'},
    dataRef: {current: {project: {id: 'project'}, timeline: {clips: [{id: 'clip', trackId: 'track'}]}}}, clipDraftRef: {current: null}, trackLocksRef: trackLocks,
    document, webSettingsOpen: false, nativeWindow: {context: {settingsModalOpen: false}}, hasOpenWorkbenchModal: () => false,
    comparisonId: null, sceneTarget: null, nativeMenuComposing: {current: false}, nativeMenuTextFocus,
    assetsCollapsed: false, inspectorCollapsed: false, application: {isRestoredWorkspace: () => false} as object | null, opacityRestored: false,
    isBusy: () => false, online: true, auth: true, canOpenExport: true, historyState: {canUndo: true, canRedo: true}, splitState: {canSplit: true},
    menuRemoval: {current: {available: () => true}}, menuPlayback: {current: {available: () => true}}, workbenchMenuView,
  };
  const read = () => appFunction('readNativeMenuView', '  function executeNativeMenuCommand(', bindings)() as ReturnType<typeof workbenchMenuView>;
  assert.equal(read().commands['import-media'], true, 'Live candidate workspaces retain the existing import capability');
  bindings.opacityRestored = true; assert.equal(read().commands['import-media'], false); bindings.opacityRestored = false;
  trackLocks.current.project.push('track'); assert.equal(read().commands['clip-split'], false); assert.equal(read().commands['edit-undo'], false);
  trackLocks.current.project.length = 0; bindings.application = null; assert.equal(read().commands['clip-split'], true);
  document.activeElement = {closest: () => ({})}; assert.equal(read().editingContext, 'text'); assert.equal(read().commands['clip-split'], false); assert.equal(read().commands['playback-toggle'], false);
});

test('actual App scopes bind each command to its relevant owner without exporting business targets', () => {
  const app = actualAppScope(), capture = () => Object.fromEntries(['clip-split', 'playback-toggle', 'clip-remove', 'edit-undo', 'import-media', 'show-help'].map(command => [command, app.scope(command as MenuCommandId)]));
  let before = capture(); app.view.current.editing.playhead++; let after = capture();
  assert.notEqual(after['clip-split'], before['clip-split']);
  for (const command of ['playback-toggle', 'clip-remove', 'edit-undo', 'import-media', 'show-help']) assert.equal(after[command], before[command]);
  before = after; app.data.current.timeline.revision++; after = capture();
  for (const command of ['clip-split', 'clip-remove', 'edit-undo']) assert.notEqual(after[command], before[command]);
  assert.equal(after['playback-toggle'], before['playback-toggle']);
  before = after; app.changeMedia('media-b'); after = capture(); assert.notEqual(after['playback-toggle'], before['playback-toggle']); assert.equal(after['clip-split'], before['clip-split']);
  before = after; app.epoch.current++; after = capture(); assert.notEqual(after['playback-toggle'], before['playback-toggle']); assert.equal(after['clip-remove'], before['clip-remove']);
  before = after; app.removalEpoch.current++; after = capture(); assert.notEqual(after['clip-remove'], before['clip-remove']); assert.equal(after['playback-toggle'], before['playback-toggle']);
  before = after; app.view.current.editing.selectedClipId = 'clip-b'; after = capture();
  for (const command of ['clip-split', 'clip-remove', 'playback-toggle']) assert.notEqual(after[command], before[command]);
});

test('DOM focus and Space guards preserve text, IME and native button activation', () => {
  const text = {closest: (selector: string) => selector.includes('input') ? {} : null};
  assert.equal(nativeMenuTextFocus(text), true); assert.equal(nativeMenuTextFocus({shadowRoot: {activeElement: text}}), true);
  assert.equal(nativeMenuSpaceTarget({closest: (selector: string) => selector.startsWith('button') ? {} : null}), true);
  assert.equal(nativeMenuSpaceTarget({closest: () => null}), false);
  for (const patch of [{repeat: true}, {defaultPrevented: true}, {isComposing: true}, {keyCode: 229}, {metaKey: true}, {ctrlKey: true}, {shiftKey: true}, {altKey: true}]) assert.equal(nativeMenuSpaceShortcut({key: ' ', ...patch}, false), false);
  assert.equal(nativeMenuSpaceShortcut({key: ' '}, true), false); assert.equal(nativeMenuSpaceShortcut({key: ' '}, false), true);
});

test('actual App keyboard routing leaves desktop accelerators single-owned, retains Web keys and Windows Ctrl+Y', () => {
  const start = appSource.indexOf('    const onKeyDown = (event: KeyboardEvent) => {', appSource.indexOf('  function changeTimelineHistory('));
  const end = appSource.indexOf("    window.addEventListener('keydown', onKeyDown)", start);
  assert.ok(start > 0 && end > start);
  const code = transformSync(appSource.slice(start, end), {loader: 'ts', format: 'cjs'}).code;
  const calls: string[] = [], doc = {modal: false};
  const keyboard = (desktop: boolean) => Function('nativeMenuBridge', 'viewRef', 'hasOpenWorkbenchModal', 'document', 'application', 'timelineSplitActionForKey', 'splitState', 'splitTimelineClip', 'timelineHistoryActionForKey', 'historyState', 'changeTimelineHistory', `${code};return onKeyDown;`)(
    desktop ? {} : null, {current: {activeMode: 'editing'}}, () => doc.modal, {}, false, timelineSplitActionForKey, {canSplit: true}, () => calls.push('split'), timelineHistoryActionForKey,
    {canUndo: true, canRedo: true}, (direction: string) => calls.push(direction),
  ) as (event: unknown) => void;
  const event = (key: string, patch = {}) => ({key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, isComposing: false, keyCode: 0, target: null, preventDefault() {this.defaultPrevented = true;}, ...patch});
  const desktop = keyboard(true); desktop(event('z')); desktop(event('z', {shiftKey: true})); desktop(event('b')); assert.deepEqual(calls, []);
  desktop(event('y')); assert.deepEqual(calls, ['redo']);
  const web = keyboard(false); web(event('z')); web(event('b')); assert.deepEqual(calls, ['redo', 'undo', 'split']);
  web(event('z', {isComposing: true})); web(event('b', {target: {closest: () => ({})}}));
  doc.modal = true; web(event('z')); assert.deepEqual(calls, ['redo', 'undo', 'split']);
});

test('absent bridges remain Web and malformed desktop bridges never become a usable transport', async () => {
  assert.equal(readDesktopMenuBridge({}), null);
  assert.throws(() => readDesktopMenuBridge({__mioonMenuCommands: {}}));
  const bridge = readDesktopMenuBridge({__mioonMenuCommands: {context: async () => ({url: 'https://synthetic.invalid/'}), publish: async () => true, subscribe: () => () => {}}});
  assert.ok(bridge); await assert.rejects(bridge.context());
});

test('actual empty launcher menu state needs no project or model and never opens Help behind an editor or pending draft', () => {
  const source = readFileSync(new URL('../apps/web/src/LauncherRoot.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('    const read = () => {'), end = source.indexOf('    const session =', start); assert.ok(start > 0 && end > start);
  const code = transformSync(source.slice(start, end), {loader: 'ts', format: 'cjs'}).code;
  const context = {quitting: false, settingsModalOpen: false, editorCount: 0}, state = {shown: true, phase: 'home', creating: false, sealed: false, createUnknown: false, openUnknown: false};
  const close = {dirty: false, busy: false, unknown: false}, doc = {visibilityState: 'visible', activeElement: null}, mounted = {current: true};
  let modal = false, canHelp = true;
  const read = Function('controller', 'mounted', 'document', 'hasOpenWorkbenchModal', 'composing', 'nativeMenuTextFocus', 'menuHelp', 'launcherMenuView', `${code};return read;`)(
    {getContext: () => context, getState: () => state, readCloseSnapshot: () => close}, mounted, doc, () => modal,
    {current: false}, nativeMenuTextFocus, {current: {available: () => canHelp}}, launcherMenuView,
  ) as () => ReturnType<typeof launcherMenuView>;
  assert.equal(read().commands['show-help'], true); assert.equal(Object.values(read().commands).filter(Boolean).length, 1);
  for (const target of [context, state, close]) {
    const key = target === context ? 'quitting' : target === state ? 'sealed' : 'dirty';
    Reflect.set(target, key, true); assert.equal(read().commands['show-help'], false); Reflect.set(target, key, false);
  }
  context.editorCount = 1; assert.equal(read().commands['show-help'], false); context.editorCount = 0;
  doc.visibilityState = 'hidden'; assert.equal(read().commands['show-help'], false); doc.visibilityState = 'visible';
  modal = true; assert.equal(read().commands['show-help'], false); modal = false;
  canHelp = false; assert.equal(read().commands['show-help'], false); canHelp = true;
  state.createUnknown = true; assert.equal(read().commands['show-help'], false); state.createUnknown = false;
  mounted.current = false; assert.equal(read().commands['show-help'], false);
});

interface HookSlot {current?: unknown; value?: unknown; deps?: readonly unknown[]; cleanup?: () => void}
interface PlaybackProps {
  bindingKey: string; getMedia(): unknown; isCurrent(media: unknown): boolean;
  onRegisterMenuPlayback(control: MenuPlaybackControl): () => void; onMenuStateChange(): void;
}
function playbackControls() {
  const slots: HookSlot[] = [], effects: (() => void)[] = []; let index = 0;
  const effect = (callback: () => (() => void) | void, deps: readonly unknown[]) => {
    const id = index++, previous = slots[id];
    if (previous && deps.every((value, offset) => Object.is(value, previous.deps?.[offset]))) return;
    slots[id] = {deps}; effects.push(() => {previous?.cleanup?.(); slots[id].cleanup = callback() || undefined;});
  };
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({type, props: {...props, children}}),
    useRef: (value: unknown) => slots[index++] ||= {current: value},
    useState: (value: unknown) => {const id = index++; slots[id] ||= {value}; return [slots[id].value, (next: unknown) => {slots[id].value = next;}];},
    useEffect: effect, useLayoutEffect: effect,
  };
  const module = {exports: {} as {default(props: PlaybackProps): unknown}};
  const code = transformSync(readFileSync(new URL('../apps/web/src/PreviewPlaybackControls.tsx', import.meta.url), 'utf8'), {loader: 'tsx', format: 'cjs'}).code;
  Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'react') return {...react, default: react};
    if (name.includes('I18nProvider')) return {useI18n: () => ({t: (key: string) => key})};
    if (name === './timeline-removal.ts') return {displayTimelineFrame: String};
    if (name.startsWith('@mioon/ui/components/')) return new Proxy({}, {get: (_target, key) => String(key)});
    assert.fail(`Unexpected playback control dependency ${name}`);
  }, module, module.exports);
  return {render(props: PlaybackProps) {index = 0; const result = module.exports.default(props); while (effects.length) effects.shift()?.(); return result;},
    dispose() {for (const slot of slots) slot?.cleanup?.();}};
}

function renderedPlaybackButton(tree: unknown): {onClick(): unknown} {
  const nodes = (value: unknown): {props: Record<string, unknown>}[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' && 'props' in value
    ? [value as {props: Record<string, unknown>}, ...nodes((value as {props: Record<string, unknown>}).props.children)] : [];
  const button = nodes(tree).find(node => node.props['data-testid'] === 'preview-play-pause'); assert.ok(button);
  return button.props as {onClick(): unknown};
}

for (const change of ['button-pause', 'natural-ended', 'pending-button-play'] as const) test(`real control and native bridge cannot revive an old playback toggle after ${change}`, async () => {
  const controls = playbackControls(), listeners = new Map<string, () => void>(), pending = Promise.withResolvers<void>();
  let plays = 0, pauses = 0, registered: MenuPlaybackControl | null = null, refresh = () => {};
  const media = {readyState: 1, paused: change === 'pending-button-play', ended: false,
    async play() {plays++; if (change === 'pending-button-play') await pending.promise; this.paused = false; this.ended = false; listeners.get('play')?.();},
    pause() {pauses++; this.paused = true; listeners.get('pause')?.();},
    addEventListener(name: string, update: () => void) {listeners.set(name, update);}, removeEventListener(name: string) {listeners.delete(name);}};
  const tree = controls.render({bindingKey: 'same-project:same-media:visible', getMedia: () => media, isCurrent: () => true,
    onRegisterMenuPlayback: control => {registered = control; return () => {registered = null;}}, onMenuStateChange: () => refresh()});
  assert.ok(registered); const control = registered as MenuPlaybackControl;
  const f = await fixture(command => command === 'playback-toggle' ? control.toggle() : undefined, command => command === 'playback-toggle' ? control.scope!() : 'same-target');
  refresh = () => f.controller.refresh();
  try {
    f.holdMessages(); assert.equal(f.host.send(f.contents, 'playback-toggle'), true);
    if (change === 'natural-ended') {media.paused = true; media.ended = true; listeners.get('ended')?.();}
    else renderedPlaybackButton(tree).onClick();
    await flush(); f.deliver(); await flush();
    assert.equal(plays, change === 'pending-button-play' ? 1 : 0, 'old toggle cannot start or restart media');
    assert.equal(pauses, change === 'button-pause' ? 1 : 0);
    pending.resolve(); await flush();
    assert.equal(f.host.send(f.contents, 'playback-toggle'), true); await flush();
    assert.equal(plays, 1, 'a fresh explicit command still operates normally');
  } finally {pending.resolve(); f.dispose(); controls.dispose();}
});

test('real preview menu control uses the current media and cannot play a hidden, unready or disposed binding', async () => {
  const controls = playbackControls(), listeners = new Map<string, () => void>();
  let plays = 0, pauses = 0, current = true, notifications = 0, registered: MenuPlaybackControl | null = null;
  const media = {readyState: 1, paused: true, ended: false,
    async play() {plays++; this.paused = false; listeners.get('play')?.();}, pause() {pauses++; this.paused = true; listeners.get('pause')?.();},
    addEventListener(name: string, update: () => void) {listeners.set(name, update);}, removeEventListener(name: string) {listeners.delete(name);}};
  const props: PlaybackProps = {bindingKey: 'project:asset:visible', getMedia: () => media, isCurrent: () => current,
    onRegisterMenuPlayback: control => {registered = control; return () => {if (registered === control) registered = null;}}, onMenuStateChange: () => {notifications++;}};
  controls.render(props); assert.ok(registered);
  const menu = registered as MenuPlaybackControl;
  assert.equal(menu.available(), true); await menu.toggle(); assert.equal(plays, 1); assert.equal(media.paused, false);
  await menu.toggle(); assert.equal(pauses, 1); assert.equal(media.paused, true); assert.ok(notifications >= 3);
  current = false; controls.render({...props, bindingKey: 'project:asset:hidden'});
  assert.equal(menu.available(), false); await menu.toggle(); assert.equal(plays, 1);
  current = true; media.readyState = 0; assert.equal(menu.available(), false); await menu.toggle(); assert.equal(plays, 1);
  media.readyState = 1; controls.dispose(); assert.equal(registered, null); assert.equal(menu.available(), false); await menu.toggle(); assert.equal(plays, 1);
});
