import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWorkspaceState, normalizeWorkspaceState, readStoredWorkspaceState, readWorkspaceState, writeWorkspaceState, reconcileWorkspaceState, sourceForAsset } from '../apps/web/src/workspace-state.ts';
import { prepareSubmission, readPending, reconcilePending } from '../apps/web/src/submissions.ts';

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: unknown) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
const projectData = () => ({
  project: { id: 'project-a' },
  assets: [{ id: 'asset-v1' }, { id: 'asset-v2' }, { id: 'image' }, { id: 'orphan' }],
  shots: [{ id: 'shot-a', selectedVersionId: 'version-2', revision: 8 }],
  nodes: [{ id: 'image-node', type: 'image', assetId: 'image' }],
  edges: [{ id: 'reference-edge', kind: 'reference', source: 'image-node', target: 'shot-a', sourceAssetId: 'image' }],
  versions: [{ id: 'version-1', assetId: 'asset-v1', shotId: 'shot-a', number: 1 }, { id: 'version-2', assetId: 'asset-v2', shotId: 'shot-a', number: 2 }],
  timeline: { revision: 5, clips: [{ id: 'clip-a', assetId: 'asset-v1' }] },
  timelineHistory: { revision: 5, cursor: 2, length: 3 }, jobs: [],
});
const saved = () => ({
  ...defaultWorkspaceState(), activeMode: 'editing',
  canvas: { viewport: { x: 132, y: -56, zoom: .67 }, selectedId: 'shot-a', selectedEdgeId: 'reference-edge', inspectorTab: 'versions', highlightedVersionId: 'version-1', storyboardOpen: false, miniMap: true },
  editing: { selectedClipId: 'clip-a', quickAssetId: 'asset-v1', previewKind: 'source', playhead: 93, pixelsPerSecond: 135, scrollLeft: 412, scrollTop: 27, timelineCollapsed: false, snappingEnabled: false },
  shared: { assetFilter: 'video', assetSearch: 'synthetic', assetsCollapsed: false, inspectorCollapsed: false },
});

test('new projects open Canvas with storyboard collapsed and independent Editing defaults', () => {
  const a = defaultWorkspaceState(), b = defaultWorkspaceState();
  assert.equal(a.activeMode, 'canvas');
  assert.equal(a.canvas.storyboardOpen, false);
  assert.equal(a.editing.previewKind, 'timeline');
  assert.equal(a.editing.timelineCollapsed, false);
  assert.equal(a.editing.snappingEnabled, true);
  a.canvas.viewport = { x: 1, y: 2, zoom: 1 }; a.editing.playhead = 120;
  a.editing.snappingEnabled = false;
  assert.equal(b.canvas.viewport, null); assert.equal(b.editing.playhead, 0);
  assert.equal(b.editing.snappingEnabled, true);
});

test('legacy v1 cache defaults only the new magnet preference without a read mutation', () => {
  const storage = new MemoryStorage(), legacy = saved();
  delete (legacy.editing as unknown as Record<string, unknown>).snappingEnabled;
  const raw = JSON.stringify(legacy);
  storage.setItem('mioon.workspace.v1:project-a', raw);
  assert.deepEqual(readWorkspaceState('project-a', storage), { ...legacy, editing: { ...legacy.editing, snappingEnabled: true } });
  assert.equal(storage.getItem('mioon.workspace.v1:project-a'), raw);
  assert.equal('snappingEnabled' in legacy.editing, false);
  for (const value of [null, 0, 1, 'false', 'true']) {
    (legacy.editing as unknown as Record<string, unknown>).snappingEnabled = value;
    assert.equal(normalizeWorkspaceState(legacy).editing.snappingEnabled, true);
  }
  legacy.editing.snappingEnabled = false;
  assert.equal(normalizeWorkspaceState(legacy).editing.snappingEnabled, false);
});

