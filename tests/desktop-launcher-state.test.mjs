import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas, workspaceRestoreInspectionSchema } from '../packages/contracts/src/index.mjs';
import { createLauncherClient, createLauncherController, parseLauncherProjects } from '../apps/web/src/launcher-state.ts';
import { createProjectEntryController } from '../apps/web/src/project-entry-state.ts';
import { createLastProjectController } from '../apps/web/src/last-project-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
const uuid = n => `78000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checks = { parseCreateInput: value => schemas['project.create'].parse(value), parseWorkspaceInspection: value => workspaceRestoreInspectionSchema.parse(value) };
const ctx = patch => ({ version: 2, role: 'launcher', windowId: uuid(9), contextId: uuid(1), backendId: uuid(2), initialProjectId: null, autoOpen: false,
  editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null,
  settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false, ...patch });
const row = (id = uuid(3), name = '故事') => ({ id, name, description: '', revision: 1, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' });
const result = patch => ({ ok: true, reason: 'accepted', targetWindowId: uuid(11), targetPhase: 'opening', ...patch });
const tick = () => new Promise(setImmediate);
function fixture({ context = ctx(), confirm = async () => true, rpc, invoke, locator = null } = {}) {
  const calls = [], opens = []; let current = context, serial = 100;
  let controller;
  const bridge = { context: async () => current,
    async openProject(projectId, remember, entryToken) {
      opens.push({ projectId, remember, entryToken });
      if (invoke) return invoke({ projectId, remember, entryToken, controller });
      assert.equal(controller.consume(entryToken, projectId).accepted, true);
      const value = result(); current = { ...current, entryReceipt: { entryToken, result: value } }; return value;
    } };
  const client = createLauncherClient(async (operation, input) => {
    calls.push([operation, input]);
    if (rpc) return rpc(operation, input);
    if (operation === 'workspace.restore.inspect') return { restored: false };
    if (operation === 'project.list') return [row(), row(uuid(4))];
    if (operation === 'project.create') return row(uuid(5), input.name);
  }, checks);
  controller = createProjectEntryController({ client, context, bridge, locator, confirm, newToken: () => uuid(++serial) });
  controller.activate();
  return { controller, calls, opens, client, bridge, context: () => current,
    receive(patch) { current = { ...current, ...patch }; controller.updateContext(current); } };
}
test('catalog and create ACK use canonical unknown validation including exact input match', async () => {
  for (const value of [null, {}, [row(), row()], [{ ...row(), id: 'bad' }], [{ ...row(), revision: '1' }]]) assert.throws(() => parseLauncherProjects(value));
  let dispatched = 0;
  const client = createLauncherClient(async () => { dispatched++; return row(); }, checks);
  await assert.rejects(client.create('', '')); assert.equal(dispatched, 0);
  await assert.rejects(client.create('different', '')); assert.equal(dispatched, 1);
});
test('explicit openings seal a one-use permit and different editor projects never replace the source', async () => {
  const initial = ctx({ role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1 });
  const f = fixture({ context: initial }); await f.controller.boot(); assert.equal(f.controller.getState().shown, false);
  assert.equal(await f.controller.open(uuid(4)), true);
  assert.equal(f.controller.getContext().initialProjectId, uuid(3));
  assert.equal(f.controller.getState().shown, false);
  assert.equal(f.controller.consume(f.opens[0].entryToken, uuid(4)).accepted, false);
});
test('accepted already-ready editor targets close the picker while rejected targets retain its error', async () => {
  for (const accepted of [true, false]) {
    const initial = ctx({role:'editor',initialProjectId:uuid(3),editorProjectId:uuid(3),editorPhase:'ready',editorCount:2});
    const f = fixture({context:initial,invoke:({controller,entryToken,projectId}) => {
      assert.equal(controller.consume(entryToken, projectId).accepted,true);
      return accepted ? result({targetPhase:'ready'}) : result({ok:false,reason:'busy',targetWindowId:null,targetPhase:null});
    }});
    await f.controller.boot(); await f.controller.show('open');
    assert.equal(await f.controller.open(uuid(4)),accepted);
    assert.equal(f.controller.getState().shown,!accepted);
    assert.equal(f.controller.getState().phase,accepted?'home':'error');
    assert.equal(Boolean(f.controller.getState().error),!accepted);
    assert.equal(f.controller.getContext().editorProjectId,uuid(3));
  }
});
test('an exact late accepted receipt closes the editor picker after an unknown open without redispatch', async () => {
  const initial=ctx({role:'editor',initialProjectId:uuid(3),editorProjectId:uuid(3),editorPhase:'ready',editorCount:2});
  const f=fixture({context:initial,invoke:({controller,entryToken,projectId})=>{assert.equal(controller.consume(entryToken,projectId).accepted,true);throw new Error('lost');}});
  await f.controller.boot();await f.controller.show('open');
  assert.equal(await f.controller.open(uuid(4)),false);assert.equal(f.controller.getState().openUnknown,true);
  f.receive({entryReceipt:{entryToken:uuid(999),result:result({targetPhase:'ready'})}});
  assert.equal(f.controller.getState().shown,true);
  f.receive({entryReceipt:{entryToken:f.opens[0].entryToken,result:result({targetPhase:'ready'})}});
  assert.equal(f.controller.getState().shown,false);assert.equal(f.controller.getState().openUnknown,false);assert.equal(f.opens.length,1);
});
test('programmatic open cannot bypass unknown creation and refreshing never proves creation success', async () => {
  const pending = Promise.withResolvers();
  const f = fixture({ rpc: async (op) => op === 'workspace.restore.inspect' ? { restored: false } : op === 'project.list' ? [row()] : pending.promise });
  await f.controller.boot();
  f.controller.reportCreate({ dirty: true, busy: true, version: 1 });
  const work = f.controller.create('new', '');
  assert.equal(await f.controller.open(uuid(3)), false); assert.equal(await f.controller.create('again', ''), false);
  pending.reject(new Error('network')); assert.equal(await work, false);
  await f.controller.refresh(); assert.equal(f.controller.getState().createUnknown, true);
  assert.equal(await f.controller.open(uuid(3)), false); assert.equal(await f.controller.show('open'), false);
  assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 1); assert.equal(f.opens.length, 0);
});
test('input after dirty confirmation capture cancels before sealing', async () => {
  const answer = Promise.withResolvers(); const f = fixture({ confirm: () => answer.promise }); await f.controller.boot();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const pending = f.controller.open(uuid(3));
  f.controller.reportCreate({ dirty: true, busy: false, version: 2 }); answer.resolve(true);
  assert.equal(await pending, false); assert.equal(f.opens.length, 0);
});
test('sealed lock blocks stale mutation handlers and cannot be consumed for a different target twice', async () => {
  const pending = Promise.withResolvers(); let captured;
  const f = fixture({ invoke: value => { captured = value; return pending.promise; } }); await f.controller.boot();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const work = f.controller.open(uuid(3)); await tick();
  assert.equal(f.controller.canMutate(), false);
  f.controller.reportCreate({ dirty: false, busy: false, version: 2 });
  assert.equal(f.controller.readCloseSnapshot().dirty, true);
  assert.equal(f.controller.consume(captured.entryToken, uuid(4)).accepted, false);
  assert.equal(f.controller.consume(captured.entryToken, uuid(3)).accepted, true);
  assert.equal(f.controller.consume(captured.entryToken, uuid(3)).accepted, false);
  assert.equal(await f.controller.create('new', ''), false);
  pending.resolve(result()); assert.equal(await work, true);
  assert.equal(f.controller.readCloseSnapshot().dirty, true, 'hiding/opening is not draft discard');
});
test('lost ACK reconciles only matching receipt, never editorCount, without redispatch', async () => {
  const f = fixture({ invoke: ({ controller, entryToken, projectId }) => { assert.equal(controller.consume(entryToken, projectId).accepted, true); throw new Error('lost'); } });
  await f.controller.boot(); assert.equal(await f.controller.open(uuid(3)), false);
  assert.equal(f.controller.getState().openUnknown, true);
  f.receive({ editorCount: 2 }); assert.equal(f.controller.getState().sealed, true);
  f.receive({ entryReceipt: { entryToken: uuid(999), result: result() } }); assert.equal(f.controller.getState().sealed, true);
  f.receive({ entryReceipt: { entryToken: f.opens[0].entryToken, result: result() } });
  assert.equal(f.controller.getState().sealed, false); assert.equal(f.controller.getState().openUnknown, false); assert.equal(f.opens.length, 1);
  assert.equal(f.controller.canMutate(), false, 'hidden launcher cannot create after receipt');
});
test('confirmed create keeps one latch into open, and failed open never replays the known create', async () => {
  const f = fixture({ invoke: ({ controller, entryToken, projectId }) => {
    assert.equal(controller.getState().creating, true); assert.equal(controller.canMutate(), false);
    assert.equal(controller.consume(entryToken, projectId).accepted, true);
    return result({ ok: false, reason: 'busy', targetWindowId: null, targetPhase: null });
  } }); await f.controller.boot();
  assert.equal(await f.controller.create('new', ''), true);
  assert.equal(f.controller.getState().createUnknown, false); assert.equal(f.controller.getState().createdProjectId, uuid(5));
  assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 1);
});
test('first startup is read-only, consumed once, and cancelled by newer local input', async () => {
  const locator = { activate() {}, dispose() {}, discover: async () => null, getState: () => ({ identityBlocked: false }), invalidateNavigation() {}, rememberOpened() { assert.fail('startup cannot remember'); } };
  const f = fixture({ context: ctx({ autoOpen: true }), locator }); await f.controller.boot(); await f.controller.boot();
  assert.deepEqual(f.opens.map(value => value.remember), [false]);
  const held = Promise.withResolvers(); const g = fixture({ context: ctx({ autoOpen: true }), locator, rpc: async op => op === 'workspace.restore.inspect' ? { restored: false } : held.promise });
  const boot = g.controller.boot(); g.controller.interacted(); held.resolve([row()]); await boot; assert.equal(g.opens.length, 0);
});
test('launcher-only locator queue invalidates stale selections before a later ready target', async () => {
  const writes = [], order = [];
  const locator = { activate() {}, dispose() {}, discover: async () => null, getState: () => ({ identityBlocked: false }),
    invalidateNavigation: version => order.push(['invalidate', version]), rememberOpened: (projectId, version) => writes.push([projectId, version]) };
  const f = fixture({ locator }); await f.controller.boot();
  f.receive({ selectionVersion: 1, selectionProjectId: null });
  f.receive({ selectionVersion: 2, selectionProjectId: null });
  f.receive({ selectionVersion: 1, selectionProjectId: uuid(3) }); assert.equal(writes.length, 0);
  f.receive({ selectionVersion: 2, selectionProjectId: uuid(4) }); f.receive({ selectionVersion: 2, selectionProjectId: uuid(4) });
  assert.deepEqual(writes, [[uuid(4), 2]]); assert.deepEqual(order, [['invalidate', 0], ['invalidate', 1], ['invalidate', 2]]);
});
test('entry unknown creation preserves exact P0 close-only risk admission across quit context', async () => {
  const f = fixture({ rpc: async op => op === 'workspace.restore.inspect' ? { restored: false } : op === 'project.list' ? [row()] : Promise.reject(new Error('unknown')) });
  await f.controller.boot(); f.controller.reportCreate({ dirty: true, busy: false, version: 1 }); await f.controller.create('new', '');
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => 'same', readDocumentURL: () => 'http://localhost/', readAdditionalSnapshot: f.controller.readCloseSnapshot,
    now: () => 1, newToken: () => 'close-token' });
  const ticket = admission.inspect(); assert.equal(ticket.disposition, 'unknown-dirty');
  f.receive({ quitting: true });
  assert.equal(admission.commit(ticket.token, { discardDirty: true, allowDrainFailure: false, expiresAt: 1000 }), false);
  assert.equal(admission.inspect('reload', 'http://localhost/').disposition, 'blocked');
  const risk = admission.inspect();
  assert.equal(admission.commit(risk.token, { discardDirty: true, allowDrainFailure: false, allowUnknown: true, expiresAt: 1000 }), true);
});
test('preload absence remains Web; malformed or changed native role never becomes Web', async () => {
  assert.equal(readDesktopWindowBridge({ location: { search: '?role=settings' } }), null);
  assert.throws(() => readDesktopWindowBridge({ __mioonProjectWindow: {} }));
  let value = ctx(), receive;
  const source = { context: async () => value, openProject: async () => result(), publishLocatorStatus: async () => true, requestLocatorAction: async () => true, requestProjectEntry: async () => true,
    showProjects: async () => true, showSettings: async () => true, editorStatus: async () => true, subscribe: listener => { receive = listener; return () => {}; } };
  const bridge = readDesktopWindowBridge({ __mioonProjectWindow: source }); await bridge.context(); const seen = []; bridge.subscribe(v => seen.push(v));
  value = { ...value, role: 'settings' }; receive(value); assert.equal(seen.length, 0); await assert.rejects(bridge.context());
});

test('scoped picker Escape/backdrop dismissal is guarded and retains draft metadata', async () => {
  const initial = ctx({ role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1 });
  let allowed = false;
  const f = fixture({ context: initial, confirm: async () => allowed }); await f.controller.boot(); await f.controller.show('new');
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  assert.equal(await f.controller.dismiss(), false); assert.equal(f.controller.getState().shown, true);
  allowed = true; assert.equal(await f.controller.dismiss(), true); assert.equal(f.controller.getState().shown, false);
  assert.equal(f.controller.readCloseSnapshot().dirty, true);
  await f.controller.show('new'); assert.equal(f.controller.readCloseSnapshot().dirty, true);
});

for (const action of ['open', 'dismiss']) test(`exact departure capture survives the caller await before ${action}`, async () => {
  const answer = Promise.withResolvers();
  const initial = action === 'open' ? ctx() : ctx({ role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1 });
  const f = fixture({ context: initial, confirm: () => answer.promise }); await f.controller.boot();
  if (action === 'dismiss') await f.controller.show('new');
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const work = action === 'open' ? f.controller.open(uuid(3)) : f.controller.dismiss();
  answer.resolve(true);
  // Runs after departure validates its answer but before the awaiting caller
  // resumes: a boolean would accidentally authorize this newer input version.
  queueMicrotask(() => f.controller.reportCreate({ dirty: true, busy: false, version: 2 }));
  assert.equal(await work, false); assert.equal(f.opens.length, 0); assert.equal(f.controller.getState().shown, true);
});
