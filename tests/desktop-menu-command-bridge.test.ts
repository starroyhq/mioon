import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createMenuCommandHost} from '../apps/desktop/src/menu-command-host.ts';
import type {MenuCommandDocument} from '../apps/desktop/src/menu-command-host.ts';
import {createMenuCommandBridge} from '../apps/desktop/src/menu-command-preload.ts';
import {menuCommandGestureScript} from '../apps/desktop/src/menu-command-gesture.ts';
import vm from 'node:vm';
import {MENU_COMMAND_CHANNEL, MENU_COMMAND_EVENT, MENU_COMMAND_IDS, isMenuCommandId, isMenuCommandIntent,
  isMenuCommandRequest, isMenuCommandState, isMenuDocumentIdentity} from '../apps/desktop/src/menu-command-protocol.ts';
import type {MenuCommandId, MenuCommandIntent, MenuCommandState, MenuDocumentIdentity} from '../apps/desktop/src/menu-command-protocol.ts';

const id = '11111111-1111-4111-8111-111111111111', otherId = '22222222-2222-4222-8222-222222222222';
const identity: MenuDocumentIdentity = {version: 1, windowId: id, backendId: id, contextId: id, role: 'editor'};
const commands = (enabled = true): Record<MenuCommandId, boolean> => Object.fromEntries(MENU_COMMAND_IDS.map(command => [command, enabled])) as Record<MenuCommandId, boolean>;
const state = (reportVersion = 1): MenuCommandState => ({version: 1, reportVersion, editingContext: 'timeline', workspaceMode: 'editing',
  assetsVisible: true, inspectorVisible: true, timelineVisible: true, commands: commands()});
const intent = (sequence = 1, reportVersion = 1): MenuCommandIntent => ({...identity, command: 'clip-split', sequence, reportVersion});

function fixture() {
  const first = {key: 'first'}, second = {key: 'second'}, frame = {}, otherFrame = {};
  type Contents = typeof first;
  const documents = new Map<Contents, MenuCommandDocument>(), sent: {document: MenuCommandDocument; intent: MenuCommandIntent}[] = [];
  let allowed = true, changes = 0, failSend = false, policy: (() => void) | null = null, throwRead = false;
  function document(contents: Contents, patch: Partial<MenuDocumentIdentity> = {}, documentFrame: unknown = frame) {
    const value: MenuCommandDocument = {...identity, ...patch, frame: documentFrame, isCurrent: () => documents.get(contents) === value};
    documents.set(contents, value); return value;
  }
  document(first); document(second, {windowId: otherId, contextId: otherId}, otherFrame);
  const host = createMenuCommandHost({
    getDocument(contents: Contents) { if (throwRead) throw Error('synthetic disappearing native handle'); return documents.get(contents) ?? null; },
    isAllowed() { policy?.(); return allowed; },
    send(document, value) { if (failSend) throw Error('synthetic lost dispatch'); sent.push({document, intent: value}); },
    onChanged() { changes++; },
  });
  return {host, first, second, frame, otherFrame, sent, documents, document,
    get changes() { return changes; }, setAllowed(value: boolean) { allowed = value; }, failSend() { failSend = true; },
    setPolicy(value: () => void) { policy = value; }, throwRead() { throwRead = true; },
    publish(contents = first, next = state(), requestContext = documents.get(contents)!.contextId, senderFrame = documents.get(contents)!.frame) {
      return host.dispatch({sender: contents, senderFrame}, {action: 'publish', contextId: requestContext, state: next});
    }};
}

