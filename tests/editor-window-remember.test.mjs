import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProjectWindowHost } from '../apps/desktop/src/project-window-host.ts';
import { createProjectWindowBridge } from '../apps/desktop/src/project-window-preload.ts';
import { isProjectWindowContext, isProjectWindowRequest, PROJECT_WINDOW_CHANNEL } from '../apps/desktop/src/project-window-protocol.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
import { reportEditorWindowStatus } from '../apps/web/src/editor-native-window.ts';
import { createProjectEntryController } from '../apps/web/src/project-entry-state.ts';
import { createLastProjectController } from '../apps/web/src/last-project-state.ts';
const backendId = '11111111-1111-4111-8111-111111111111';
const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const origin = 'http://127.0.0.1:41234';
const tick = () => new Promise(setImmediate);
function fixture(t, { put } = {}) {
  let interactive = true, token = 0, revision = 0;
  const windows = [], requests = [], writes = [], controllers = new Map();
  class Window extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: 'about:blank' }, getURL: () => this.webContents.mainFrame.url,
      send: (channel, value) => this.webContents.emit(channel, {}, value) }); }
    isDestroyed() { return this.destroyed; } isMinimized() { return false; }
    show() {} showInactive() {} focus() {} restore() {} hide() {}
    close() { this.destroyed = true; this.emit('closed'); }
    async loadURL(url) { this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
      this.webContents.mainFrame = { url }; this.webContents.emit('did-navigate', {}, url); this.emit('ready-to-show'); }
  }
  const host = createProjectWindowHost({ backendId, launcherUrl: `${origin}/`, settingsUrl: `${origin}/?settings=1`, editorUrl: id => `${origin}/?project=${id}`,
    isCurrent: () => true, canInteract: () => interactive, createWindow() { const window = new Window(); windows.push(window); return window; },
    consumeProjectEntry: (owner, entryToken, projectId) => controllers.get(owner.window)?.consume(entryToken, projectId) });
  const envelope = (projectId = null, rev = 0) => ({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: backendId,
    projectId, revision: rev, updatedAt: projectId ? '2026-10-13T00:00:00.000Z' : null, targetStatus: projectId ? 'matching' : 'unset' });
  const locator = createLastProjectController({ client: { get: async () => envelope(), put: async value => {
    writes.push(value); if (put) return put(value, envelope); revision++; return envelope(value.projectId, revision); } } });
  t.after(() => { for (const controller of controllers.values()) controller.dispose(); host.dispose(); });
  const client = { inspect: async () => ({ restored: false, workspaceOrigin: null }), list: async () => [projectA, projectB].map(id => ({ id, name: id, updatedAt: '2026-10-13T00:00:00.000Z' })), create: async () => assert.fail('No create in selection test') };
  function bridge(window) { return readDesktopWindowBridge({ __mioonProjectWindow: createProjectWindowBridge({
    async invoke(channel, request) { requests.push(request); assert.equal(channel, PROJECT_WINDOW_CHANNEL); return host.dispatch({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, request); },
    on: (channel, listener) => window.webContents.on(channel, listener), removeListener: (channel, listener) => window.webContents.removeListener(channel, listener),
  }) }); }
  async function attach(window, launcher = false) {
    await host.loadFor(window); const native = bridge(window), context = await native.context();
    const controller = createProjectEntryController({ context, bridge: native, client, locator: launcher ? locator : null,
      newToken: () => `77000000-0000-4000-8000-${String(++token).padStart(12, '0')}` });
    controllers.set(window, controller); controller.activate(); controller.interacted(); native.subscribe(controller.updateContext); await controller.boot();
    if (!launcher) await controller.show('open');
    return { window, bridge: native, controller };
  }
  return { host, windows, requests, writes, locator, attach,
    async launcher() { return attach(host.ensureLauncher(), true); },
    async editor(id) { return attach(windows.find(window => host.contextFor(window)?.initialProjectId === id)); },
    async binding(editor) { return { context: await editor.bridge.context(), bridge: editor.bridge }; },
    setInteractive(value) { interactive = value; host.refresh(); } };
}
test('v2 native open requires exact explicit entry token and no business payload', () => {
  const request = { action: 'open', contextId: backendId, projectId: projectA, remember: true, entryToken: backendId };
  assert.equal(isProjectWindowRequest(request), true);
  for (const patch of [{ entryToken: undefined }, { remember: undefined }, { operation: 'last-project.put' }]) assert.equal(isProjectWindowRequest({ ...request, ...patch }), false);
});
test('automatic native startup is read-only; editors never call their locator callback', async t => {
  const f = fixture(t), launcher = await f.launcher();
  await launcher.controller.open(projectA, false); const editor = await f.editor(projectA);
  await reportEditorWindowStatus(await f.binding(editor), projectA, 'ready', { rememberProject: () => assert.fail('Editor cannot write locator') });
  await tick(); assert.deepEqual(f.writes, []); assert.equal(isProjectWindowContext(await editor.bridge.context()), true);
});
test('out-of-order A/B readiness remembers only newest explicit target through one launcher queue', async t => {
  const f = fixture(t), launcher = await f.launcher();
  await launcher.controller.open(projectA); const a = await f.editor(projectA);
  await a.controller.open(projectB); const b = await f.editor(projectB);
  await reportEditorWindowStatus(await f.binding(a), projectA, 'ready'); await tick(); assert.equal(f.writes.length, 0);
  await reportEditorWindowStatus(await f.binding(b), projectB, 'ready'); await tick();
  assert.deepEqual(f.writes.map(value => value.projectId), [projectB]);
  await reportEditorWindowStatus(await f.binding(a), projectA, 'ready'); await tick(); assert.equal(f.writes.length, 1);
});
test('one launcher serializes already-dispatched A then B with exact CAS revision', async t => {
  const held = Promise.withResolvers(); let count = 0;
  const f = fixture(t, { put: (value, envelope) => ++count === 1 ? held.promise : Promise.resolve(envelope(value.projectId, value.expectedRevision + 1)) });
  const launcher = await f.launcher(); await launcher.controller.open(projectA); const a = await f.editor(projectA);
  await reportEditorWindowStatus(await f.binding(a), projectA, 'ready'); await tick(); assert.equal(f.writes.length, 1);
  await a.controller.open(projectB); const b = await f.editor(projectB); await reportEditorWindowStatus(await f.binding(b), projectB, 'ready'); await tick();
  assert.equal(f.writes.length, 1, 'B must wait for exact A ACK');
  held.resolve({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: backendId, projectId: projectA, revision: 1, updatedAt: '2026-10-13T00:00:00.000Z', targetStatus: 'matching' });
  await tick(); assert.deepEqual(f.writes.map(value => [value.projectId, value.expectedRevision]), [[projectA, 0], [projectB, 1]]);
});
test('unknown locator PUT retains exact old body and blocks the next editor selection', async t => {
  const f = fixture(t, { put: async () => { throw new Error('lost ACK'); } }); const launcher = await f.launcher();
  await launcher.controller.open(projectA); const a = await f.editor(projectA); await reportEditorWindowStatus(await f.binding(a), projectA, 'ready'); await tick();
  const pending = f.locator.getState().pendingInput; assert.equal(f.locator.getState().uncertain, true);
  await a.controller.open(projectB); const b = await f.editor(projectB); await reportEditorWindowStatus(await f.binding(b), projectB, 'ready'); await tick();
  assert.equal(f.writes.length, 1); assert.deepEqual(f.locator.getState().pendingInput, pending);
});
test('failed/reloaded/closed target cannot supply late remember eligibility', async t => {
  for (const action of ['failed', 'reload', 'close']) await t.test(action, async t => {
    const f = fixture(t), launcher = await f.launcher(); await launcher.controller.open(projectA); const a = await f.editor(projectA), old = await f.binding(a);
    if (action === 'failed') await reportEditorWindowStatus(old, projectA, 'failed');
    if (action === 'reload') await a.window.loadURL(`${origin}/?project=${projectA}`);
    if (action === 'close') a.window.close();
    if (action === 'failed') await reportEditorWindowStatus(old, projectA, 'ready');
    else { const accepted = await reportEditorWindowStatus(old, projectA, 'ready').catch(() => false); assert.equal(accepted, false); }
    await tick(); assert.deepEqual(f.writes, []);
  });
});
test('wrong project and disposed editor cannot even report readiness', async t => {
  const f = fixture(t), launcher = await f.launcher(); await launcher.controller.open(projectA); const a = await f.editor(projectA), binding = await f.binding(a);
  assert.equal(await reportEditorWindowStatus(binding, projectB, 'ready'), false);
  assert.equal(await reportEditorWindowStatus(binding, projectA, 'ready', { isCurrent: () => false }), false); assert.deepEqual(f.writes, []);
});
