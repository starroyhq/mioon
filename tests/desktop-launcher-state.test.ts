import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas } from '../packages/contracts/src/index.ts';
import { createLauncherClient, createLauncherController, parseLauncherProjects, LauncherCreateError } from '../apps/web/src/launcher-state.ts';
import type { LauncherCreatedProject } from '../apps/web/src/launcher-state.ts';
import { projectEntriesResponseSchema } from '../packages/contracts/src/project-entry.ts';
import type { ProjectEntriesResponse } from '../packages/contracts/src/project-entry.ts';
import { createProjectEntryController } from '../apps/web/src/project-entry-state.ts';
import { createLastProjectController } from '../apps/web/src/last-project-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';

type ControllerOptions = Parameters<typeof createProjectEntryController>[0];
type LauncherContext = ControllerOptions['context'];
type LauncherBridge = ControllerOptions['bridge'];
type Locator = NonNullable<ControllerOptions['locator']>;
type ContractChecks = Parameters<typeof createLauncherClient>[1];
type Rpc = Parameters<typeof createLauncherClient>[0];
type ProjectController = ReturnType<typeof createProjectEntryController>;
type EntryResult = NonNullable<LauncherContext['entryReceipt']>['result'];
interface OpenRecord { projectId: string; remember: boolean; entryToken: string }
interface InvokeArgs extends OpenRecord { controller: ProjectController }

