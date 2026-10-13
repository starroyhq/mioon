import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProjectWindowHost } from '../apps/desktop/src/project-window-host.ts';
import { createProjectWindowBridge } from '../apps/desktop/src/project-window-preload.ts';
import { isProjectWindowContext, isProjectWindowRequest, PROJECT_WINDOW_CHANNEL, PROJECT_WINDOW_EVENT } from '../apps/desktop/src/project-window-protocol.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
import { reportEditorWindowStatus } from '../apps/web/src/editor-native-window.ts';

const backendId = '11111111-1111-4111-8111-111111111111';
const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const origin = 'http://127.0.0.1:41234';
function fixture(t) {
  let interactive = true;
  const windows = [], requests = [], writes = [];
  class Window extends EventEmitter {
    constructor() {
      super(); this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'about:blank' }, getURL: () => this.webContents.mainFrame.url,
        send: (channel, value) => this.webContents.emit(channel, {}, value),
      });
    }
    isDestroyed() { return this.destroyed; } isMinimized() { return false; }
    show() {} showInactive() {} focus() {} restore() {}
    close() { this.destroyed = true; this.emit('closed'); }
    async loadURL(url) {
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      this.webContents.mainFrame = { url }; this.webContents.emit('did-navigate', {}, url); this.emit('ready-to-show');
    }
  }
  const host = createProjectWindowHost({ backendId, launcherUrl: `${origin}/`, editorUrl: id => `${origin}/?project=${id}`,
    isCurrent: () => true, canInteract: () => interactive,
    createWindow() { const window = new Window(); windows.push(window); return window; },
  });
  t.after(() => host.dispose());
  function bridge(window) {
    return readDesktopWindowBridge({ __mioonProjectWindow: createProjectWindowBridge({
      async invoke(channel, request) {
        requests.push(request); assert.equal(channel, PROJECT_WINDOW_CHANNEL);
        return host.dispatch({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, request);
      }, on: (channel, listener) => window.webContents.on(channel, listener),
      removeListener: (channel, listener) => window.webContents.removeListener(channel, listener),
    }) });
  }
  return { host, windows, writes, requests, bridge,
    setInteractive(value) { interactive = value; host.refresh(); },
    async launcher() { const window = host.ensureLauncher(); await host.loadFor(window); return { window, bridge: bridge(window) }; },
    async editor() { const window = windows.at(-1); await host.loadFor(window); return { window, bridge: bridge(window) }; },
    async binding(editor) { return { context: await editor.bridge.context(), bridge: editor.bridge }; },
    rememberProject: id => writes.push(id),
  };
}

test('remember protocol fields remain exact, optional, boolean/safe integer metadata', () => {
  const request = { action: 'open', contextId: backendId, projectId: projectA };
  for (const remember of [false, true]) assert.equal(isProjectWindowRequest({ ...request, remember }), true);
  assert.equal(isProjectWindowRequest(request), true);
  for (const remember of [null, undefined, 0, 1, 'true', {}, []]) assert.equal(isProjectWindowRequest({ ...request, remember }), false);
  assert.equal(isProjectWindowRequest({ ...request, remember: true, operation: 'workspace.lastProject.set' }), false);
  const context = { version: 1, role: 'editor', contextId: backendId, backendId, initialProjectId: projectA, autoOpen: false,
    editorProjectId: projectA, editorPhase: 'ready', settingsSlot: null, settingsVersion: 0, quitting: false };
  assert.equal(isProjectWindowContext(context), true);
  for (const rememberVersion of [0, 1, Number.MAX_SAFE_INTEGER]) assert.equal(isProjectWindowContext({ ...context, rememberVersion }), true);
  for (const rememberVersion of [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])
    assert.equal(isProjectWindowContext({ ...context, rememberVersion }), false);
  assert.equal(isProjectWindowContext({ ...context, rememberVersion: 1, locator: 'secret' }), false);
});

test('automatic native startup passes false through both bridges and never remembers', async t => {
  const f = fixture(t), launcher = await f.launcher();
  assert.equal((await launcher.bridge.openProject(projectA, false)).ok, true);
  assert.equal(f.requests.find(request => request.action === 'open').remember, false);
  const editor = await f.editor(), binding = await f.binding(editor);
  assert.equal(binding.context.rememberVersion ?? 0, 0);
  assert.equal(await reportEditorWindowStatus(binding, projectA, 'ready', f), true);
  assert.deepEqual(f.writes, []);
});

test('manual/create selection remembers only after verified ready and once per host version', async t => {
  const f = fixture(t), launcher = await f.launcher();
  assert.equal((await launcher.bridge.openProject(projectA)).ok, true);
  const editor = await f.editor(), first = await f.binding(editor);
  assert.equal(first.context.rememberVersion, 1);
  assert.deepEqual(f.writes, [], 'accepted/opening is never a remember write');
  assert.equal(await reportEditorWindowStatus(first, projectA, 'ready', f), true);
  assert.deepEqual(f.writes, [projectA]);
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', f);
  assert.deepEqual(f.writes, [projectA], 'duplicate ready does not retry metadata');
  assert.equal((await launcher.bridge.openProject(projectA)).reason, 'already-open');
  const next = await f.binding(editor);
  assert.equal(next.context.rememberVersion, 2); assert.deepEqual(f.writes, [projectA]);
  await reportEditorWindowStatus(next, projectA, 'ready', f);
  assert.deepEqual(f.writes, [projectA, projectA]);
  assert.equal(f.windows.length, 2);
});

