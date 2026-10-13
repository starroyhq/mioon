import test from 'node:test';
import assert from 'node:assert/strict';
import { schemas, workspaceRestoreInspectionSchema } from '../packages/contracts/src/index.mjs';
import { lastProjectEnvelopeSchema } from '../packages/contracts/src/last-project.ts';
import { createLauncherClient, createLauncherController, createLauncherCloseSettings, parseLauncherProjects, launcherCreateDisabledReason } from '../apps/web/src/launcher-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import { createNativeCloseAdmission, createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import { createLastProjectController } from '../apps/web/src/last-project-state.ts';
import { readDesktopWindowBridge } from '../apps/web/src/desktop-window-client.ts';
const uuid = n => `78000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checks = { parseCreateInput: value => schemas['project.create'].parse(value), parseWorkspaceInspection: value => workspaceRestoreInspectionSchema.parse(value) };
const context = patch => ({ version: 1, role: 'launcher', contextId: uuid(1), backendId: uuid(2), initialProjectId: null, autoOpen: true, editorProjectId: null, editorPhase: 'none', settingsSlot: null, settingsVersion: 0, quitting: false, ...patch });
const row = (id = uuid(3)) => ({ id, name: '故事', description: '', revision: 1, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture({ projects = [row(), row(uuid(4))], initial = context(), rpc, locatorProject = null, explicit = null } = {}) {
  const calls = [], opens = [], openIntents = [], writes = [];
  const bridge = { context: async () => initial, openProject: async (projectId, remember) => { opens.push(projectId); openIntents.push({ projectId, remember }); return { ok: true, reason: 'accepted' }; } };
  const client = createLauncherClient(async (operation, input) => {
    calls.push([operation, input]);
    if (rpc) return rpc(operation, input);
    if (operation === 'workspace.restore.inspect') return { restored: false };
    if (operation === 'project.list') return projects;
    if (operation === 'project.create') return row(uuid(5));
    assert.fail(operation);
  }, checks);
  const locator = createLastProjectController({ client: {
    get: async () => lastProjectEnvelopeSchema.parse({ supported: true, workspaceScope: 'a'.repeat(64), instanceId: uuid(7), projectId: locatorProject, revision: locatorProject ? 1 : 0, updatedAt: locatorProject ? '2026-10-13T00:00:00.000Z' : null, targetStatus: locatorProject ? 'matching' : 'unset' }),
    put: async value => { writes.push(value); assert.fail('Launcher must not remember a project before the editor validates it'); },
  } });
  const controller = createLauncherController({ client, context: initial, bridge, locator, explicitProjectId: explicit });
  controller.activate();
  return { controller, client, calls, opens, openIntents, writes, bridge };
}

test('RPC results are unknown until canonical inspection and project rows are checked', async () => {
  for (const value of [null, {}, [row(), row()], [{ ...row(), id: 'nope' }], [{ ...row(), revision: '1' }], [{ ...row(), updatedAt: 'not-a-date' }]]) assert.throws(() => parseLauncherProjects(value));
  const f = fixture({ rpc: async () => ({ restored: false, unexpected: true }) });
  await f.controller.boot(); assert.equal(f.opens.length, 0); assert.ok(f.controller.getState().listError);
  let dispatched = 0;
  const client = createLauncherClient(async () => { dispatched++; return row(); }, checks);
  await assert.rejects(client.create('', '')); assert.equal(dispatched, 0);
});
test('one launcher chooser preserves URL, verified locator, then first-project order', async () => {
  for (const [explicit, locatorProject, expected] of [[uuid(4), uuid(3), uuid(4)], [null, uuid(4), uuid(4)], ['invalid', null, uuid(3)]]) {
    const f = fixture({ explicit, locatorProject }); await f.controller.boot(); assert.deepEqual(f.opens, [expected]); assert.deepEqual(f.openIntents, [{ projectId: expected, remember: false }]); assert.deepEqual(f.writes, []);
    await f.controller.refresh(); await f.controller.boot(); assert.deepEqual(f.opens, [expected]);
  }
});
test('recreated launcher never reopens a project automatically', async () => {
  const f = fixture({ initial: context({ autoOpen: false }) }); await f.controller.boot(); await f.controller.refresh(); assert.deepEqual(f.opens, []);
  assert.equal(await f.controller.open(uuid(3)), true); assert.deepEqual(f.opens, [uuid(3)]);
  assert.deepEqual(f.openIntents, [{ projectId: uuid(3), remember: true }]); assert.deepEqual(f.writes, []);
});
test('a late startup read cannot navigate after local interaction or disposal', async () => {
  for (const change of [f => f.controller.interacted(), f => f.controller.dispose()]) {
    const waiting = deferred();
    const f = fixture({ rpc: async operation => operation === 'workspace.restore.inspect' ? { restored: false } : waiting.promise });
    const boot = f.controller.boot(); await Promise.resolve(); change(f); waiting.resolve([row()]); await boot; assert.deepEqual(f.opens, []);
  }
});
test('same-project focuses through host while another project gives close-current guidance', async () => {
  const f = fixture({ initial: context({ autoOpen: false, editorProjectId: uuid(3), editorPhase: 'ready' }) }); await f.controller.boot();
  assert.equal(await f.controller.open(uuid(4)), false); assert.equal(f.opens.length, 0); assert.match(f.controller.getState().notice, /关闭/);
  assert.equal(await f.controller.open(uuid(3)), true); assert.deepEqual(f.opens, [uuid(3)]);
  assert.deepEqual(f.openIntents, [{ projectId: uuid(3), remember: true }]); assert.deepEqual(f.writes, []);
  assert.match(launcherCreateDisabledReason(f.controller.getContext(), f.controller.getState()), /编辑窗口/);
  assert.equal(await f.controller.create('new', ''), false); assert.equal(f.calls.some(([name]) => name === 'project.create'), false);
});
test('host context delivery updates the interaction fence without inventing launcher state changes', async () => {
  const f = fixture({ initial: context({ autoOpen: false }) }); await f.controller.boot();
  const before = f.controller.getState();
  for (const quitting of [true, true, false, false]) {
    f.controller.updateContext(context({ autoOpen: false, quitting }));
    assert.equal(f.controller.getContext().quitting, quitting);
    assert.equal(f.controller.getState(), before);
    if (quitting) assert.match(launcherCreateDisabledReason(f.controller.getContext(), before), /退出/);
  }
});
test('actual launcher failure, readiness and editor closure still publish once per state transition', async () => {
  for (const editorPhase of ['ready', 'none']) {
    const f = fixture({ initial: context({ autoOpen: false }) }); await f.controller.boot();
    await f.controller.open(uuid(3)); const opening = f.controller.getState();
    assert.equal(opening.phase, 'opening'); assert.equal(opening.openingProjectId, uuid(3));
    const failed = context({ autoOpen: false, editorProjectId: uuid(3), editorPhase: 'failed' });
    f.controller.updateContext(failed); const error = f.controller.getState();
    assert.equal(error.phase, 'error'); assert.ok(error.error); assert.ok(error.version > opening.version);
    f.controller.updateContext({ ...failed }); assert.equal(f.controller.getState(), error);
    const settled = { ...failed, editorPhase, editorProjectId: editorPhase === 'ready' ? uuid(3) : null };
    f.controller.updateContext(settled); const home = f.controller.getState();
    assert.equal(home.phase, 'home'); assert.equal(home.openingProjectId, null); assert.ok(home.version > error.version);
    f.controller.updateContext({ ...settled }); assert.equal(f.controller.getState(), home);
  }
});
test('creation has one dispatch; unknown cannot replay or open and requires close-only risk permission', async () => {
  const pending = deferred();
  const f = fixture({ initial: context({ autoOpen: false }), rpc: async operation => operation === 'workspace.restore.inspect' ? { restored: false } : operation === 'project.list' ? [row()] : pending.promise });
  await f.controller.boot(); const work = f.controller.create('new', '');
  assert.equal(await f.controller.create('new', ''), false); assert.equal(await f.controller.open(uuid(3)), false);
  pending.reject(new Error('network timeout')); assert.equal(await work, false); await f.controller.refresh();
  assert.equal(f.controller.getState().createUnknown, true); assert.equal(await f.controller.create('new', ''), false); assert.equal(await f.controller.open(uuid(3)), false);
  assert.equal(f.calls.filter(([name]) => name === 'project.create').length, 1);
  const settings = createSettingsNavigationRegistry();
  const close = createLauncherCloseSettings(settings, () => ({ dirty: true, busy: f.controller.getState().creating, blocked: false, version: f.controller.getState().version }));
  const admission = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: close, readScope: () => 'launcher', newToken: () => 'token',
    readAdditionalSnapshot: () => ({ dirty: false, busy: f.controller.getState().creating, unknown: f.controller.getState().createUnknown, identity: [f.controller, f.controller.getState().version, 'project.create'] }),
    readDocumentURL: () => 'http://localhost/', now: () => 1 });
  const ticket = admission.inspect(); assert.equal(ticket.disposition, 'unknown-dirty');
  assert.equal(admission.commit(ticket.token, { discardDirty: true, allowDrainFailure: false, expiresAt: 1000 }), false);
  assert.equal(admission.inspect('reload', 'http://localhost/').disposition, 'blocked');
});
test('confirmed creation remains confirmed if opening fails; no implicit second create', async () => {
  const f = fixture({ initial: context({ autoOpen: false }) }); await f.controller.boot();
  f.bridge.openProject = async () => { throw new Error('window transport'); };
  assert.equal(await f.controller.create('new', ''), true); assert.ok(f.controller.getState().projects.some(project => project.id === uuid(5)));
  assert.equal(f.controller.getState().creating, false); assert.equal(f.controller.getState().createUnknown, false); assert.equal(f.controller.getState().phase, 'error');
  assert.equal(f.calls.filter(([name]) => name === 'project.create').length, 1);
});
test('settings and local-create P0 captures invalidate on same-dirty new input', () => {
  const settings = createSettingsNavigationRegistry(); let local = { dirty: true, busy: false, blocked: false, version: 1 };
  const close = createLauncherCloseSettings(settings, () => local), native = createNativeCloseAdmission({ registry: createNativeCloseRegistry(), settings: close, readScope: () => 'launcher', now: () => 1, newToken: () => 'token' });
  const ticket = native.inspect(); assert.equal(ticket.disposition, 'dirty'); local = { ...local, version: 2 };
  assert.equal(native.commit(ticket.token, { discardDirty: true, allowDrainFailure: true, expiresAt: 1000 }), false);
  const form = settings.register('home:agent'); form.update({ dirty: false, busy: false, blocked: true, version: 1 }); assert.equal(native.inspect().disposition, 'blocked');
  assert.equal(JSON.stringify(close.capture()).includes('password'), false);
});
test('preload alone selects native identity; forged query role is Web and invalid preload fails closed', async () => {
  assert.equal(readDesktopWindowBridge({ location: { search: '?role=launcher&project=anything' } }), null);
  assert.throws(() => readDesktopWindowBridge({ __mioonProjectWindow: {} }));
  let listener, received = [];
  const source = { context: async () => context(), openProject: async () => ({ ok: true, reason: 'accepted' }), showProjects: async () => true, showSettings: async () => true, editorStatus: async () => true, subscribe: fn => { listener = fn; return () => {}; } };
  const bridge = readDesktopWindowBridge({ __mioonProjectWindow: source }); await bridge.context(); bridge.subscribe(next => received.push(next));
  listener(context({ contextId: uuid(99) })); assert.deepEqual(received, []);
  listener(context({ editorProjectId: uuid(3), editorPhase: 'opening' })); assert.equal(received.length, 1);
  source.openProject = async () => ({ ok: true, reason: 'another-editor' });
  await assert.rejects(bridge.openProject('not-a-project'));
});

test('native navigation cancels delayed startup even without a DOM interaction', async () => {
  for (const target of [{}, { settingsSlot: 'agent', settingsVersion: 1 }]) {
    const waiting = deferred();
    const f = fixture({ rpc: async operation => operation === 'workspace.restore.inspect' ? { restored: false } : waiting.promise });
    const boot = f.controller.boot(); await Promise.resolve();
    f.controller.updateContext(context({ autoOpen: false, ...target }));
    waiting.resolve([row()]); await boot; assert.deepEqual(f.opens, []);
  }
});


test('explicit launcher creation requests remember only through the editor navigation intent', async () => {
  const f = fixture({ initial: context({ autoOpen: false }) }); await f.controller.boot();
  assert.equal(await f.controller.create('new story', ''), true);
  assert.deepEqual(f.openIntents, [{ projectId: uuid(5), remember: true }]);
  assert.deepEqual(f.writes, [], 'launcher never writes the locator before editor validation');
  assert.equal(f.calls.filter(([operation]) => operation === 'project.create').length, 1);
});