test('menu protocol permits exactly bounded presentation state and fixed commands', () => {
  assert.equal(isMenuDocumentIdentity(identity), true); assert.equal(isMenuCommandState(state()), true);
  assert.equal(isMenuCommandRequest({action: 'describe'}), true);
  assert.equal(isMenuCommandRequest({action: 'publish', contextId: id, state: state()}), true);
  for (const command of MENU_COMMAND_IDS) assert.equal(isMenuCommandId(command), true);
  for (const bad of ['image.generate', '/tmp/file', {toString: () => 'export'}, '', null]) assert.equal(isMenuCommandId(bad), false);
  for (const bad of [{...identity, version: 2}, {...identity, contextId: ''}, {...identity, role: 'admin'}, {...identity, path: '/tmp/private'}]) assert.equal(isMenuDocumentIdentity(bad), false);
  for (const bad of [{...state(), reportVersion: 0}, {...state(), reportVersion: Number.MAX_SAFE_INTEGER + 1}, {...state(), editingContext: 'canvas'},
    {...state(), workspaceMode: 'settings'}, {...state(), assetsVisible: 1}, {...state(), commands: {...commands(), 'image.generate': true}},
    {...state(), commands: {...commands(), export: 'yes'}}, {...state(), commands: {}}, {...state(), operation: 'export.create'}]) assert.equal(isMenuCommandState(bad), false);
  for (const bad of [{action: 'publish', contextId: id, state: state(), windowId: id}, {action: 'describe', contextId: id}, {action: 'execute', command: 'export'}]) assert.equal(isMenuCommandRequest(bad), false);
  for (const bad of [{...intent(), sequence: 0}, {...intent(), command: 'video.generate'}, {...intent(), path: '/tmp/file'}, {...intent(), version: 2},
    {...intent(), reportVersion: undefined}, {...intent(), reportVersion: 0}, {...intent(), reportVersion: -1}, {...intent(), reportVersion: Number.NaN},
    {...intent(), reportVersion: Number.MAX_SAFE_INTEGER + 1}]) assert.equal(isMenuCommandIntent(bad), false);
});

test('host sends one immutable intent only to the exact reported document', () => {
  const f = fixture();
  assert.equal(f.host.send(f.first, 'clip-split'), false);
  assert.deepEqual(f.host.dispatch({sender: f.first, senderFrame: f.frame}, {action: 'describe'}), identity);
  assert.equal(f.publish(), true);
  assert.equal(f.host.canDispatch(f.first, 'clip-split'), true);
  assert.equal(f.host.canDispatch(f.second, 'clip-split'), false);
  assert.equal(f.host.send(f.first, 'clip-split'), true);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].document, f.documents.get(f.first));
  assert.deepEqual(f.sent[0].intent, intent()); assert.equal(Object.isFrozen(f.sent[0].intent), true);
  assert.equal(f.changes, 1);
});

test('reports are immutable ordered display hints and cannot bypass a live host fence', () => {
  const f = fixture(), report = state(); f.publish(f.first, report);
  (report.commands as Record<MenuCommandId, boolean>)['clip-split'] = false;
  assert.equal(f.host.stateFor(f.first)!.commands['clip-split'], true);
  assert.equal(Object.isFrozen(f.host.stateFor(f.first)!.commands), true);
  assert.equal(f.publish(f.first, {...state(), commands: commands(false)}), false);
  assert.equal(f.publish(f.first, {...state(2), commands: commands(false)}), true);
  assert.equal(f.publish(f.first, state()), false); assert.equal(f.host.send(f.first, 'clip-split'), false);
  f.publish(f.first, state(3)); f.setAllowed(false);
  assert.equal(f.host.canDispatch(f.first, 'clip-split'), false); assert.equal(f.host.send(f.first, 'clip-split'), false);
  assert.equal(f.sent.length, 0);
});

test('each dispatched intent echoes its exact current frozen report version without business selection data', () => {
  const f = fixture(); f.publish(f.first, state(7));
  assert.equal(f.host.send(f.first, 'clip-split'), true); f.publish(f.first, state(8));
  assert.equal(f.host.send(f.first, 'clip-split'), true);
  assert.deepEqual(f.sent.map(value => value.intent.reportVersion), [7, 8]);
  assert.deepEqual(f.sent.map(value => value.intent.sequence), [1, 2]);
  assert.deepEqual(Object.keys(f.sent[0].intent).sort(), ['version', 'windowId', 'backendId', 'contextId', 'role', 'command', 'sequence', 'reportVersion'].sort());
});

