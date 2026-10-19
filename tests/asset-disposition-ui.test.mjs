import * as annotations from '../apps/web/src/asset-annotation-state.ts';
import { i18nTestModule, renderMessage as renderI18nMessage, message as msg } from './helpers/i18n.ts';
import test from 'node:test';
import { TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof } from '@mioon/contracts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createAssetDispositionController, dispositionCounts, dispositionRow, matchesDisposition, filterLibraryAssets, dispositionKey, dispositionFilters } from '../apps/web/src/asset-disposition-state.ts';
import { assertMutationOwner, prepareMutation, validateMutationResponse, isMutationOperation, mutationNotApplied } from '../apps/web/src/mutation-submissions.ts';
import { clearPending, prepareSubmission, pendingForProject, readPending } from '../apps/web/src/submissions.ts';

import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const taskIntentModule = { exports: {} };
Function('module', 'exports', transformSync(readFileSync(new URL('../apps/web/src/task-workspace-intent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(taskIntentModule, taskIntentModule.exports);
const { captureTaskWorkspaceIntent } = taskIntentModule.exports;
const projectId = '10000000-0000-4000-8000-000000000001';
const otherProject = '10000000-0000-4000-8000-000000000002';
const assetId = index => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const asset = (index = 1, patch = {}) => ({ id: assetId(index), projectId, mimeType: 'video/mp4', name: `Source ${index}`, duration: 12, ...patch });
const row = (index = 1, revision = 0, disposition = 'neutral', owner = projectId) => ({ id: assetId(index), assetId: assetId(index), projectId: owner, revision, disposition });
const context = (ids = [assetId(1)], patch = {}) => ({ scope: `${projectId}:1`, projectId, assetIds: ids, ...patch });
const resultFor = (input, rows = new Map()) => ({ projectId: input.projectId, items: input.assetIds.map(id => rows.get(id) || { id, assetId: id, projectId: input.projectId, revision: 0, disposition: 'neutral' }) });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function fixture(options = {}) {
  const controller = createAssetDispositionController({ read: async input => resultFor(input), save: async input => ack(input), ...options });
  controller.setContext(options.context || context()); await flush();
  return controller;
}
function storage(t) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), values = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { get length() { return values.size; }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete globalThis.sessionStorage);
}
const ack = input => ({ id: input.assetId, assetId: input.assetId, projectId: input.projectId, revision: input.expectedRevision + 1, disposition: input.disposition });

test('all loaded assets are read serially in ordered 100-ID batches without hidden truncation', async () => {
  const ids = Array.from({ length: 237 }, (_, i) => assetId(i + 1)), calls = [];
  let active = 0, maxActive = 0;
  const controller = await fixture({ context: context(ids), read: async input => { active++; maxActive = Math.max(maxActive, active); calls.push(structuredClone(input)); await Promise.resolve(); active--; return resultFor(input); } });
  assert.deepEqual(calls.map(call => call.assetIds.length), [100, 100, 37]);
  assert.deepEqual(calls.flatMap(call => call.assetIds), ids); assert.equal(maxActive, 1);
  assert.deepEqual(dispositionCounts(controller.getState(), ids.map((_, i) => asset(i + 1))), { all: 237, neutral: 237, favorite: 0, rejected: 0, unknown: 0 });
});

test('only confirmed revision-zero rows are neutral; loading, failed and omitted rows stay unknown', async () => {
  const hold = deferred(), controller = createAssetDispositionController({ read: () => hold.promise, save: async () => null });
  controller.setContext(context());
  assert.equal(dispositionRow(controller.getState(), assetId(1)), null);
  assert.deepEqual(dispositionCounts(controller.getState(), [asset()]), { all: 1, neutral: 0, favorite: 0, rejected: 0, unknown: 1 });
  assert.equal(matchesDisposition(controller.getState(), assetId(1), 'favorite'), true);
  hold.resolve({ projectId, items: [] }); await flush();
  assert.equal(controller.getState().entries[assetId(1)].phase, 'error');
  assert.equal(dispositionCounts(controller.getState(), [asset()]).neutral, 0);
  const confirmed = await fixture(); assert.equal(dispositionRow(confirmed.getState(), assetId(1)).revision, 0);
});

test('missing, reordered, foreign, duplicate and invalid batch payloads cannot confirm even one row', async () => {
  for (const items of [[row(1)], [row(2), row(1)], [row(1), row(2, 0, 'neutral', otherProject)], [row(1), row(1)], [row(1), row(2, 0, 'favorite')]]) {
    const controller = await fixture({ context: context([assetId(1), assetId(2)]), read: async () => ({ projectId, items }) });
    assert.equal(dispositionCounts(controller.getState(), [asset(1), asset(2)]).unknown, 2);
    assert.equal(controller.getState().loading, false);
  }
});

test('failed middle batch preserves successful batches and retry is GET-only with all IDs', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => assetId(i + 1)); let fail = true, writes = 0;
  const controller = await fixture({ context: context(ids), read: async input => { if (fail && input.assetIds[0] === assetId(101)) throw Error('Offline second batch'); return resultFor(input); }, save: async () => { writes++; } });
  assert.equal(dispositionCounts(controller.getState(), ids.map((_, i) => asset(i + 1))).unknown, 100);
  assert.equal(dispositionRow(controller.getState(), assetId(205)).revision, 0);
  fail = false; await controller.read();
  assert.equal(dispositionCounts(controller.getState(), ids.map((_, i) => asset(i + 1))).neutral, 205); assert.equal(writes, 0);
});

