// View preferences never change project data,
// generation snapshots, timeline history or the durable request recovery log.
import { defaultWorkspaceLayout, isWorkspaceLayout, normalizeWorkspaceLayout } from './workspace-layout.ts';

const PREFIX = 'mioon.workspace.v1:';
const id = value => typeof value === 'string' && value.length < 200 ? value : null;
const number = (value, fallback, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function defaultWorkspaceState() {
  return { version: 1, activeMode: 'canvas',
    canvas: { viewport: null, selectedId: null, selectedEdgeId: null, inspectorTab: 'settings', highlightedVersionId: null, storyboardOpen: false, miniMap: false },
    editing: { selectedClipId: null, quickAssetId: null, previewKind: 'timeline', playhead: 0, pixelsPerSecond: 76, scrollLeft: 0, scrollTop: 0, timelineCollapsed: false, snappingEnabled: true },
    shared: { assetFilter: 'all', assetSearch: '', assetsCollapsed: false, inspectorCollapsed: false },
    layout: defaultWorkspaceLayout() };
}
export function normalizeWorkspaceState(value) {
  const base = defaultWorkspaceState();
  if (!value || value.version !== 1) return base;
  const c = value.canvas || {}, e = value.editing || {}, s = value.shared || {};
  return { version: 1, activeMode: value.activeMode === 'editing' ? 'editing' : 'canvas',
    canvas: { viewport: c.viewport && ['x', 'y', 'zoom'].every(key => Number.isFinite(c.viewport[key])) ? { x: number(c.viewport.x, 0, -1e6, 1e6), y: number(c.viewport.y, 0, -1e6, 1e6), zoom: number(c.viewport.zoom, 1, .2, 1.75) } : null,
      selectedId: id(c.selectedId), selectedEdgeId: id(c.selectedEdgeId), inspectorTab: c.inspectorTab === 'versions' ? 'versions' : 'settings', highlightedVersionId: id(c.highlightedVersionId), storyboardOpen: c.storyboardOpen === true, miniMap: c.miniMap === true },
    editing: { selectedClipId: id(e.selectedClipId), quickAssetId: id(e.quickAssetId), previewKind: e.previewKind === 'source' ? 'source' : 'timeline', playhead: Math.round(number(e.playhead, 0, 0, 18000)), pixelsPerSecond: number(e.pixelsPerSecond, 76, 28, 220), scrollLeft: number(e.scrollLeft, 0, 0, 1e7), scrollTop: number(e.scrollTop, 0, 0, 1e6), timelineCollapsed: e.timelineCollapsed === true, snappingEnabled: e.snappingEnabled !== false },
    shared: { assetFilter: ['all', 'image', 'video', 'audio'].includes(s.assetFilter) ? s.assetFilter : 'all', assetSearch: typeof s.assetSearch === 'string' ? s.assetSearch.slice(0, 500) : '', assetsCollapsed: s.assetsCollapsed === true, inspectorCollapsed: s.inspectorCollapsed === true },
    layout: normalizeWorkspaceLayout(value.layout, s) };
}
export function readStoredWorkspaceState(projectId, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const value = JSON.parse(target?.getItem(`${PREFIX}${projectId}`) || 'null');
    if (value && Object.hasOwn(value, 'layout') && !isWorkspaceLayout(value.layout)) return null;
    return value && value.version === 1 ? normalizeWorkspaceState(value) : null;
  } catch { return null; }
}
export function readWorkspaceState(projectId, storage) {
  return readStoredWorkspaceState(projectId, storage) || defaultWorkspaceState();
}
export function writeWorkspaceState(projectId, state, storage) {
  if (!projectId) return false;
  try { const target = storage === undefined ? globalThis.localStorage : storage; target?.setItem(`${PREFIX}${projectId}`, JSON.stringify(normalizeWorkspaceState(state))); return Boolean(target); } catch { return false; }
}
export function reconcileWorkspaceState(state, data) {
  const next = normalizeWorkspaceState(state);
  if (![...(data.shots || []), ...(data.nodes || [])].some(record => record.id === next.canvas.selectedId)) next.canvas.selectedId = null;
  if (!(data.edges || []).some(edge => edge.id === next.canvas.selectedEdgeId)) next.canvas.selectedEdgeId = null;
  if (!(data.versions || []).some(version => version.id === next.canvas.highlightedVersionId)) next.canvas.highlightedVersionId = null;
  if (!(data.timeline?.clips || []).some(clip => clip.id === next.editing.selectedClipId)) next.editing.selectedClipId = null;
  if (!(data.assets || []).some(asset => asset.id === next.editing.quickAssetId)) next.editing.quickAssetId = null;
  return next;
}
export function sourceForAsset(data, assetId) {
  const asset = data.assets?.find(item => item.id === assetId);
  if (!asset) return null;
  const version = data.versions?.find(item => item.assetId === assetId);
  const shot = version && data.shots?.find(item => item.id === version.shotId);
  const nodes = data.nodes?.filter(item => item.assetId === assetId) || [];
  return { asset, version: shot ? version : null, shot: shot || null, node: nodes.length === 1 ? nodes[0] : null };
}
