import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProjectWindowHost } from '../apps/desktop/src/project-window-host.ts';
import { MultiWindowQuitCoordinator, MultiWindowRestartCoordinator, createProjectWindowQuitRouter } from '../apps/desktop/src/project-window-quit.ts';
import { installNativeCloseAdmission } from '../apps/desktop/src/native-close.ts';
import { PROJECT_WINDOW_EVENT, isProjectWindowContext } from '../apps/desktop/src/project-window-protocol.ts';

const backendId = '11111111-1111-4111-8111-111111111111';
const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const origin = 'http://127.0.0.1:41234';
const editorUrl = projectId => `${origin}/?project=${projectId}`;
const tick = () => new Promise(resolve => setImmediate(resolve));

class NativeWindow extends EventEmitter {
  constructor(creation, events) {
    super();
    this.creation = creation; this.events = events; this.destroyed = false; this.visible = false;
    this.shows = 0; this.inactiveShows = 0; this.focuses = 0; this.closeCalls = 0;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url: 'about:blank' };
    this.webContents.getURL = () => this.webContents.mainFrame.url;
    this.webContents.sent = [];
    this.webContents.send = (channel, value) => this.webContents.sent.push({ channel, value });
    this.webContents.executeJavaScript = async () => { throw new Error('Renderer is unavailable'); };
    this.webContents.loadURL = url => this.loadURL(url);
  }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return false; }
  restore() { this.events.push(`${this.creation.role}:restore`); }
  show() { this.visible = true; this.shows++; this.events.push(`${this.creation.role}:show`); }
  showInactive() { this.visible = true; this.inactiveShows++; this.events.push(`${this.creation.role}:inactive`); }
  focus() { this.focuses++; this.events.push(`${this.creation.role}:focus`); }
  hide() { this.visible = false; this.events.push(`${this.creation.role}:hide`); }
  async loadURL(url) {
    this.events.push(`${this.creation.role}:load`);
    this.navigate(url);
    if (this.loading) await this.loading.promise;
    this.emit('ready-to-show');
  }
  navigate(url) {
    this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    this.webContents.mainFrame = { url };
    this.webContents.emit('did-navigate', {}, url);
  }
  inPage(url) {
    this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url });
    this.webContents.mainFrame.url = url;
    this.webContents.emit('did-navigate-in-page', {}, url, true);
  }
  close() {
    this.closeCalls++; this.events.push(`${this.creation.role}:close`);
    let prevented = false;
    this.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented && !this.holdClose) this.finishClose();
  }
  finishClose() {
    if (this.destroyed) return;
    this.destroyed = true; this.visible = false;
    this.events.push(`${this.creation.role}:closed`); this.emit('closed');
  }
}

function fixture(t, setup = {}) {
  const events = [], created = [], owners = new Map();
  let current = true, interactive = true;
  const host = createProjectWindowHost({ backendId, launcherUrl: `${origin}/`, editorUrl,
    isCurrent: () => current, canInteract: () => interactive,
    createWindow: creation => {
      const window = new NativeWindow(creation, events);
      setup.create?.(window); created.push(window); return window;
    },
    prepareWindow(window, owner) { owners.set(window, owner); setup.prepare?.(window, owner); },
    onLoadError: setup.onLoadError,
  });
  t.after(() => host.dispose());
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (window, request) => host.dispatch(event(window), request.action === 'describe' ? request :
    { contextId: host.contextFor(window).contextId, ...request });
  return { host, events, created, owners, event, invoke,
    setCurrent(value) { current = value; }, setInteractive(value) { interactive = value; host.refresh(); },
    async launcher() { const window = host.ensureLauncher(); await host.loadFor(window); return window; },
    async editor(projectId = projectA) {
      assert.equal(host.openProject(projectId).reason, 'accepted');
      const window = created.at(-1); await host.loadFor(window); return window;
    },
    ready(window, projectId = projectA) { return invoke(window, { action: 'editor-status', projectId, phase: 'ready' }); },
  };
}

