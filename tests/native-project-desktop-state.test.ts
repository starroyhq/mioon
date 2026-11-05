import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createNativeProjectDesktopController, projectLocationRisks} from '../apps/web/src/native-project-desktop-state.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {projectEntryFixture, projectEntryOwnerFixture, PROJECT_ENTRY_TEST_INSTANCE} from './helpers/project-entry-fixture.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), createdId = id(2), token = id(3);
const facts = {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'} as const;
const capabilities = {ready: true, create: true, open: true, saveAs: true, duplicate: true, copyTo: true, adoptCopy: true, help: true, reveal: true, openOriginal: true, copySource: true, locationFacts: true};
const registered = projectEntryFixture([{id: projectId}, {id: createdId}]);
const created = registered.registered[1].project;
type Handler = (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function fixture(t: TestContext, handlers: Record<string, Handler> = {}) {
  const calls: Record<string, unknown>[] = [], directoryCalls: unknown[][] = [], opened: string[] = [], dispatched: string[] = [];
  let directory = registered;
  let heldRead: Promise<unknown> | null = null;
  const identity = projectEntryOwnerFixture(() => heldRead ?? directory, directoryCalls); t.after(() => identity.dispose());
  const preload = createProjectEntriesDesktopBridge(async (_channel, input) => {
    assert.ok(input !== null && typeof input === 'object' && 'action' in input);
    const request = input as Record<string, unknown>; calls.push(request);
    const defaults: Record<string, unknown> = {capabilities, listRecent: directory, takePendingOpen: null, currentLocation: {displayPath: '/synthetic/project.mioon', facts},
      chooseLocation: {token, displayPath: '/synthetic/selected', facts}, createAtSelection: {status: 'created', project: created},
      openSelectedFile: {status: 'cancelled'}, openRecent: {status: 'opened', projectId, windowId: id(9)}, openPrivacySettings: null, reveal: null};
    return {ok: true, data: handlers[String(request.action)] ? await handlers[String(request.action)](request) : defaults[String(request.action)]};
  });
  const client = readProjectEntryDesktopClient({__mioonProjectEntries: preload}); assert.ok(client);
  let consent = true, visible = true;
  const controller = createNativeProjectDesktopController({client, identity,
    beforeAction: async () => {if (!consent) return false; await readProjectEntryIdentity(identity); return true;},
    openCreated: async value => {opened.push(value); return true;}, isCurrent: () => visible, onOpened: () => dispatched.push('host-opened'), message: () => 'Shared save panel message', newId: () => id(10)});
  controller.activate(); t.after(() => controller.dispose()); await controller.initialize(false);
  return {controller, client, identity, calls, directoryCalls, opened, dispatched, consent(value: boolean) {consent = value;}, visible(value: boolean) {visible = value;}, directory(value: typeof directory) {directory = value;}, holdDirectory(value: Promise<unknown> | null) {heldRead = value;}};
}
test('strict native adapter accepts nullable RecentProject without inventing canonical revision and forces saveAs off', async t => {
  const f = await fixture(t); assert.equal(f.controller.getState().capabilities?.saveAs, false);
  f.controller.showCreate(); f.controller.change({name: 'Native project', createFolder: false}); await f.controller.chooseLocation();
  assert.equal(await f.controller.create(), true); assert.deepEqual(f.opened, [createdId]); assert.equal(created.summary, null);
  const input = f.calls.find(call => call.action === 'createAtSelection'); assert.equal(input?.createFolder, false); assert.equal(input?.token, token);
  await assert.rejects(f.client.saveAs({token, projectId, requestId: id(10)}), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.equal(f.calls.some(call => call.action === 'saveAs'), false);
});
test('cancelled panels and cancelled departure dispatch no create/copy/open and retain form inputs', async t => {
  const f = await fixture(t, {chooseLocation: () => null}); f.controller.showCreate(); f.controller.change({name: 'Keep this', description: 'Draft'});
  assert.equal(await f.controller.chooseLocation(), false); assert.equal(await f.controller.openFile(), false); assert.equal(await f.controller.create(), false);
  const count = f.calls.length, reads = f.directoryCalls.length; f.consent(false); await f.controller.openFile();
  assert.equal(f.calls.length, count); assert.equal(f.directoryCalls.length, reads); f.controller.closeCreate(); f.controller.showCreate();
  assert.equal(f.controller.getState().values.description, 'Draft'); assert.deepEqual(f.opened, []); assert.deepEqual(f.dispatched, []);
  assert.equal(f.calls.some(call => ['createAtSelection', 'duplicate', 'copyTo', 'openRecent'].includes(String(call.action))), false);
});
test('opened from selected file is already a host operation and never opens a second window', async t => {
  const f = await fixture(t, {openSelectedFile: () => ({status: 'opened', projectId, windowId: id(9)})});
  assert.equal(await f.controller.openFile(), true); assert.deepEqual(f.dispatched, ['host-opened']); assert.deepEqual(f.opened, []);
  assert.equal(f.calls.filter(call => call.action === 'openSelectedFile').length, 1); assert.equal(f.calls.some(call => call.action === 'openRecent'), false);
});
test('COPY publishes only verified original display facts and invokes its exact host token', async t => {
  const f = await fixture(t, {openSelectedFile: () => ({status: 'copy', token, name: 'Copy', original: {name: 'Original', displayPath: '/verified/original.mioon'}}),
    openOriginal: request => {assert.equal(request.token, token); return {status: 'opened', projectId, windowId: id(9)};}});
  await f.controller.openFile(); const failure = f.controller.getState().failure; assert.equal(failure?.issue.code, 'PROJECT_FILE_COPY');
  if (failure?.issue.code === 'PROJECT_FILE_COPY') {assert.equal(failure.issue.originalProjectId, null); assert.equal(failure.issue.originalProjectFile, '/verified/original.mioon');}
  assert.equal(await f.controller.openOriginal(), true); assert.deepEqual(f.opened, []);
  const without = await fixture(t, {openSelectedFile: () => ({status: 'copy', token, name: 'Copy'})}); await without.controller.openFile();
  assert.equal(await without.controller.openOriginal(), false); assert.equal(without.calls.some(call => call.action === 'openOriginal'), false);
  without.controller.closeFailure(); assert.equal(without.calls.some(call => call.action === 'adoptCopy'), false);
});
test('read-only and network copyTo use the same save panel message and exact source token then open the new identity', async t => {
  for (const reason of ['read-only', 'network'] as const) {
    const f = await fixture(t, {openSelectedFile: () => ({status: 'copy-source', token, name: 'Source', displayPath: '/observed/source.mioon', reason, facts: {...facts, isLocal: reason !== 'network', volumeReadOnly: reason === 'read-only'}}),
      copyTo: request => ({requestId: request.requestId, sourceProjectId: projectId, project: created, contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0})});
    await f.controller.openFile(); assert.equal(await f.controller.copyTo(), true);
    const panel = f.calls.find(call => call.action === 'chooseLocation'); assert.equal(panel?.purpose, 'copy-to'); assert.equal(panel?.suggestedName, 'Source'); assert.equal(panel?.message, 'Shared save panel message');
    assert.equal(f.calls.find(call => call.action === 'copyTo')?.sourceToken, token); assert.deepEqual(f.opened, [createdId]);
  }
});
test('unknown create retains exact inputs and close protection; refresh does not replay; explicit recheck never creates another key', async t => {
  let calls = 0;
  const f = await fixture(t, {createAtSelection: () => {if (++calls === 1) throw Error('Lost acknowledgement'); return {status: 'created', project: created};}});
  f.controller.showCreate(); f.controller.change({name: 'Exact name'}); await f.controller.chooseLocation();
  assert.equal(await f.controller.create(), false); assert.equal(f.controller.getState().createState.kind, 'unknown'); assert.equal(f.controller.readCloseSnapshot().unknown, true);
  f.controller.closeCreate(); f.controller.change({name: 'Changed'}); await f.controller.initialize(false); assert.equal(calls, 1); assert.equal(f.controller.getState().values.name, 'Exact name');
  assert.equal(await f.controller.recheck(), true); assert.deepEqual(f.calls.filter(call => call.action === 'createAtSelection')[0], f.calls.filter(call => call.action === 'createAtSelection')[1]);
  assert.deepEqual(f.opened, [createdId]); assert.equal(f.controller.readCloseSnapshot().unknown, false);
});
test('held selected-file response is isolated after replacement directory instance and cannot publish or dispatch', async t => {
  const held = Promise.withResolvers<unknown>(); const f = await fixture(t, {openSelectedFile: () => held.promise});
  const pending = f.controller.openFile(); await new Promise(setImmediate); assert.equal(f.controller.getState().busy, true);
  f.directory(projectEntryFixture([{id: projectId}], {instanceId: id(60)})); await f.identity.refresh();
  held.resolve({status: 'opened', projectId, windowId: id(9)}); assert.equal(await pending, false); assert.equal(f.controller.getState().blocked, true); assert.deepEqual(f.dispatched, []);
  f.directory(registered); await f.identity.refresh(); assert.equal(f.identity.getVerifiedScope(), null); assert.equal(await f.controller.openFile(), false);
});
test('adoptCopy uses its verified ticket once and opened never routes through a second project selection', async t => {
  const f = await fixture(t, {openSelectedFile: () => ({status: 'copy', token, name: 'Copy'}), adoptCopy: request => {
    assert.equal(request.token, token); return {status: 'opened', projectId: createdId, windowId: id(9)};
  }});
  await f.controller.openFile(); assert.equal(await f.controller.adoptCopy(), true);
  assert.equal(f.calls.filter(call => call.action === 'adoptCopy').length, 1); assert.deepEqual(f.opened, []); assert.deepEqual(f.dispatched, ['host-opened']);
});
test('duplicate with a lost acknowledgement rechecks one exact request and never repeats its save panel', async t => {
  let calls = 0;
  const f = await fixture(t, {duplicate: request => {
    if (++calls === 1) throw Error('Lost copy acknowledgement');
    return {requestId: request.requestId, sourceProjectId: projectId, project: created, contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0};
  }});
  assert.equal(await f.controller.duplicate(projectId), false); assert.equal(f.controller.readCloseSnapshot().unknown, true);
  assert.equal(await f.controller.duplicate(projectId), false); assert.equal(calls, 1);
  assert.equal(await f.controller.recheck(), true); assert.equal(f.calls.filter(call => call.action === 'chooseLocation').length, 1);
  const inputs = f.calls.filter(call => call.action === 'duplicate'); assert.deepEqual(inputs[0], inputs[1]); assert.deepEqual(f.opened, [createdId]);
});
test('cold pending COPY is consumed once and closing it does not adopt or copy', async t => {
  const f = await fixture(t, {takePendingOpen: () => ({status: 'copy', token, name: 'Pending copy'})});
  await f.controller.initialize(false); await f.controller.initialize(false); assert.equal(f.calls.filter(call => call.action === 'takePendingOpen').length, 1);
  assert.equal(f.controller.getState().failure?.issue.code, 'PROJECT_FILE_COPY'); f.controller.closeFailure();
  assert.equal(f.calls.some(call => ['adoptCopy', 'copyTo', 'openOriginal'].includes(String(call.action))), false);
});
test('hidden owner ignores a held selected-file result and does not remain busy when shown again', async t => {
  const held = Promise.withResolvers<unknown>(), f = await fixture(t, {openSelectedFile: () => held.promise});
  const pending = f.controller.openFile(); await new Promise(setImmediate); f.visible(false);
  held.resolve({status: 'opened', projectId, windowId: id(9)}); assert.equal(await pending, false); assert.deepEqual(f.dispatched, []);
  f.visible(true); assert.equal(f.controller.getState().busy, false); assert.equal(f.controller.getState().action.kind, 'idle');
});
test('location risks require positive host facts and dismissal lasts only for the current controller session', async t => {
  assert.deepEqual(projectLocationRisks(facts), []);
  const f = await fixture(t, {currentLocation: () => ({displayPath: '/observed/project.mioon', facts: {...facts, cloud: 'known-icloud', permissionBits: false, fileSystem: 'exfat'}})});
  await f.controller.initialize(true); assert.deepEqual(f.controller.getState().risks.map(risk => risk.kind), ['cloud', 'permissions']);
  f.controller.dismissRisk(); await f.controller.initialize(true); assert.deepEqual(f.controller.getState().risks, []);
  const next = await fixture(t, {currentLocation: () => ({displayPath: '/observed/project.mioon', facts: {...facts, permissionBits: false}})}); await next.controller.initialize(true); assert.equal(next.controller.getState().risks.length, 1);
});
test('concurrent native initialization joins one generation-owned flight and old failure cannot erase reactivated capabilities', async t => {
  let hold = false; const held = Promise.withResolvers<unknown>(); t.after(() => held.resolve(capabilities));
  const f = await fixture(t, {capabilities: () => hold ? held.promise : capabilities});
  f.controller.dispose(); f.controller.activate(); hold = true;
  const first = f.controller.initialize(false), second = f.controller.initialize(false); await new Promise(setImmediate);
  assert.equal(f.calls.filter(call => call.action === 'capabilities').length, 2, 'One initial read plus one joined reactivation read');
  f.controller.dispose(); f.controller.activate(); hold = false; await f.controller.initialize(false);
  assert.equal(f.controller.getState().capabilities?.ready, true);
  held.reject(Error('Old initialization failed')); await Promise.all([first, second]);
  assert.equal(f.controller.getState().capabilities?.ready, true); assert.equal(f.controller.getState().blocked, false);
});
test('recent open uses fresh strict directory and consumes the entry permit once through the public desktop bridge', async t => {
  let entry: ReturnType<typeof createProjectEntryController>;
  const f = await fixture(t, {openRecent: request => {assert.equal(entry.consume(String(request.entryToken), String(request.projectId)).accepted, true); assert.equal(entry.consume(String(request.entryToken), String(request.projectId)).accepted, false); return {status: 'opened', projectId, windowId: id(9)};}});
  const context: ProjectWindowContext = {version: 2, role: 'launcher', windowId: id(30), contextId: id(31), backendId: PROJECT_ENTRY_TEST_INSTANCE, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  const bridge = {openProject: async () => assert.fail('opened cannot open twice'), context: async () => context} as unknown as ProjectWindowBridge;
  let consent = false;
  entry = createProjectEntryController({context, bridge, desktopClient: f.client, identity: f.identity, manageIdentityLifecycle: false,
    client: createLauncherClient(async () => assert.fail('No project RPC'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(f.identity)}), confirm: async () => consent, newToken: () => id(40)});
  entry.activate(); t.after(() => entry.dispose()); await entry.boot(); entry.reportCreate({dirty: true, busy: false, version: 1});
  const reads = f.directoryCalls.length; assert.equal(await entry.open(projectId), false); assert.equal(f.directoryCalls.length, reads); assert.equal(f.calls.some(call => call.action === 'openRecent'), false);
  consent = true; assert.equal(await entry.open(projectId), true); assert.ok(f.directoryCalls.length > reads); assert.equal(f.calls.filter(call => call.action === 'openRecent').length, 1);
  assert.equal(entry.readCloseSnapshot().unknown, false);
});
test('home native departure retains its live permit across its own busy reports but rejects later native form edits and dirty cancellation before GET', async t => {
  const f = await fixture(t), context: ProjectWindowContext = {version: 2, role: 'launcher', windowId: id(30), contextId: id(31), backendId: PROJECT_ENTRY_TEST_INSTANCE, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  let consent = false;
  const entry = createProjectEntryController({context, bridge: {context: async () => context} as unknown as ProjectWindowBridge, identity: f.identity, manageIdentityLifecycle: false,
    readAdditionalSnapshot: f.controller.readCloseSnapshot, confirm: async () => consent,
    client: createLauncherClient(async () => assert.fail('No RPC'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(f.identity)})});
  entry.activate(); t.after(() => entry.dispose()); await entry.boot(); f.controller.showCreate(); f.controller.change({name: 'Keep draft'}); f.controller.closeCreate();
  const reads = f.directoryCalls.length; assert.equal(await entry.prepareHomeNativeDeparture(), null); assert.equal(f.directoryCalls.length, reads); assert.equal(entry.readCloseSnapshot().dirty, true);
  consent = true; const permit = await entry.prepareHomeNativeDeparture(); assert.ok(permit); assert.equal(permit(), true);
  entry.reportNativeAction({busy: true, unknown: false, version: 1}); assert.equal(permit(), true); assert.equal(entry.readCloseSnapshot().busy, true);
  f.controller.showCreate(); f.controller.change({name: 'New input'}); assert.equal(permit(), false); assert.equal(entry.readCloseSnapshot().dirty, true);
});
test('a confirmed native result opens from a hidden editor with one opaque permit and one consent, preserving the old draft', async t => {
  let entry: ReturnType<typeof createProjectEntryController>, consumed = 0, confirmations = 0;
  const f = await fixture(t, {openRecent: request => {consumed++; assert.equal(entry.consume(String(request.entryToken), String(request.projectId)).accepted, true); return {status: 'opened', projectId: request.projectId, windowId: id(9)};}});
  const context: ProjectWindowContext = {version: 2, role: 'editor', windowId: id(30), contextId: id(31), backendId: PROJECT_ENTRY_TEST_INSTANCE, initialProjectId: projectId, autoOpen: false, editorProjectId: projectId, editorPhase: 'ready', editorCount: 1, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  entry = createProjectEntryController({context, bridge: {context: async () => context, openProject: () => assert.fail('No second window open')} as unknown as ProjectWindowBridge,
    desktopClient: f.client, identity: f.identity, manageIdentityLifecycle: false, readAdditionalSnapshot: f.controller.readCloseSnapshot, readNativeDraftVersion: f.controller.getDraftVersion,
    confirm: async () => {confirmations++; return true;}, newToken: () => id(80), client: createLauncherClient(async () => assert.fail('No RPC'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(f.identity)})});
  entry.activate(); t.after(() => entry.dispose()); await entry.boot(); assert.equal(entry.getState().shown, false);
  f.controller.showCreate(); f.controller.change({name: 'Retained native draft'}); f.controller.closeCreate();
  const granted = await entry.prepareNativeResultDeparture(); assert.ok(granted); assert.equal(confirmations, 1);
  assert.equal(entry.getState().shown, false, 'Result preparation does not open an additional picker');
  assert.equal(await entry.openNativeResult(createdId, () => true), false); assert.equal(consumed, 0);
  assert.equal(await entry.openNativeResult(createdId, granted), true); assert.equal(consumed, 1); assert.equal(confirmations, 1);
  assert.equal(entry.getState().shown, false);
  assert.equal(f.controller.getState().values.name, 'Retained native draft'); assert.equal(entry.readCloseSnapshot().dirty, true);
  assert.equal(await entry.openNativeResult(createdId, granted), false, 'A successful result consumes the opaque permit');
  const home = await entry.prepareHomeNativeDeparture(); assert.ok(home); f.controller.showCreate(); f.controller.change({description: 'Later input'});
  assert.equal(home(), false); assert.equal(await entry.openNativeResult(createdId, home), false); assert.equal(consumed, 1);
  const fresh = await entry.prepareNativeResultDeparture(); assert.ok(fresh); const held = Promise.withResolvers<unknown>(); f.holdDirectory(held.promise);
  const pending = entry.openNativeResult(createdId, fresh); await new Promise(setImmediate); f.controller.change({name: 'Input during fresh verification'});
  held.resolve(registered); assert.equal(await pending, false); assert.equal(consumed, 1); assert.equal(f.controller.getState().values.name, 'Input during fresh verification');
});