test('failed refresh and contradictory same-revision reads expose unknown instead of cached neutral', async () => {
  let result = { projectId, items: [row()] }, offline = false;
  const controller = await fixture({ read: async () => { if (offline) throw Error('Offline'); return result; } });
  offline = true; await controller.read(); assert.equal(dispositionRow(controller.getState(), assetId(1)), null);
  assert.equal(dispositionCounts(controller.getState(), [asset()]).unknown, 1);
  offline = false; result = { projectId, items: [row(1, 1, 'favorite')] }; await controller.read();
  result = { projectId, items: [row(1, 1, 'rejected')] }; await controller.read();
  assert.equal(dispositionRow(controller.getState(), assetId(1)), null);
  assert.equal(controller.getState().entries[assetId(1)].row.disposition, 'favorite');
});

test('synchronous repeated clicks issue one CAS write and never mutate files, assets or clips', async () => {
  const hold = deferred(), calls = [], remote = new Map();
  const assets = [asset()], timeline = { revision: 8, clips: [{ id: 'clip', assetId: assetId(1), sourceInFrame: 10, durationFrames: 50 }] }, before = structuredClone({ assets, timeline });
  const controller = await fixture({ read: async input => resultFor(input, remote), save: input => { calls.push(input); return hold.promise; } });
  const first = controller.set(assetId(1), 'rejected');
  assert.equal(await controller.set(assetId(1), 'favorite'), null);
  assert.equal(await controller.set(assetId(1), 'rejected'), null);
  remote.set(assetId(1), row(1, 1, 'rejected')); hold.resolve(row(1, 1, 'rejected')); await first;
  assert.deepEqual(calls, [{ projectId, assetId: assetId(1), expectedRevision: 0, disposition: 'rejected' }]);
  assert.equal(dispositionRow(controller.getState(), assetId(1)).disposition, 'rejected');
  assert.deepEqual({ assets, timeline }, before);
});

test('two windows use independent disposition CAS and a loser rereads before a fresh choice', async () => {
  const remote = new Map(), writes = [];
  const options = { read: async input => resultFor(input, remote), save: async input => { writes.push(input); const revision = remote.get(input.assetId)?.revision || 0; if (revision !== input.expectedRevision) return null; const saved = ack(input); remote.set(input.assetId, saved); return saved; } };
  const left = await fixture(options), right = await fixture(options);
  await left.set(assetId(1), 'favorite'); await right.set(assetId(1), 'rejected');
  assert.equal(writes.length, 2); assert.equal(writes[1].expectedRevision, 0);
  assert.equal(dispositionRow(right.getState(), assetId(1)).disposition, 'favorite');
  assert.match(renderI18nMessage('zh-Hans', right.getState().mutationError), /未获确认/);
  await right.set(assetId(1), 'rejected'); assert.equal(writes[2].expectedRevision, 1);
  assert.equal(dispositionRow(right.getState(), assetId(1)).revision, 2);
});