test('one launcher, one editor, one backend; same project focuses and different project is explicitly blocked', async t => {
  const f = fixture(t), launcher = await f.launcher();
  assert.equal(f.host.ensureLauncher(), launcher);
  assert.equal(f.invoke(launcher, { action: 'describe' }).autoOpen, true);
  const editor = await f.editor();
  assert.equal(f.host.contextFor(launcher).autoOpen, false);
  assert.equal(f.host.contextFor(editor).initialProjectId, projectA);
  assert.equal(f.ready(editor), true);
  assert.equal(launcher.visible, true); assert.equal(editor.visible, true);
  assert.equal(f.events.includes('launcher:hide'), false);
  assert.deepEqual(f.host.openProject(projectA), { ok: true, reason: 'already-open' });
  assert.deepEqual(f.host.openProject(projectB), { ok: false, reason: 'another-editor' });
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.created.map(window => window.creation.backendId), [backendId, backendId]);
  assert.ok(f.created.flatMap(window => window.webContents.sent).every(({ channel, value }) =>
    channel === PROJECT_WINDOW_EVENT && isProjectWindowContext(value)));
});

test('IPC requires exact window, main frame, canonical current URL and bounded request keys', async t => {
  const f = fixture(t), launcher = await f.launcher(), contextId = f.host.contextFor(launcher).contextId;
  const request = { action: 'open', contextId, projectId: projectA };
  const frame = { url: `${origin}/` };
  assert.throws(() => f.host.dispatch({ sender: {}, senderFrame: frame }, request), /sender/);
  assert.throws(() => f.host.dispatch({ sender: launcher.webContents, senderFrame: frame }, request), /sender/);
  assert.throws(() => f.host.dispatch(f.event(launcher), { ...request, url: 'file:///secret' }), /request/);
  assert.throws(() => f.host.dispatch(f.event(launcher), { ...request, projectId: '../secret' }), /request/);
  launcher.webContents.mainFrame.url = `${origin}/other`;
  assert.throws(() => f.host.dispatch(f.event(launcher), request), /sender/);
  launcher.webContents.mainFrame.url = `${origin}/`;
  const contentsUrl = launcher.webContents.getURL;
  launcher.webContents.getURL = () => `${origin}/?unexpected=1`;
  assert.throws(() => f.host.dispatch(f.event(launcher), request), /sender/);
  launcher.webContents.getURL = contentsUrl;
  assert.equal(f.created.length, 1);
});

test('only assigned editor and exact current project may report initial ready or failed', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  assert.equal(f.invoke(launcher, { action: 'editor-status', projectId: projectA, phase: 'ready' }), false);
  assert.equal(f.ready(editor, projectB), false);
  editor.inPage(editorUrl(projectB));
  assert.equal(f.ready(editor, projectB), false, 'opening cannot replace its assigned project through history');
  assert.equal(f.invoke(editor, { action: 'editor-status', projectId: projectB, phase: 'failed' }), false);
  editor.inPage(editorUrl(projectA));
  assert.equal(f.invoke(editor, { action: 'editor-status', projectId: projectA, phase: 'failed' }), true);
  editor.inPage(editorUrl(projectB));
  assert.equal(f.ready(editor, projectB), false, 'failed initial opening does not release its assigned project');
  editor.inPage(editorUrl(projectA));
  assert.equal(f.ready(editor), true);
  editor.inPage(editorUrl(projectB));
  assert.equal(f.ready(editor, projectB), true, 'a guarded in-editor navigation is reported against its exact URL');
  assert.equal(f.host.contextFor(editor).editorProjectId, projectB);
  assert.equal(f.host.openProject(projectB).reason, 'already-open');
  assert.equal(f.host.openProject(projectA).reason, 'another-editor');
});