test('foreign frames, windows and extra fields cannot publish menu state', () => {
  const f = fixture();
  assert.throws(() => f.publish(f.first, state(), id, f.otherFrame));
  assert.throws(() => f.publish(f.second, state(), id));
  assert.throws(() => f.host.dispatch({sender: f.first, senderFrame: f.frame}, {action: 'publish', contextId: id, state: state(), command: 'export'}));
  assert.equal(f.host.stateFor(f.first), null); assert.equal(f.host.stateFor(f.second), null); assert.equal(f.changes, 0);
});

for (const replacement of ['context', 'frame', 'backend', 'window', 'closed'] as const) test(`${replacement} replacement retires the previous report without lending the new document an intent`, () => {
  const f = fixture(); f.publish();
  if (replacement === 'closed') f.documents.delete(f.first);
  else f.document(f.first, replacement === 'context' ? {contextId: otherId} : replacement === 'backend' ? {backendId: otherId} : replacement === 'window' ? {windowId: otherId} : {}, replacement === 'frame' ? {} : f.frame);
  assert.equal(f.host.stateFor(f.first), null); assert.equal(f.host.send(f.first, 'clip-split'), false); assert.equal(f.sent.length, 0);
  if (replacement === 'context') assert.throws(() => f.publish(f.first, state(), id));
});

test('a fresh document may start its own report sequence but an old same-frame context cannot publish', () => {
  const f = fixture(); f.publish(f.first, state(8));
  f.document(f.first, {contextId: otherId});
  assert.throws(() => f.publish(f.first, state(9), id));
  assert.equal(f.publish(f.first, state()), true);
  assert.equal(f.host.send(f.first, 'export'), true);
  assert.equal(f.sent[0].intent.contextId, otherId); assert.equal(f.sent[0].intent.sequence, 1);
});

test('synchronous policy changes and failed native reads cannot dispatch stale work', () => {
  const f = fixture(); f.publish();
  f.setPolicy(() => { f.document(f.first, {contextId: otherId}); });
  assert.equal(f.host.send(f.first, 'clip-split'), false); assert.equal(f.sent.length, 0);
  const other = fixture(); other.publish(); other.throwRead();
  assert.equal(other.host.stateFor(other.first), null); assert.equal(other.host.send(other.first, 'export'), false);
  assert.throws(() => other.publish());
});

test('a newly disabled report and missing main frame cannot inherit an earlier dispatch check', () => {
  const f = fixture(); f.publish(); let calls = 0;
  f.setPolicy(() => { if (++calls === 1) f.publish(f.first, {...state(2), commands: commands(false)}); });
  assert.equal(f.host.send(f.first, 'clip-split'), false); assert.equal(f.sent.length, 0);
  const missing = fixture(); missing.document(missing.first, {}, null);
  assert.throws(() => missing.publish(missing.first, state(), id, null)); assert.equal(missing.host.send(missing.first, 'export'), false);
});

test('uncertain transport results are never retried and disposal denies future work', () => {
  const f = fixture(); f.publish(); f.failSend();
  assert.equal(f.host.send(f.first, 'export'), false); assert.equal(f.sent.length, 0);
  f.host.forget(f.first); assert.equal(f.host.stateFor(f.first), null); assert.equal(f.host.send(f.first, 'export'), false);
  f.publish(); f.host.dispose(); const changes = f.changes; f.host.dispose();
  assert.equal(f.changes, changes); assert.equal(f.host.stateFor(f.first), null); assert.equal(f.host.send(f.first, 'export'), false);
  assert.throws(() => f.publish());
});

