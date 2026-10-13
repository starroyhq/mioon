import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEditorWindowInputs } from '../apps/web/src/editor-window-inputs.ts';
import { TIMELINE_EXPORT_DEFAULT_SETTINGS, TIMELINE_MUTATION_OPERATIONS, REFERENCE_MUTATION_OPERATIONS } from '@mioon/contracts';
import { isMutationOperation } from '../apps/web/src/mutation-submissions.js';

const app = readFileSync(process.env.MIOON_EDITOR_CREATE_APP_SOURCE || new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
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
function fixture(options = {}) {
  const inputs = createEditorWindowInputs(), busy = new Set(), calls = [];
  let refreshCalls = 0;
  const read = navigation => inputs.read({ busy, navigation, defaultSettings: TIMELINE_EXPORT_DEFAULT_SETTINGS });
  const env = {
    nativeWindow: options.web ? null : { context: { role: 'editor' } }, editorInputs: { current: inputs },
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

test('native real create/runSession lost ACK latches unknown and prevents immediate duplicate POST', async () => {
  const held = deferred(), f = fixture({ create: () => held.promise });
  const pending = f.createProject(name, description); await tick();
  assert.equal(f.posts().length, 1); assert.equal(f.read(true).busy, true);
  held.reject(Error('Connection lost after create')); assert.equal(await pending, false);
  assert.equal(f.read().busy, false); assert.equal(f.read().unknown, true); assert.equal(f.read(true).unknown, true);
  assert.equal(await f.createProject(name, description), false); assert.equal(f.posts().length, 1, 'Unkeyed create must not replay');
  assert.equal(f.inputs.canCreateProject(), false); assert.doesNotMatch(JSON.stringify(f.read()), /Private project/);
});

for (const invalid of [{ id: id(2) }, { ...row(), name: 'Another name' }, { ...row(), description: 'Another description' }]) {
  test(`native malformed/mismatched create ACK remains unknown: ${Object.keys(invalid).length}:${invalid.name || 'shape'}`, async () => {
    const f = fixture({ create: () => invalid }); assert.equal(await f.createProject(name, description), false);
    assert.equal(f.read().unknown, true); assert.equal(await f.createProject(name, description), false); assert.equal(f.posts().length, 1);
    assert.equal(f.calls.some(call => call[0] === 'select'), false);
  });
}

for (const readFailure of ['refreshFailure', 'listFailure']) test(`valid native create ACK stays confirmed after ${readFailure}`, async () => {
  const f = fixture({ [readFailure]: true }); assert.equal(await f.createProject(name, description), false);
  assert.equal(f.posts().length, 1); assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false);
  assert.equal(f.inputs.canCreateProject(), true); assert.equal(f.env.projectCreateFlight.current, null);
});

test('native acknowledged creation opens once and releases its exact observer', async () => {
  const f = fixture(); assert.equal(await f.createProject(name, description), true); assert.equal(f.posts().length, 1);
  assert.deepEqual(f.posts()[0][2], { name, description }); assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false);
  assert.equal(f.calls.filter(call => call[0] === 'select').length, 1);
});

for (const outcome of ['predispatch', 'rejected', 'earlyBusy']) test(`native ${outcome} releases flight without creating uncertainty`, async () => {
  const f = fixture(outcome === 'rejected' ? { create: () => { throw Object.assign(Error('Invalid name'), { definitive: true, status: 400 }); } } : { [outcome]: true });
  assert.equal(await f.createProject(name, description), false); assert.equal(f.read().unknown, false); assert.equal(f.read().busy, false);
  assert.equal(f.posts().length, outcome === 'rejected' ? 1 : 0); assert.equal(f.inputs.canCreateProject(), true);
});

test('late native ACK after navigation settles only its old operation without opening the created project', async () => {
  const held = deferred(), f = fixture({ create: () => held.promise }), pending = f.createProject(name, description); await tick();
  f.env.currentProject.current = id(3); held.resolve(row()); assert.equal(await pending, false);
  assert.equal(f.read().unknown, false); assert.equal(f.posts().length, 1); assert.equal(f.calls.some(call => call[0] === 'select'), false);
});

test('stale observer finalization/failure cannot clear a newer create or a latched unknown', () => {
  const f = fixture(), first = f.inputs.beginProjectCreate(id(1)); assert.ok(first);
  f.inputs.failProjectCreate(first, { dispatched: false }); const second = f.inputs.beginProjectCreate(id(1)); assert.ok(second);
  f.inputs.finishProjectCreate(first); f.inputs.failProjectCreate(first, { dispatched: true });
  assert.equal(f.read().busy, true); assert.equal(f.read().unknown, false);
  f.inputs.failProjectCreate(second, { dispatched: true }); const unknown = f.read();
  f.inputs.finishProjectCreate(second); f.inputs.validateProjectCreate(first, row(), name, description);
  assert.deepEqual(f.read(), unknown); assert.equal(f.inputs.beginProjectCreate(id(1)), null);
});

test('Web real create/runSession preserves legacy retry and response semantics without a native observer', async () => {
  let count = 0; const f = fixture({ web: true, create: () => { if (!count++) throw Error('Lost old Web ACK'); return { id: id(2) }; } });
  assert.equal(await f.createProject(name, description), false); assert.equal(f.read().unknown, false);
  assert.equal(await f.createProject(name, description), true); assert.equal(f.posts().length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'run').every(call => call[1].length === 3), true);
});