test('real reload rotates bridge generation while native lifetime ownership survives; in-page changes do not rotate', async t => {
  const f = fixture(t); await f.launcher(); const editor = await f.editor(); f.ready(editor);
  const owner = f.owners.get(editor), previous = f.host.contextFor(editor), oldEvent = f.event(editor);
  editor.inPage(editorUrl(projectB));
  assert.equal(f.host.contextFor(editor).contextId, previous.contextId);
  assert.equal(f.ready(editor, projectB), true);
  editor.navigate(editorUrl(projectB));
  const next = f.host.contextFor(editor);
  assert.notEqual(next.contextId, previous.contextId);
  assert.equal(next.initialProjectId, projectB);
  assert.equal(owner.isCurrent(), true);
  assert.throws(() => f.host.dispatch(oldEvent, { action: 'describe' }), /sender/);
  assert.throws(() => f.host.dispatch(f.event(editor), { action: 'editor-status', contextId: previous.contextId,
    projectId: projectB, phase: 'ready' }), /Stale/);
  assert.equal(f.ready(editor, projectB), true);
});

test('newer launcher/settings intent wins against delayed editor readiness', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  const focusBefore = editor.focuses;
  editor.isMinimized = () => true;
  assert.equal(f.host.showSettings('comfy'), true);
  const version = f.host.contextFor(launcher).settingsVersion;
  assert.equal(f.ready(editor), true);
  assert.equal(editor.inactiveShows, 1); assert.equal(editor.focuses, focusBefore);
  assert.equal(f.events.includes('editor:restore'), false, 'restore can activate a minimized window');
  assert.equal(launcher.visible, true);
  assert.equal(f.host.contextFor(launcher).settingsSlot, 'comfy');
  assert.equal(f.host.showSettings('comfy'), true);
  assert.equal(f.host.contextFor(launcher).settingsVersion, version + 1);
  assert.equal(f.host.showProjects(), true);
  assert.equal(f.host.contextFor(launcher).settingsSlot, null);
});

test('editor slot releases on actual closed, then launcher reappears without reopening the project', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor(); f.ready(editor);
  const launcherShows = launcher.shows;
  editor.holdClose = true; editor.close();
  assert.equal(f.host.openProject(projectB).reason, 'another-editor');
  assert.equal(launcher.shows, launcherShows);
  editor.finishClose();
  assert.equal(launcher.visible, true); assert.equal(f.host.contextFor(launcher).autoOpen, false);
  assert.equal(launcher.shows, launcherShows + 1);
  assert.equal(f.host.contextFor(launcher).editorPhase, 'none');
  assert.equal(f.host.openProject(projectB).reason, 'accepted');
});

test('closing launcher leaves editor/backend lifetime intact; later launcher is never auto-open', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor(); f.ready(editor);
  launcher.close();
  assert.deepEqual(f.host.windows(), [editor]); assert.equal(f.owners.get(editor).isCurrent(), true);
  assert.equal(f.host.showProjects(), true);
  const replacement = f.created.at(-1); await f.host.loadFor(replacement);
  assert.notEqual(replacement, launcher); assert.equal(f.host.contextFor(replacement).autoOpen, false);
  assert.equal(f.host.contextFor(replacement).backendId, backendId);
});

test('closed/replaced owners cannot publish ready, reveal a window, or report a late failed load', async t => {
  const held = Promise.withResolvers(), errors = [];
  const f = fixture(t, { create(window) { if (window.creation.role === 'editor') window.loading = held; },
    onLoadError: error => errors.push(error) });
  await f.launcher(); f.host.openProject(projectA);
  const old = f.created.at(-1); await tick();
  const oldRequest = { action: 'editor-status', contextId: f.host.contextFor(old).contextId, projectId: projectA, phase: 'ready' };
  old.finishClose();
  f.host.openProject(projectB); const replacement = f.created.at(-1);
  assert.throws(() => f.host.dispatch(f.event(old), oldRequest), /sender/);
  old.emit('ready-to-show'); held.reject(new Error('late old load'));
  await f.host.loadFor(old); await f.host.loadFor(replacement).catch(() => {});
  assert.equal(old.visible, false); assert.equal(f.host.contextFor(replacement).editorProjectId, projectB);
  // The shared deferred also rejects the current replacement's load; only that
  // exact current owner is allowed to report its own failure.
  assert.equal(errors.length, 1);
});

