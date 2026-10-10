import test from 'node:test';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createSourceRangeController, sourceFrameCount, sourcePositionFrame, sourceRangeIssue, sourceRangeAddPlan } from '../apps/web/src/source-range-state.js';
import { assertMutationOwner, prepareMutation, validateMutationResponse, isMutationOperation, mutationNotApplied } from '../apps/web/src/mutation-submissions.js';
import { readPending, clearPending, prepareSubmission, pendingForProject } from '../apps/web/src/submissions.js';

const asset = (patch = {}) => ({ id: 'asset-a', projectId: 'project-a', mimeType: 'video/mp4', name: 'Source', duration: 1200, ...patch });
const row = (revision = 0, range = null, source = asset()) => ({ id: source.id, assetId: source.id, projectId: source.projectId, revision, range, sourceFrameCount: sourceFrameCount(source.duration), fps: 30 });
const context = (patch = {}) => ({ scope: 'project-a:1:asset-a:1', projectId: 'project-a', asset: asset(), ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
async function controllerFixture({ initial = row(), read, save = async input => row(input.expectedRevision + 1, { inFrame: input.inFrame, outFrame: input.outFrame }), ctx = context() } = {}) {
  const controller = createSourceRangeController({ read: read || (async () => initial), save });
  controller.setContext(ctx); await flush();
  return controller;
}
const timeline = (patch = {}) => ({ projectId: 'project-a', revision: 7, tracks: [{ id: 'video', kind: 'video' }, { id: 'audio', kind: 'audio' }], clips: [], ...patch });
function storage(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete globalThis.sessionStorage);
}

test('shared source frames are uncapped, positive, safe and deterministic at fractional boundaries', () => {
  assert.equal(sourceFrameCount(1200), 36000);
  assert.equal(sourceFrameCount(1 / 30), 1);
  assert.equal(sourceFrameCount(1.999), 59);
  for (const duration of [undefined, null, '20', 0, -1, NaN, Infinity, .01, Number.MAX_SAFE_INTEGER]) assert.equal(sourceFrameCount(duration), null);
  assert.equal(sourcePositionFrame(2.499, 36000), 74);
  assert.equal(sourcePositionFrame(1 / 30, 36000), 1);
  assert.equal(sourcePositionFrame(1201, 36000), 36000);
  for (const range of [{ inFrame: '', outFrame: 2 }, { inFrame: 0.5, outFrame: 2 }, { inFrame: 2, outFrame: 2 }, { inFrame: -1, outFrame: 2 }, { inFrame: 0, outFrame: 36001 }]) assert.ok(sourceRangeIssue(range, 36000));
  assert.equal(sourceRangeIssue({ inFrame: '20000', outFrame: '35999' }, 36000), '');
});

test('default full source is never treated as explicitly saved, even when untouched', async () => {
  const controller = await controllerFixture();
  assert.deepEqual(controller.getState().draft, { inFrame: 0, outFrame: 36000 });
  assert.equal(controller.getState().dirty, false); assert.equal(controller.snapshot(), null);
  await controller.save();
  assert.equal(controller.getState().row.revision, 1); assert.equal(controller.snapshot().outFrame, 36000);
  assert.match(sourceRangeAddPlan({ snapshot: controller.snapshot(), asset: asset(), timeline: timeline() }).reason, /18000/);
});

test('edits during an acknowledged save remain dirty and use its next CAS revision', async () => {
  const hold = deferred(), inputs = [];
  const controller = await controllerFixture({ save: input => { inputs.push(structuredClone(input)); return hold.promise; } });
  controller.edit('inFrame', '20000'); controller.edit('outFrame', '20120');
  const save = controller.save(); controller.edit('outFrame', '20240');
  hold.resolve(row(1, { inFrame: 20000, outFrame: 20120 })); await save;
  assert.deepEqual(inputs[0], { projectId: 'project-a', assetId: 'asset-a', expectedRevision: 0, inFrame: 20000, outFrame: 20120 });
  assert.equal(controller.getState().draft.outFrame, '20240'); assert.equal(controller.getState().dirty, true);
  assert.equal(controller.getState().baseRevision, 1); assert.equal(controller.snapshot(), null);
  controller.discard(); assert.equal(controller.snapshot().outFrame, 20120);
});

test('null, throwing, or malformed save never clears the editable draft or automatically retries POST', async () => {
  for (const response of [null, 'throw', row(1, { inFrame: 0, outFrame: 40 }), row(9, { inFrame: 30, outFrame: 60 })]) {
    let calls = 0;
    const controller = await controllerFixture({ save: async () => { calls++; if (response === 'throw') throw Error('Offline'); return response; } });
    controller.edit('inFrame', 30); controller.edit('outFrame', 60);
    await controller.save(); await flush();
    assert.equal(calls, 1); assert.deepEqual(controller.getState().draft, { inFrame: 30, outFrame: 60 });
    assert.equal(controller.getState().dirty, true); assert.equal(controller.snapshot(), null);
  }
});

test('late GET, older revision, and late ACK cannot downgrade confirmed state or erase a newer draft', async () => {
  const oldGet = deferred(), saveAck = deferred(); let calls = 0;
  const controller = await controllerFixture({ initial: row(1, { inFrame: 10, outFrame: 100 }), read: async () => ++calls === 1 ? row(1, { inFrame: 10, outFrame: 100 }) : calls === 2 ? oldGet.promise : row(3, { inFrame: 30, outFrame: 130 }), save: () => saveAck.promise });
  const pendingGet = controller.read();
  oldGet.resolve(row(0)); await pendingGet; assert.equal(controller.getState().row.revision, 1);
  controller.edit('outFrame', 110); const pendingSave = controller.save();
  await controller.read(); assert.equal(controller.getState().row.revision, 3);
  controller.edit('outFrame', 150);
  saveAck.resolve(row(2, { inFrame: 10, outFrame: 110 })); await pendingSave;
  assert.equal(controller.getState().row.revision, 3); assert.equal(controller.getState().draft.outFrame, 150);
  assert.equal(controller.getState().conflict, true); assert.equal(controller.snapshot(), null);
});

test('older GET generations are ignored and project/asset epochs reject late reads, saves and source positions', async () => {
  const first = deferred(), second = deferred(), saveAck = deferred(); let reads = 0;
  const controller = createSourceRangeController({ read: () => ++reads === 1 ? first.promise : second.promise, save: () => saveAck.promise });
  controller.setContext(context()); const reread = controller.read();
  second.resolve(row(2, { inFrame: 20, outFrame: 100 })); await reread;
  first.resolve(row(1, { inFrame: 0, outFrame: 100 })); await flush(); assert.equal(controller.getState().row.revision, 2);
  controller.edit('outFrame', 120); const saving = controller.save();
  controller.setContext(context({ scope: 'project-b:1:asset-b:1', projectId: 'project-b', asset: asset({ id: 'asset-b', projectId: 'project-b' }) }));
  saveAck.resolve(row(3, { inFrame: 20, outFrame: 120 })); await saving;
  controller.position(100, 'project-a:1:asset-a:1'); assert.equal(controller.getState().position, 0);
  assert.equal(controller.getState().row, null); assert.equal(controller.getState().dirty, false);
});

test('explicit recovery reread preserves a changed draft until explicit discard', async () => {
  let remote = row(0);
  const controller = await controllerFixture({ read: async () => remote, save: async () => { remote = row(1, { inFrame: 30, outFrame: 60 }); return null; } });
  controller.edit('inFrame', 30); controller.edit('outFrame', 60); await controller.save();
  controller.edit('outFrame', 75); await controller.read();
  assert.equal(controller.getState().row.revision, 1); assert.equal(controller.getState().draft.outFrame, 75);
  assert.equal(controller.getState().conflict, true); assert.equal(controller.snapshot(), null);
  controller.discard(); assert.equal(controller.snapshot().outFrame, 60);
});

test('saved range creates an immutable bounded timeline plan; later range saves cannot rewrite it', async () => {
  const controller = await controllerFixture({ initial: row(1, { inFrame: 20000, outFrame: 20120 }) });
  const snapshot = controller.snapshot(), tl = timeline({ clips: [{ id: 'before', trackId: 'video', startFrame: 20, durationFrames: 40 }] });
  const plan = sourceRangeAddPlan({ snapshot, asset: asset(), timeline: tl });
  assert.equal(plan.valid, true); assert.equal(plan.expectedRevision, 7);
  assert.deepEqual(plan.input, { trackId: 'video', assetId: 'asset-a', name: 'Source', startFrame: 60, durationFrames: 120, sourceInFrame: 20000 });
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(plan.input), true);
  controller.edit('inFrame', 21000); controller.edit('outFrame', 21300); await controller.save();
  assert.equal(plan.input.sourceInFrame, 20000); assert.equal(plan.input.durationFrames, 120); assert.equal(tl.clips.length, 1);
  for (const patch of [{ blocked: true }, { snapshot: null }, { timeline: timeline({ tracks: [] }) }, { timeline: timeline({ clips: [{ trackId: 'video', startFrame: 17900, durationFrames: 50 }] }) }, { asset: asset({ projectId: 'other' }) }]) assert.equal(sourceRangeAddPlan({ snapshot, asset: asset(), timeline: tl, ...patch }).valid, false);
  const audio = asset({ mimeType: 'audio/wav' }); assert.equal(sourceRangeAddPlan({ snapshot, asset: audio, timeline: tl }).input.trackId, 'audio');
});

