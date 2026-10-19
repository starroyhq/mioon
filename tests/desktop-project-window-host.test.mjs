import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    onDocumentInvalidated: setup.invalidated, onWebContentsDestroyed: setup.destroyed,
    consumeProjectEntry: setup.consume ?? (async (_owner, entryToken, projectId) => ({ version: 1, entryToken, projectId, accepted: true })),
  });
  t.after(() => host.dispose());
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (window, request) => host.dispatch(event(window), request.action === 'describe' ? request :
    { contextId: host.contextFor(window).contextId, ...request });
  const open = (projectId, source = created.find(window => window.creation.role === 'launcher'), entryToken = randomUUID(), remember = true) =>
    invoke(source, { action: 'open', projectId, entryToken, remember });
  return { host, events, created, owners, event, invoke, open,
    setCurrent(value) { current = value; }, setInteractive(value) { interactive = value; host.refresh(); },
    async launcher() { const window = host.ensureLauncher(); await host.loadFor(window); return window; },
    async editor(projectId = projectA) {
      assert.equal((await open(projectId)).reason, 'accepted');
      const window = created.at(-1); await host.loadFor(window); return window;
    },
    ready(window, projectId = projectA) { return invoke(window, { action: 'editor-status', projectId, phase: 'ready' }); },
  };
}

test('different projects get immutable editors and the launcher hides at first reservation', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor(), b = await f.editor(projectB);
  assert.equal(f.host.ensureLauncher(), launcher); assert.equal(launcher.visible, false);
  assert.equal(f.host.contextFor(launcher).editorCount, 2);
  assert.equal(f.host.contextFor(a).initialProjectId, projectA); assert.equal(f.host.contextFor(b).initialProjectId, projectB);
  f.ready(a); f.ready(b, projectB);
  assert.equal((await f.open(projectA, b)).reason, 'already-open'); assert.equal(f.created.length, 3);
  assert.equal(a.focuses > 0, true); assert.equal(launcher.visible, false);
  assert.ok(f.created.flatMap(window => window.webContents.sent).every(({ channel, value }) => channel === PROJECT_WINDOW_EVENT && isProjectWindowContext(value)));
});

test('v2 requires exact sender, main frame, context and fixed project URL', async t => {
  const f = fixture(t), launcher = await f.launcher(), contextId = f.host.contextFor(launcher).contextId;
  const request = { action: 'open', contextId, projectId: projectA, entryToken: randomUUID(), remember: true };
  assert.throws(() => f.host.dispatch({ sender: {}, senderFrame: launcher.webContents.mainFrame }, request), /sender/);
  assert.throws(() => f.host.dispatch({ sender: launcher.webContents, senderFrame: { url: `${origin}/` } }, request), /sender/);
  assert.throws(() => f.host.dispatch(f.event(launcher), { ...request, url: 'file:///secret' }), /request/);
  assert.throws(() => f.host.dispatch(f.event(launcher), { ...request, contextId: randomUUID() }), /Stale/);
  const a = await f.editor(); f.ready(a);
  a.inPage(editorUrl(projectB));
  assert.throws(() => f.ready(a, projectB), /sender/);
  assert.equal(f.host.contextFor(a).initialProjectId, projectA);
  a.navigate(editorUrl(projectB));
  assert.equal(f.host.isTrustedDocument(a), false); assert.equal(f.host.windowForContents(a.webContents), null);
  assert.throws(() => f.ready(a, projectB), /sender/);
});