test('same-window successful navigation supersedes a late initial-load rejection', async t => {
  const held = Promise.withResolvers(), errors = [];
  const f = fixture(t, { create(window) { if (window.creation.role === 'editor') window.loading = held; },
    onLoadError: error => errors.push(error) });
  const launcher = await f.launcher(); f.host.openProject(projectA);
  const editor = f.created.at(-1), originalLoad = f.host.loadFor(editor);
  await tick(); f.ready(editor);
  const previous = f.host.contextFor(editor).contextId;
  editor.navigate(editorUrl(projectA));
  assert.notEqual(f.host.contextFor(editor).contextId, previous);
  assert.equal(f.ready(editor), true);
  const shows = launcher.shows;
  held.reject(Object.assign(new Error('old document aborted'), { code: 'ERR_ABORTED' }));
  await originalLoad;
  assert.equal(f.host.contextFor(editor).editorPhase, 'ready');
  assert.equal(launcher.shows, shows); assert.deepEqual(errors, []);
});

test('quit fence rejects creation/reveal immediately but does not revoke native owner identity', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  f.setInteractive(false);
  const editorShows = editor.shows, launcherShows = launcher.shows;
  assert.equal(f.host.ensureLauncher(), null);
  assert.equal(f.host.openProject(projectB).reason, 'busy');
  assert.equal(f.host.showProjects(), false); assert.equal(f.host.showSettings('agent'), false);
  assert.equal(f.owners.get(editor).isCurrent(), true);
  assert.equal(f.host.contextFor(launcher).quitting, true);
  assert.equal(f.ready(editor), true);
  editor.emit('ready-to-show'); launcher.emit('ready-to-show');
  assert.equal(editor.shows, editorShows); assert.equal(launcher.shows, launcherShows);
  launcher.finishClose(); editor.finishClose();
  assert.equal(f.created.length, 2); assert.deepEqual(f.host.windows(), []);
});

test('superseded backend identity rejects stale load and bridge callbacks', async t => {
  const f = fixture(t), launcher = await f.launcher();
  f.setCurrent(false);
  const shows = launcher.shows;
  launcher.emit('ready-to-show');
  assert.equal(launcher.shows, shows); assert.equal(f.owners.get(launcher).isCurrent(), false);
  assert.equal(f.host.ensureLauncher(), null);
  assert.equal(f.host.openProject(projectA).reason, 'unavailable');
  assert.throws(() => f.invoke(launcher, { action: 'describe' }), /sender/);
});

test('Quit closes source synchronously first, waits for every actual closed, then stops exactly once', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  editor.holdClose = true; launcher.holdClose = true;
  let stops = 0, finishes = 0;
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.getWindows,
    stop: () => { stops++; }, finish: () => { finishes++; },
    onStateChange: state => f.setInteractive(state === 'idle') });
  const pending = quit.request(editor);
  assert.equal(quit.state, 'requesting'); assert.equal(editor.closeCalls, 1); assert.equal(launcher.closeCalls, 0);
  assert.equal(quit.request(), pending); assert.equal(stops, 0);
  assert.equal(f.host.openProject(projectB).reason, 'busy');
  editor.finishClose();
  assert.equal(launcher.closeCalls, 1); assert.equal(stops, 0); assert.equal(f.created.length, 2);
  launcher.finishClose(); assert.equal(stops, 0);
  assert.equal(await pending, true);
  assert.equal(stops, 1); assert.equal(finishes, 1); assert.equal(quit.state, 'finished');
});

test('unrelated or replaced owner cancellation cannot cancel the active exact-window quit', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  launcher.holdClose = true; editor.holdClose = true;
  let stops = 0;
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows, stop: () => { stops++; }, finish() {},
    onStateChange: state => f.setInteractive(state === 'idle') });
  const first = quit.request(editor);
  assert.equal(quit.cancel(launcher), false);
  assert.equal(quit.cancel(editor), true); assert.equal(await first, false);
  assert.equal(quit.state, 'idle'); assert.equal(stops, 0);
  editor.finishClose();
  f.host.openProject(projectB); const replacement = f.created.at(-1); await f.host.loadFor(replacement);
  replacement.holdClose = true;
  const second = quit.request(replacement);
  assert.equal(quit.cancel(editor), false);
  assert.equal(quit.state, 'requesting');
  assert.equal(quit.cancel(replacement), true); assert.equal(await second, false);
});