test('range receipts reuse the local mutation protocol with exact asset ownership and replay binding', t => {
  storage(t);
  const entry = { projectId: 'project-a', key: 'source-range:asset-a', operation: 'asset.range.set', input: { projectId: 'project-a', assetId: 'asset-a', expectedRevision: 0, inFrame: 20000, outFrame: 20120 } };
  const snapshot = { project: { id: 'project-a' }, assets: [asset()] };
  assert.doesNotThrow(() => assertMutationOwner(entry, snapshot));
  for (const value of [{ ...entry, input: { ...entry.input, assetId: 'wrong' } }, { ...entry, input: { ...entry.input, assetId: undefined } }, { ...entry, projectId: 'other' }]) assert.throws(() => assertMutationOwner(value, snapshot), { code: 'MUTATION_PROJECT_MISMATCH' });
  const stored = prepareMutation(entry, { requestId: () => 'original-range-request' });
  entry.input.outFrame = 22000; assert.equal(stored.input.outFrame, 20120);
  assert.throws(() => prepareMutation(entry), { code: 'MUTATION_PENDING' });
  assert.deepEqual(prepareMutation(stored, { replay: true, requestId: () => { throw Error('No new ID'); } }), stored);
  assert.doesNotThrow(() => validateMutationResponse(stored, row(1, { inFrame: 20000, outFrame: 20120 })));
  for (const invalid of [row(2, { inFrame: 20000, outFrame: 20120 }), row(1, { inFrame: 20000, outFrame: 22000 }), { ...row(1, { inFrame: 20000, outFrame: 20120 }), assetId: 'wrong' }]) assert.throws(() => validateMutationResponse(stored, invalid), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.deepEqual(readPending(entry.projectId, entry.key), stored); clearPending(entry.projectId, entry.key);
  const plan = sourceRangeAddPlan({ snapshot: { ...context(), assetId: 'asset-a', revision: 1, inFrame: 20000, outFrame: 20120 }, asset: asset(), timeline: timeline() });
  const pending = prepareSubmission({ projectId: 'project-a', key: 'timeline:mutation', operation: 'timeline.clip.add', input: { projectId: 'project-a', expectedRevision: plan.expectedRevision, requestId: 'fixed-add-request', ...plan.input } });
  assert.equal(prepareSubmission({ ...pending, input: { ...pending.input, sourceInFrame: 21000 } }).input.sourceInFrame, 20000);
});

test('App guards dirty clip before source selection, clears clip selection, and rereads after replay', async () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const source = app.slice(app.indexOf('async function previewSource('), app.indexOf('async function addSavedSourceRange('));
  const updates = [], calls = []; let accept = false;
  const scope = { viewRef: { current: { activeMode: 'editing', editing: { quickAssetId: null } } }, setPreviewAsset: () => {}, context: () => ({ projectId: 'project-a' }), guardNavigation: async () => { calls.push('guard'); return accept; }, isCurrent: () => true, dataRef: { current: { assets: [asset()] } }, navigationEpoch: { current: 0 }, updateView: (...args) => updates.push(args) };
  const preview = Function(...Object.keys(scope), `${source};return previewSource`)(...Object.values(scope));
  await preview(asset()); assert.equal(calls.length, 1); assert.deepEqual(updates, []);
  accept = true; await preview(asset()); assert.deepEqual(updates, [['editing', { quickAssetId: 'asset-a', selectedClipId: null, previewKind: 'source' }]]);
  assert.doesNotMatch(source, /setRightDockTab/);
  assert.match(app, /replay && operation === 'asset.range.set'/); assert.match(app, /setSourceRangeRefresh/);
  assert.match(app, /shotDirty \|\| clipDirty \|\| sourceDirty/);
  assert.match(app, /quickAssetId && sourceAsset \? <SourceRangeInspector/);
  assert.match(app, /sourceInFrame: 0/); // Existing whole-asset route is retained.
});