test('unknown write outcome is fenced even after a latest read; only receipt recovery reopens editing', async () => {
  let pending = false, writes = 0; const remote = new Map();
  const controller = await fixture({ hasPending: () => pending, read: async input => resultFor(input, remote), save: async input => { writes++; remote.set(input.assetId, ack(input)); pending = true; return null; } });
  await controller.set(assetId(1), 'favorite');
  assert.equal(controller.getState().uncertain, true); assert.equal(dispositionRow(controller.getState(), assetId(1)).disposition, 'favorite');
  await controller.read(); await controller.set(assetId(1), 'rejected'); assert.equal(writes, 1);
  pending = false; await controller.read(); assert.equal(controller.getState().uncertain, false); assert.equal(controller.getState().mutationError, '');
  await controller.set(assetId(1), 'rejected'); assert.equal(writes, 2);
});

test('resolving an unrelated pending mutation releases stale uncertainty without a user reread', async () => {
  let pending = true, writes = 0;
  const controller = await fixture({ hasPending: () => pending, save: async input => { writes++; return ack(input); } });
  assert.equal(controller.getState().uncertain, true);
  pending = false; controller.syncPending(); assert.equal(controller.getState().uncertain, false);
  await controller.set(assetId(1), 'favorite'); assert.equal(writes, 1);
});

test('newer reads and a late acknowledgement cannot downgrade the independent revision', async () => {
  const hold = deferred(), remote = new Map([[assetId(1), row(1, 1, 'favorite')]]);
  const controller = await fixture({ read: async input => resultFor(input, remote), save: () => hold.promise });
  const writing = controller.set(assetId(1), 'rejected');
  remote.set(assetId(1), row(1, 3, 'neutral')); await controller.read();
  hold.resolve(row(1, 2, 'rejected')); await writing;
  assert.deepEqual(dispositionRow(controller.getState(), assetId(1)), row(1, 3, 'neutral'));
});

test('older GET generations are ignored and stale latest reads retain a newer confirmed revision', async () => {
  const first = deferred(), second = deferred(); let reads = 0;
  const controller = createAssetDispositionController({ read: async input => ++reads === 1 ? first.promise : reads === 2 ? second.promise : resultFor(input), save: async () => null });
  controller.setContext(context()); const newer = controller.read();
  second.resolve({ projectId, items: [row(1, 3, 'favorite')] }); await newer;
  first.resolve({ projectId, items: [row()] }); await flush();
  assert.equal(dispositionRow(controller.getState(), assetId(1)).revision, 3);
  await controller.read(); assert.equal(dispositionRow(controller.getState(), assetId(1)).revision, 3);
});

test('project navigation, return-to-project epochs, removed IDs and unmount reject obsolete work', async () => {
  const heldRead = deferred(), heldSave = deferred(); let reads = 0;
  const controller = await fixture({ read: async input => ++reads === 2 ? heldRead.promise : resultFor(input), save: () => heldSave.promise });
  const writing = controller.set(assetId(1), 'favorite'), oldRead = controller.read();
  controller.setContext(context([assetId(2)], { scope: `${otherProject}:1`, projectId: otherProject })); await flush();
  controller.setContext(context([assetId(1)], { scope: `${projectId}:3` })); await flush();
  heldRead.resolve({ projectId, items: [row(1, 9, 'rejected')] }); heldSave.resolve(row(1, 1, 'favorite')); await oldRead; await writing;
  assert.equal(dispositionRow(controller.getState(), assetId(1)).revision, 0);
  assert.equal(await controller.set(assetId(1), 'favorite', `${projectId}:1`), null);
  controller.setContext(context([assetId(2)], { scope: `${projectId}:3` })); await flush();
  assert.equal(await controller.set(assetId(1), 'favorite'), null);
  controller.dispose(); assert.equal(await controller.set(assetId(2), 'favorite'), null);
});