test('a remaining owner veto cancels quit and retains the backend after source already closed', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  let stops = 0;
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows, stop: () => { stops++; }, finish() {},
    onStateChange: state => f.setInteractive(state === 'idle') });
  launcher.on('close', event => { event.preventDefault(); quit.cancel(launcher); });
  assert.equal(await quit.request(editor), false);
  assert.equal(editor.destroyed, true); assert.equal(launcher.destroyed, false);
  assert.equal(stops, 0); assert.equal(f.created.length, 2); assert.equal(quit.state, 'idle');
  assert.equal(f.owners.get(launcher).isCurrent(), true);
});

test('P0 confirmed-gone Exit consumes only the source permit synchronously in multiwindow Quit', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  let probes = 0, stops = 0;
  editor.webContents.executeJavaScript = async () => { probes++; throw new Error('gone'); };
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows, stop: () => { stops++; }, finish() {},
    onStateChange: state => f.setInteractive(state === 'idle') });
  const admission = installNativeCloseAdmission(editor, {
    isCurrent: () => f.owners.get(editor).isCurrent(), confirmClose: () => false, confirmDiscard: () => false,
    onBlocked() {}, onCancel: () => quit.cancel(editor), requestQuit: () => quit.request(editor),
  });
  t.after(() => admission.dispose());
  editor.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const decision = admission.captureRecoveryDecision();
  assert.equal(decision.claimPrompt(), true);
  const result = decision.exit();
  assert.equal(editor.destroyed, true, 'source close occurs in the recovery exit stack');
  assert.equal(launcher.destroyed, true);
  assert.equal(await result, true); assert.equal(probes, 0); assert.equal(stops, 1);
  assert.ok(f.events.indexOf('editor:close') < f.events.indexOf('launcher:close'));
});

test('failed stop does not finish or create windows; invalid source cannot start quit', async t => {
  const f = fixture(t), launcher = await f.launcher();
  const failure = new Error('backend drain failed'); let finishes = 0;
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows, stop: () => { throw failure; },
    finish() { finishes++; }, onStateChange: state => f.setInteractive(state === 'idle') });
  const foreign = new NativeWindow({ role: 'editor' }, []);
  assert.equal(await quit.request(foreign), false); assert.equal(quit.state, 'idle'); assert.equal(launcher.closeCalls, 0);
  await assert.rejects(quit.request(), error => error === failure);
  assert.equal(finishes, 0); assert.equal(quit.state, 'idle'); assert.equal(f.created.length, 1);
});

test('destroyed handles awaiting actual closed retain slots and keep backend Quit fenced', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  editor.destroyed = true;
  assert.equal(f.host.openProject(projectB).reason, 'busy');
  assert.equal(f.host.windows().includes(editor), true);
  let stops = 0;
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows, stop() { stops++; }, finish() {},
    onStateChange: state => f.setInteractive(state === 'idle') });
  const pending = quit.request(editor);
  assert.equal(editor.closeCalls, 0, 'a destroyed handle is never closed again');
  assert.equal(launcher.closeCalls, 0); assert.equal(stops, 0); assert.equal(quit.state, 'requesting');
  editor.emit('closed');
  assert.equal(launcher.closeCalls, 1);
  assert.equal(await pending, true); assert.equal(stops, 1);
});

test('restart uses P0 closure order, stops after actual closed and starts only after stop resolves', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  launcher.holdClose = true; editor.holdClose = true;
  const stopped = Promise.withResolvers(); let stopCalls = 0, startCalls = 0;
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows, canRequest: () => true,
    stop: () => { stopCalls++; return stopped.promise; }, start: () => { startCalls++; },
    onStateChange: state => f.setInteractive(state === 'idle') });
  const pending = restart.request(editor);
  assert.equal(restart.state, 'requesting'); assert.equal(editor.closeCalls, 1); assert.equal(launcher.closeCalls, 0);
  assert.equal(f.host.openProject(projectB).reason, 'busy');
  editor.finishClose(); assert.equal(launcher.closeCalls, 1); assert.equal(stopCalls, 0);
  launcher.finishClose(); await tick();
  assert.equal(stopCalls, 1); assert.equal(startCalls, 0); assert.equal(restart.state, 'stopping');
  assert.equal(restart.cancelForQuit(), false, 'stop/start cannot overlap a Quit drain');
  stopped.resolve(); assert.equal(await pending, true);
  assert.equal(startCalls, 1); assert.equal(restart.state, 'idle');
  assert.equal(f.events.some(event => event.endsWith(':hide')), false); assert.equal(f.created.length, 2);
});