const uuid = (n: number): string => `78000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checks: ContractChecks = { parseCreateInput: value => schemas['project.create'].parse(value), readDirectory: async () => directory([row()]) };
const ctx = (patch: object = {}): LauncherContext => ({ version: 2, role: 'launcher', windowId: uuid(9), contextId: uuid(1), backendId: uuid(2), initialProjectId: null, autoOpen: false,
  editorProjectId: null, editorPhase: 'none', editorCount: 0, entryMode: null, entryVersion: 0, entryReceipt: null,
  settingsSlot: null, settingsVersion: 0, selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false, ...patch }) as LauncherContext;
const row = (id: string = uuid(3), name: string = '故事'): LauncherCreatedProject => ({ id, name, description: '', revision: 1, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' });
function directory(projects: readonly LauncherCreatedProject[], patch: Partial<ProjectEntriesResponse> = {}): ProjectEntriesResponse {
  return projectEntriesResponseSchema.parse({version: 1, appLibraryScope: 'a'.repeat(64), instanceId: uuid(900), registered: projects.map((project, index) => ({
    project: {projectId: project.id, name: project.name, projectFile: `/native-recent/${project.id}.mioon`, fileIdentity: {dev: '1', ino: String(index + 1)}, lastOpenedAt: null,
      summary: {description: project.description, revision: project.revision, createdAt: project.createdAt, updatedAt: project.updatedAt,
        fps: 30, width: 1080, height: 1920, presetId: 'portrait_1080', shotCount: 0, durationFrames: 0, cover: null}}, availability: {state: 'available'}, coverUrl: null})), ...patch});
}
const result = (patch: object = {}): EntryResult => ({ ok: true, reason: 'accepted', targetWindowId: uuid(11), targetPhase: 'opening', ...patch }) as EntryResult;
const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });
function fixture({ context = ctx(), confirm = async () => true, rpc, readDirectory, invoke, locator = null, explicitProjectId = null }:
  { context?: LauncherContext; confirm?: () => Promise<boolean>; rpc?: (operation: string, input?: Readonly<Record<string, unknown>>) => unknown;
    readDirectory?: () => unknown;
    invoke?: (value: InvokeArgs) => unknown; locator?: Locator | null; explicitProjectId?: string | null } = {}) {
  const calls: Array<[string, unknown]> = [], opens: OpenRecord[] = []; let current = context, serial = 100;
  let controller: ProjectController;
  const bridge = { context: async () => current,
    async openProject(projectId: string, remember: boolean, entryToken: string) {
      opens.push({ projectId, remember, entryToken });
      if (invoke) return invoke({ projectId, remember, entryToken, controller });
      assert.equal(controller.consume(entryToken, projectId).accepted, true);
      const value = result(); current = { ...current, entryReceipt: { entryToken, result: value } }; return value;
    } } as unknown as LauncherBridge;
  const client = createLauncherClient(async (operation, input) => {
    calls.push([operation, input]);
    if (rpc) return rpc(operation, input);
    if (operation === 'project.create') return row(uuid(5), String((input as { name?: unknown } | undefined)?.name));
    assert.fail(`Unexpected native RPC ${operation}`);
  }, {...checks, readDirectory: async () => {calls.push(['directory.list', undefined]); return readDirectory ? readDirectory() : directory([row(), row(uuid(4))]);}});
  controller = createProjectEntryController({ client, context, bridge, locator, explicitProjectId, confirm, newToken: () => uuid(++serial) });
  controller.activate();
  return { controller, calls, opens, client, bridge, context: () => current,
    receive(patch: object) { current = { ...current, ...patch } as LauncherContext; controller.updateContext(current); } };
}
test('catalog and create ACK use canonical unknown validation including exact input match', async () => {
  for (const value of [null, {}, [row(), row()], [{ ...row(), id: 'bad' }], [{ ...row(), revision: '1' }]]) assert.throws(() => parseLauncherProjects(value));
  let dispatched = 0;
  const client = createLauncherClient(async () => { dispatched++; return row(); }, checks);
  await assert.rejects(client.create('', '')); assert.equal(dispatched, 0);
  await assert.rejects(client.create('different', '')); assert.equal(dispatched, 1);
});
test('default native directory reads the fixed GET and retains registrations with no cached summary', async () => {
  const original = globalThis.fetch, requests: {url: string; options: RequestInit}[] = [];
  const catalog = directory([row(), row(uuid(4))]);
  catalog.registered[0].project.summary = null;
  catalog.registered[0].project.projectFile = '/Volumes/外置盘/未知项目.mioon';
  catalog.registered[0].availability = {state: 'missing'};
  try {
    globalThis.fetch = async (url, options) => {requests.push({url: String(url), options: options!}); return Response.json({ok: true, data: catalog});};
    const client = createLauncherClient(async () => assert.fail('Listing must never use RPC project.list'), {parseCreateInput: checks.parseCreateInput});
    const projects = await client.list();
    assert.deepEqual(projects, [{id: uuid(3), name: '故事', updatedAt: ''}, row(uuid(4))]);
    assert.equal(Object.hasOwn(projects[0], 'description'), false); assert.equal(Object.hasOwn(projects[0], 'revision'), false); assert.equal(Object.hasOwn(projects[0], 'createdAt'), false);
    assert.equal(requests[0].url, '/api/project-entries'); assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.credentials, 'same-origin'); assert.equal(requests[0].options.cache, 'no-store'); assert.equal(requests[0].options.redirect, 'error');
    assert.equal(requests[0].options.body, undefined); assert.equal(JSON.stringify(projects).includes('/Volumes/'), false);
    catalog.registered = []; assert.deepEqual(await client.list(), []);
  } finally {globalThis.fetch = original;}
});
test('native catalog requires the complete strict DTO before pinning or accepting another backend instance', async () => {
  const valid = directory([row()]); let value: unknown = {...valid, instanceId: 'invalid'};
  const client = createLauncherClient(async () => assert.fail('No list RPC'), {...checks, readDirectory: async () => value});
  await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  value = directory([row()], {appLibraryScope: 'b'.repeat(64)}); assert.deepEqual(await client.list(), [row()]);
  for (const malformed of [[row()], {...valid, appLibraryScope: 'b'.repeat(64), registered: [valid.registered[0], valid.registered[0]]},
    {...valid, appLibraryScope: 'b'.repeat(64), extra: true},
    {...valid, appLibraryScope: 'b'.repeat(64), instanceId: uuid(901), registered: [{...valid.registered[0], availability: {state: 'unknown'}}]}]) {
    value = malformed; await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  value = directory([row(uuid(4))], {appLibraryScope: 'b'.repeat(64), instanceId: uuid(902)});
  assert.deepEqual(await client.list(), [row(uuid(4))]);
});
test('same project UUID in a different library blocks creation before dispatch and permanently pins the private client', async () => {
  let value = directory([row()]), reads = 0, creates = 0;
  const client = createLauncherClient(async () => {creates++; return row();}, {...checks, readDirectory: async () => {reads++; return value;}});
  await client.list(); value = directory([row()], {appLibraryScope: 'b'.repeat(64), instanceId: uuid(901)});
  await assert.rejects(client.create(row().name, ''), error => error instanceof LauncherCreateError && error.outcome === 'rejected');
  assert.equal(creates, 0); assert.equal(reads, 2);
  value = directory([row()]);
  await assert.rejects(client.list(), {code: 'PROJECT_ENTRY_SCOPE_MISMATCH', status: 409});
  await assert.rejects(client.create(row().name, ''), error => error instanceof LauncherCreateError && error.outcome === 'rejected');
  assert.equal(reads, 2); assert.equal(creates, 0);
});
test('create always rechecks directory identity and a failed preflight is definitive without a create RPC', async () => {
  let reads = 0, creates = 0, offline = false;
  const client = createLauncherClient(async () => {creates++; return row();}, {...checks, readDirectory: async () => {reads++; if (offline) throw Error('offline'); return directory([row()]);}});
  await client.list(); offline = true;
  await assert.rejects(client.create(row().name, ''), error => error instanceof LauncherCreateError && error.outcome === 'rejected');
  assert.equal(creates, 0); assert.equal(reads, 2);
  offline = false; assert.deepEqual(await client.create(row().name, ''), row());
  assert.equal(creates, 1); assert.equal(reads, 3);
});
test('a scope mismatch observed after create dispatch keeps its acknowledgement unknown', async () => {
  const pending = Promise.withResolvers<unknown>(); let value = directory([row()]), creates = 0;
  const client = createLauncherClient(async () => {creates++; return pending.promise;}, {...checks, readDirectory: async () => value});
  const creating = client.create(row().name, ''); await tick(); assert.equal(creates, 1);
  value = directory([row()], {appLibraryScope: 'b'.repeat(64)});
  await assert.rejects(client.list(), {code: 'PROJECT_ENTRY_SCOPE_MISMATCH'});
  pending.resolve(row());
  await assert.rejects(creating, error => error instanceof LauncherCreateError && error.outcome === 'unknown');
  assert.equal(creates, 1);
});
test('unknown-summary membership never weakens canonical create acknowledgement validation', async () => {
  const catalog = directory([row()]); catalog.registered[0].project.summary = null;
  const client = createLauncherClient(async () => ({id: row().id, name: row().name, updatedAt: ''}), {...checks, readDirectory: async () => catalog});
  assert.deepEqual(await client.list(), [{id: row().id, name: row().name, updatedAt: ''}]);
  await assert.rejects(client.create(row().name, ''), error => error instanceof LauncherCreateError && error.outcome === 'unknown');
});
test('cancelled native departure performs no directory read or window dispatch even for an uncached UUID', async () => {
  for (const target of [uuid(3), uuid(99)]) {
    const f = fixture({confirm: async () => false}); await f.controller.boot();
    f.controller.reportCreate({dirty: true, busy: false, version: 1}); const reads = f.calls.length;
    assert.equal(await f.controller.open(target), false); assert.equal(f.calls.length, reads); assert.equal(f.opens.length, 0);
    assert.equal(f.controller.getState().catalogReady, true);
  }
});
test('native open confirms departure before a fresh directory read and uses only that read for membership', async () => {
  const answer = Promise.withResolvers<boolean>(), order: string[] = []; let catalog = directory([row()]);
  const f = fixture({confirm: () => {order.push('confirm'); return answer.promise;}, readDirectory: () => {order.push('GET'); return catalog;},
    invoke: ({controller, entryToken, projectId}) => {order.push('open'); assert.equal(controller.consume(entryToken, projectId).accepted, true); return result();}});
  await f.controller.boot(); order.length = 0; catalog = directory([row(uuid(4))]);
  f.controller.reportCreate({dirty: true, busy: false, version: 1});
  const opening = f.controller.open(uuid(4)); assert.deepEqual(order, ['confirm']);
  answer.resolve(true); assert.equal(await opening, true);
  assert.deepEqual(order, ['confirm', 'GET', 'open']); assert.deepEqual(f.opens.map(item => item.projectId), [uuid(4)]);
});
test('fresh native open cannot reuse cached membership after a failed read, malformed DTO or same-UUID library replacement', async () => {
  for (const failure of ['offline', 'malformed', 'scope']) {
    let catalog: unknown = directory([row()]);
    const f = fixture({readDirectory: () => {if (failure === 'offline' && catalog === null) throw Error('offline'); return catalog;}});
    await f.controller.boot();
    catalog = failure === 'offline' ? null : failure === 'malformed' ? [row()] : directory([row()], {appLibraryScope: 'b'.repeat(64)});
    assert.equal(await f.controller.open(uuid(3)), false); assert.equal(f.opens.length, 0);
    assert.equal(f.controller.getState().catalogReady, false); assert.equal(f.controller.getState().listBusy, false);
    assert.ok(f.controller.getState().listError); assert.equal(f.controller.getState().projects[0].id, uuid(3), 'Old display data is never fresh authority');
  }
});
test('a removed registration in a successful native read cannot be opened from its old card', async () => {
  let catalog = directory([row()]); const f = fixture({readDirectory: () => catalog}); await f.controller.boot();
  catalog = directory([]); assert.equal(await f.controller.open(uuid(3)), false);
  assert.equal(f.opens.length, 0); assert.deepEqual(f.controller.getState().projects, []);
  assert.equal(f.controller.getState().catalogReady, true); assert.ok(f.controller.getState().error);
});
test('a native open read rejects repeated open/create actions and keeps one exact confirmed flight', async () => {
  const held = Promise.withResolvers<unknown>(); let reads = 0, confirmations = 0;
  const f = fixture({confirm: async () => {confirmations++; return true;}, readDirectory: () => ++reads === 1 ? directory([row()]) : held.promise});
  await f.controller.boot(); f.controller.reportCreate({dirty: true, busy: false, version: 1});
  const opening = f.controller.open(uuid(3)); await tick(); assert.equal(reads, 2); assert.equal(f.controller.getState().listBusy, true);
  assert.equal(await f.controller.open(uuid(3)), false); assert.equal(await f.controller.create('new', ''), false);
  assert.equal(reads, 2); assert.equal(confirmations, 1); assert.equal(f.opens.length, 0);
  held.resolve(directory([row()])); assert.equal(await opening, true); assert.equal(f.opens.length, 1);
});
test('input, native context, visibility and lifetime changes revoke a pending native open read', async () => {
  for (const change of ['input', 'context', 'quit-cancel', 'hidden', 'lifetime']) {
    const held = Promise.withResolvers<unknown>(); let reads = 0;
    const f = fixture({readDirectory: () => ++reads === 1 ? directory([row()]) : held.promise}); await f.controller.boot();
    f.controller.reportCreate({dirty: true, busy: false, version: 1});
    const opening = f.controller.open(uuid(3)); await tick(); assert.equal(reads, 2);
    if (change === 'input') f.controller.reportCreate({dirty: true, busy: false, version: 2});
    if (change === 'context') f.receive({settingsVersion: 1});
    if (change === 'quit-cancel') {f.receive({quitting: true}); f.receive({quitting: false});}
    if (change === 'hidden') f.controller.setVisible(false);
    if (change === 'lifetime') {f.controller.dispose(); f.controller.activate();}
    held.resolve(directory([row()])); assert.equal(await opening, false); assert.equal(f.opens.length, 0);
  }
});
test('a newer catalog read retires old native open success and failure without consuming its departure again', async () => {
  for (const reject of [false, true]) {
    const held = Promise.withResolvers<unknown>(); let reads = 0;
    const f = fixture({readDirectory: () => ++reads === 2 ? held.promise : directory([row()])}); await f.controller.boot();
    const opening = f.controller.open(uuid(3)); await tick(); assert.equal(reads, 2);
    assert.equal(await f.controller.refresh(), true); assert.equal(reads, 3);
    if (reject) held.reject(Error('old failure')); else held.resolve(directory([row()]));
    assert.equal(await opening, false); assert.equal(f.opens.length, 0); assert.equal(f.controller.getState().listBusy, false);
    assert.equal(f.controller.getState().listError, ''); assert.equal(f.controller.getState().catalogReady, true);
  }
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
  const pending = Promise.withResolvers<unknown>();
  const f = fixture({ readDirectory: () => directory([row()]), rpc: async () => pending.promise });
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
  const answer = Promise.withResolvers<boolean>(); const f = fixture({ confirm: () => answer.promise }); await f.controller.boot();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const pending = f.controller.open(uuid(3));
  f.controller.reportCreate({ dirty: true, busy: false, version: 2 }); answer.resolve(true);
  assert.equal(await pending, false); assert.equal(f.opens.length, 0);
});
test('sealed lock blocks stale mutation handlers and cannot be consumed for a different target twice', async () => {
  const pending = Promise.withResolvers<EntryResult>(); let captured: InvokeArgs | undefined;
  const f = fixture({ invoke: value => { captured = value; return pending.promise; } }); await f.controller.boot();
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const work = f.controller.open(uuid(3)); await tick();
  assert.equal(f.controller.canMutate(), false);
  f.controller.reportCreate({ dirty: false, busy: false, version: 2 });
  assert.equal(f.controller.readCloseSnapshot().dirty, true);
  assert.equal(f.controller.consume(captured!.entryToken, uuid(4)).accepted, false);
  assert.equal(f.controller.consume(captured!.entryToken, uuid(3)).accepted, true);
  assert.equal(f.controller.consume(captured!.entryToken, uuid(3)).accepted, false);
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
test('first startup stays home without a URL; an explicit target is read-only, consumed once, and cancelled by newer input', async () => {
  const locator = { activate() {}, dispose() {}, discover: async () => null, getState: () => ({ identityBlocked: false }), invalidateNavigation() {}, rememberOpened() { assert.fail('startup cannot remember'); } } as unknown as Locator;
  const f = fixture({ context: ctx({ autoOpen: true }), locator }); await f.controller.boot(); await f.controller.boot();
  assert.deepEqual(f.opens, []);
  const explicit = fixture({ context: ctx({ autoOpen: true }), locator, explicitProjectId: uuid(3) }); await explicit.controller.boot(); await explicit.controller.boot();
  assert.deepEqual(explicit.opens.map(value => [value.projectId, value.remember]), [[uuid(3), false]]);
  const held = Promise.withResolvers<unknown>(); const g = fixture({ context: ctx({ autoOpen: true }), locator, explicitProjectId: uuid(3), readDirectory: () => held.promise });
  const boot = g.controller.boot(); g.controller.interacted(); held.resolve(directory([row()])); await boot; assert.equal(g.opens.length, 0);
});
test('launcher-only locator queue invalidates stale selections before a later ready target', async () => {
  const writes: Array<[string, number]> = [], order: Array<[string, number]> = [];
  const locator = { activate() {}, dispose() {}, discover: async () => null, getState: () => ({ identityBlocked: false }),
    invalidateNavigation: (version: number) => order.push(['invalidate', version]), rememberOpened: (projectId: string, version: number) => writes.push([projectId, version]) } as unknown as Locator;
  const f = fixture({ locator }); await f.controller.boot();
  f.receive({ selectionVersion: 1, selectionProjectId: null });
  f.receive({ selectionVersion: 2, selectionProjectId: null });
  f.receive({ selectionVersion: 1, selectionProjectId: uuid(3) }); assert.equal(writes.length, 0);
  f.receive({ selectionVersion: 2, selectionProjectId: uuid(4) }); f.receive({ selectionVersion: 2, selectionProjectId: uuid(4) });
  assert.deepEqual(writes, [[uuid(4), 2]]); assert.deepEqual(order, [['invalidate', 0], ['invalidate', 1], ['invalidate', 2]]);
});
test('entry unknown creation preserves exact P0 close-only risk admission across quit context', async () => {
  const f = fixture({ readDirectory: () => directory([row()]), rpc: async () => Promise.reject(new Error('unknown')) });
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
  let value = ctx(); let receive: ((value: LauncherContext) => void) | undefined;
  const source = { context: async () => value, openProject: async () => result(), publishLocatorStatus: async () => true, requestLocatorAction: async () => true, requestProjectEntry: async () => true,
    showProjects: async () => true, showSettings: async () => true, closeSettings: async () => true, editorStatus: async () => true, subscribe: (listener: (value: LauncherContext) => void) => { receive = listener; return () => {}; } };
  const bridge = readDesktopWindowBridge({ __mioonProjectWindow: source }); if (!bridge) throw new Error('expected a project window bridge'); await bridge.context(); const seen: LauncherContext[] = []; bridge.subscribe(v => seen.push(v));
  value = { ...value, role: 'settings' }; receive?.(value); assert.equal(seen.length, 0); await assert.rejects(bridge.context());
});

test('settings close requires its explicit native bridge method and an exact boolean acknowledgement', async () => {
  for (const receipt of [true, false, undefined, null, 'true', { closed: true }]) {
    let calls = 0;
    const source = { context: async () => ctx(), openProject: async () => result(), publishLocatorStatus: async () => true, requestLocatorAction: async () => true, requestProjectEntry: async () => true,
      showProjects: async () => true, showSettings: async () => true, closeSettings: async () => { calls++; return receipt; }, editorStatus: async () => true, subscribe: () => () => {} };
    const bridge = readDesktopWindowBridge({ __mioonProjectWindow: source }); assert.ok(bridge);
    if (typeof receipt === 'boolean') assert.equal(await bridge.closeSettings(), receipt);
    else await assert.rejects(bridge.closeSettings(), /桌面窗口身份/);
    assert.equal(calls, 1);
    const { closeSettings: _closeSettings, ...missingMethod } = source;
    assert.throws(() => readDesktopWindowBridge({ __mioonProjectWindow: missingMethod }), /桌面窗口身份/);
  }
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

test('an editor lease revoke is terminal for create, open and show without treating an ordinary load failure as a revoke', async () => {
  const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'failed', editorCount: 1, leaseRevoked: true});
  const f = fixture({context: initial}); await f.controller.boot();
  f.controller.reportCreate({dirty: true, busy: false, version: 1});
  const projects = f.controller.getState().projects, close = f.controller.readCloseSnapshot();
  for (const recover of [false, true]) {
    if (recover) f.receive({leaseRevoked: false, editorPhase: 'ready'});
    assert.equal(await f.controller.show('new'), false);
    assert.equal(await f.controller.open(uuid(4)), false);
    assert.equal(await f.controller.create('new', ''), false);
    assert.equal(f.controller.canMutate(), false);
    assert.equal(f.controller.getState().shown, false); assert.equal(f.controller.getState().createUnknown, false);
    assert.equal(f.controller.getState().projects, projects); assert.equal(f.controller.readCloseSnapshot().dirty, close.dirty);
  }
  assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 0); assert.equal(f.opens.length, 0);
  const failed = fixture({context: {...initial, leaseRevoked: false}}); await failed.controller.boot();
  assert.equal(await failed.controller.show('new'), true); await failed.controller.refresh();
  assert.equal(await failed.controller.create('new', ''), true);
  assert.equal(failed.calls.filter(([op]) => op === 'project.create').length, 1);
});

test('revocation preserves the shown dirty form and its exact guarded dismissal', async () => {
  const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1});
  let allowed = false;
  const f = fixture({context: initial, confirm: async () => allowed}); await f.controller.boot(); await f.controller.show('new'); await f.controller.refresh();
  f.controller.reportCreate({dirty: true, busy: false, version: 1});
  const projects = f.controller.getState().projects;
  f.receive({editorPhase: 'failed', leaseRevoked: true});
  assert.equal(await f.controller.create('new', ''), false); assert.equal(await f.controller.open(uuid(4)), false);
  assert.equal(await f.controller.show('open'), false); assert.equal(f.controller.canMutate(), false);
  assert.equal(await f.controller.dismiss(), false); assert.equal(f.controller.getState().shown, true);
  assert.equal(f.controller.readCloseSnapshot().dirty, true); assert.equal(f.controller.getState().projects, projects);
  allowed = true; assert.equal(await f.controller.dismiss(), true); assert.equal(f.controller.getState().shown, false);
  assert.equal(f.controller.readCloseSnapshot().dirty, true);
  assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 0); assert.equal(f.opens.length, 0);
});

test('a revoke observed while describing a create is definitive before dispatch, including an older describe reply', async () => {
  for (const observation of ['describe', 'subscription', 'older-describe']) {
    const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1});
    const fresh = Promise.withResolvers<LauncherContext>(), f = fixture({context: initial});
    await f.controller.boot(); await f.controller.show('new'); await f.controller.refresh();
    f.controller.reportCreate({dirty: true, busy: false, version: 1});
    f.bridge.context = () => fresh.promise;
    const pending = f.controller.create('new', ''); await tick(); assert.equal(f.controller.getState().creating, true);
    if (observation === 'subscription') f.receive({editorPhase: 'failed', leaseRevoked: true});
    if (observation === 'older-describe') f.receive({editorCount: 2});
    fresh.resolve(observation === 'subscription' ? initial : {...initial, editorPhase: 'failed', leaseRevoked: true});
    assert.equal(await pending, false, observation); assert.equal(f.controller.getState().creating, false, observation);
    assert.equal(f.controller.getState().createUnknown, false, observation); assert.equal(f.controller.readCloseSnapshot().dirty, true, observation);
    assert.equal(f.controller.canMutate(), false, observation);
    assert.equal(await f.controller.create('again', ''), false, observation); assert.equal(await f.controller.show('new'), false, observation);
    assert.equal(await f.controller.open(uuid(4)), false, observation);
    assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 0, observation); assert.equal(f.opens.length, 0, observation);
    if (observation === 'older-describe') assert.equal(f.controller.getContext().editorCount, 2, 'a terminal observation must not roll back the newer host context');
  }
});

test('a revoke during the real create client directory preflight rejects before its mutation dispatch', async () => {
  const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1});
  const catalog = Promise.withResolvers<unknown>(); let holdDirectory = false;
  const f = fixture({context: initial, readDirectory: () => holdDirectory ? catalog.promise : directory([row(), row(uuid(4))])});
  await f.controller.boot(); await f.controller.show('new'); await f.controller.refresh();
  f.controller.reportCreate({dirty: true, busy: false, version: 1}); holdDirectory = true;
  const pending = f.controller.create('new', ''); await tick();
  assert.equal(f.controller.getState().creating, true); assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 0);
  f.receive({editorPhase: 'failed', leaseRevoked: true}); catalog.resolve(directory([row(), row(uuid(4))]));
  assert.equal(await pending, false); assert.equal(f.controller.getState().creating, false);
  assert.equal(f.controller.getState().createUnknown, false); assert.equal(f.controller.getState().createdProjectId, null);
  assert.equal(f.controller.readCloseSnapshot().dirty, true); assert.equal(f.controller.canMutate(), false);
  assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 0); assert.equal(f.opens.length, 0);
});

test('revocation after a create mutation was dispatched retains its exact success or unknown outcome without opening or replaying', async () => {
  for (const acknowledged of [true, false]) {
    const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1});
    const mutation = Promise.withResolvers<unknown>(), f = fixture({context: initial, rpc: () => mutation.promise});
    await f.controller.boot(); await f.controller.show('new'); await f.controller.refresh();
    f.controller.reportCreate({dirty: true, busy: false, version: 1});
    const pending = f.controller.create('new', ''); await tick();
    assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 1);
    f.receive({editorPhase: 'failed', leaseRevoked: true});
    if (acknowledged) mutation.resolve(row(uuid(5), 'new')); else mutation.reject(new Error('lost create acknowledgement'));
    assert.equal(await pending, acknowledged); assert.equal(f.controller.getState().createUnknown, !acknowledged);
    assert.equal(f.controller.getState().createdProjectId, acknowledged ? uuid(5) : null);
    assert.equal(f.controller.readCloseSnapshot().dirty, true); assert.equal(f.controller.getState().creating, false);
    assert.equal(await f.controller.create('again', ''), false); assert.equal(f.opens.length, 0);
    assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 1);
  }
});

test('a revoked editor can reconcile its original unknown open receipt but cannot consume or redispatch a permit', async () => {
  const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1});
  const f = fixture({context: initial, invoke: () => {throw new Error('lost acknowledgement');}});
  await f.controller.boot(); await f.controller.show('open'); f.controller.reportCreate({dirty: true, busy: false, version: 1});
  assert.equal(await f.controller.open(uuid(4)), false); assert.equal(f.controller.getState().openUnknown, true);
  const token = f.opens[0].entryToken;
  f.receive({editorPhase: 'failed', leaseRevoked: true});
  assert.equal(f.controller.consume(token, uuid(4)).accepted, false);
  assert.equal(await f.controller.open(uuid(4)), false); assert.equal(await f.controller.create('again', ''), false);
  f.bridge.context = async () => ({...f.context(), entryReceipt: {entryToken: token, result: result({targetPhase: 'ready'})}});
  await f.controller.reconcileOpen();
  assert.equal(f.controller.getState().openUnknown, false); assert.equal(f.controller.getState().sealed, false);
  assert.equal(f.controller.getState().shown, false); assert.equal(f.controller.readCloseSnapshot().dirty, true);
  assert.equal(await f.controller.show('new'), false); assert.equal(f.controller.canMutate(), false);
  assert.equal(f.opens.length, 1); assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 0);
});

test('revocation retains an unknown creation and its close protection without allowing read-only refresh to resubmit it', async () => {
  const initial = ctx({role: 'editor', initialProjectId: uuid(3), editorProjectId: uuid(3), editorPhase: 'ready', editorCount: 1});
  const f = fixture({context: initial, rpc: async () => {throw new Error('lost create acknowledgement');}});
  await f.controller.boot(); await f.controller.show('new'); await f.controller.refresh();
  f.controller.reportCreate({dirty: true, busy: false, version: 1});
  assert.equal(await f.controller.create('new', ''), false); assert.equal(f.controller.getState().createUnknown, true);
  const close = f.controller.readCloseSnapshot(); f.receive({editorPhase: 'failed', leaseRevoked: true});
  assert.equal(await f.controller.refresh(), true); await f.controller.reconcileOpen();
  assert.equal(await f.controller.create('again', ''), false); assert.equal(await f.controller.open(uuid(4)), false);
  assert.equal(await f.controller.show('new'), false); assert.equal(await f.controller.dismiss(), false);
  assert.equal(f.controller.getState().createUnknown, true); assert.equal(f.controller.getState().shown, true);
  const retained = f.controller.readCloseSnapshot();
  assert.equal(retained.dirty, close.dirty); assert.equal(retained.busy, close.busy); assert.equal(retained.unknown, close.unknown);
  const admission = createNativeCloseAdmission({registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: () => 'same', readDocumentURL: () => 'http://localhost/', readAdditionalSnapshot: f.controller.readCloseSnapshot,
    now: () => 1, newToken: () => 'revoked-close-token'});
  assert.equal(admission.inspect().disposition, 'unknown-dirty');
  assert.equal(f.calls.filter(([op]) => op === 'project.create').length, 1); assert.equal(f.opens.length, 0);
});

for (const action of ['open', 'dismiss']) test(`exact departure capture survives the caller await before ${action}`, async () => {
  const answer = Promise.withResolvers<boolean>();
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