test('source range controls use full source bounds and retain timeline caps separately', () => {
  const source = readFileSync(new URL('../apps/web/src/SourceRangeInspector.jsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
  const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
  const module = { exports: {} };
  const hooks = { createElement, useRef: value => ({ current: value }), useLayoutEffect: fn => fn() };
  const require = id => id === 'react' ? { ...hooks, default: hooks } : id.endsWith('workspace-visibility.jsx') ? { useWorkspaceVisibility: () => true } : id.endsWith('.css') ? {} : id.endsWith('icons.jsx') ? { default: 'Icon', __esModule: true } : id.endsWith('source-range-state.js') ? { SOURCE_RANGE_FPS: 30, sourceFrameCount, sourceRangeIssue, sourceRangeAddPlan, supportsSourceRange: () => true } : new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const rendered = module.exports.default({ asset: asset(), state: { scope: 'source-a', row: row(1, { inFrame: 20000, outFrame: 20120 }), draft: { inFrame: 20000, outFrame: 20120 }, position: 20000 }, controller: { getState: () => ({ scope: 'source-a' }), snapshot: () => ({ projectId: 'project-a', assetId: 'asset-a', revision: 1, inFrame: 20000, outFrame: 20120 }) }, timeline: timeline() });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const all = nodes(rendered), find = id => all.find(node => node.props?.['data-testid'] === id);
  assert.equal(find('source-range-in').props.max, 35999); assert.equal(find('source-range-out').props.max, 36000);
  assert.equal(find('source-range-add').props.disabled, false);
  assert.match(source, /不是原生帧率或 VFR/); assert.match(source, /关闭并重建原生窗口可能丢失凭据/);
  const inspector = readFileSync(new URL('../apps/web/src/TimelineInspector.jsx', import.meta.url), 'utf8');
  assert.match(inspector, /data-testid="clip-source-in"[^>]*sourceFrameCount/);
  assert.match(inspector, /data-testid="clip-start"[^>]*max="17999"/);
  assert.match(inspector, /data-testid="clip-duration"[^>]*max="18000"/);
});

test('retained source inspector handlers reject another asset epoch, hidden panes and unmount', async () => {
  const source = readFileSync(new URL('../apps/web/src/SourceRangeInspector.jsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
  const slots = []; let cursor = 0, visible = true, scope = 'asset-a:1', cleanups = [], tree;
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; }, useLayoutEffect: (fn, deps) => { const i = cursor++, prior = slots[i]; if (!prior || deps.some((value, n) => value !== prior.deps[n])) { prior?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; cleanups.push(slots[i]); } } };
  const module = { exports: {} }, actions = [];
  const require = id => id === 'react' ? { ...react, default: react } : id.endsWith('.css') ? {} : id.endsWith('workspace-visibility.jsx') ? { useWorkspaceVisibility: () => visible } : id.endsWith('icons.jsx') ? { default: 'Icon', __esModule: true } : id.endsWith('source-range-state.js') ? { SOURCE_RANGE_FPS: 30, sourceFrameCount, sourceRangeIssue, sourceRangeAddPlan, supportsSourceRange: () => true } : new Proxy({}, { get: (_, key) => String(key) });
  Function('require', 'module', 'exports', code)(require, module, module.exports);
  const controller = { getState: () => ({ scope }), snapshot: () => ({ scope, projectId: 'project-a', assetId: 'asset-a', revision: 1, inFrame: 20, outFrame: 120 }), ...Object.fromEntries(['edit', 'save', 'discard', 'read', 'seek'].map(name => [name, (...args) => actions.push([name, ...args])])) };
  const props = () => ({ asset: asset(), state: { scope, row: row(1, { inFrame: 20, outFrame: 120 }), draft: { inFrame: 20, outFrame: 120 }, position: 50, dirty: true }, controller, timeline: timeline(), onAdd: snapshot => actions.push(['add', snapshot]) });
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
  const render = () => { cursor = 0; tree = module.exports.default(props()); };
  const handlers = () => nodes(tree).flatMap(node => [node.props?.onClick && (() => node.props.onClick()), node.props?.onChange && (() => node.props.onChange({ target: { value: '22' } }))].filter(Boolean));
  render(); const old = handlers(); assert.ok(old.length >= 9);
  scope = 'asset-b:2'; render(); old.forEach(fn => fn()); assert.deepEqual(actions, []);
  const current = handlers(); visible = false; render(); current.forEach(fn => fn()); assert.deepEqual(actions, []);
  visible = true; render(); handlers().find(Boolean)(); assert.ok(actions.length > 0); actions.length = 0;
  const retained = handlers(); for (const item of cleanups) item.cleanup?.(); retained.forEach(fn => fn()); assert.deepEqual(actions, []);
});

test('exact snapshot comparison admits a clicked saved range before freezing, never a superseded callback', async () => {
  const { sameSourceSnapshot } = await import('../apps/web/src/source-range-state.js');
  const snapshot = { scope: 'source:1', projectId: 'project-a', assetId: 'asset-a', revision: 1, inFrame: 20, outFrame: 120 };
  assert.equal(sameSourceSnapshot(snapshot, { ...snapshot }), true);
  for (const patch of [{ scope: 'source:2' }, { assetId: 'asset-b' }, { projectId: 'project-b' }, { revision: 2 }, { inFrame: 30 }, { outFrame: 130 }]) assert.equal(sameSourceSnapshot(snapshot, { ...snapshot, ...patch }), false);
  assert.equal(sameSourceSnapshot(snapshot, null), false);
});

test('actual App range replay uses its original request and triggers latest scoped reread without installing historical ACK', async t => {
  storage(t);
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const code = app.slice(app.indexOf('async function run('), app.indexOf('async function inspect('));
  let remote = row(), historical, generation = {}, controller;
  const calls = [], busy = new Set(), notices = [];
  const currentProject = { current: 'project-a' };
  const scope = {
    currentProject, context: () => ({ projectId: currentProject.current, epoch: 1 }), isCurrent: owner => owner.projectId === currentProject.current,
    isBusy: (key, project) => busy.has(`${project}:${key}`), markBusy: (project, key, value) => value ? busy.add(`${project}:${key}`) : busy.delete(`${project}:${key}`),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, mutationNotApplied, validateMutationResponse, prepareSubmission, clearPending, pendingForProject,
    isReferenceOperation: () => false, setPending: () => {}, setShowJobs: () => {}, setAuth: () => {}, readableError: error => error.message,
    requestCounter: { current: 0 }, dataRef: { current: { project: { id: 'project-a' }, assets: [asset()] } }, setData: () => {},
    rpc: async (operation, input) => { calls.push({ operation, input: structuredClone(input) }); if (calls.length === 1) { historical = row(1, { inFrame: input.inFrame, outFrame: input.outFrame }); remote = historical; throw Error('Lost response after commit'); } return historical; },
    refresh: async () => {}, notify: (...args) => notices.push(args),
    setSourceRangeRefresh: update => { generation = update(generation); void controller.read(); },
  };
  const run = Function(...Object.keys(scope), `${code};return run`)(...Object.values(scope));
  controller = await controllerFixture({ read: async () => remote, save: input => run('source-range:asset-a', 'asset.range.set', input, undefined, { returnAfterNavigation: true }) });
  controller.edit('inFrame', 30); controller.edit('outFrame', 60); await controller.save();
  const stored = readPending('project-a', 'source-range:asset-a'); assert.ok(stored); assert.equal(calls.length, 1);
  controller.edit('outFrame', 75);
  assert.equal(await run(stored.key, stored.operation, { ...stored.input, outFrame: 75 }), null); assert.equal(calls.length, 1);
  remote = row(2, { inFrame: 100, outFrame: 200 });
  assert.equal(await run(stored.key, stored.operation, stored.input, 'Recovered', { replay: true }), null); await flush();
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(readPending('project-a', stored.key), null);
  assert.deepEqual(generation, { 'project-a:asset-a': 1 });
  assert.equal(controller.getState().row.revision, 2); assert.equal(controller.getState().draft.outFrame, 75); assert.equal(controller.getState().conflict, true);
  assert.equal(controller.snapshot(), null); assert.equal(busy.size, 0);
});
