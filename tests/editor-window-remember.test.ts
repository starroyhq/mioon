import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createProjectWindowHost } from '../apps/desktop/src/project-window-host.ts';
import { createProjectWindowBridge } from '../apps/desktop/src/project-window-preload.ts';
import { isProjectWindowContext, isProjectWindowRequest, PROJECT_WINDOW_CHANNEL } from '../apps/desktop/src/project-window-protocol.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
import { reportEditorWindowStatus as reportRaw } from '../apps/web/src/editor-native-window.ts';
import { createProjectEntryController } from '../apps/web/src/project-entry-state.ts';
import { createLastProjectController } from '../apps/web/src/last-project-state.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {projectEntryFixture, projectEntryOwnerFixture} from './helpers/project-entry-fixture.ts';
import {schemas} from '../packages/contracts/src/index.ts';
import {createProjectWindowLeaseFixture,projectWindowLeaseValue} from './helpers/project-window-lease-fixture.ts';
type AttachedController = ReturnType<typeof createProjectEntryController>;
type NativeBridge = NonNullable<ReturnType<typeof readDesktopWindowBridge>>;
interface FakeWebContents extends EventEmitter {mainFrame: {url: string}; getURL(): string; send(channel: string, value: unknown): void}
interface FakeWindowView extends EventEmitter {destroyed: boolean; webContents: FakeWebContents; isDestroyed(): boolean; isMinimized(): boolean; show(): void; showInactive(): void; focus(): void; restore(): void; hide(): void; close(): void; loadURL(url: string): Promise<void>}
interface Attached {window: FakeWindowView; bridge: NativeBridge; controller: AttachedController}
const report = (binding: unknown, projectId: string, status: string, options?: Record<string, unknown>) =>
  reportRaw(binding as never, projectId, status as never, options as never);