test('preload pins identity, strips native events and consumes duplicate or old commands once', async () => {
  const listeners = new Set<(event: unknown, value: unknown) => void>(), calls: unknown[] = [], received: MenuCommandIntent[] = [];
  let described: MenuDocumentIdentity = identity;
  const bridge = createMenuCommandBridge({invoke: async (channel, request) => { assert.equal(channel, MENU_COMMAND_CHANNEL); calls.push(request); return request.action === 'describe' ? described : true; },
    on: (channel, receive) => { assert.equal(channel, MENU_COMMAND_EVENT); listeners.add(receive); }, removeListener: (_channel, receive) => { listeners.delete(receive); }});
  assert.deepEqual(Object.keys(bridge).sort(), ['context', 'publish', 'receiveUserGesture', 'subscribe']); assert.equal(Object.isFrozen(bridge), true);
  await bridge.publish(state()); const release = bridge.subscribe(value => received.push(value));
  const emit = (value: unknown) => { for (const receive of [...listeners]) receive({sender: {send() {assert.fail();}}, private: 'not exposed'}, value); };
  emit(intent()); emit(intent()); emit({...intent(2), contextId: otherId}); emit({...intent(3), windowId: otherId}); emit({...intent(4), backendId: otherId});
  emit({...intent(5), role: 'settings'}); emit({...intent(6), path: '/tmp/private'}); emit({...intent(6), reportVersion: undefined});
  emit({...intent(6), reportVersion: 0}); emit(intent(7)); emit(intent(6));
  assert.deepEqual(received, [intent(), intent(7)]); assert.ok(received.every(value => Object.isFrozen(value)));
  release(); release(); emit(intent(8)); assert.equal(received.length, 2); assert.equal(listeners.size, 0);
  const published = calls.filter(value => (value as {action:string}).action === 'publish').length;
  described = {...identity, contextId: otherId}; await assert.rejects(bridge.publish(state(2)));
  assert.equal(calls.filter(value => (value as {action:string}).action === 'publish').length, published);
});

test('preload replaces the command consumer instead of dispatching one intent to two controllers', async () => {
  const listeners = new Set<(event: unknown, value: unknown) => void>(), received: string[] = [];
  const bridge = createMenuCommandBridge({invoke: async () => identity, on: (_channel, receive) => {listeners.add(receive);}, removeListener: (_channel, receive) => {listeners.delete(receive);}});
  await bridge.context(); const old = bridge.subscribe(() => received.push('old')), current = bridge.subscribe(() => received.push('current'));
  old(); assert.equal(listeners.size, 1);
  for (const receive of [...listeners]) receive({}, intent());
  assert.deepEqual(received, ['current']); current(); assert.equal(listeners.size, 0);
});

test('publishing captures state before awaiting identity and refuses malformed responses without retry', async () => {
  const held = Promise.withResolvers<unknown>(), sent: unknown[] = [];
  const bridge = createMenuCommandBridge({invoke: async (_channel, request) => { if (request.action === 'describe') return held.promise; sent.push(request); return true; }, on(){}, removeListener(){}});
  const source = state(), publish = bridge.publish(source);
  (source.commands as Record<MenuCommandId, boolean>).export = false;
  held.resolve(identity); assert.equal(await publish, true);
  assert.equal((sent[0] as {state:MenuCommandState}).state.commands.export, true);
  await assert.rejects(bridge.publish({...state(), operation:'video.generate'} as MenuCommandState)); assert.equal(sent.length, 1);
  let invokes = 0;
  const malformed = createMenuCommandBridge({invoke: async (_channel, request) => {invokes++; return request.action === 'describe' ? identity : {accepted:true};}, on(){}, removeListener(){}});
  await assert.rejects(malformed.publish(state())); assert.equal(invokes, 2);
});

test('fixed user-gesture entry accepts only import and shares identity, sequence and consumer checks with IPC', async () => {
  const listeners = new Set<(event: unknown, value: unknown) => void>(), received: MenuCommandIntent[] = [];
  const bridge = createMenuCommandBridge({invoke: async () => identity, on: (_channel, receive) => {listeners.add(receive);}, removeListener: (_channel, receive) => {listeners.delete(receive);}});
  const upload = {...intent(), command: 'import-media' as const};
  assert.equal(bridge.receiveUserGesture(upload), false, 'No context or active consumer means no deferred dispatch');
  await bridge.context(); const release = bridge.subscribe(value => received.push(value));
  for (const bad of [{...upload, command: 'export'}, {...upload, command: 'video.generate'}, {...upload, contextId: otherId},
    {...upload, backendId: otherId}, {...upload, windowId: otherId}, {...upload, role: 'settings'}, {...upload, path: '/tmp/private'}, {...upload, reportVersion: 0}]) {
    assert.equal(bridge.receiveUserGesture(bad), false);
  }
  assert.equal(bridge.receiveUserGesture(upload), true); assert.equal(bridge.receiveUserGesture(upload), false);
  for (const receive of listeners) receive({private: 'not exposed'}, upload);
  assert.deepEqual(received, [upload]);
  const next = {...upload, sequence: 2};
  for (const receive of listeners) receive({}, next);
  assert.equal(bridge.receiveUserGesture(next), false, 'IPC and gesture may never consume the same intent twice');
  release(); assert.equal(bridge.receiveUserGesture({...upload, sequence: 3}), false); assert.equal(received.length, 2);
});

