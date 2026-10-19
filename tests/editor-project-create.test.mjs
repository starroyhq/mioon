import { i18nTestModule, createI18nTestContext, message as msg, renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEditorWindowInputs } from '../apps/web/src/editor-window-inputs.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, TIMELINE_MUTATION_OPERATIONS, REFERENCE_MUTATION_OPERATIONS } from '@mioon/contracts';
import { isMutationOperation } from '../apps/web/src/mutation-submissions.ts';
import { schemas, workspaceRestoreInspectionSchema } from '../packages/contracts/src/index.ts';
import { createLauncherClient, LauncherCreateError } from '../apps/web/src/launcher-state.ts';
import { createProjectEntryController } from '../apps/web/src/project-entry-state.ts';
import { ApiError } from '../apps/web/src/api.ts';

import { lenientFunction, stripSourceTypes } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app = readFileSync(process.env.MIOON_EDITOR_CREATE_APP_SOURCE || new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const id = n => `76000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const name = 'Private project name', description = 'Private project description';
const row = () => ({ id: id(2), name, description, revision: 1, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(setImmediate);
function section(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from); assert.equal(app.indexOf(start, from + start.length), -1);
  return app.slice(from, to);
}
function appFixture(options = {}) {
  const inputs = createEditorWindowInputs(), busy = new Set(), calls = [];
  let refreshCalls = 0;
  const read = navigation => inputs.read({ busy, navigation, defaultSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS });
  const env = { application: null, clipConnectionBlocked: {current: false}, msg, ...createI18nTestContext(), localizedError: value => Object.assign(new Error(renderCoreMessage('zh-Hans', value)), { displayMessage: value }),
    nativeWindow: options.web ? null : { context: { role: 'editor', initialProjectId: id(1) } }, editorInputs: { current: inputs },
    nativeProjectEntry: options.noEntry ? null : { show: mode => { calls.push(['scoped-entry', mode]); return Promise.resolve(true); } },
    projectCreateFlight: { current: null }, currentProject: { current: id(1) }, importSession: { current: { active: true, selection: 0 } },
    context: () => ({ projectId: env.currentProject.current, epoch: 1, workspace: options.predispatch ? {} : null }),
    isCurrent: capture => capture.projectId === env.currentProject.current && env.importSession.current.active,
    notify: (...args) => calls.push(['notice', ...args]), readableError: error => error.message,
    markBusy(projectId, key, value) { inputs.changed(); if (value) busy.add(`${projectId}:${key}`); else busy.delete(`${projectId}:${key}`); },
    isBusy: (key, projectId) => options.earlyBusy && key === 'project-create' || busy.has(`${projectId}:${key}`),
    prepareSettingsDeparture: async () => ({}), settingsNavigation: { current: { canLeave: () => true } },
    guardProjectNavigation: async (_message, _dirty, current) => current() && (options.web || !read(true).busy && !read(true).unknown),
    captureTaskWorkspaceIntent: () => () => true, readTaskRevealContext: () => ({}), isMutationOperation,
    TIMELINE_MUTATION_OPERATIONS, REFERENCE_MUTATION_OPERATIONS,
    pinNewWorkspaceIntent: () => ({}), assertWorkspaceIntent: () => ({}),
    assertWorkspaceOperation: () => { if (options.predispatch) throw Error('Local workspace rejection before dispatch'); },
    async refresh() { refreshCalls++; calls.push(['refresh']); if (options.refreshFailure && refreshCalls === 1) throw Error('Follow-up read failed'); },
    async rpc(operation, input) {
      calls.push(['rpc', operation, input]);
      if (operation === 'project.create') return options.create ? options.create(input) : row();
      if (operation === 'project.list') { if (options.listFailure) throw Error('Project list unavailable'); return [row()]; }
      assert.fail(`Unexpected operation ${operation}`);
    },
    setProjects: value => calls.push(['projects', value]), setShowCreate: value => calls.push(['show-create', value]),
    setProjectListStatus: value => calls.push(['list-status', value]), setAuth: value => calls.push(['auth', value]),
    projectOpenFailureKind: () => 'read',
    selectProject: async projectId => { calls.push(['select', projectId]); env.currentProject.current = projectId; return true; },
  };
  const source = [section('  async function runSession(', '  // Picking a shot,'), section('  async function createProject(', '  async function addShot(')].join('\n');
  const api = Function('env', `with (env) { ${source}\n return { runSession, createProject }; }`)(env);
  env.run = (...args) => { calls.push(['run', args]); return api.runSession(...args); };
  return { ...api, env, calls, inputs, read, posts: () => calls.filter(call => call[0] === 'rpc' && call[1] === 'project.create') };
}

const nativeContext = () => ({ version: 2, role: 'editor', windowId: id(10), contextId: id(11), backendId: id(12),
  initialProjectId: id(1), autoOpen: false, editorProjectId: id(1), editorPhase: 'ready', editorCount: 1,
  entryMode: null, entryVersion: 0, entryReceipt: null, settingsSlot: null, settingsVersion: 0,
  selectionProjectId: null, selectionVersion: 0, locatorStatus: null, locatorIntent: null, quitting: false });
const openResult = patch => ({ ok: true, reason: 'accepted', targetWindowId: id(20), targetPhase: 'opening', ...patch });
// Execute the actual composition-root DI with the real transport error class
// and contract schemas, rather than a test-only definitive-error predicate.
const main = readFileSync(new URL('../apps/web/src/main.tsx', import.meta.url), 'utf8');
const declaration = main.match(/^const launcherContracts(?:: [^=]+)? = (.+);$/m);
assert.ok(declaration, 'Main retains one narrow contract DI declaration');
const checks = Function('ApiError', 'schemas', 'workspaceRestoreInspectionSchema', `return (${stripSourceTypes('('+declaration[1]+')',{loader:'ts'}).trim().replace(/;$/,'')});`)(ApiError, schemas, workspaceRestoreInspectionSchema);
async function entryFixture(options = {}) {
  const calls = [], opens = []; let current = nativeContext(), token = 100, controller;
  const failure = { inspect: false, list: false, describe: false };
  const bridge = {
    context: async () => { if (failure.describe) throw Error('Describe unavailable before dispatch'); return current; },
    async openProject(projectId, remember, entryToken) {
      opens.push({ projectId, remember, entryToken });
      assert.equal(controller.consume(entryToken, projectId).accepted, true, 'Host consumes the real exact sealed permit');
      if (options.open) return options.open({ projectId, remember, entryToken });
      const result = openResult(); current = { ...current, entryReceipt: { entryToken, result } }; return result;
    },
  };
  const client = createLauncherClient(async (operation, input) => {
    calls.push([operation, input]);
    if (operation === 'workspace.restore.inspect') { if (failure.inspect) throw Error('Workspace refresh unavailable'); return { restored: false }; }
    if (operation === 'project.list') { if (failure.list) throw Error('Project list unavailable'); return [row()]; }
    if (operation === 'project.create') return options.create ? options.create(input) : row();
    assert.fail(`Unexpected entry operation ${operation}`);
  }, checks);
  controller = createProjectEntryController({ client, bridge, context: current, confirm: async () => true, newToken: () => id(++token) });
  controller.activate(); await controller.show('new'); await tick();
  assert.ok(controller.getState().workspace, 'The real canonical inspection and catalog reads completed');
  return { controller, client, calls, opens, failure, read: () => controller.readCloseSnapshot(),
    posts: () => calls.filter(([operation]) => operation === 'project.create'),
    receive(patch) { current = { ...current, ...patch }; controller.updateContext(current); } };
}

test('native entry lost create ACK latches unknown and prevents immediate or refreshed duplicate POST', async () => {
  const held = deferred(), f = await entryFixture({ create: () => held.promise });
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  const pending = f.controller.create(name, description); await tick();
  assert.equal(f.posts().length, 1); assert.equal(f.read().busy, true);
  assert.equal(await f.controller.create(name, description), false);
  held.reject(Error('Connection lost after create')); assert.equal(await pending, false);
  assert.equal(f.read().busy, false); assert.equal(f.read().unknown, true); assert.equal(f.read().dirty, true);
  assert.equal(await f.controller.create(name, description), false);
  await f.controller.refresh();
  assert.equal(f.read().unknown, true, 'A matching list row is not a create acknowledgement');
  assert.equal(await f.controller.show('open'), false); assert.equal(await f.controller.dismiss(), false);
  assert.equal(await f.controller.open(id(2)), false); assert.equal(f.opens.length, 0);
  assert.equal(f.posts().length, 1, 'Unkeyed create must not replay');
  assert.equal(f.controller.canMutate(), false); assert.doesNotMatch(JSON.stringify(f.read()), /Private project/);
});

for (const invalid of [{ id: id(2) }, { ...row(), name: 'Another name' }, { ...row(), description: 'Another description' }]) {
  test(`native real canonical malformed/mismatched create ACK remains unknown: ${Object.keys(invalid).length}:${invalid.name || 'shape'}`, async () => {
    const f = await entryFixture({ create: () => invalid }); assert.equal(await f.controller.create(name, description), false);
    assert.equal(f.read().unknown, true); assert.equal(await f.controller.create(name, description), false); assert.equal(f.posts().length, 1);
    assert.equal(f.opens.length, 0); assert.equal(f.controller.getContext().initialProjectId, id(1));
  });
}

for (const readFailure of ['inspect', 'list']) test(`valid native create ACK stays confirmed after ${readFailure} refresh failure`, async () => {
  const f = await entryFixture(); assert.equal(await f.controller.create(name, description), true);
  f.failure[readFailure] = true; await f.controller.refresh();
  assert.ok(f.controller.getState().listError);
  assert.equal(f.controller.getState().createdProjectId, id(2));
  assert.equal(f.posts().length, 1); assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false);
  assert.equal(f.opens.length, 1); assert.equal(f.controller.getContext().initialProjectId, id(1));
  assert.equal(f.controller.getState().shown, false, 'The source editor remains mounted, with its entry dismissed only after open acceptance');
});

test('native acknowledged creation opens once, keeps the latch through the exact open receipt, and never replaces its source', async () => {
  const opening = deferred(), f = await entryFixture({ open: () => opening.promise });
  const work = f.controller.create(name, description); await tick();
  assert.equal(f.posts().length, 1); assert.deepEqual(f.posts()[0][1], { name, description });
  assert.equal(f.read().unknown, false); assert.equal(f.read().busy, true);
  assert.equal(f.controller.getState().sealed, true); assert.equal(f.controller.canMutate(), false);
  assert.equal(await f.controller.create(name, description), false); assert.equal(f.posts().length, 1);
  opening.resolve(openResult()); assert.equal(await work, true);
  assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false); assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].projectId, id(2)); assert.equal(f.opens[0].remember, true);
  assert.equal(f.controller.getContext().initialProjectId, id(1));
});

test('known native create ACK is not downgraded or replayed when opening is refused', async () => {
  const f = await entryFixture({ open: () => openResult({ ok: false, reason: 'busy', targetWindowId: null, targetPhase: null }) });
  assert.equal(await f.controller.create(name, description), true, 'The form receives the authoritative create success, not a retry invitation');
  assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false);
  assert.equal(f.controller.getState().createdProjectId, id(2)); assert.equal(f.controller.getState().shown, true);
  await f.controller.refresh(); assert.equal(f.posts().length, 1); assert.equal(f.opens.length, 1);
});

test('native predispatch identity failure releases the create latch without RPC or uncertainty', async () => {
  const f = await entryFixture(); f.failure.describe = true;
  assert.equal(await f.controller.create(name, description), false);
  assert.equal(f.posts().length, 0); assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false);
  assert.equal(f.controller.canMutate(), true);
});

test('native local canonical input rejection makes no POST and remains safely editable', async () => {
  const f = await entryFixture(); assert.equal(await f.controller.create('', description), false);
  assert.equal(f.posts().length, 0); assert.equal(f.read().busy, false); assert.equal(f.read().unknown, false);
  assert.equal(f.controller.canMutate(), true);
});

test('native definitive create rejection releases only the rejected flight without uncertainty', async () => {
  const f = await entryFixture({ create: () => { throw new ApiError('Invalid name', 'VALIDATION_ERROR', undefined, true, 400); } });
  assert.equal(await f.controller.create(name, description), false);
  assert.equal(f.posts().length, 1); assert.equal(f.read().busy, false); assert.equal(f.read().unknown, false);
  assert.equal(f.controller.canMutate(), true); assert.equal(f.opens.length, 0);
});

for (const [label, error] of [
  ['network loss', Error('Network connection lost')],
  ['server 500', new ApiError('Internal error', 'INTERNAL', undefined, false, 500)],
  ['protocol error', new ApiError('Invalid response', 'BACKEND_PROTOCOL_ERROR')],
  ['plain definitive lookalike', Object.assign(Error('Invalid name'), { definitive: true, status: 400, code: 'VALIDATION_ERROR' })],
  ['plain outcome lookalike', { outcome: 'rejected', definitive: true }],
]) test(`native ${label} has no transport rejection proof and keeps unknown without replay`, async () => {
  const f = await entryFixture({ create: () => { throw error; } });
  assert.equal(await f.controller.create(name, description), false);
  assert.equal(f.posts().length, 1); assert.equal(f.read().busy, false); assert.equal(f.read().unknown, true);
  assert.equal(f.controller.canMutate(), false); assert.equal(f.opens.length, 0);
  assert.equal(await f.controller.create(name, description), false); assert.equal(f.posts().length, 1);
});

test('native known rejection permits only a new explicit submission after the user corrects input', async () => {
  let attempts = 0;
  const f = await entryFixture({ create: input => {
    if (!attempts++) throw new ApiError('Invalid name', 'VALIDATION_ERROR', undefined, true, 400);
    return { ...row(), ...input };
  } });
  assert.equal(await f.controller.create(name, description), false);
  await f.controller.refresh(); await tick(); assert.equal(f.posts().length, 1, 'Read and render completion never auto-retry');
  f.controller.reportCreate({ dirty: true, busy: false, version: 1 });
  assert.equal(await f.controller.create('Corrected project', description), true);
  assert.equal(f.posts().length, 2); assert.deepEqual(f.posts()[1][1], { name: 'Corrected project', description });
  assert.equal(f.opens.length, 1); assert.equal(f.read().unknown, false);
});

test('create client defaults to unknown without trusted transport classification and never classifies an invalid ACK as rejection', async () => {
  const plainChecks = { parseCreateInput: checks.parseCreateInput, parseWorkspaceInspection: checks.parseWorkspaceInspection };
  const definitive = new ApiError('Rejected', 'VALIDATION_ERROR', undefined, true, 400);
  for (const contractChecks of [plainChecks, { ...plainChecks, isDefinitiveCreateRejection() { throw Error('No proof available'); } }]) {
    const client = createLauncherClient(async () => { throw definitive; }, contractChecks);
    await assert.rejects(client.create(name, description), error => error instanceof LauncherCreateError && error.outcome === 'unknown');
  }
  let classified = 0;
  const client = createLauncherClient(async () => ({ id: id(2) }), { ...plainChecks, isDefinitiveCreateRejection() { classified++; return true; } });
  await assert.rejects(client.create(name, description), error => error instanceof LauncherCreateError && error.outcome === 'unknown');
  assert.equal(classified, 0, 'A malformed success is checked after the rejection classifier boundary');
});

test('native early-busy duplicate cannot dispatch or release the original pending create', async () => {
  const held = deferred(), f = await entryFixture({ create: () => held.promise });
  const original = f.controller.create(name, description);
  assert.equal(await f.controller.create(name, description), false); await tick();
  assert.equal(f.posts().length, 1); assert.equal(f.read().busy, true); assert.equal(f.read().unknown, false);
  assert.equal(await f.controller.dismiss(), false); assert.equal(await f.controller.show('open'), false);
  held.resolve(row()); assert.equal(await original, true); assert.equal(f.read().busy, false); assert.equal(f.opens.length, 1);
});

for (const late of ['acknowledged', 'lost']) test(`late ${late} native create after disposal cannot open or settle a replacement owner`, async () => {
  const old = deferred(), f = await entryFixture({ create: () => old.promise });
  const oldWork = f.controller.create(name, description); await tick(); f.controller.dispose();
  const held = deferred(), next = await entryFixture({ create: () => held.promise });
  const newWork = next.controller.create(name, description); await tick(); const before = next.read();
  if (late === 'acknowledged') old.resolve(row()); else old.reject(Error('Old owner response lost'));
  assert.equal(await oldWork, false); assert.equal(f.opens.length, 0); assert.equal(f.posts().length, 1);
  assert.deepEqual(next.read(), before); assert.equal(next.read().busy, true); assert.equal(next.read().unknown, false);
  held.reject(Error('New owner response lost')); assert.equal(await newWork, false);
  assert.equal(next.read().unknown, true); await next.controller.refresh(); assert.equal(next.read().unknown, true);
  assert.equal(await next.controller.create(name, description), false); assert.equal(next.posts().length, 1);
});

for (const noEntry of [false, true]) test(`legacy native App create only requests scoped New and performs zero business actions (entry ${!noEntry})`, async () => {
  const f = appFixture({ noEntry }); const before = f.read();
  assert.equal(await f.createProject(name, description), false);
  assert.deepEqual(f.calls, noEntry ? [] : [['scoped-entry', 'new']]);
  assert.equal(f.posts().length, 0); assert.equal(f.env.currentProject.current, id(1));
  assert.equal(f.env.projectCreateFlight.current, null); assert.deepEqual(f.read(), before);
});

test('stale observer finalization/failure cannot clear a newer create or a latched unknown', () => {
  const f = appFixture(), first = f.inputs.beginProjectCreate(id(1)); assert.ok(first);
  f.inputs.failProjectCreate(first, { dispatched: false }); const second = f.inputs.beginProjectCreate(id(1)); assert.ok(second);
  f.inputs.finishProjectCreate(first); f.inputs.failProjectCreate(first, { dispatched: true });
  assert.equal(f.read().busy, true); assert.equal(f.read().unknown, false);
  f.inputs.failProjectCreate(second, { dispatched: true }); const unknown = f.read();
  f.inputs.finishProjectCreate(second); f.inputs.validateProjectCreate(first, row(), name, description);
  assert.deepEqual(f.read(), unknown); assert.equal(f.inputs.beginProjectCreate(id(1)), null);
});

test('Web real create/runSession preserves legacy retry and response semantics without a native observer', async () => {
  let count = 0; const f = appFixture({ web: true, create: () => { if (!count++) throw Error('Lost old Web ACK'); return { id: id(2) }; } });
  assert.equal(await f.createProject(name, description), false); assert.equal(f.read().unknown, false);
  assert.equal(await f.createProject(name, description), true); assert.equal(f.posts().length, 2);
  const runs = f.calls.filter(call => call[0] === 'run');
  assert.equal(runs.length, 2);
  for (const [, args] of runs) {
    assert.equal(args[0], 'project-create'); assert.equal(args[1], 'project.create'); assert.deepEqual(args[2], { name, description });
  }
  assert.equal(runs.every(([, args]) => args.length === 5), true);
});