test('rejected different project and nonlauncher opens cannot mint remember authority', async t => {
  const f = fixture(t), launcher = await f.launcher();
  await launcher.bridge.openProject(projectA, false);
  const editor = await f.editor();
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', f);
  assert.equal((await launcher.bridge.openProject(projectB)).reason, 'another-editor');
  assert.equal((await editor.bridge.openProject(projectA, true)).reason, 'already-open');
  assert.equal((await f.binding(editor)).context.rememberVersion ?? 0, 0);
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', f);
  assert.deepEqual(f.writes, []);
});

test('failed explicit opening clears its intent; recovery alone does not remember it', async t => {
  const f = fixture(t), launcher = await f.launcher();
  await launcher.bridge.openProject(projectA);
  const editor = await f.editor(), opening = await f.binding(editor);
  assert.equal(await reportEditorWindowStatus(opening, projectA, 'failed', f), true);
  assert.equal((await f.binding(editor)).context.rememberVersion ?? 0, 0);
  await reportEditorWindowStatus(opening, projectA, 'ready', f);
  assert.deepEqual(f.writes, []);
  await launcher.bridge.openProject(projectA);
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', f);
  assert.deepEqual(f.writes, [projectA]);
});

test('reload clears remember intent and stale document contexts cannot write', async t => {
  const f = fixture(t), launcher = await f.launcher(); await launcher.bridge.openProject(projectA);
  const editor = await f.editor(), previous = await f.binding(editor);
  await editor.window.loadURL(`${origin}/?project=${projectA}`);
  assert.equal(f.host.contextFor(editor.window).rememberVersion ?? 0, 0);
  await assert.rejects(reportEditorWindowStatus(previous, projectA, 'ready', f));
  editor.bridge = f.bridge(editor.window);
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', f);
  assert.deepEqual(f.writes, []);
});

test('quit, renderer disposal, and failed host ready acceptance never remember', async t => {
  const f = fixture(t), launcher = await f.launcher(); await launcher.bridge.openProject(projectA);
  const editor = await f.editor(), binding = await f.binding(editor);
  assert.equal(await reportEditorWindowStatus(binding, projectB, 'ready', f), false);
  assert.equal(await reportEditorWindowStatus(binding, projectA, 'ready', { ...f, isCurrent: () => false }), false);
  f.setInteractive(false);
  assert.equal(await reportEditorWindowStatus(binding, projectA, 'ready', f), false);
  assert.deepEqual(f.writes, []);
});

test('late context/ready replies cannot borrow a newer version or a disposed editor', async t => {
  const f = fixture(t), launcher = await f.launcher(); await launcher.bridge.openProject(projectA);
  const editor = await f.editor(), binding = await f.binding(editor), held = Promise.withResolvers();
  let active = true;
  const delayed = { ...binding, bridge: { ...binding.bridge, context: () => held.promise } };
  const reporting = reportEditorWindowStatus(delayed, projectA, 'ready', { ...f, isCurrent: () => active });
  await new Promise(setImmediate); active = false;
  held.resolve({ ...binding.context, editorPhase: 'ready' });
  await reporting; assert.deepEqual(f.writes, []);
  await launcher.bridge.openProject(projectA);
  await reportEditorWindowStatus(binding, projectA, 'ready', f);
  assert.deepEqual(f.writes, [], 'old version cannot borrow a newer manual open');
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', f);
  assert.deepEqual(f.writes, [projectA]);
});

test('invalid remember values are refused before any IPC or locator call', async t => {
  const f = fixture(t), launcher = await f.launcher(), before = f.requests.length;
  for (const value of [null, 0, 'yes', {}]) await assert.rejects(launcher.bridge.openProject(projectA, value));
  assert.equal(f.requests.length, before); assert.deepEqual(f.writes, []);
});


test('a delayed describe cannot erase a newer synchronous host quit or remember event', async t => {
  for (const kind of ['quit', 'new-version', 'failed', 'pending-reload', 'same-version']) await t.test(kind, async t => {
    const f = fixture(t), launcher = await f.launcher(); await launcher.bridge.openProject(projectA);
    const editor = await f.editor(), binding = await f.binding(editor);
    const asked = Promise.withResolvers(), held = Promise.withResolvers();
    const delayed = { ...binding, bridge: { ...binding.bridge, context: () => { asked.resolve(); return held.promise; } } };
    const reporting = reportEditorWindowStatus(delayed, projectA, 'ready', f);
    await asked.promise;
    const oldReady = await editor.bridge.context();
    if (kind === 'quit') f.setInteractive(false);
    else if (kind === 'new-version') await launcher.bridge.openProject(projectA);
    else if (kind === 'failed') await editor.bridge.editorStatus(projectA, 'failed');
    else if (kind === 'pending-reload') editor.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/?project=${projectA}` });
    else f.host.refresh();
    held.resolve(oldReady); await reporting;
    assert.deepEqual(f.writes, kind === 'same-version' ? [projectA] : [], 'React cleanup is intentionally not run');
    assert.equal(editor.window.webContents.listenerCount(PROJECT_WINDOW_EVENT), 0, 'temporary observer must release');
  });
});