test('project-local view state survives reload without sharing mode, selection or geometry', () => {
  const storage = new MemoryStorage(), a = saved(), b = defaultWorkspaceState();
  b.canvas.selectedId = 'node-b'; b.editing.playhead = 12;
  assert.equal(writeWorkspaceState('project-a', a, storage), true);
  assert.equal(writeWorkspaceState('project-b', b, storage), true);
  assert.deepEqual(readWorkspaceState('project-a', storage), a);
  assert.deepEqual(readWorkspaceState('project-b', storage), b);
  assert.deepEqual(readWorkspaceState('project-c', storage), defaultWorkspaceState());
  assert.deepEqual([...storage.values.keys()].sort(), ['mioon.workspace.v1:project-a', 'mioon.workspace.v1:project-b']);
});

test('changing active mode preserves the inactive mode state byte-for-byte', () => {
  const storage = new MemoryStorage(), initial = saved();
  writeWorkspaceState('project-a', initial, storage);
  const canvas = readWorkspaceState('project-a', storage); canvas.activeMode = 'canvas';
  writeWorkspaceState('project-a', canvas, storage);
  const editing = readWorkspaceState('project-a', storage); editing.activeMode = 'editing';
  assert.deepEqual(editing, initial);
});

test('malformed, obsolete and unavailable preference storage fall back safely', () => {
  const storage = new MemoryStorage();
  for (const value of ['{', 'null', 'true', '[]', '{"version":2,"activeMode":"editing"}']) {
    storage.setItem('mioon.workspace.v1:project-a', value);
    assert.deepEqual(readWorkspaceState('project-a', storage), defaultWorkspaceState());
  }
  const unavailable = { getItem() { throw Error('unavailable'); }, setItem() { throw Error('quota'); } } as unknown as Storage;
  assert.deepEqual(readWorkspaceState('project-a', unavailable), defaultWorkspaceState());
  assert.equal(writeWorkspaceState('project-a', saved(), unavailable), false);
  assert.equal(writeWorkspaceState(null as unknown as string, saved(), storage), false);
});

test('preference normalization bounds viewport, timeline geometry, frames and text', () => {
  const state = saved();
  state.canvas.viewport = { x: 1e10, y: -1e10, zoom: 10 };
  Object.assign(state.editing, { playhead: 18001.8, pixelsPerSecond: -3, scrollLeft: -10, scrollTop: Infinity });
  Object.assign(state.shared, { assetSearch: 'a'.repeat(700), assetFilter: 'unexpected' });
  const result = normalizeWorkspaceState(state);
  assert.deepEqual(result.canvas.viewport, { x: 1e6, y: -1e6, zoom: 1.75 });
  assert.equal(result.editing.playhead, 18000); assert.equal(result.editing.pixelsPerSecond, 28);
  assert.equal(result.editing.scrollLeft, 0); assert.equal(result.editing.scrollTop, 0);
  assert.equal(result.shared.assetSearch.length, 500); assert.equal(result.shared.assetFilter, 'all');
  state.editing.playhead = 17.8; state.canvas.viewport.zoom = NaN;
  assert.equal(normalizeWorkspaceState(state).editing.playhead, 18);
  assert.equal(normalizeWorkspaceState(state).canvas.viewport, null);
});

test('normalization ignores unexpected fields rather than persisting domain data or secrets', () => {
  const state = { ...saved(), requestId: 'forbidden', selectedVersionId: 'not-a-preference', token: 'not-real', timeline: { clips: ['not-a-preference'] } };
  assert.deepEqual(normalizeWorkspaceState(state), saved());
  assert.equal(normalizeWorkspaceState({ version: 1, activeMode: 'preview' }).activeMode, 'canvas');
});

test('refresh reconciliation keeps valid independent selections, viewport and local mode', () => {
  const data = projectData(), original = structuredClone(data), state = saved();
  assert.deepEqual(reconcileWorkspaceState(state, data), state);
  assert.deepEqual(data, original);
  assert.deepEqual(state, saved());
});

test('external removals prune dangling IDs without switching modes or resetting geometry', () => {
  const state = saved(), current = projectData();
  current.shots = []; current.edges = []; current.versions = []; current.timeline.clips = []; current.assets = [];
  const result = reconcileWorkspaceState(state, current);
  assert.equal(result.activeMode, 'editing');
  const canvasView = result.canvas as unknown as Record<string, unknown>, editingView = result.editing as unknown as Record<string, unknown>;
  for (const key of ['selectedId', 'selectedEdgeId', 'highlightedVersionId']) assert.equal(canvasView[key], null);
  for (const key of ['selectedClipId', 'quickAssetId']) assert.equal(editingView[key], null);
  assert.deepEqual(result.canvas.viewport, state.canvas.viewport);
  for (const key of ['playhead', 'pixelsPerSecond', 'scrollLeft', 'scrollTop']) assert.equal(editingView[key], (state.editing as unknown as Record<string, unknown>)[key]);
});