test('gesture entry retains the one current command consumer and a frozen context', async () => {
  const listeners = new Set<(event: unknown, value: unknown) => void>(), received: string[] = [];
  let current = identity;
  const bridge = createMenuCommandBridge({invoke: async () => current, on: (_channel, receive) => {listeners.add(receive);}, removeListener: (_channel, receive) => {listeners.delete(receive);}});
  await bridge.context(); const old = bridge.subscribe(() => received.push('old')), release = bridge.subscribe(() => received.push('new'));
  old(); assert.equal(bridge.receiveUserGesture({...intent(), command: 'import-media'}), true); assert.deepEqual(received, ['new']);
  current = {...identity, contextId: otherId}; await assert.rejects(bridge.context());
  assert.equal(bridge.receiveUserGesture({...intent(2), command: 'import-media', contextId: otherId}), false);
  release(); assert.equal(listeners.size, 0);
});

test('gesture whitelist snapshots changing getters and refuses throwing getters before consumption', async () => {
  const received: MenuCommandIntent[] = [];
  const bridge = createMenuCommandBridge({invoke: async () => identity, on(){}, removeListener(){}});
  await bridge.context(); bridge.subscribe(value => received.push(value));
  let reads = 0;
  const changed = {...intent(), get command() {return ++reads === 1 ? 'import-media' : 'clip-split';}};
  assert.equal(bridge.receiveUserGesture(changed), false);
  assert.equal(bridge.receiveUserGesture({...intent(), get command() {throw Error('synthetic getter');}}), false);
  assert.equal(received.length, 0);
  assert.equal(bridge.receiveUserGesture({...intent(), command: 'import-media'}), true, 'Rejected values must not spend a legitimate sequence');
  assert.equal(received.length, 1); assert.equal(received[0].command, 'import-media'); assert.equal(Object.isFrozen(received[0]), true);
});

test('user-activated import script calls only its fixed validated entry with bounded scalar identity', () => {
  const upload = {...intent(), command: 'import-media' as const}, calls: unknown[] = [];
  const source = menuCommandGestureScript(upload);
  assert.ok(source.length < 600);
  assert.equal(vm.runInNewContext(source, {__mioonMenuCommands: {receiveUserGesture(value: unknown) {calls.push(value); return true;}}}), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [upload]);
  assert.equal(vm.runInNewContext(source, {}), false); assert.equal(vm.runInNewContext(source, {__mioonMenuCommands: {}}), false);
  for (const bad of [{...upload, command: 'export'}, {...upload, command: 'video.generate'}, {...upload, sequence: 0},
    {...upload, reportVersion: Number.MAX_SAFE_INTEGER + 1}, {...upload, contextId: 'x'.repeat(4096)}, {...upload, script: 'arbitrary()'},
    {...upload, path: '/tmp/private'}, {...upload, selector: 'input'}]) assert.throws(() => menuCommandGestureScript(bad));
  let reads = 0;
  const changing = {...upload, get windowId() {return ++reads === 1 ? id : 'x'.repeat(4096);}};
  assert.throws(() => menuCommandGestureScript(changing));
});

test('the actual sandbox preload bundles the menu bridge with Electron as its sole import', async () => {
  const result = await build({entryPoints: ['apps/desktop/src/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], write: false, metafile: true});
  assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)), ['electron']);
  assert.match(result.outputFiles[0].text, /exposeInMainWorld\("__mioonMenuCommands"/);
  assert.doesNotMatch(result.outputFiles[0].text, /node:|\.sendSync\(|\.postMessage\(|webContents|process\.env/);
});
