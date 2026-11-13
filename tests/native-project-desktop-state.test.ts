import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createProjectEntriesDesktopBridge} from '../apps/desktop/src/project-entry-desktop-preload.ts';
import {readProjectEntryDesktopClient} from '../apps/web/src/project-entry-desktop-client.ts';
import {createNativeProjectDesktopController, projectLocationRisks} from '../apps/web/src/native-project-desktop-state.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import {readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import type {NewProjectFormatVersion} from '../packages/contracts/src/project-entry.ts';
import {projectEntryFixture, projectEntryOwnerFixture, PROJECT_ENTRY_TEST_INSTANCE} from './helpers/project-entry-fixture.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
const id = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), createdId = id(2), token = id(3);
const facts = {fileSystem: 'apfs', isLocal: true, volumeReadOnly: false, permissionBits: true, cloud: 'not-reported'} as const;
const capabilities = {ready: true, create: true, open: true, saveAs: true, duplicate: true, copyTo: true, adoptCopy: true, help: true, reveal: true, openOriginal: true, copySource: true, locationFacts: true};
const registered = projectEntryFixture([{id: projectId}, {id: createdId}]);
const created = registered.registered[1].project;
type Handler = (input: Record<string, unknown>) => unknown | Promise<unknown>;
async function fixture(t: TestContext, handlers: Record<string, Handler> = {}, {now, newProjectFormatVersion}: {now?: () => number; newProjectFormatVersion?: NewProjectFormatVersion} = {}) {
  const calls: Record<string, unknown>[] = [], directoryCalls: unknown[][] = [], opened: string[] = [], dispatched: string[] = [];
  const pendingListeners = new Set<(event: unknown, value: unknown) => void>();
  const owner = {backendId: id(90), windowId: id(91), contextId: id(92)};
  let directory = newProjectFormatVersion === undefined ? registered : {...registered, newProjectFormatVersion};
  let heldRead: Promise<unknown> | null = null;
  const identity = projectEntryOwnerFixture(() => heldRead ?? directory, directoryCalls); t.after(() => identity.dispose());
  const preload = createProjectEntriesDesktopBridge(async (_channel, input) => {
    assert.ok(input !== null && typeof input === 'object' && 'action' in input);
    const request = input as Record<string, unknown>; calls.push(request);
    const defaults: Record<string, unknown> = {capabilities, listRecent: directory, takePendingOpen: null, currentLocation: {displayPath: '/synthetic/project.mioon', facts},
      chooseLocation: {token, displayPath: '/synthetic/selected', facts}, createAtSelection: {status: 'created', project: created},
      openSelectedFile: {status: 'cancelled'}, openRecent: {status: 'opened', projectId, windowId: id(9)}, openPrivacySettings: null, reveal: null};
    return {ok: true, data: handlers[String(request.action)] ? await handlers[String(request.action)](request) : defaults[String(request.action)]};
  }, {on(_channel: string, listener: (event: unknown, value: unknown) => void) {pendingListeners.add(listener);},
    removeListener(_channel: string, listener: (event: unknown, value: unknown) => void) {pendingListeners.delete(listener);}, context: async () => owner});
  const client = readProjectEntryDesktopClient({__mioonProjectEntries: preload}); assert.ok(client);
  let consent = true, visible = true;
  const controller = createNativeProjectDesktopController({client, identity,
    beforeAction: async () => {if (!consent) return false; await readProjectEntryIdentity(identity); return true;},
    openCreated: async value => {opened.push(value); return true;}, isCurrent: () => true, canStart: () => visible, onOpened: () => dispatched.push('host-opened'), message: () => 'Shared save panel message', newId: () => id(10), now});
  controller.activate(); t.after(() => controller.dispose()); await controller.initialize(false);
  return {controller, client, identity, calls, directoryCalls, opened, dispatched,
    notifyPending() {for (const listener of pendingListeners) listener({}, owner);}, pendingListeners: () => pendingListeners.size,
    consent(value: boolean) {consent = value;}, visible(value: boolean) {visible = value;}, directory(value: typeof directory) {directory = value;}, holdDirectory(value: Promise<unknown> | null) {heldRead = value;}};
}
const flushPending = async () => {await new Promise(setImmediate); await new Promise(setImmediate);};
test('strict native adapter accepts nullable RecentProject without inventing canonical revision and forces saveAs off', async t => {
  const f = await fixture(t); assert.equal(f.controller.getState().capabilities?.saveAs, false);
  f.controller.showCreate(); f.controller.change({name: 'Native project', createFolder: false}); await f.controller.chooseLocation();
  assert.equal(await f.controller.create(), true); assert.deepEqual(f.opened, [createdId]); assert.equal(created.summary, null);
  const input = f.calls.find(call => call.action === 'createAtSelection'); assert.equal(input?.createFolder, false); assert.equal(input?.token, token);
  await assert.rejects(f.client.saveAs({token, projectId, requestId: id(10)}), {code: 'PROJECT_ENTRY_UNAVAILABLE'});
  assert.equal(f.calls.some(call => call.action === 'saveAs'), false);
});
test('native creation uses the verified creation format and starts format 4 in portrait', async t => {
  for (const newProjectFormatVersion of [3, 4] as const) {
    const f = await fixture(t, {}, {newProjectFormatVersion});
    assert.equal(f.controller.getState().newProjectFormatVersion, newProjectFormatVersion);
    assert.equal(f.controller.showCreate(), true);
    f.controller.change({name: 'Native project', description: 'Retained direction', presetId: 'landscape_1080', createFolder: false});
    assert.equal(await f.controller.chooseLocation(), true);
    assert.equal(await f.controller.create(), true);
    assert.deepEqual(f.calls.find(call => call.action === 'createAtSelection'), {
      action: 'createAtSelection', token, name: 'Native project',
      description: newProjectFormatVersion === 4 ? '' : 'Retained direction',
      timelinePresetId: newProjectFormatVersion === 4 ? 'portrait_1080' : 'landscape_1080',
      createFolder: false,
    });
  }
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
test('replay admission refusals preserve the original unknown and block new native writes until an exact ACK', async t => {
  for (const kind of ['createAtSelection', 'duplicate', 'copyTo'] as const) for (const [code, status] of [
    ['PROJECT_ENTRY_UNAVAILABLE', 409], ['PROJECT_ENTRY_BUSY', 409], ['PROJECT_ENTRY_BUSY', 503], ['PROJECT_HOST_BUSY', 409], ['PROJECT_ENTRY_TICKET_EXPIRED', 409],
  ] as const) await t.test(`${kind}/${code}/${status}`, async t => {
    let attempts = 0;
    const f = await fixture(t, {openSelectedFile: () => ({status: 'copy-source', token, name: 'Source', displayPath: '/observed/source.mioon', reason: 'read-only', facts}),
      [kind]: request => {
        attempts++;
        if (attempts === 1) throw Error('Original write may have committed before its ACK was lost');
        if (attempts === 2) throw Object.assign(Error('Replay refused before the operation cache'), {code, status});
        return kind === 'createAtSelection' ? {status: 'created', project: created}
          : {requestId: request.requestId, sourceProjectId: projectId, project: created, contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0};
      }});
    if (kind === 'createAtSelection') {f.controller.showCreate(); f.controller.change({name: 'Retain original', description: 'Keep this draft', createFolder: false}); await f.controller.chooseLocation();}
    else if (kind === 'copyTo') await f.controller.openFile();
    assert.equal(await (kind === 'createAtSelection' ? f.controller.create() : kind === 'duplicate' ? f.controller.duplicate(projectId) : f.controller.copyTo()), false);
    const original = f.calls.find(call => call.action === kind); assert.ok(original);
    const selection = f.controller.getState().selection, failure = f.controller.getState().failure;
    assert.equal(f.controller.readCloseSnapshot().unknown, true);
    assert.equal(await f.controller.recheck(), false);
    assert.equal(f.controller.getState().action.kind, 'unknown'); assert.equal(f.controller.readCloseSnapshot().unknown, true);
    assert.equal(f.controller.getState().selection, selection); assert.equal(f.controller.getState().selectionInvalid, false);
    assert.equal(f.controller.getState().failure, failure); assert.deepEqual(f.opened, []);
    if (kind === 'createAtSelection') {assert.equal(f.controller.getState().createState.kind, 'unknown'); assert.equal(f.controller.getState().values.description, 'Keep this draft');}
    const calls = f.calls.length;
    f.controller.closeCreate(); f.controller.closeFailure(); assert.equal(f.controller.showCreate(), false);
    assert.equal(await f.controller.create(), false); assert.equal(await f.controller.duplicate(projectId), false); assert.equal(await f.controller.copyTo(), false);
    assert.equal(f.calls.length, calls, 'A refusal to replay cannot authorize a new mutation or another system panel');
    assert.equal(attempts, 2);
    assert.equal(await f.controller.recheck(), true); assert.equal(attempts, 3);
    const writes = f.calls.filter(call => call.action === kind); assert.equal(writes.length, 3);
    for (const input of writes) assert.deepEqual(input, original, 'Reconciliation retains the original token, requestId and full input');
    assert.equal(f.calls.filter(call => call.action === 'chooseLocation').length, 1);
    assert.deepEqual(f.opened, [createdId]); assert.equal(f.controller.readCloseSnapshot().unknown, false);
  });
});
test('dispatched native creates retain retired unknown before and after late ACK across scope, instance and disposal', async t => {
  for (const boundary of ['scope', 'instance', 'dispose'] as const) await t.test(boundary, async t => {
    const held = Promise.withResolvers<unknown>(); t.after(() => held.resolve({status: 'created', project: created}));
    const f = await fixture(t, {createAtSelection: () => held.promise});
    f.controller.showCreate(); f.controller.change({name: 'Retained retired draft'}); await f.controller.chooseLocation();
    const pending = f.controller.create(); await new Promise(setImmediate);
    const writes = f.calls.filter(call => call.action === 'createAtSelection'); assert.equal(writes.length, 1);
    if (boundary === 'dispose') f.controller.dispose();
    else {f.directory(projectEntryFixture([{id: projectId}], boundary === 'scope' ? {appLibraryScope: 'b'.repeat(64)} : {instanceId: id(88)})); await f.identity.refresh();}
    assert.equal(f.controller.readCloseSnapshot().unknown, true, 'A dispatched write is unknown synchronously when its owner retires');
    assert.equal(f.controller.getState().values.name, 'Retained retired draft');
    held.resolve({status: 'created', project: created}); assert.equal(await pending, false);
    assert.equal(f.controller.readCloseSnapshot().unknown, true); assert.equal(f.controller.getState().busy, false); assert.deepEqual(f.opened, []);
    if (boundary === 'dispose') f.controller.activate();
    assert.equal(await f.controller.recheck(), false); await f.controller.initialize(false);
    assert.equal(f.calls.filter(call => call.action === 'createAtSelection').length, 1); assert.equal(f.controller.readCloseSnapshot().unknown, true);
  });
});
test('retiring a selected location before create dispatch does not invent an unknown write', async t => {
  const held = Promise.withResolvers<unknown>(); t.after(() => held.resolve(null));
  const f = await fixture(t, {chooseLocation: () => held.promise}); f.controller.showCreate(); f.controller.change({name: 'No write yet'});
  const selecting = f.controller.chooseLocation(); await new Promise(setImmediate);
  f.directory(projectEntryFixture([{id: projectId}], {instanceId: id(89)})); await f.identity.refresh();
  assert.equal(f.controller.readCloseSnapshot().unknown, false); held.resolve(null); assert.equal(await selecting, false);
  assert.equal(f.controller.readCloseSnapshot().unknown, false); assert.equal(f.calls.some(call => call.action === 'createAtSelection'), false);
});
test('every native copy mutation keeps its dispatched intent retired after a late success', async t => {
  for (const kind of ['duplicate', 'copyTo', 'adoptCopy'] as const) await t.test(kind, async t => {
    const held = Promise.withResolvers<unknown>(); t.after(() => held.resolve(null)); const sourceToken = id(44);
    const f = await fixture(t, {openSelectedFile: () => kind === 'adoptCopy' ? {status: 'copy', token: sourceToken, name: 'Copy'}
      : {status: 'copy-source', token: sourceToken, name: 'Source', displayPath: '/observed/source.mioon', reason: 'read-only', facts}, [kind]: () => held.promise});
    if (kind !== 'duplicate') await f.controller.openFile();
    const pending = kind === 'duplicate' ? f.controller.duplicate(projectId) : kind === 'copyTo' ? f.controller.copyTo() : f.controller.adoptCopy();
    await new Promise(setImmediate); const request = f.calls.find(call => call.action === kind); assert.ok(request);
    f.directory(projectEntryFixture([{id: projectId}], {instanceId: id(92)})); await f.identity.refresh(); assert.equal(f.controller.readCloseSnapshot().unknown, true);
    held.resolve(kind === 'adoptCopy' ? {status: 'opened', projectId: createdId, windowId: id(9)} : {requestId: request.requestId, sourceProjectId: projectId, project: created, contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0});
    assert.equal(await pending, false); assert.equal(f.controller.readCloseSnapshot().unknown, true); assert.deepEqual(f.opened, []); assert.deepEqual(f.dispatched, []);
    assert.equal(await f.controller.recheck(), false); assert.equal(f.calls.filter(call => call.action === kind).length, 1);
  });
});
test('disposal during metadata preflight is not a dispatched write, but disposal of an already unknown write preserves it', async t => {
  const f = await fixture(t); f.controller.showCreate(); f.controller.change({name: 'Keep preflight draft'}); await f.controller.chooseLocation();
  const held = Promise.withResolvers<unknown>(); f.holdDirectory(held.promise); const pending = f.controller.create(); await new Promise(setImmediate);
  f.controller.dispose(); assert.equal(f.controller.readCloseSnapshot().unknown, false); assert.equal(f.controller.getState().busy, false);
  f.controller.activate(); held.resolve(registered); assert.equal(await pending, false); assert.equal(f.calls.some(call => call.action === 'createAtSelection'), false);
  assert.equal(f.controller.getState().values.name, 'Keep preflight draft');
  const unknown = await fixture(t, {createAtSelection: () => {throw Error('Lost ACK');}}); unknown.controller.showCreate(); unknown.controller.change({name: 'Keep unknown draft'}); await unknown.controller.chooseLocation(); await unknown.controller.create();
  assert.equal(unknown.controller.readCloseSnapshot().unknown, true); unknown.controller.dispose(); unknown.controller.activate();
  assert.equal(await unknown.controller.recheck(), false); assert.equal(unknown.controller.readCloseSnapshot().unknown, true); assert.equal(unknown.calls.filter(call => call.action === 'createAtSelection').length, 1);
});
test('known host and entry admission refusal are closable errors while post-dispatch uncertainty remains unknown', async t => {
  for (const [code, status] of [['PROJECT_HOST_BUSY', 409], ['PROJECT_ENTRY_BUSY', 409], ['PROJECT_ENTRY_BUSY', 503]] as const) for (const kind of ['duplicate', 'copyTo'] as const) await t.test(code + ' ' + status + ' ' + kind, async t => {
    const f = await fixture(t, {openSelectedFile: () => ({status: 'copy-source', token, name: 'Source', displayPath: '/observed/source.mioon', reason: 'read-only', facts}),
      [kind]: () => {throw Object.assign(Error(code), {code, status, details: {}});}});
    if (kind === 'copyTo') await f.controller.openFile();
    assert.equal(await (kind === 'duplicate' ? f.controller.duplicate(projectId) : f.controller.copyTo()), false);
    assert.equal(f.calls.filter(call => call.action === kind).length, 1); assert.equal(f.controller.getState().action.kind, 'error'); assert.equal(f.controller.readCloseSnapshot().unknown, false);
    f.controller.closeFailure(); assert.equal(f.controller.getState().failure, null); assert.equal(await f.controller.recheck(), false);
    assert.equal(f.calls.filter(call => call.action === kind).length, 1, 'Closing/rechecking a deterministic refusal never resends a write');
  });
  for (const [code, status] of [['PROJECT_ENTRY_OUTCOME_UNKNOWN', 409], ['PROJECT_HOST_BUSY', 500], ['PROJECT_ENTRY_BUSY', 500]] as const) {
    const uncertain = await fixture(t, {duplicate: () => {throw Object.assign(Error('Unconfirmed effect'), {code, status, details: {}});}});
    await uncertain.controller.duplicate(projectId); assert.equal(uncertain.controller.getState().action.kind, 'unknown'); assert.equal(uncertain.controller.readCloseSnapshot().unknown, true);
    uncertain.controller.closeFailure(); assert.notEqual(uncertain.controller.getState().failure, null);
  }
});
test('a failed read before explicit write reconciliation preserves the original unknown request', async t => {
  let writes = 0;
  const f = await fixture(t, {createAtSelection: () => {if (++writes === 1) throw Error('Lost ACK'); return {status: 'created', project: created};}});
  f.controller.showCreate(); f.controller.change({name: 'Keep exact input'}); await f.controller.chooseLocation(); await f.controller.create();
  const held = Promise.withResolvers<unknown>(); f.holdDirectory(held.promise); const retrying = f.controller.recheck(); await new Promise(setImmediate); held.reject(Error('Metadata offline'));
  assert.equal(await retrying, false); assert.equal(writes, 1); assert.equal(f.controller.readCloseSnapshot().unknown, true); assert.equal(f.controller.getState().action.kind, 'unknown');
  f.holdDirectory(null); assert.equal(await f.controller.recheck(), true); const inputs = f.calls.filter(call => call.action === 'createAtSelection'); assert.equal(inputs.length, 2); assert.deepEqual(inputs[0], inputs[1]);
});
test('only proven pre-write native operations classify unavailable 409 as a rejection and retire an invalid create location', async t => {
  for (const kind of ['createAtSelection', 'duplicate', 'copyTo', 'adoptCopy'] as const) await t.test(kind, async t => {
    const f = await fixture(t, {openSelectedFile: () => kind === 'adoptCopy' ? {status: 'copy', token, name: 'Copy'} : {status: 'copy-source', token, name: 'Source', displayPath: '/observed/source.mioon', reason: 'read-only', facts},
      [kind]: () => {throw Object.assign(Error('The selected ticket is no longer available'), {code: 'PROJECT_ENTRY_UNAVAILABLE', status: 409});}});
    if (kind === 'createAtSelection') {f.controller.showCreate(); f.controller.change({name: 'Retained name', description: 'Retained description', createFolder: false}); await f.controller.chooseLocation();}
    else if (kind !== 'duplicate') await f.controller.openFile();
    assert.equal(await (kind === 'createAtSelection' ? f.controller.create() : kind === 'duplicate' ? f.controller.duplicate(projectId) : kind === 'copyTo' ? f.controller.copyTo() : f.controller.adoptCopy()), false);
    assert.equal(f.calls.filter(call => call.action === kind).length, 1);
    assert.equal(f.controller.readCloseSnapshot().unknown, kind === 'adoptCopy');
    assert.equal(f.controller.getState().action.kind, kind === 'adoptCopy' ? 'unknown' : 'error');
    if (kind === 'createAtSelection') {
      assert.equal(f.controller.getState().selection, null); assert.equal(f.controller.getState().selectionInvalid, true);
      assert.equal(f.controller.getState().values.name, 'Retained name'); assert.equal(f.controller.getState().values.description, 'Retained description'); assert.equal(f.controller.getState().values.createFolder, false);
      assert.equal(await f.controller.create(), false); assert.equal(f.calls.filter(call => call.action === kind).length, 1);
      await f.controller.chooseLocation(); assert.equal(f.controller.getState().selectionInvalid, false); assert.ok(f.controller.getState().selection);
      f.controller.closeCreate(); assert.equal(f.controller.getState().createOpen, false);
    } else {f.controller.closeFailure(); assert.equal(f.controller.getState().failure === null, kind !== 'adoptCopy');}
  });
  const uncertain = await fixture(t, {createAtSelection: () => {throw Object.assign(Error('Unconfirmed post-write effect'), {code: 'PROJECT_ENTRY_OUTCOME_UNKNOWN', status: 409});}});
  uncertain.controller.showCreate(); uncertain.controller.change({name: 'Keep unknown'}); await uncertain.controller.chooseLocation(); await uncertain.controller.create();
  assert.equal(uncertain.controller.readCloseSnapshot().unknown, true); assert.ok(uncertain.controller.getState().selection);
});
test('known invalid copy tickets require a fresh destination and never reuse an expired source observation', async t => {
  for (const kind of ['duplicate', 'copyTo'] as const) await t.test(kind, async t => {
    let attempts = 0;
    const f = await fixture(t, {openSelectedFile: () => ({status: 'copy-source', token, name: 'Source', displayPath: '/observed/source.mioon', reason: 'read-only', facts}), [kind]: request => {
      if (++attempts === 1) throw Object.assign(Error('Expired native selection'), {code: 'PROJECT_ENTRY_UNAVAILABLE', status: 409});
      return {requestId: request.requestId, sourceProjectId: projectId, project: created, contentSequence: 0, contentToken: 'a'.repeat(32), versions: 0};
    }});
    if (kind === 'copyTo') await f.controller.openFile();
    await (kind === 'duplicate' ? f.controller.duplicate(projectId) : f.controller.copyTo()); assert.equal(f.controller.readCloseSnapshot().unknown, false);
    await f.controller.retryFailure();
    if (kind === 'copyTo') {
      assert.equal(attempts, 1, 'An unknown-expired source must be observed again before another copy');
      assert.equal(f.calls.filter(call => call.action === 'openSelectedFile').length, 2);
      assert.equal(f.controller.getState().failure?.issue.code, 'PROJECT_INVALID'); assert.equal(f.controller.getState().selectionInvalid, false);
      assert.equal(await f.controller.copyTo(), true);
    }
    assert.equal(attempts, 2); assert.equal(f.calls.filter(call => call.action === 'chooseLocation').length, 2); assert.equal(f.controller.readCloseSnapshot().unknown, false); assert.deepEqual(f.opened, [createdId]);
  });
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
test('an initialized launcher takes a later OS result through the real preload notification once', async t => {
  let pending: unknown = null;
  const f = await fixture(t, {takePendingOpen: () => {const result = pending; pending = null; return result;}});
  assert.equal(f.controller.getState().failure, null);
  assert.equal(f.pendingListeners(), 1);
  pending = {status: 'copy', token, name: 'Late OS copy'};
  f.notifyPending(); f.notifyPending(); await flushPending();
  assert.equal(f.controller.getState().failure?.name, 'Late OS copy');
  const shown = f.controller.getState().failure;
  f.notifyPending(); await flushPending();
  assert.equal(f.controller.getState().failure, shown, 'Duplicate hints cannot redisplay an already-consumed result');
  assert.equal(f.calls.filter(call => call.action === 'takePendingOpen').length, 3);
  f.controller.closeFailure(); await flushPending();
  assert.equal(f.controller.getState().failure, null);
  assert.equal(f.calls.some(call => ['adoptCopy', 'copyTo', 'openOriginal'].includes(String(call.action))), false);
});
test('a result notification arriving during a null take is retained for a second serial take', async t => {
  const held = Promise.withResolvers<unknown>(); let takes = 0;
  const f = await fixture(t, {takePendingOpen: () => ++takes === 1 ? null : takes === 2 ? held.promise : {status: 'copy', token, name: 'Delayed by risk confirmation'}});
  f.notifyPending(); await flushPending(); assert.equal(takes, 2);
  f.notifyPending(); held.resolve(null); await flushPending();
  assert.equal(takes, 3); assert.equal(f.controller.getState().failure?.name, 'Delayed by risk confirmation');
});
test('hidden launchers defer pending results until reveal and disposed owners ignore late responses', async t => {
  let pending: unknown = null;
  const f = await fixture(t, {takePendingOpen: () => {const result = pending; pending = null; return result;}});
  f.visible(false); pending = {status: 'copy', token, name: 'Hidden copy'}; f.notifyPending(); await flushPending();
  assert.equal(f.calls.filter(call => call.action === 'takePendingOpen').length, 1); assert.equal(f.controller.getState().failure, null);
  f.visible(true); await f.controller.resumeKnownOpen(false); assert.equal(f.controller.getState().failure?.name, 'Hidden copy');
  f.controller.closeFailure();
  const held = Promise.withResolvers<unknown>(); let takes = 0;
  const old = await fixture(t, {takePendingOpen: () => ++takes === 2 ? held.promise : null});
  old.notifyPending(); await flushPending(); assert.equal(takes, 2);
  old.controller.dispose(); assert.equal(old.pendingListeners(), 0);
  old.controller.activate(); await old.controller.initialize(false); assert.equal(old.pendingListeners(), 1);
  held.resolve({status: 'copy', token, name: 'Old document copy'}); await flushPending();
  assert.equal(old.controller.getState().failure, null); assert.equal(old.controller.readCloseSnapshot().unknown, false);
});
test('pending notifications wait for active work, an open create draft and retained unknown outcomes', async t => {
  let pending: unknown = null;
  const held = Promise.withResolvers<unknown>();
  const f = await fixture(t, {takePendingOpen: () => {const result = pending; pending = null; return result;}, createAtSelection: () => held.promise});
  f.controller.showCreate(); f.controller.change({name: 'Draft keeps priority'});
  pending = {status: 'copy', token, name: 'After create'}; f.notifyPending(); await flushPending();
  assert.equal(f.calls.filter(call => call.action === 'takePendingOpen').length, 1); assert.equal(f.controller.getState().values.name, 'Draft keeps priority');
  await f.controller.chooseLocation(); const creating = f.controller.create(); await flushPending();
  assert.equal(f.controller.getState().busy, true); assert.equal(f.controller.getState().failure, null);
  held.resolve({status: 'created', project: created}); await creating; await flushPending();
  assert.equal(f.controller.getState().failure?.name, 'After create'); assert.deepEqual(f.opened, [createdId]);

  let attempts = 0, next: unknown = null;
  const unknown = await fixture(t, {takePendingOpen: () => {const value = next; next = null; return value;},
    openSelectedFile: () => ({status: 'copy', token, name: 'Original unknown'}), adoptCopy: () => {if (++attempts === 1) throw Error('Lost original ACK'); return {status: 'opened', projectId, windowId: id(9)};}});
  await unknown.controller.openFile(); await unknown.controller.adoptCopy(); const retained = unknown.controller.getState().failure;
  next = {status: 'copy', token: id(4), name: 'Next OS request'}; unknown.notifyPending(); await flushPending();
  assert.equal(unknown.controller.getState().failure, retained); assert.equal(unknown.controller.readCloseSnapshot().unknown, true);
  assert.equal(unknown.calls.filter(call => call.action === 'takePendingOpen').length, 1);
  await unknown.controller.recheck(); await flushPending();
  assert.equal(unknown.controller.getState().failure?.name, 'Next OS request'); assert.equal(unknown.controller.readCloseSnapshot().unknown, false);
});
test('a pending read that finishes after hiding waits for reveal and keeps its original expiry', async t => {
  for (const expireBeforeReveal of [false, true]) await t.test(String(expireBeforeReveal), async t => {
    let clock = 1000, takes = 0; const held = Promise.withResolvers<unknown>();
    const f = await fixture(t, {takePendingOpen: () => ++takes === 2 ? held.promise : null}, {now: () => clock});
    f.notifyPending(); await flushPending(); assert.equal(takes, 2);
    f.visible(false); held.resolve({status: 'copy', token, name: 'Taken before hiding', expiresAt: 2000}); await flushPending();
    assert.equal(f.controller.getState().failure, null); assert.equal(f.controller.readCloseSnapshot().unknown, false);
    clock = expireBeforeReveal ? 2000 : 1999; f.visible(true); await f.controller.resumeKnownOpen(false);
    assert.equal(f.controller.getState().failure?.name ?? null, expireBeforeReveal ? null : 'Taken before hiding');
    assert.equal(takes, 2, 'An already-consumed result is not fetched or replayed on reveal');
  });
});
test('already-expired selected or delayed OS results are never newly displayed', async t => {
  const value = {status: 'copy', token, name: 'Expired before display', expiresAt: 1000};
  const f = await fixture(t, {takePendingOpen: () => value, openSelectedFile: () => value}, {now: () => 1000});
  assert.equal(f.controller.getState().failure, null);
  await f.controller.openFile(); assert.equal(f.controller.getState().failure, null);
  assert.equal(f.controller.readCloseSnapshot().unknown, false);
});
test('declining pending-result departure retains the hint without repeatedly asking for consent', async t => {
  let pending: unknown = null;
  const f = await fixture(t, {takePendingOpen: () => {const value = pending; pending = null; return value;}});
  f.consent(false); pending = {status: 'copy', token, name: 'Awaiting consent'}; f.notifyPending(); await flushPending();
  assert.equal(f.calls.filter(call => call.action === 'takePendingOpen').length, 1); assert.equal(f.controller.getState().busy, false);
  const reads = f.directoryCalls.length; await flushPending(); assert.equal(f.directoryCalls.length, reads);
  f.consent(true); await f.controller.resumeKnownOpen(false); assert.equal(f.controller.getState().failure?.name, 'Awaiting consent');
});
test('explicit expired entry tickets are closable first-dispatch errors and retain destination reselect semantics', async t => {
  for (const kind of ['createAtSelection', 'duplicate', 'copyTo', 'adoptCopy', 'openOriginal'] as const) await t.test(kind, async t => {
    const f = await fixture(t, {openSelectedFile: () => kind === 'copyTo'
      ? {status: 'copy-source', token, name: 'Read-only source', displayPath: '/source.mioon', reason: 'read-only', facts}
      : {status: 'copy', token, name: 'Copy source', original: {name: 'Original', displayPath: '/original.mioon'}},
      [kind]: () => {throw Object.assign(Error('Expired before backend dispatch'), {code: 'PROJECT_ENTRY_TICKET_EXPIRED', status: 409, details: {}});}});
    if (kind === 'createAtSelection') {f.controller.showCreate(); f.controller.change({name: 'Retained draft', description: 'Description'}); await f.controller.chooseLocation();}
    else if (kind !== 'duplicate') await f.controller.openFile();
    await (kind === 'createAtSelection' ? f.controller.create() : kind === 'duplicate' ? f.controller.duplicate(projectId) : kind === 'copyTo' ? f.controller.copyTo() : kind === 'adoptCopy' ? f.controller.adoptCopy() : f.controller.openOriginal());
    assert.equal(f.controller.getState().action.kind, 'error'); assert.equal(f.controller.readCloseSnapshot().unknown, false);
    if (kind === 'createAtSelection') {
      assert.equal(f.controller.getState().selection, null); assert.equal(f.controller.getState().selectionInvalid, true);
      assert.equal(f.controller.getState().values.name, 'Retained draft'); assert.equal(f.controller.getState().values.description, 'Description');
      f.controller.closeCreate(); assert.equal(f.controller.getState().createOpen, false);
    } else if (kind === 'duplicate') {
      assert.equal(f.controller.getState().selectionInvalid, true); assert.equal(f.controller.getState().failure?.reselect, 'duplicate');
      f.controller.closeFailure(); assert.equal(f.controller.getState().failure, null);
    } else {
      assert.equal(f.controller.getState().failure?.issue.code, kind === 'copyTo' ? 'PROJECT_INVALID' : 'PROJECT_FILE_COPY');
      assert.equal(f.controller.getState().failure?.entryExpired, true); assert.equal(f.controller.getState().failure?.token, undefined);
      f.controller.closeFailure(); assert.equal(f.controller.getState().failure, null);
    }
    assert.equal(await f.controller.recheck(), false); assert.equal(f.calls.filter(call => call.action === kind).length, 1);
  });
});
test('an expired adopt-copy replay cannot settle or close the preceding unknown write', async t => {
  let attempts = 0;
  const f = await fixture(t, {openSelectedFile: () => ({status: 'copy', token, name: 'Retained original copy'}), adoptCopy: () => {
    if (++attempts === 1) throw Error('Original write ACK lost');
    if (attempts === 2) throw Object.assign(Error('Replay ticket evicted before cache lookup'), {code: 'PROJECT_ENTRY_TICKET_EXPIRED', status: 409, details: {}});
    return {status: 'opened', projectId, windowId: id(9)};
  }});
  await f.controller.openFile(); await f.controller.adoptCopy(); const failure = f.controller.getState().failure;
  await f.controller.recheck(); assert.equal(f.controller.getState().failure, failure);
  assert.equal(f.controller.getState().action.kind, 'unknown'); assert.equal(f.controller.readCloseSnapshot().unknown, true);
  f.controller.closeFailure(); assert.equal(f.controller.getState().failure, failure); assert.equal(await f.controller.adoptCopy(), false);
  assert.equal(attempts, 2); await f.controller.recheck(); assert.equal(attempts, 3); assert.equal(f.controller.readCloseSnapshot().unknown, false);
  const inputs = f.calls.filter(call => call.action === 'adoptCopy'); for (const input of inputs) assert.deepEqual(input, inputs[0]);
});
test('hiding the presentation preserves an admitted selected-file result and prevents new native actions', async t => {
  const held = Promise.withResolvers<unknown>(), f = await fixture(t, {openSelectedFile: () => held.promise});
  const pending = f.controller.openFile(); await new Promise(setImmediate); f.visible(false);
  held.resolve({status: 'opened', projectId, windowId: id(9)}); assert.equal(await pending, true); assert.deepEqual(f.dispatched, ['host-opened']);
  const count = f.calls.length; assert.equal(await f.controller.openFile(), false); assert.equal(f.calls.length, count);
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
test('recent open releases only proven main admission refusals before consumption and retains post-consumption uncertainty', async t => {
  for (const consumed of [false, true]) for (const [code, status] of [['PROJECT_ENTRY_BUSY', 409], ['PROJECT_ENTRY_BUSY', 503], ['PROJECT_ENTRY_UNAVAILABLE', 409]] as const) await t.test(`${code}/${status}/consumed=${consumed}`, async t => {
    let entry: ReturnType<typeof createProjectEntryController>;
    const f = await fixture(t, {openRecent: request => {if (consumed) assert.equal(entry.consume(String(request.entryToken), projectId).accepted, true); throw Object.assign(Error(code), {code, status});}});
    const context: ProjectWindowContext = {version: 2, role: 'launcher', windowId: id(30), contextId: id(31), backendId: PROJECT_ENTRY_TEST_INSTANCE, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
    entry = createProjectEntryController({context, bridge: {context: async () => context} as unknown as ProjectWindowBridge, desktopClient: f.client, identity: f.identity, manageIdentityLifecycle: false,
      client: createLauncherClient(async () => assert.fail('No RPC'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(f.identity)}), confirm: async () => true, newToken: () => id(40)});
    entry.activate(); t.after(() => entry.dispose()); await entry.boot(); entry.reportCreate({dirty: true, busy: false, version: 1});
    assert.equal(await entry.open(projectId), false); assert.equal(f.calls.filter(call => call.action === 'openRecent').length, 1);
    assert.equal(entry.getState().openUnknown, consumed); assert.equal(entry.getState().sealed, consumed); assert.equal(entry.readCloseSnapshot().unknown, consumed); assert.equal(entry.readCloseSnapshot().dirty, true);
    assert.equal(entry.canMutate(), !consumed);
  });
});
test('home retained unknown requires fresh explicit local consent without bypassing any other owner or native fence', async t => {
  const f = await fixture(t), context: ProjectWindowContext = {version: 2, role: 'launcher', windowId: id(30), contextId: id(31), backendId: PROJECT_ENTRY_TEST_INSTANCE, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  let approved = false, confirmations = 0, nativeUnknown = false;
  const entry = createProjectEntryController({context, bridge: {context: async () => context} as unknown as ProjectWindowBridge, identity: f.identity, manageIdentityLifecycle: false,
    readAdditionalSnapshot: () => ({dirty: false, busy: false, unknown: nativeUnknown, identity: [nativeUnknown]}), confirm: async () => {confirmations++; return approved;},
    client: createLauncherClient(async () => assert.fail('No RPC'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(f.identity)})});
  entry.activate(); t.after(() => entry.dispose()); await entry.boot(); entry.reportNativeAction({busy: false, unknown: true, version: 1});
  assert.equal(await entry.prepareHomeNativeDeparture(), null);
  let reads = f.directoryCalls.length; assert.equal(await entry.prepareHomeNativeRecheck(1), null); assert.equal(confirmations, 1); assert.equal(f.directoryCalls.length, reads, 'Cancellation must precede metadata GET');
  approved = true; const grant = await entry.prepareHomeNativeRecheck(1); assert.ok(grant); assert.equal(confirmations, 2); assert.ok(f.directoryCalls.length > reads); assert.equal(grant(), true);
  entry.reportNativeAction({busy: true, unknown: true, version: 2}); assert.equal(grant(), true, 'Its own recheck progress does not invalidate the newly consented grant');
  reads = f.directoryCalls.length; assert.equal(await entry.prepareHomeNativeRecheck(1), null); assert.equal(await entry.prepareHomeNativeRecheck(2), null); assert.equal(confirmations, 2); assert.equal(f.directoryCalls.length, reads);
  entry.reportNativeAction({busy: false, unknown: true, version: 3}); nativeUnknown = true;
  assert.equal(await entry.prepareHomeNativeRecheck(3), null); assert.equal(confirmations, 2); assert.equal(f.directoryCalls.length, reads); assert.equal(grant(), false);
  nativeUnknown = false; const next = await entry.prepareHomeNativeRecheck(3); assert.ok(next); entry.reportCreate({dirty: true, busy: false, version: 1}); assert.equal(next(), false);
  entry.setVisible(false); assert.equal(await entry.prepareHomeNativeRecheck(3), null); entry.setVisible(true);
  f.directory(projectEntryFixture([{id: projectId}], {instanceId: id(98)})); await f.identity.refresh(); assert.equal(await entry.prepareHomeNativeRecheck(3), null); assert.equal(entry.readCloseSnapshot().unknown, true);
});
test('an explicitly closed template unknown permits existing-project navigation but retains close risk and rejects every create path', async t => {
  let entry: ReturnType<typeof createProjectEntryController>, confirmations = 0;
  const f = await fixture(t, {openRecent: request => {assert.equal(entry.consume(String(request.entryToken), String(request.projectId)).accepted, true); return {status: 'opened', projectId, windowId: id(9)};}});
  const context: ProjectWindowContext = {version: 2, role: 'launcher', windowId: id(30), contextId: id(31), backendId: PROJECT_ENTRY_TEST_INSTANCE, initialProjectId: null, autoOpen: false, editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false};
  entry = createProjectEntryController({context, bridge: {context: async () => context} as unknown as ProjectWindowBridge, desktopClient: f.client, identity: f.identity, manageIdentityLifecycle: false,
    client: createLauncherClient(async () => assert.fail('Template unknown must never dispatch a legacy create'), {parseCreateInput: value => value, readDirectory: () => readProjectEntryIdentity(f.identity)}), confirm: async () => {confirmations++; return true;}, newToken: () => id(40)});
  entry.activate(); t.after(() => entry.dispose()); await entry.boot(); entry.reportCreate({dirty: true, busy: false, version: 1}); entry.reportNativeAction({busy: false, unknown: true, version: 1});
  const reads = f.directoryCalls.length; assert.equal(await entry.open(projectId), false); assert.equal(confirmations, 0); assert.equal(f.directoryCalls.length, reads);
  entry.reportNativeAction({busy: false, unknown: true, allowOpen: true, version: 2});
  assert.equal(entry.canMutate(), true); assert.equal(await entry.show('new'), false); assert.equal(await entry.create('Never create', ''), false); assert.equal(await entry.prepareHomeNativeDeparture(), null); assert.equal(await entry.prepareNativeResultDeparture(), null);
  assert.equal(await entry.show('open'), true); assert.equal(await entry.open(projectId), true); assert.equal(confirmations, 1); assert.equal(f.calls.filter(call => call.action === 'openRecent').length, 1);
  assert.equal(entry.readCloseSnapshot().unknown, true); assert.equal(entry.readCloseSnapshot().dirty, true);
  entry.reportNativeAction({busy: true, unknown: true, allowOpen: true, version: 3}); assert.equal(entry.canMutate(), false); assert.equal(await entry.open(projectId), false); assert.equal(await entry.show('open'), false);
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