test('disposition filters are a pure local view and keep unknown metadata visible', () => {
  const assets = [asset(1), asset(2), asset(3)], original = structuredClone(assets);
  const state = { entries: { [assetId(1)]: { phase: 'ready', row: row(1, 1, 'favorite') }, [assetId(2)]: { phase: 'ready', row: row(2, 1, 'rejected') } } };
  assert.deepEqual(filterLibraryAssets(assets, { disposition: 'favorite', state }).map(a => a.id), [assetId(1), assetId(3)]);
  assert.deepEqual(filterLibraryAssets(assets, { disposition: 'neutral', state }).map(a => a.id), [assetId(3)]);
  assert.deepEqual(assets, original);
});

test('disposition receipts use asset ownership and exact keyed mutation recovery', t => {
  storage(t);
  const entry = { projectId, key: dispositionKey(assetId(1)), operation: 'asset.disposition.set', input: { projectId, assetId: assetId(1), expectedRevision: 0, disposition: 'favorite' } };
  const snapshot = { project: { id: projectId }, assets: [asset()] };
  assert.equal(isMutationOperation(entry.operation), true); assert.doesNotThrow(() => assertMutationOwner(entry, snapshot));
  for (const input of [{ ...entry.input, assetId: assetId(2) }, { ...entry.input, assetId: undefined }, { ...entry.input, projectId: otherProject }]) assert.throws(() => assertMutationOwner({ ...entry, input }, snapshot), { code: 'MUTATION_PROJECT_MISMATCH' });
  const stored = prepareMutation(entry, { requestId: () => 'original-disposition-request' });
  assert.throws(() => prepareMutation({ ...entry, input: { ...entry.input, disposition: 'rejected' } }), { code: 'MUTATION_PENDING' });
  assert.deepEqual(prepareMutation(stored, { replay: true }), stored);
  assert.throws(() => prepareMutation({ ...stored, input: { ...stored.input, disposition: 'rejected' } }, { replay: true }), { code: 'MUTATION_REPLAY_MISMATCH' });
  assert.doesNotThrow(() => validateMutationResponse(stored, row(1, 1, 'favorite')));
  assert.throws(() => validateMutationResponse(stored, row(1, 2, 'favorite')), { code: 'BACKEND_PROTOCOL_ERROR' });
  assert.deepEqual(readPending(projectId, entry.key), stored);
});

const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
test('actual App recovery replays the exact key and refreshes current marks separately from historical ACK', async t => {
  storage(t); let lost = true, refreshes = 0, markRefreshes = 0; const calls = [], busy = new Set();
  const input = { projectId, assetId: assetId(1), expectedRevision: 0, disposition: 'favorite' };
  const scope = { clipConnectionBlocked: { current: false }, msg, localizedError: value => Object.assign(new Error(renderI18nMessage('zh-Hans', value)), { displayMessage: value }), shotTextRef: { current: null }, context: () => ({ projectId, epoch: 1 }), currentProject: { current: projectId }, isCurrent: () => true,
    isBusy: key => busy.has(key), markBusy: (_id, key, value) => value ? busy.add(key) : busy.delete(key),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, validateMutationResponse, mutationNotApplied, prepareSubmission, clearPending, pendingForProject,
    isReferenceOperation: () => false, dataRef: { current: { project: { id: projectId }, assets: [asset()] } }, setPending() {}, openTasks() {}, setAuth() {}, notify() {}, readableError: error => error.message,
    refresh: async () => { refreshes++; }, setDispositionRefresh: updater => { markRefreshes++; updater({}); },
    rpc: async (operation, current) => { calls.push({ operation, input: structuredClone(current) }); if (lost) throw Error('Lost'); return row(1, 1, 'favorite'); },
  };
  const source = app.slice(app.indexOf('async function runSession('), app.indexOf('  // Picking a shot, node or clip')).replace('async function runSession(', 'async function run(');
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify(captured.workspace || 'test-workspace') }; } });
  const run = Function(...Object.keys(scope), `${source}; return run;`)(...Object.values(scope));
  await run(dispositionKey(assetId(1)), 'asset.disposition.set', input);
  const original = readPending(projectId, dispositionKey(assetId(1))); assert.ok(original);
  await run(dispositionKey(assetId(1)), 'asset.disposition.set', { ...input, disposition: 'rejected' }); assert.equal(calls.length, 1);
  lost = false; const replayed = await run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.equal(replayed, null); assert.deepEqual(calls[0], calls[1]); assert.equal(markRefreshes, 1); assert.equal(readPending(projectId, original.key), null); assert.ok(refreshes >= 2);
});