test('external CLI/MCP edits and late generated versions never select a local mode', () => {
  for (const activeMode of ['canvas', 'editing']) {
    const data = projectData(), state = { ...saved(), activeMode };
    data.shots[0].selectedVersionId = 'version-3'; data.shots[0].revision++;
    data.versions.push({ id: 'version-3', assetId: 'new-asset', shotId: 'shot-a' } as never);
    data.assets.push({ id: 'new-asset' }); data.timeline.revision++;
    data.timelineHistory = { revision: 6, cursor: 3, length: 3 };
    assert.deepEqual(reconcileWorkspaceState(state, data), state);
  }
});

test('return-to-source resolves the immutable clip asset version instead of the shot current version', () => {
  const data = projectData(), before = structuredClone(data), clip = data.timeline.clips[0];
  const source = sourceForAsset(data, clip.assetId);
  assert.ok(source);
  const version = source.version as {id: string};
  const shot = source.shot as {id: string; selectedVersionId?: string};
  const asset = source.asset as {id: string};
  assert.equal(version.id, 'version-1'); assert.equal(shot.id, 'shot-a');
  assert.equal(shot.selectedVersionId, 'version-2'); assert.equal(asset.id, clip.assetId);
  assert.deepEqual(data, before);
});

test('imported source resolves one canvas node and absent sources fail safely', () => {
  const data = projectData();
  const imported = sourceForAsset(data, 'image');
  assert.ok(imported);
  assert.equal((imported.node as {id: string}).id, 'image-node');
  assert.equal(imported.version, null);
  assert.equal(sourceForAsset(data, 'missing'), null);
  const orphan = sourceForAsset(data, 'orphan');
  assert.ok(orphan); assert.equal(orphan.node, null);
  data.nodes.push({ id: 'second-image-node', assetId: 'image' } as never);
  const importedAgain = sourceForAsset(data, 'image'); assert.ok(importedAgain); assert.equal(importedAgain.node, null, 'Never pick arbitrarily among multiple nodes');
  data.shots = [];
  const versionless = sourceForAsset(data, 'asset-v1'); assert.ok(versionless); assert.equal(versionless.version, null, 'A missing parent shot cannot yield a navigable version');
});

test('workspace switching/reload leaves exact pending generation, reference and timeline recovery identities intact', t => {
  const storage = new MemoryStorage(), prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => prior ? Object.defineProperty(globalThis, 'sessionStorage', prior) : delete (globalThis as Record<string, unknown>).sessionStorage);
  const requests = ['generation.submit', 'reference.attach', 'timeline.clip.add', 'timeline.undo', 'timeline.render'].map((operation, index) => ({
    projectId: 'project-a', key: `pending-${index}`, operation, createdAt: '2026-10-09T13:00:00.000Z', input: { projectId: 'project-a', expectedRevision: 5, requestId: `original-${index}` },
  }));
  requests.forEach(entry => prepareSubmission(entry as unknown as Parameters<typeof prepareSubmission>[0]));
  for (const activeMode of ['editing', 'canvas', 'editing']) {
    writeWorkspaceState('project-a', { ...saved(), activeMode }, storage);
    assert.equal(readWorkspaceState('project-a', storage).activeMode, activeMode);
    writeWorkspaceState('project-b', defaultWorkspaceState(), storage);
    reconcilePending('project-a', { jobs: [], exports: [], timeline: { revision: 99 } });
    requests.forEach(entry => assert.deepEqual(readPending(entry.projectId, entry.key), entry));
  }
});

test('a denied global localStorage getter is caught before reading or writing preferences', t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Object.assign(Error('Access denied'), { name: 'SecurityError' }); } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'localStorage', prior) : delete (globalThis as Record<string, unknown>).localStorage);
  assert.deepEqual(readWorkspaceState('project-a'), defaultWorkspaceState());
  assert.equal(writeWorkspaceState('project-a', saved()), false);
});

