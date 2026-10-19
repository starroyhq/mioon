// View preferences never change project data,
// generation snapshots, timeline history or the durable request recovery log.
import { defaultWorkspaceLayout, isWorkspaceLayout, normalizeWorkspaceLayout } from './workspace-layout.ts';
import type { WorkspaceLayout } from './workspace-layout.ts';

const PREFIX = 'mioon.workspace.v1:';
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}
export interface WorkspaceViewport {x: number; y: number; zoom: number}
export interface WorkspaceCanvasState {
  viewport: WorkspaceViewport | null;
  selectedId: string | null;
  selectedEdgeId: string | null;
  inspectorTab: 'settings' | 'versions';
  highlightedVersionId: string | null;
  storyboardOpen: boolean;
  miniMap: boolean;
}
export interface WorkspaceEditingState {
  selectedClipId: string | null;
  quickAssetId: string | null;
  previewKind: 'timeline' | 'source';
  playhead: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  scrollTop: number;
  timelineCollapsed: boolean;
  snappingEnabled: boolean;
}
export interface WorkspaceSharedState {
  assetFilter: 'all' | 'image' | 'video' | 'audio';
  assetSearch: string;
  assetsCollapsed: boolean;
  inspectorCollapsed: boolean;
}
export interface WorkspaceState {
  version: 1;
  activeMode: 'canvas' | 'editing';
  canvas: WorkspaceCanvasState;
  editing: WorkspaceEditingState;
  shared: WorkspaceSharedState;
  layout: WorkspaceLayout;
}
export interface WorkspaceRelationRow {readonly id: string; readonly [key: string]: unknown}
export interface WorkspaceReconcileData {
  readonly shots?: unknown;
  readonly nodes?: unknown;
  readonly edges?: unknown;
  readonly versions?: unknown;
  readonly timeline?: unknown;
  readonly assets?: unknown;
}
export interface WorkspaceSourceForAsset {
  readonly asset: unknown;
  readonly version: unknown;
  readonly shot: unknown;
  readonly node: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const property = (value: unknown, key: string): unknown => isRecord(value) ? value[key] : undefined;
const id = (value: unknown): string | null => typeof value === 'string' && value.length < 200 ? value : null;
const number = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function defaultWorkspaceState(): WorkspaceState {
  return { version: 1, activeMode: 'canvas',
    canvas: { viewport: null, selectedId: null, selectedEdgeId: null, inspectorTab: 'settings', highlightedVersionId: null, storyboardOpen: false, miniMap: false },
    editing: { selectedClipId: null, quickAssetId: null, previewKind: 'timeline', playhead: 0, pixelsPerSecond: 76, scrollLeft: 0, scrollTop: 0, timelineCollapsed: false, snappingEnabled: true },
    shared: { assetFilter: 'all', assetSearch: '', assetsCollapsed: false, inspectorCollapsed: false },
    layout: defaultWorkspaceLayout() };
}
export function normalizeWorkspaceState(value: unknown): WorkspaceState {
  const base = defaultWorkspaceState();
  const source = isRecord(value) ? value : null;
  if (!source || source.version !== 1) return base;
  const c = isRecord(source.canvas) ? source.canvas : {}, e = isRecord(source.editing) ? source.editing : {}, s = isRecord(source.shared) ? source.shared : {};
  const viewport = isRecord(c.viewport) && ['x', 'y', 'zoom'].every(key => typeof property(c.viewport, key) === 'number' && Number.isFinite(property(c.viewport, key)))
    ? { x: number(property(c.viewport, 'x'), 0, -1e6, 1e6), y: number(property(c.viewport, 'y'), 0, -1e6, 1e6), zoom: number(property(c.viewport, 'zoom'), 1, .2, 1.75) }
    : null;
  const assetFilter = ['all', 'image', 'video', 'audio'].includes(String(s.assetFilter)) ? String(s.assetFilter) as WorkspaceSharedState['assetFilter'] : 'all';
  return { version: 1, activeMode: source.activeMode === 'editing' ? 'editing' : 'canvas',
    canvas: { viewport,
      selectedId: id(c.selectedId), selectedEdgeId: id(c.selectedEdgeId), inspectorTab: c.inspectorTab === 'versions' ? 'versions' : 'settings', highlightedVersionId: id(c.highlightedVersionId), storyboardOpen: c.storyboardOpen === true, miniMap: c.miniMap === true },
    editing: { selectedClipId: id(e.selectedClipId), quickAssetId: id(e.quickAssetId), previewKind: e.previewKind === 'source' ? 'source' : 'timeline', playhead: Math.round(number(e.playhead, 0, 0, 18000)), pixelsPerSecond: number(e.pixelsPerSecond, 76, 28, 220), scrollLeft: number(e.scrollLeft, 0, 0, 1e7), scrollTop: number(e.scrollTop, 0, 0, 1e6), timelineCollapsed: e.timelineCollapsed === true, snappingEnabled: e.snappingEnabled !== false },
    shared: { assetFilter, assetSearch: typeof s.assetSearch === 'string' ? s.assetSearch.slice(0, 500) : '', assetsCollapsed: s.assetsCollapsed === true, inspectorCollapsed: s.inspectorCollapsed === true },
    layout: normalizeWorkspaceLayout(source.layout, s) };
}
export function readStoredWorkspaceState(projectId: string, storage?: WorkspaceStorage): WorkspaceState | null {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const value: unknown = JSON.parse(target?.getItem(`${PREFIX}${projectId}`) || 'null');
    if (isRecord(value) && Object.hasOwn(value, 'layout') && !isWorkspaceLayout(value.layout)) return null;
    return isRecord(value) && value.version === 1 ? normalizeWorkspaceState(value) : null;
  } catch { return null; }
}
export function readWorkspaceState(projectId: string, storage?: WorkspaceStorage): WorkspaceState {
  return readStoredWorkspaceState(projectId, storage) || defaultWorkspaceState();
}
export function writeWorkspaceState(projectId: string, state: unknown, storage?: WorkspaceStorage): boolean {
  if (!projectId) return false;
  try { const target = storage === undefined ? globalThis.localStorage : storage; target?.setItem(`${PREFIX}${projectId}`, JSON.stringify(normalizeWorkspaceState(state))); return Boolean(target); } catch { return false; }
}
export function reconcileWorkspaceState(state: unknown, data: unknown): WorkspaceState {
  const next = normalizeWorkspaceState(state);
  const relation = (table: string): WorkspaceRelationRow[] => rows(property(data, table)).filter(isRecord).map(row => ({ ...row, id: String(row.id) }));
  const shots = relation('shots'), nodes = relation('nodes'), edges = relation('edges'), versions = relation('versions'), assets = relation('assets');
  const timeline = isRecord(property(data, 'timeline')) ? property(data, 'timeline') as Record<string, unknown> : null;
  const clips = rows(property(timeline, 'clips')).filter(isRecord).map(row => ({ ...row, id: String(row.id) }));
  if (![...shots, ...nodes].some(record => record.id === next.canvas.selectedId)) next.canvas.selectedId = null;
  if (!edges.some(edge => edge.id === next.canvas.selectedEdgeId)) next.canvas.selectedEdgeId = null;
  if (!versions.some(version => version.id === next.canvas.highlightedVersionId)) next.canvas.highlightedVersionId = null;
  if (!clips.some(clip => clip.id === next.editing.selectedClipId)) next.editing.selectedClipId = null;
  if (!assets.some(asset => asset.id === next.editing.quickAssetId)) next.editing.quickAssetId = null;
  return next;
}
export function sourceForAsset(data: unknown, assetId: unknown): WorkspaceSourceForAsset | null {
  const asset = rows(property(data, 'assets')).find(item => property(item, 'id') === assetId);
  if (!asset) return null;
  const version = rows(property(data, 'versions')).find(item => property(item, 'assetId') === assetId);
  const shot = version && rows(property(data, 'shots')).find(item => property(item, 'id') === property(version, 'shotId'));
  const nodes = rows(property(data, 'nodes')).filter(item => property(item, 'assetId') === assetId);
  return { asset, version: shot ? version : null, shot: shot || null, node: nodes.length === 1 ? nodes[0] : null };
}