test('actual App annotation recovery preserves the exact session intent and rereads separately from historical ACK', async t => {
  storage(t); let lost = true, refreshes = 0, markRefreshes = 0; const calls = [], busy = new Set();
  const input = { projectId, assetId: assetId(1), expectedRevision: 0, tags: ['tag'], note: 'literal <text>' };
  const scope = { clipConnectionBlocked: { current: false }, msg, localizedError: value => Object.assign(new Error(renderI18nMessage('zh-Hans', value)), { displayMessage: value }), shotTextRef: { current: null }, context: () => ({ projectId, epoch: 1 }), currentProject: { current: projectId }, isCurrent: () => true,
    isBusy: key => busy.has(key), markBusy: (_id, key, value) => value ? busy.add(key) : busy.delete(key),
    TIMELINE_MUTATION_OPERATIONS, isTimelineMutationResponse, REFERENCE_MUTATION_OPERATIONS, isReferenceMutationResponse, hasRequestNotAppliedProof,
    isMutationOperation, assertMutationOwner, prepareMutation, validateMutationResponse, mutationNotApplied, prepareSubmission, clearPending, pendingForProject,
    isReferenceOperation: () => false, dataRef: { current: { project: { id: projectId }, assets: [asset()] } }, setPending() {}, openTasks() {}, setAuth() {}, notify() {}, readableError: error => error.message,
    refresh: async () => { refreshes++; }, setAnnotationRefresh: updater => { markRefreshes++; updater({}); },
    rpc: async (operation, current) => { calls.push({ operation, input: structuredClone(current) }); if (lost) throw Error('Lost'); return { id: assetId(1), assetId: assetId(1), projectId, revision: 1, tags: ['tag'], note: 'literal <text>' }; },
  };
  const source = app.slice(app.indexOf('async function runSession('), app.indexOf('  // Picking a shot, node or clip')).replace('async function runSession(', 'async function run(');
  Object.assign(scope, { captureTaskWorkspaceIntent, readTaskRevealContext: () => { const captured = scope.context(); return { active: true, projectId: captured.projectId, projectEpoch: 0, navigationEpoch: captured.epoch || 0, panelIntent: 0, workspaceScope: JSON.stringify(captured.workspace || 'test-workspace') }; } });
  const run = Function(...Object.keys(scope), `${source}; return run;`)(...Object.values(scope));
  await run(annotations.annotationKey(assetId(1)), 'asset.annotation.set', input);
  const original = readPending(projectId, annotations.annotationKey(assetId(1))); assert.ok(original);
  await run(annotations.annotationKey(assetId(1)), 'asset.annotation.set', { ...input, tags: ['changed'], note: 'different' }); assert.equal(calls.length, 1);
  lost = false; const replayed = await run(original.key, original.operation, original.input, undefined, { replay: true });
  assert.equal(replayed, null); assert.deepEqual(calls[0], calls[1]); assert.equal(markRefreshes, 1); assert.equal(readPending(projectId, original.key), null); assert.ok(refreshes >= 2);
});

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function controlHarness() {
  const source = readFileSync(new URL('../apps/web/src/AssetDispositionControls.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code, slots = [];
  let cursor = 0, effects = []; const h = { visible: true };
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useRef: value => { const index = cursor++; return slots[index] ||= { current: value }; },
    useMemo: (fn, deps) => { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useLayoutEffect: (fn, deps) => { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) { const previous = slots[index]; slots[index] = { fn, deps, cleanup: previous?.cleanup }; effects.push(index); } },
  };
  const module = { exports: {} };
  Function('require', 'module', 'exports', code)(id => id.endsWith('/i18n/I18nProvider.tsx') ? i18nTestModule() : id === 'react' ? { ...react, default: react } : id.endsWith('workspace-visibility.tsx') ? { useWorkspaceVisibility: () => h.visible } : id.endsWith('asset-disposition-state.ts') ? { dispositionLabels: { neutral: '未标记', favorite: '收藏', rejected: '拒选' }, dispositionRow } : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  h.render = props => { cursor = 0; effects = []; const tree = module.exports.default(props); for (const index of effects) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].fn(); } return nodes(tree); };
  h.unmount = () => slots.forEach(slot => slot.cleanup?.());
  return h;
}
test('mark controls are accessible and reject retained hidden, re-shown, project-stale and unmounted clicks', () => {
  const h = controlHarness(), calls = []; let scope = `${projectId}:1`;
  const state = { scope, entries: { [assetId(1)]: { phase: 'ready', row: row() } } }, controller = { getState: () => ({ scope }), set: (...args) => calls.push(args) };
  const props = { asset: asset(), state, controller }, clickEvent = { stopPropagation() {} };
  const find = tree => tree.find(node => node.props?.['data-testid'] === `asset-disposition-favorite-${assetId(1)}`);
  const initial = find(h.render(props)); assert.equal(initial.props['aria-pressed'], false); assert.equal(initial.props.draggable, false); initial.props.onClick(clickEvent); assert.equal(calls.length, 1);
  h.visible = false; const hidden = find(h.render(props)); assert.equal(hidden.props.disabled, true); initial.props.onClick(clickEvent); hidden.props.onClick(clickEvent);
  h.visible = true; const shown = find(h.render(props)); initial.props.onClick(clickEvent); hidden.props.onClick(clickEvent); assert.equal(calls.length, 1);
  shown.props.onClick(clickEvent); assert.equal(calls.length, 2);
  const changed = h.render({ ...props, asset: asset(2), state: { ...state, entries: { [assetId(2)]: { phase: 'ready', row: row(2) } } } });
  shown.props.onClick(clickEvent); assert.equal(calls.length, 2, 'A retained previous source callback stays obsolete');
  const current = changed.find(node => node.props?.['data-testid'] === `asset-disposition-favorite-${assetId(2)}`);
  current.props.onClick(clickEvent); assert.equal(calls.length, 3);
  scope = `${otherProject}:2`; current.props.onClick(clickEvent); assert.equal(calls.length, 3);
  scope = state.scope; h.unmount(); current.props.onClick(clickEvent); assert.equal(calls.length, 3);
});