const backendId = '11111111-1111-4111-8111-111111111111';
const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const projectC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', projectD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const origin = 'http://127.0.0.1:41234';
const tick = () => new Promise(setImmediate);
function fixture(t: TestContext) {
  let interactive = true, token = 0, directory = projectEntryFixture([projectA, projectB, projectC, projectD].map(id => ({id})));
  const windows: FakeWindowView[] = [], requests: unknown[] = [], writes: unknown[] = [], locatorReads: string[] = [], directoryCalls: unknown[][] = [], controllers = new Map<FakeWindowView, AttachedController>();
  class FakeWindow extends EventEmitter implements FakeWindowView {
    destroyed = false;
    webContents: FakeWebContents;
    constructor() { super(); this.webContents = Object.assign(new EventEmitter(), {
      mainFrame: {url: 'about:blank'}, getURL: () => this.webContents.mainFrame.url,
      send: (channel: string, value: unknown) => {this.webContents.emit(channel, {}, value);} }) as FakeWebContents; }
    isDestroyed(): boolean { return this.destroyed; } isMinimized(): boolean { return false; }
    show(): void {} showInactive(): void {} focus(): void {} restore(): void {} hide(): void {}
    close(): void { this.destroyed = true; this.emit('closed'); }
    async loadURL(url: string): Promise<void> { this.webContents.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false, url});
      this.webContents.mainFrame = {url}; this.webContents.emit('did-navigate', {}, url); this.emit('ready-to-show'); }
  }
  const host = createProjectWindowHost({ backendId, launcherUrl: `${origin}/`, settingsUrl: `${origin}/?settings=1`, editorUrl: id => `${origin}/?project=${id}`,
    projectEntries:createProjectWindowLeaseFixture().port,
    admitProject:async(_owner,projectId)=>projectWindowLeaseValue(backendId,projectId).project.projectFile,
    isCurrent: () => true, canInteract: () => interactive, createWindow() { const window = new FakeWindow(); windows.push(window); return window as never; },
    consumeProjectEntry: (owner: {window: FakeWindowView}, entryToken: unknown, projectId: unknown) => typeof entryToken === 'string' && typeof projectId === 'string' ? controllers.get(owner.window)?.consume(entryToken, projectId) : undefined });
  // Deliberately pass the obsolete option as a negative probe: no production
  // readiness, selection or lifecycle path may read or persist this locator.
  const locator = createLastProjectController({client: {
    get: async () => {locatorReads.push('GET'); throw Error('Retired locator read');},
    put: async (value: unknown) => {writes.push(value); throw Error('Retired locator write');},
  } as never});
  t.after(() => { for (const controller of controllers.values()) controller.dispose(); locator.dispose(); host.dispose(); assert.deepEqual(locatorReads, []); assert.deepEqual(writes, []); });
  function bridge(window: FakeWindowView): NativeBridge { return readDesktopWindowBridge({__mioonProjectWindow: createProjectWindowBridge({
    async invoke(channel: string, request: unknown) { requests.push(request); assert.equal(channel, PROJECT_WINDOW_CHANNEL); return host.dispatch({sender: window.webContents, senderFrame: window.webContents.mainFrame}, request as never); },
    on: (channel: string, listener: (...args: unknown[]) => void) => window.webContents.on(channel, listener), removeListener: (channel: string, listener: (...args: unknown[]) => void) => window.webContents.removeListener(channel, listener),
  } as never)})!; }
  async function attach(window: FakeWindowView, launcher = false): Promise<Attached> {
    await host.loadFor(window as never); const native = bridge(window), context = await native.context();
    const identity = projectEntryOwnerFixture(() => directory, directoryCalls);
    const client = createLauncherClient(async () => assert.fail('Selection cannot call project RPC'), {parseCreateInput: value => schemas['project.create'].parse(value), readDirectory: () => readProjectEntryIdentity(identity)});
    const options = {context, bridge: native, client, identity, locator: launcher ? locator : null,
      newToken: () => `77000000-0000-4000-8000-${String(++token).padStart(12, '0')}`};
    const controller = createProjectEntryController(options);
    controllers.set(window, controller); controller.activate(); controller.interacted(); native.subscribe(controller.updateContext); await controller.boot();
    if (!launcher) await controller.show('open');
    return { window, bridge: native, controller };
  }
  async function beginOpen(source: Attached, projectId: string, remember = true) {
    const result = source.controller.open(projectId, remember);
    await tick();
    const target = windows.find(window => host.contextFor(window as never)?.initialProjectId === projectId);
    assert.ok(target);
    return {editor: await attach(target), result};
  }
  return { host, windows, requests, writes, locator, locatorReads, directoryCalls, attach,
    setDirectory(value: typeof directory) {directory = value;},
    async launcher() { return attach(host.ensureLauncher() as unknown as FakeWindowView, true); },
    beginOpen,
    async binding(editor: Attached) { return {context: await editor.bridge.context(), bridge: editor.bridge}; },
    setInteractive(value: boolean): void { interactive = value; host.refresh(); } };
}
test('v2 native open requires exact explicit entry token and no business payload', () => {
  const request = { action: 'open', contextId: backendId, projectId: projectA, remember: true, entryToken: backendId };
  assert.equal(isProjectWindowRequest(request), true);
  for (const patch of [{ entryToken: undefined }, { remember: undefined }, { operation: 'last-project.put' }]) assert.equal(isProjectWindowRequest({ ...request, ...patch }), false);
});
test('automatic native startup is read-only; editors never call their locator callback', async (t: TestContext) => {
  const f = fixture(t), launcher = await f.launcher();
  const {editor, result} = await f.beginOpen(launcher, projectA, false);
  await report(await f.binding(editor), projectA, 'ready', { rememberProject: () => assert.fail('Editor cannot write locator') });
  assert.equal(await result, true);
  await tick(); assert.deepEqual(f.writes, []); const context = await editor.bridge.context(); assert.equal(isProjectWindowContext(context), true); assert.equal(context.editorPhase, 'ready');
  const selection = await launcher.bridge.context(); assert.equal(selection.selectionProjectId, null); assert.equal(selection.selectionVersion, 0);
});
test('editor reports exact status and ignores rejected or stale acknowledgements', async (t: TestContext) => {
  const f = fixture(t), launcher = await f.launcher();
  const {editor, result} = await f.beginOpen(launcher, projectA, false), binding = await f.binding(editor);
  let active = true;
  const calls: unknown[][] = [];
  const options = {isCurrent: () => active};
  const bridge = (accept: (...args: unknown[]) => boolean) => ({
    ...binding, bridge: {...binding.bridge, editorStatus: async (...args: unknown[]) => {
      calls.push(args);
      return accept(...args);
    }},
  });
  assert.equal(await report(bridge(() => false), projectA, 'ready', options), false);
  assert.equal(await report(bridge(() => {active = false; return true;}), projectA, 'ready', options), false);
  active = true;
  const failure = {code: 'PROJECT_MISSING'};
  assert.equal(await report(bridge(() => true), projectA, 'failed', {...options, failure}), true);
  assert.equal(await report(bridge(() => true), projectA, 'ready', options), true);
  assert.deepEqual(calls, [[projectA, 'ready'], [projectA, 'ready'], [projectA, 'failed', failure], [projectA, 'ready']]);
  await report(binding, projectA, 'ready');
  assert.equal(await result, true);
});
test('out-of-order A/B readiness reports only the newest host selection without persisting a locator target', async (t: TestContext) => {
  const f = fixture(t), launcher = await f.launcher();
  const anchor = await f.beginOpen(launcher, projectC, false);
  await report(await f.binding(anchor.editor), projectC, 'ready'); assert.equal(await anchor.result, true);
  const secondAnchor = await f.beginOpen(anchor.editor, projectD, false);
  await report(await f.binding(secondAnchor.editor), projectD, 'ready'); assert.equal(await secondAnchor.result, true);
  const {editor: a, result: resultA} = await f.beginOpen(anchor.editor, projectA);
  const {editor: b, result: resultB} = await f.beginOpen(secondAnchor.editor, projectB);
  await report(await f.binding(a), projectA, 'ready'); await tick(); assert.equal((await launcher.bridge.context()).selectionProjectId, null); assert.equal(f.writes.length, 0);
  await report(await f.binding(b), projectB, 'ready'); await tick();
  assert.deepEqual(await Promise.all([resultA, resultB]), [true, true]);
  const selected = await launcher.bridge.context(); assert.equal(selected.selectionProjectId, projectB); assert.equal(selected.selectionVersion, 2);
  await report(await f.binding(a), projectA, 'ready'); await tick(); assert.equal((await launcher.bridge.context()).selectionProjectId, projectB);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.locatorReads, []);
});
test('ready A then B uses fresh strict directory metadata independently of host selection and has no locator CAS queue', async (t: TestContext) => {
  const f = fixture(t);
  const launcher = await f.launcher(), {editor: a, result: resultA} = await f.beginOpen(launcher, projectA);
  await report(await f.binding(a), projectA, 'ready'); assert.equal(await resultA, true);
  await tick(); assert.equal((await launcher.bridge.context()).selectionProjectId, projectA);
  const reads = f.directoryCalls.length;
  f.setDirectory(projectEntryFixture([{id: projectB, name: '来自新目录的 B'}]));
  const {editor: b, result: resultB} = await f.beginOpen(a, projectB);
  await report(await f.binding(b), projectB, 'ready'); assert.equal(await resultB, true); await tick();
  assert.equal((await launcher.bridge.context()).selectionProjectId, projectB); assert.ok(f.directoryCalls.length > reads);
  await launcher.controller.refresh(); assert.deepEqual(launcher.controller.getState().projects, [{id: projectB, name: '来自新目录的 B', updatedAt: ''}]);
  const snapshot = launcher.controller.identity!.getState().snapshot!; assert.equal(snapshot.registered[0].project.summary, null); assert.equal(snapshot.registered[0].project.lastOpenedAt, null);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.locatorReads, []); assert.ok(f.directoryCalls.every(call => call[1] === '/api/project-entries' && call[2] === 'GET'));
});
test('directory instance replacement blocks a new window before dispatch and cannot borrow a previous ready selection', async (t: TestContext) => {
  const f = fixture(t); const launcher = await f.launcher();
  const {editor: a, result} = await f.beginOpen(launcher, projectA);
  await report(await f.binding(a), projectA, 'ready'); assert.equal(await result, true); await tick();
  const before = f.windows.length, requests = f.requests.length;
  f.setDirectory(projectEntryFixture([{id: projectA}, {id: projectB}], {instanceId: '77000000-0000-4000-8000-000000000010'}));
  assert.equal(await a.controller.open(projectB), false); assert.equal(f.windows.length, before); assert.equal(f.requests.length, requests);
  assert.equal(a.controller.identity!.getState().identityBlocked, true); assert.equal(a.controller.identity!.getVerifiedScope(), null);
  assert.equal((await launcher.bridge.context()).selectionProjectId, projectA, 'Existing host readiness is presentation metadata, not replacement service authority');
  f.setDirectory(projectEntryFixture([{id: projectA}, {id: projectB}])); assert.equal(await a.controller.refresh(), false); assert.equal(await a.controller.open(projectB), false);
  assert.equal(f.windows.length, before); assert.deepEqual(f.writes, []); assert.deepEqual(f.locatorReads, []);
});
test('failed/reloaded/closed target cannot supply late remember eligibility', async (t: TestContext) => {
  for (const action of ['failed', 'reload', 'close']) await t.test(action, async (t: TestContext) => {
    const f = fixture(t), launcher = await f.launcher(), {editor: a, result} = await f.beginOpen(launcher, projectA), old = await f.binding(a);
    if (action === 'failed') await report(old, projectA, 'failed');
    if (action === 'reload') await a.window.loadURL(`${origin}/?project=${projectA}`);
    if (action === 'close') a.window.close();
    const accepted = await report(old, projectA, 'ready').catch(() => false); assert.equal(accepted, false);
    assert.equal(await result, false);
    await tick(); assert.deepEqual(f.writes, []); assert.equal((await launcher.bridge.context()).selectionProjectId, null);
  });
});
test('wrong project and disposed editor cannot even report readiness', async (t: TestContext) => {
  const f = fixture(t), launcher = await f.launcher(), {editor: a, result} = await f.beginOpen(launcher, projectA), binding = await f.binding(a);
  const before = f.requests.length;
  assert.equal(await report(binding, projectB, 'ready'), false);
  assert.equal(await report(binding, projectA, 'ready', { isCurrent: () => false }), false); assert.deepEqual(f.writes, []); assert.equal(f.requests.length, before);
  a.window.close(); assert.equal(await result, false);
});