test('a blocked foreign navigation start retains the assigned live document but never trusts a foreign commit', async t => {
  const invalidated = [], f = fixture(t, { invalidated: owner => invalidated.push(owner) });
  const launcher = await f.launcher(), before = f.host.contextFor(launcher), owner = f.host.ownerForContents(launcher.webContents);
  assert.ok(owner?.isCurrent());
  launcher.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.com/' });
  assert.equal(f.host.contextFor(launcher).contextId, before.contextId);
  assert.equal(f.host.isTrustedDocument(launcher), true);
  assert.equal(owner.isCurrent(), true);
  assert.deepEqual(invalidated, []);
  assert.equal(f.invoke(launcher, { action: 'describe' }).contextId, before.contextId);
  launcher.webContents.mainFrame = { url: 'https://example.com/' };
  launcher.webContents.emit('did-navigate', {}, 'https://example.com/');
  assert.equal(owner.isCurrent(), false);
  assert.equal(f.host.isTrustedDocument(launcher), false);
  assert.throws(() => f.invoke(launcher, { action: 'describe' }), /sender/);
});

test('an assigned reload retires the previous document before its replacement commits', async t => {
  const f = fixture(t), launcher = await f.launcher(), before = f.host.contextFor(launcher);
  const owner = f.host.ownerForContents(launcher.webContents);
  launcher.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/` });
  assert.equal(owner.isCurrent(), false);
  assert.notEqual(f.host.contextFor(launcher).contextId, before.contextId);
  assert.throws(() => f.invoke(launcher, { action: 'describe' }), /sender/);
});

test('same project including uppercase UUID focuses its exact existing owner without another load', async t => {
  const f = fixture(t); await f.launcher(); const a = await f.editor();
  const before = f.events.filter(event => event === 'editor:load').length;
  const result = await f.open(projectA.toUpperCase());
  assert.equal(result.reason, 'already-open'); assert.equal(result.targetWindowId, f.host.contextFor(a).windowId);
  assert.equal(result.targetPhase, 'opening'); assert.equal(f.created.length, 2);
  assert.equal(f.events.filter(event => event === 'editor:load').length, before);
});

test('one sealed token has one consume/reservation and a readable historical receipt after target closes', async t => {
  const hold = Promise.withResolvers(); let consumes = 0;
  const f = fixture(t, { consume: async (_owner, entryToken, projectId) => { consumes++; await hold.promise; return { version: 1, entryToken, projectId, accepted: true }; } });
  const launcher = await f.launcher(), token = randomUUID();
  const first = f.open(projectA, launcher, token), second = f.open(projectA, launcher, token);
  assert.equal(first, second); assert.equal(f.created.length, 1); assert.equal(f.host.contextFor(launcher).entryReceipt, null);
  hold.resolve(); const result = await first; assert.equal(consumes, 1); assert.equal(result.reason, 'accepted');
  const a = f.created.at(-1); await f.host.loadFor(a); a.finishClose();
  const receipt = f.host.contextFor(launcher).entryReceipt;
  assert.equal(receipt.entryToken, token); assert.deepEqual(receipt.result, result);
  assert.deepEqual(await f.open(projectA, launcher, token), result); assert.equal(consumes, 1); assert.equal(f.created.length, 2);
});

test('unknown or busy launcher admission refuses all first reservations without hiding it', async t => {
  const f = fixture(t, { consume: async (_owner, entryToken, projectId) => ({ version: 1, entryToken, projectId, accepted: false }) });
  const launcher = await f.launcher();
  assert.equal(f.host.requestProjectEntry('open'), true); assert.equal(f.host.requestProjectEntry('new'), true);
  assert.equal((await f.open(projectA)).ok, false); assert.equal(launcher.visible, true); assert.equal(f.created.length, 1);
  assert.equal(f.host.contextFor(launcher).entryReceipt.result.ok, false);
});

test('stale document or a quit fence crossing admission cannot reserve, hide or replay', async t => {
  for (const transition of ['reload', 'quit']) {
    const hold = Promise.withResolvers();
    const f = fixture(t, { consume: async (_owner, entryToken, projectId) => { await hold.promise; return { version: 1, entryToken, projectId, accepted: true }; } });
    const launcher = await f.launcher(), pending = f.open(projectA);
    if (transition === 'reload') launcher.navigate(`${origin}/`);
    else { f.setInteractive(false); f.setInteractive(true); }
    hold.resolve(); assert.equal((await pending).ok, false); assert.equal(f.created.length, 1); assert.equal(launcher.visible, true);
  }
});

test('late A admission/readiness does not steal focus from newer B', async t => {
  const f = fixture(t); await f.launcher(); const base = await f.editor(); f.ready(base);
  const a = await f.editor(projectB); const projectC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const b = await f.editor(projectC), before = a.focuses;
  a.isMinimized = () => true; f.ready(b, projectC); f.ready(a, projectB);
  assert.equal(a.focuses, before); assert.equal(a.inactiveShows > 0, true); assert.equal(f.events.includes('editor:restore'), false);
});

test('settings is one independent owner and entry intents target an editor rather than reveal launcher', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor();
  assert.equal(f.host.showSettings('agent'), true); const settings = f.created.at(-1); await f.host.loadFor(settings);
  assert.equal(f.host.contextFor(settings).role, 'settings'); assert.equal(f.host.showSettings('comfy'), true);
  assert.equal(f.created.at(-1), settings); assert.equal(f.host.contextFor(settings).settingsSlot, 'comfy');
  assert.equal(f.host.contextFor(launcher).settingsSlot, null); assert.equal(launcher.visible, false);
  assert.equal(f.host.requestProjectEntry('new', a), true); assert.equal(f.host.contextFor(a).entryMode, 'new');
  assert.equal((await f.open(projectB, settings)).ok, false);
  a.finishClose(); assert.equal(launcher.visible, true); assert.equal(settings.destroyed, false);
});

test('actual last editor closure reveals launcher once and preserves settings', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor(), b = await f.editor(projectB);
  const before = launcher.shows;
  a.finishClose(); assert.equal(launcher.visible, false); assert.equal(launcher.shows, before);
  b.holdClose = true; f.host.closeStateChanged(b, 'closing'); b.close();
  assert.equal((await f.open(projectB)).reason, 'busy'); assert.equal(f.host.contextFor(launcher).editorCount, 1);
  f.host.closeStateChanged(b, 'retained'); assert.equal((await f.open(projectB)).reason, 'already-open');
  f.host.closeStateChanged(b, 'closing'); b.finishClose();
  assert.equal(launcher.visible, true); assert.equal(launcher.shows, before + 1); assert.equal(f.host.contextFor(launcher).autoOpen, false);
});

test('reload rotates exact document capture but never immutable project binding', async t => {
  const f = fixture(t); await f.launcher(); const a = await f.editor(); f.ready(a);
  const capture = f.host.ownerForContents(a.webContents), stable = f.owners.get(a), before = f.host.contextFor(a);
  a.navigate(editorUrl(projectA));
  assert.equal(capture.isCurrent(), false); assert.equal(stable.isCurrent(), true);
  assert.notEqual(f.host.contextFor(a).contextId, before.contextId); assert.equal(f.host.contextFor(a).windowId, before.windowId);
  assert.equal(f.host.contextFor(a).initialProjectId, projectA); assert.equal(f.ready(a), true);
});

test('failed editor owns a visible failure surface while launcher remains hidden', async t => {
  const errors = [], hold = Promise.withResolvers();
  const f = fixture(t, { create(window) { if (window.creation.role === 'editor') window.loading = hold; }, onLoadError: error => errors.push(error) });
  const launcher = await f.launcher(); await f.open(projectA); const a = f.created.at(-1), load = f.host.loadFor(a);
  await tick(); hold.reject(new Error('load failed')); await assert.rejects(load, /load failed/);
  assert.equal(errors.length, 1); assert.equal(f.host.contextFor(a).editorPhase, 'failed'); assert.equal(a.visible, true); assert.equal(launcher.visible, false);
  assert.equal((await f.open(projectA)).targetWindowId, f.host.contextFor(a).windowId); assert.equal(f.created.length, 2);
});

test('reload supersedes late initial load rejection without changing current ready state', async t => {
  const errors = [], hold = Promise.withResolvers();
  const f = fixture(t, { create(window) { if (window.creation.role === 'editor') window.loading = hold; }, onLoadError: error => errors.push(error) });
  await f.launcher(); await f.open(projectA); const a = f.created.at(-1), original = f.host.loadFor(a);
  await tick(); a.navigate(editorUrl(projectA)); f.ready(a); hold.reject(new Error('old load')); await original;
  assert.equal(f.host.contextFor(a).editorPhase, 'ready'); assert.equal(errors.length, 0);
});

test('latest explicit ready selection alone reaches the launcher locator and closing/reload revoke it', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor();
  const first = f.host.contextFor(launcher).selectionVersion; const b = await f.editor(projectB);
  assert.equal(f.host.contextFor(launcher).selectionVersion > first, true); assert.equal(f.host.contextFor(launcher).selectionProjectId, null);
  f.ready(a); assert.equal(f.host.contextFor(launcher).selectionProjectId, null);
  f.ready(b, projectB); assert.equal(f.host.contextFor(launcher).selectionProjectId, projectB);
  f.host.closeStateChanged(b, 'closing'); assert.equal(f.host.contextFor(launcher).selectionProjectId, null);
  f.host.closeStateChanged(b, 'retained'); assert.equal(f.host.contextFor(launcher).selectionProjectId, null);
  await f.open(projectA); assert.equal(f.host.contextFor(launcher).selectionProjectId, projectA);
  a.navigate(editorUrl(projectA)); f.ready(a); assert.equal(f.host.contextFor(launcher).selectionProjectId, null);
});

test('quit fence rejects creation/reveal immediately but does not revoke native owner identity', async t => {
  const f = fixture(t), launcher = await f.launcher(), editor = await f.editor();
  f.setInteractive(false);
  const editorShows = editor.shows, launcherShows = launcher.shows;
  assert.equal(f.host.ensureLauncher(), null);
  assert.equal((await f.open(projectB)).reason, 'busy');
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
  assert.throws(() => f.open(projectA));
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
  assert.equal((await f.open(projectB)).reason, 'busy');
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
  await f.open(projectB); const replacement = f.created.at(-1); await f.host.loadFor(replacement);
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
  assert.equal((await f.open(projectA)).reason, 'busy');
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
  assert.equal((await f.open(projectB)).reason, 'busy');
  editor.finishClose(); assert.equal(launcher.closeCalls, 1); assert.equal(stopCalls, 0);
  launcher.finishClose(); await tick();
  assert.equal(stopCalls, 1); assert.equal(startCalls, 0); assert.equal(restart.state, 'stopping');
  assert.equal(restart.cancelForQuit(), false, 'stop/start cannot overlap a Quit drain');
  stopped.resolve(); assert.equal(await pending, true);
  assert.equal(startCalls, 1); assert.equal(restart.state, 'idle');
  assert.equal(f.events.some(event => event.endsWith(':hide')), true); assert.equal(f.created.length, 2);
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


test('fresh entry intents advance only their target entry version and never settings form state', async t => {
  const f = fixture(t), launcher = await f.launcher();
  const first = f.host.contextFor(launcher).entryVersion;
  assert.equal(f.host.showProjects(), true); assert.equal(f.host.contextFor(launcher).entryVersion, first + 1);
  assert.equal(f.host.requestProjectEntry('new'), true); assert.equal(f.host.contextFor(launcher).entryVersion, first + 2);
  assert.equal(f.host.contextFor(launcher).settingsVersion, 0);
  assert.equal(f.host.showSettings('agent'), true); const settings = f.created.at(-1); await f.host.loadFor(settings);
  assert.equal(f.host.contextFor(settings).settingsVersion, 1); assert.equal(f.host.contextFor(settings).entryVersion, 0);
});

test('out-of-order independent entry admissions preserve newer focus and selection intent', async t => {
  const held = Promise.withResolvers();
  const projectC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', projectD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const f = fixture(t, { consume: async (_owner, entryToken, projectId) => {
    if (projectId === projectC) await held.promise;
    return { version: 1, entryToken, projectId, accepted: true };
  } });
  const launcher = await f.launcher(), a = await f.editor(), b = await f.editor(projectB);
  const openingC = f.open(projectC, a); await f.open(projectD, b);
  const d = f.created.at(-1); await f.host.loadFor(d); f.ready(d, projectD);
  const dFocus = d.focuses; held.resolve(); await openingC;
  const c = f.created.at(-1); await f.host.loadFor(c); f.ready(c, projectC);
  assert.equal(c.focuses, 0); assert.equal(c.inactiveShows > 0, true); assert.equal(d.focuses, dFocus);
  assert.equal(f.host.contextFor(launcher).selectionProjectId, projectD);
});

test('cancelled Quit does not revive pre-fence readiness; fresh selection may reveal again', async t => {
  const f = fixture(t); await f.launcher(); const a = await f.editor();
  const count = a.shows + a.inactiveShows;
  f.setInteractive(false); f.setInteractive(true); f.ready(a); a.emit('ready-to-show');
  assert.equal(a.shows + a.inactiveShows, count);
  await f.open(projectA); assert.equal(a.shows + a.inactiveShows, count + 1);
});

test('P0 close metadata follows its real pending admission and exact cancellation', async t => {
  const f = fixture(t); await f.launcher(); const a = await f.editor(); f.ready(a);
  const inspect = Promise.withResolvers();
  a.webContents.executeJavaScript = () => inspect.promise;
  const admission = installNativeCloseAdmission(a, { isCurrent: () => f.owners.get(a).isCurrent(),
    confirmClose: () => false, confirmDiscard: () => false, onBlocked() {}, onCancel() {}, requestQuit() {},
    onCloseStateChange: state => f.host.closeStateChanged(a, state) });
  t.after(() => admission.dispose()); a.close();
  assert.equal(f.host.contextFor(a).editorPhase, 'closing'); assert.equal((await f.open(projectA)).reason, 'busy');
  inspect.resolve({ version: 1, token: 'exact-close-token', disposition: 'blocked' }); await tick();
  assert.equal(f.host.contextFor(a).editorPhase, 'ready'); assert.equal(a.destroyed, false);
});

test('activation focuses the exact editor without opening a picker or revealing launcher', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor(), b = await f.editor(projectB);
  const entryA = f.host.contextFor(a).entryVersion, entryB = f.host.contextFor(b).entryVersion, focusA = a.focuses;
  assert.equal(f.host.activate(a), true); assert.equal(a.focuses, focusA + 1);
  assert.equal(f.host.contextFor(a).entryVersion, entryA); assert.equal(f.host.contextFor(b).entryVersion, entryB);
  assert.equal(launcher.visible, false); assert.notEqual(f.host.preferredWindow(launcher), launcher, 'hidden launcher is not a menu reload fallback');
  f.setInteractive(false); assert.equal(f.host.activate(b), false); assert.equal(f.host.activate(), false);
});

const locatorSummary = (statusVersion = 1, extra = {}) => ({ version: 1, statusVersion, phase: 'error', uncertain: true,
  identityBlocked: false, canRetry: true, canRecheck: true, reading: false, rechecked: false, ...extra });

test('locator metadata has one exact launcher owner and settings forwards one version-bound action', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor();
  f.host.showSettings('agent'); const settings = f.created.at(-1); await f.host.loadFor(settings);
  const status = locatorSummary();
  assert.equal(f.invoke(a, { action: 'locator-status', status }), false);
  assert.equal(f.invoke(settings, { action: 'locator-status', status }), false);
  assert.equal(f.invoke(launcher, { action: 'locator-status', status }), true);
  assert.deepEqual(f.host.contextFor(a).locatorStatus, status); assert.deepEqual(f.host.contextFor(settings).locatorStatus, status);
  assert.equal(f.invoke(a, { action: 'locator-action', locatorAction: 'retry', expectedStatusVersion: 1 }), false);
  assert.equal(f.invoke(settings, { action: 'locator-action', locatorAction: 'retry', expectedStatusVersion: 0 }), false);
  assert.equal(f.invoke(settings, { action: 'locator-action', locatorAction: 'retry', expectedStatusVersion: 1 }), true);
  const intent = f.host.contextFor(launcher).locatorIntent;
  assert.equal(intent.action, 'retry'); assert.equal(intent.expectedStatusVersion, 1);
  assert.equal(f.host.contextFor(a).locatorIntent, null); assert.equal(f.host.contextFor(settings).locatorIntent, null);
  assert.equal(f.invoke(settings, { action: 'locator-action', locatorAction: 'retry', expectedStatusVersion: 1 }), true);
  assert.equal(f.host.contextFor(launcher).locatorIntent.intentVersion, intent.intentVersion);
  assert.equal(f.invoke(settings, { action: 'locator-action', locatorAction: 'recheck', expectedStatusVersion: 1 }), false);
  assert.equal(f.invoke(launcher, { action: 'locator-status', status: locatorSummary(1, { reading: true }) }), false);
  assert.equal(f.invoke(launcher, { action: 'locator-status', status: locatorSummary(2, { reading: true, canRetry: false, canRecheck: false }) }), true);
  assert.equal(f.host.contextFor(launcher).locatorIntent, null);
  assert.equal(f.invoke(settings, { action: 'locator-action', locatorAction: 'retry', expectedStatusVersion: 2 }), false);
});

test('locator reload revokes old status/action/selection and stale frames cannot republish', async t => {
  const f = fixture(t), launcher = await f.launcher(), a = await f.editor(); f.ready(a);
  f.host.showSettings('agent'); const settings = f.created.at(-1); await f.host.loadFor(settings);
  f.invoke(launcher, { action: 'locator-status', status: locatorSummary() });
  const oldEvent = f.event(launcher), oldContext = f.host.contextFor(launcher).contextId;
  launcher.navigate(`${origin}/`);
  assert.equal(f.host.contextFor(settings).locatorStatus, null); assert.equal(f.host.contextFor(launcher).selectionProjectId, null);
  assert.equal(f.invoke(settings, { action: 'locator-action', locatorAction: 'retry', expectedStatusVersion: 1 }), false);
  assert.throws(() => f.host.dispatch(oldEvent, { action: 'locator-status', contextId: oldContext, status: locatorSummary(2) }), /sender/);
  assert.throws(() => f.host.dispatch(f.event(launcher), { action: 'locator-status', contextId: oldContext, status: locatorSummary(2) }), /Stale/);
});

test('audio invalidation snapshots precede rotation and only real contents destruction proves owner loss', async t => {
  const invalidations = [], destroyed = [];
  const f = fixture(t, { invalidated: owner => invalidations.push({ owner, wasCurrent: owner.isCurrent() }), destroyed: id => destroyed.push(id) });
  await f.launcher(); const a = await f.editor(), before = f.host.contextFor(a);
  a.navigate(editorUrl(projectA));
  const old = invalidations.find(value => value.owner.windowId === before.windowId);
  assert.ok(old); assert.equal(old.wasCurrent, true); assert.equal(old.owner.contextId, before.contextId); assert.equal(old.owner.isCurrent(), false);
  assert.deepEqual(destroyed, []); f.host.closeStateChanged(a, 'closing'); a.finishClose(); assert.deepEqual(destroyed, []);
  a.webContents.emit('destroyed'); a.webContents.emit('destroyed'); assert.deepEqual(destroyed, [before.windowId]);
});

test('a pre-consume Quit refusal has an exact negative receipt even when invoke ACK is lost', async t => {
  let consumes = 0;
  const f = fixture(t, { consume: () => { consumes++; return null; } }), launcher = await f.launcher(), token = randomUUID();
  f.setInteractive(false); const refused = await f.open(projectA, launcher, token);
  f.setInteractive(true);
  assert.equal(refused.reason, 'busy'); assert.equal(consumes, 0);
  assert.deepEqual(f.host.contextFor(launcher).entryReceipt, { entryToken: token, result: refused });
  assert.deepEqual(await f.open(projectA, launcher, token), refused); assert.equal(consumes, 0); assert.equal(f.created.length, 1);
});

test('security or P0 preparation failure retains failed owner without loading application code', async t => {
  const error = new Error('Synthetic policy installation failure');
  const f = fixture(t, { prepare(window) { if (window.creation.role === 'editor') throw error; } });
  const launcher = await f.launcher(); const result = await f.open(projectA), a = f.created.at(-1);
  assert.equal(result.reason, 'accepted'); assert.equal(result.targetPhase, 'failed');
  await assert.rejects(f.host.loadFor(a), value => value === error);
  assert.equal(f.events.includes('editor:load'), false); assert.equal(launcher.visible, false);
  assert.equal(f.host.contextFor(a).editorPhase, 'failed'); assert.equal(f.host.windows().includes(a), true);
});

function rejectDestroyedContentsGetter(window) {
  const contents = window.webContents;
  Object.defineProperty(window, 'webContents', { get() {
    if (window.destroyed) throw new TypeError('Object has been destroyed');
    return contents;
  } });
  return contents;
}

test('destroyed BrowserWindow getter cannot interrupt exact editor closure or release a sibling', async t => {
  const destroyed = [];
  const f = fixture(t, { create: rejectDestroyedContentsGetter, destroyed: id => destroyed.push(id) });
  const launcher = await f.launcher(), a = await f.editor(), b = await f.editor(projectB);
  f.host.showSettings('agent'); const settings = f.created.at(-1); await f.host.loadFor(settings);
  const aContents = a.webContents, bContents = b.webContents, aId = f.host.contextFor(a).windowId, bId = f.host.contextFor(b).windowId;
  assert.doesNotThrow(() => a.finishClose());
  assert.equal(f.host.windowForContents(aContents), null); assert.equal(f.host.windowForContents(bContents), b);
  assert.equal(f.host.contextFor(launcher).editorCount, 1); assert.equal(launcher.visible, false); assert.equal(settings.destroyed, false);
  assert.deepEqual(destroyed, [], 'BrowserWindow.closed is not WebContents destruction evidence');
  assert.doesNotThrow(() => aContents.emit('destroyed')); aContents.emit('destroyed');
  assert.deepEqual(destroyed, [aId]); assert.equal(f.host.windowForContents(bContents), b);
  assert.doesNotThrow(() => b.finishClose()); assert.equal(launcher.visible, true);
  assert.doesNotThrow(() => bContents.emit('destroyed')); assert.deepEqual(destroyed, [aId, bId]);
  assert.doesNotThrow(() => f.host.dispose());
});

test('late contents destroyed after host disposal uses its captured owner without a native getter', async t => {
  const destroyed = [];
  const f = fixture(t, { create: rejectDestroyedContentsGetter, destroyed: id => destroyed.push(id) });
  await f.launcher(); const a = await f.editor(), contents = a.webContents, ownerId = f.host.contextFor(a).windowId;
  a.destroyed = true;
  assert.doesNotThrow(() => f.host.dispose()); assert.deepEqual(destroyed, []);
  assert.doesNotThrow(() => contents.emit('destroyed')); contents.emit('destroyed');
  assert.deepEqual(destroyed, [ownerId]); assert.equal(f.host.windowForContents(contents), null);
});