test('shared library keeps an excluded source editable and resets filters without touching source selection or range scope', () => {
  const source = readFileSync(new URL('../apps/web/src/AssetLibrary.tsx', import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'tsx', format: 'cjs' }).code, module = { exports: {} };
  let local = { scope: `${projectId}:1`, value: 'favorite' }; const changes = [], slots = [], effects = new Map();
  let cursor = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: initial => { const index = cursor++; if (!slots[index]) slots[index] = { value: index === 1 ? local : initial }; return [slots[index].value, value => { slots[index].value = value; if (index === 1) local = value; }]; },
    useRef: initial => { const index = cursor++; return slots[index] ||= { current: initial }; },
    useMemo: (fn, deps) => { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useLayoutEffect: (fn, deps) => { const index = cursor++; if (!slots[index] || deps.some((value, i) => value !== slots[index].deps[i])) { slots[index] = { deps, cleanup: slots[index]?.cleanup }; effects.set(index, fn); } },
    useId: () => `library-usage-${cursor++}`,
  };
  const usageModule = { exports: {} };
  const usageCode = transformSync(readFileSync(new URL('../apps/web/src/AssetTimelineUsage.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code;
  Function('require', 'module', 'exports', usageCode)(id => {
    if (id === 'react') return { ...react, default: react };
    if (id.endsWith('/i18n/I18nProvider.tsx')) return i18nTestModule();
    if (id === '@mioon/ui/components/button') return { Button: 'Button' };
    if (id === '@mioon/ui/components/workbench-icons') return { Film: 'Film' };
    throw Error(`Unexpected usage control import: ${id}`);
  }, usageModule, usageModule.exports);
  Function('require', 'module', 'exports', code)(id => id.endsWith('/i18n/I18nProvider.tsx') ? i18nTestModule() : id === 'react' ? { ...react, default: react } : id.endsWith('AssetLibraryToolbar.tsx') ? { __esModule: true, default: 'AssetLibraryToolbar', useAssetLibraryLayout: () => ({ layout: 'grid', setLayout() {} }) } : id.endsWith('AssetTimelineUsage.tsx') ? usageModule.exports : id.endsWith('asset-annotation-state.ts') ? annotations : id.endsWith('asset-disposition-state.ts') ? { dispositionCounts, dispositionFilters, filterLibraryAssets } : id.endsWith('AssetDispositionControls.tsx') ? { __esModule: true, default: 'AssetDispositionControls', useDispositionInteraction: () => ({ visible: true, admit: action => action() }) } : id.endsWith('Timeline.tsx') ? { assetKind: () => 'video', dragAsset() {} } : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  const render = props => { cursor = 0; const result = module.exports.default(props); for (const [index, fn] of effects) { slots[index].cleanup?.(); slots[index].cleanup = fn(); } effects.clear(); return nodes(result); };
  const assets = [asset(1), asset(2)], state = { scope: local.scope, entries: { [assetId(1)]: { phase: 'ready', row: row(1, 1, 'favorite') }, [assetId(2)]: { phase: 'ready', row: row(2, 1, 'rejected') } } };
  const props = { assets, filter: 'all', search: '', onFilter: value => changes.push(['type', value]), onSearch: value => changes.push(['search', value]), busy: {}, project: { id: projectId }, selectedAsset: assets[1], dispositions: { state, controller: {} }, inUseAssetIds: new Set([assetId(2)]) };
  const tree = render(props);
  assert.ok(tree.find(node => node.props?.['data-testid'] === 'asset-filter-selected-outside'));
  assert.ok(tree.find(node => node.type === 'AssetDispositionControls' && node.props.prefix === 'selected-asset'));
  assert.ok(tree.find(node => node.props?.['data-testid'] === 'asset-filter-hidden-used'));
  const scroll = tree.find(node => node.props?.className === 'asset-scroll-area');
  const scrolled = nodes(scroll), fixed = nodes(tree.find(node => node.props?.['data-testid'] === 'asset-disposition-summary'));
  assert.ok(scrolled.find(node => node.props?.['data-testid'] === 'asset-filter-selected-outside'), 'Selected-source recovery must scroll rather than consume fixed panel height');
  assert.ok(scrolled.find(node => node.props?.['data-testid'] === 'asset-filter-hidden-used'));
  assert.ok(scrolled.find(node => node.props?.['data-testid'] === 'asset-disposition-details'));
  assert.equal(fixed.some(node => node.props?.['data-testid'] === 'asset-disposition-details'), false);
  for (const id of ['asset-disposition-refresh', 'asset-filter-reset']) {
    assert.ok(fixed.find(node => node.props?.['data-testid'] === id));
    assert.equal(scrolled.some(node => node.props?.['data-testid'] === id), false, 'Refresh and reset stay accessible above the scroll');
  }
  const ready = render({ ...props, selectedAsset: null, inUseAssetIds: new Set() });
  assert.equal(ready.some(node => node.props?.['data-testid'] === 'asset-disposition-details'), false, 'A ready library has no verbose status block');
  tree.find(node => node.props?.['data-testid'] === 'asset-filter-show-selected').props.onClick();
  assert.equal(local.value, 'all'); assert.deepEqual(changes, [['type', 'all'], ['search', '']]);
  assert.doesNotMatch(source, /setQuickAssetId|setSelectedClipId|guardNavigation|inspectorEpoch|sourceRangeScope/);
  assert.equal((app.match(/<AssetLibrary /g) || []).length, 1);
  assert.match(app, /isMutationOperation\(entry.operation\) \|\| entry.operation.startsWith\('timeline\.'\)/);
  const preferences = readFileSync(new URL('../apps/web/src/workspace-state.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(preferences, /dispositionFilter|assetDisposition/);
});