test('Quit can synchronously supersede a requesting restart, without parallel stop/start', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  editor.holdClose = true; launcher.holdClose = true;
  let restartStops = 0, starts = 0, quitStops = 0;
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows,
    stop: () => { quitStops++; }, finish() {}, onStateChange: state => f.setInteractive(state === 'idle') });
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows, canRequest: () => quit.state === 'idle',
    stop: () => { restartStops++; }, start: () => { starts++; },
    onStateChange: state => f.setInteractive(state === 'idle') });
  const first = restart.request(editor);
  assert.equal(restart.cancelForQuit(), true);
  const second = quit.request(editor);
  assert.equal(quit.state, 'requesting'); assert.equal(editor.closeCalls, 2);
  assert.equal(await first, false);
  assert.equal(await restart.request(), false, 'Quit now owns lifecycle');
  editor.finishClose(); launcher.finishClose();
  assert.equal(await second, true);
  assert.equal(restartStops, 0); assert.equal(starts, 0); assert.equal(quitStops, 1);
});

test('restart cancellation is exact-window scoped and never stops a remaining owner', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  editor.holdClose = true;
  let stops = 0, starts = 0;
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows, canRequest: () => true,
    stop: () => { stops++; }, start: () => { starts++; }, onStateChange: state => f.setInteractive(state === 'idle') });
  const pending = restart.request(editor);
  assert.equal(restart.cancel(launcher), false); assert.equal(restart.cancel(editor), true);
  assert.equal(await pending, false); assert.equal(stops, 0); assert.equal(starts, 0);
  assert.equal(f.owners.get(editor).isCurrent(), true); assert.equal(f.owners.get(launcher).isCurrent(), true);
});

test('Quit during restart stop is retained, coalesced, and prevents replacement startup before serialized quit', async t => {
  const f = fixture(t); await f.launcher(); await f.editor();
  const stop = Promise.withResolvers();
  const events = []; let router;
  const refresh = () => f.setInteractive(router?.allowsWindows ?? true);
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows,
    stop() { events.push('quit-stop'); }, finish() { events.push('quit-finish'); }, onStateChange: refresh });
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows,
    canRequest: () => quit.state === 'idle' && !router?.isPending,
    stop() { events.push('restart-stop'); return stop.promise; },
    start() { assert.fail('pending Quit must prevent replacement startup'); }, onStateChange: refresh });
  router = createProjectWindowQuitRouter({ quit, restart, onPendingChange: refresh });
  const restarting = restart.request(); await tick();
  assert.equal(restart.state, 'stopping');
  const quitting = router.request();
  assert.equal(router.isPending, true); assert.equal(router.allowsWindows, false);
  assert.equal(router.request(), quitting); assert.deepEqual(events, ['restart-stop']);
  stop.resolve();
  assert.equal(f.created.length, 2);
  assert.equal(await restarting, true); assert.equal(await quitting, true);
  assert.deepEqual(events, ['restart-stop', 'quit-stop', 'quit-finish']);
  assert.equal(router.isPending, false); assert.equal(router.allowsWindows, false);
});