test('legacy cache seeds independent mode layouts from shared flags without rewriting its bytes', () => {
  const storage = new MemoryStorage();
  for (const assetsCollapsed of [true, false]) for (const inspectorCollapsed of [true, false]) {
    const legacy = saved(); delete (legacy as unknown as Record<string, unknown>).layout;
    Object.assign(legacy.shared, { assetsCollapsed, inspectorCollapsed });
    const raw = JSON.stringify(legacy); storage.setItem('mioon.workspace.v1:project-a', raw);
    const restored = readStoredWorkspaceState('project-a', storage); assert.ok(restored);
    for (const mode of ['canvas', 'editing']) {
      const layoutByMode = restored.layout as unknown as Record<string, Record<string, unknown>>;
      const modeLayout: Record<string, unknown> = layoutByMode[mode];
      assert.equal((modeLayout as {assetsCollapsed: unknown}).assetsCollapsed, assetsCollapsed);
      assert.equal((modeLayout as {inspectorCollapsed: unknown}).inspectorCollapsed, inspectorCollapsed);
    }
    assert.notEqual(restored.layout.canvas, restored.layout.editing);
    assert.equal(restored.layout.editing.timelineHeight, 300);
    assert.equal(restored.editing.snappingEnabled, false);
    assert.equal(storage.getItem('mioon.workspace.v1:project-a'), raw);
  }
});

test('supplied malformed cache layouts are rejected instead of imported as repaired preferences', () => {
  const storage = new MemoryStorage();
  const invalid = [null, [], {}, { canvas: {} }, { ...saved().layout, extra: true }];
  for (const mode of ['canvas', 'editing']) {
    for (const key of Object.keys((saved().layout as unknown as Record<string, Record<string, unknown>>)[mode])) {
      const layout = saved().layout; delete (layout as unknown as Record<string, Record<string, unknown>>)[mode][key]; invalid.push(layout);
    }
    for (const assetsWidth of [0, 481, Infinity, '242', null]) {
      const layout = saved().layout; (layout as unknown as Record<string, Record<string, unknown>>)[mode].assetsWidth = assetsWidth; invalid.push(layout);
    }
  }
  for (const layout of invalid) {
    const raw = JSON.stringify({ ...saved(), layout }); storage.setItem('mioon.workspace.v1:project-a', raw);
    assert.equal(readStoredWorkspaceState('project-a', storage), null);
    assert.deepEqual(readWorkspaceState('project-a', storage), defaultWorkspaceState());
    assert.equal(storage.getItem('mioon.workspace.v1:project-a'), raw);
  }
});

test('mode layouts survive project switching, reconciliation and reload independently of shared flags', () => {
  const storage = new MemoryStorage(), initial = saved();
  initial.layout.canvas = { assetsWidth: 411.5, inspectorWidth: 478, assetsCollapsed: true, inspectorCollapsed: false };
  initial.layout.editing = { assetsWidth: 198, inspectorWidth: 261, assetsCollapsed: false, inspectorCollapsed: true, timelineHeight: 627.25 };
  Object.assign(initial.shared, { assetsCollapsed: true, inspectorCollapsed: true });
  writeWorkspaceState('project-a', initial, storage);
  const other = readWorkspaceState('project-b', storage); other.layout.canvas.assetsWidth = 330;
  writeWorkspaceState('project-b', other, storage);
  const restored = readWorkspaceState('project-a', storage);
  assert.deepEqual(restored, initial);
  for (const activeMode of ['canvas', 'editing', 'canvas']) {
    restored.activeMode = activeMode as 'canvas' | 'editing';
    assert.deepEqual(reconcileWorkspaceState(restored, {}).layout, initial.layout);
    assert.equal(restored.editing.timelineCollapsed, initial.editing.timelineCollapsed);
    assert.equal(restored.canvas.storyboardOpen, initial.canvas.storyboardOpen);
  }
  assert.equal(readWorkspaceState('project-b', storage).layout.canvas.assetsWidth, 330);
});