test('Quit during an already-running restart start immediately fences UI and serializes backend quit', async t => {
  const f = fixture(t); await f.launcher();
  const starting = Promise.withResolvers(), events = []; let router;
  const refresh = () => f.setInteractive(router?.allowsWindows ?? true);
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows,
    stop() { events.push('quit-stop'); }, finish() {}, onStateChange: refresh });
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows,
    canRequest: () => quit.state === 'idle' && !router?.isPending,
    stop() { events.push('restart-stop'); },
    async start() {
      events.push('restart-start'); await starting.promise;
      assert.equal(router.allowsWindows, false); assert.equal(f.host.ensureLauncher(), null);
      events.push('restart-started');
    }, onStateChange: refresh });
  router = createProjectWindowQuitRouter({ quit, restart, onPendingChange: refresh });
  const restarting = restart.request(); await tick();
  assert.equal(restart.state, 'starting');
  const quitting = router.request();
  assert.equal(router.isPending, true); assert.equal(router.allowsWindows, false);
  assert.equal(quit.state, 'idle');
  assert.deepEqual(events, ['restart-stop', 'restart-start']);
  starting.resolve(); await restarting; assert.equal(await quitting, true);
  assert.deepEqual(events, ['restart-stop', 'restart-start', 'restart-started', 'quit-stop']);
  assert.equal(f.created.length, 1);
});

test('Quit router preserves synchronous source-first P0 close while superseding requesting restart', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  launcher.holdClose = true; let router, starts = 0;
  const refresh = () => f.setInteractive(router?.allowsWindows ?? true);
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows, stop() {}, finish() {}, onStateChange: refresh });
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows, canRequest: () => quit.state === 'idle',
    stop() {}, start() { starts++; }, onStateChange: refresh });
  router = createProjectWindowQuitRouter({ quit, restart, onPendingChange: refresh });
  const restarting = restart.request(launcher);
  const admission = installNativeCloseAdmission(editor, {
    isCurrent: () => f.owners.get(editor).isCurrent(), confirmClose: () => false, confirmDiscard: () => false,
    onBlocked() {}, onCancel: () => quit.cancel(editor), requestQuit: () => router.request(editor),
  });
  t.after(() => admission.dispose());
  editor.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  const exiting = admission.captureRecoveryDecision().exit();
  assert.equal(editor.destroyed, true, 'source allowance is consumed before Exit returns');
  assert.equal(quit.state, 'requesting'); assert.equal(router.isPending, true);
  assert.equal(await restarting, false);
  launcher.finishClose(); assert.equal(await exiting, true); assert.equal(starts, 0);
});

test('queued Quit survives failed restart stop, then reports its own failure and clears the pending fence', async t => {
  const f = fixture(t); await f.launcher();
  const stop = Promise.withResolvers(), quitError = new Error('quit drain failure'); let router;
  const refresh = () => f.setInteractive(router?.allowsWindows ?? true);
  const quit = new MultiWindowQuitCoordinator({ getWindows: f.host.windows,
    stop() { throw quitError; }, finish() { assert.fail('failed cleanup cannot finish'); }, onStateChange: refresh });
  const restart = new MultiWindowRestartCoordinator({ getWindows: f.host.windows, canRequest: () => true,
    stop: () => stop.promise, start() { assert.fail('failed restart stop cannot start'); }, onStateChange: refresh });
  router = createProjectWindowQuitRouter({ quit, restart, onPendingChange: refresh });
  const restarting = restart.request();
  const quitting = router.request();
  const restartCheck = assert.rejects(restarting, /restart drain failure/);
  const quitCheck = assert.rejects(quitting, error => error === quitError);
  stop.reject(new Error('restart drain failure'));
  await restartCheck; await quitCheck;
  assert.equal(router.isPending, false); assert.equal(quit.state, 'idle'); assert.equal(restart.state, 'idle');
});


test('explicit projects intent advances the existing settings version even when its slot was already null', async t => {
  const f = fixture(t), launcher = await f.launcher();
  const first = f.host.contextFor(launcher).settingsVersion;
  assert.equal(f.host.showProjects(), true);
  assert.equal(f.host.contextFor(launcher).settingsVersion, first + 1);
  assert.equal(f.host.contextFor(launcher).settingsSlot, null);
  assert.equal(f.host.showProjects(), true);
  assert.equal(f.host.contextFor(launcher).settingsVersion, first + 2);
  assert.equal(f.host.showSettings('agent'), true);
  assert.equal(f.host.contextFor(launcher).settingsVersion, first + 3);
  assert.equal(f.host.showProjects(), true);
  assert.equal(f.host.contextFor(launcher).settingsVersion, first + 4);
});
