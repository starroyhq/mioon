import {getWorkspaceRestoreContext} from './workspace-restore-schema.ts';
import {withRestoreInvocation,freezeRestoreInput} from './workspace-restore-invocation.ts';
import {refuseRestoredOperation,assertWorkspaceRestoreOrigin} from './workspace-restore-policy.ts';
import {AppError, schemas} from '@mioon/contracts';
import {getOpacityCandidateAssembly,isOpacityCandidateApplicationStore} from './opacity-candidate-store.ts';
import type {DatabaseSync} from 'node:sqlite';

type PreferencesRow = {revision: number;state: string};
interface PreferencesStore {db: DatabaseSync;tx: <T>(callback: ()=>T)=>T;get: (table: string,id: string)=>unknown}

// This is a renderer-only whitelist, deliberately separate from operation
// schemas and project/timeline records. Free text and request recovery IDs do
// not belong here. Keep its bounds aligned with apps/web/src/workspace-state.ts.
export const MAX_WORKSPACE_PREFERENCES_BYTES = 16 * 1024;
const entityId = schemas['project.get'].shape.projectId;
const invalid: (path: string[], message: string)=>never = (path, message) => { throw new AppError('VALIDATION_ERROR', '工作区偏好字段无效', 400, {issues: [{path, message}]}); };
function object(value: unknown, keys: string[], path: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, 'Expected an object');
  const record=value as Record<string, unknown>;
  const actual = Reflect.ownKeys(record);
  if (keys.some(key => !Object.hasOwn(record, key)) || actual.some(key => !keys.includes(String(key)) && !optional.includes(String(key)))) invalid(path, 'Expected exactly the documented fields');
  return record;
}
function oneOf(value: unknown, choices: readonly unknown[], path: string[]): unknown {
  if (!choices.includes(value)) invalid(path, 'Invalid preference value');
  return value;
}
function numeric(value: unknown, min: number, max: number, path: string[], integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(path, 'Number is outside the supported range');
  return Object.is(value, -0) ? 0 : value;
}
function id(value: unknown, path: string[], nullable = true): string|null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 199 || !entityId.safeParse(value).success) invalid(path, 'Expected a valid entity ID');
  return value;
}
const bool = (value: unknown, path: string[]): unknown => oneOf(value, [true, false], path);

function panelLayout(value: unknown, mode: string): {assetsWidth: number;inspectorWidth: number;assetsCollapsed: unknown;inspectorCollapsed: unknown;timelineHeight?: number} {
  const path = ['state', 'layout', mode];
  const source = object(value, ['assetsWidth', 'inspectorWidth', 'assetsCollapsed', 'inspectorCollapsed', ...(mode === 'editing' ? ['timelineHeight'] : [])], path);
  return {
    assetsWidth: numeric(source.assetsWidth, 180, 480, [...path, 'assetsWidth']),
    inspectorWidth: numeric(source.inspectorWidth, 240, 560, [...path, 'inspectorWidth']),
    assetsCollapsed: bool(source.assetsCollapsed, [...path, 'assetsCollapsed']),
    inspectorCollapsed: bool(source.inspectorCollapsed, [...path, 'inspectorCollapsed']),
    ...(mode === 'editing' ? { timelineHeight: numeric(source.timelineHeight, 160, 800, [...path, 'timelineHeight']) } : {}),
  };
}

export function parseWorkspacePreferencesState(value: unknown): Record<string, unknown> {
  const s = object(value, ['version', 'activeMode', 'canvas', 'editing', 'shared'], ['state'], ['layout']);
  const c = object(s.canvas, ['viewport', 'selectedId', 'selectedEdgeId', 'inspectorTab', 'highlightedVersionId', 'storyboardOpen', 'miniMap'], ['state', 'canvas']);
  const e = object(s.editing, ['selectedClipId', 'quickAssetId', 'previewKind', 'playhead', 'pixelsPerSecond', 'scrollLeft', 'scrollTop', 'timelineCollapsed'], ['state', 'editing'], ['snappingEnabled']);
  const shared = object(s.shared, ['assetFilter', 'assetsCollapsed', 'inspectorCollapsed'], ['state', 'shared']);
  const legacyPanel = () => ({ assetsWidth: 260, inspectorWidth: 320,
    assetsCollapsed: bool(shared.assetsCollapsed, ['state', 'shared', 'assetsCollapsed']),
    inspectorCollapsed: bool(shared.inspectorCollapsed, ['state', 'shared', 'inspectorCollapsed']) });
  let layout;
  if (Object.hasOwn(s, 'layout')) {
    const source = object(s.layout, ['canvas', 'editing'], ['state', 'layout']);
    layout = { canvas: panelLayout(source.canvas, 'canvas'), editing: panelLayout(source.editing, 'editing') };
  } else {
    // Only whole-layout omission is a legacy exception. Never repair a partial
    // layout, and never let old shared flags override a supplied mode layout.
    layout = { canvas: legacyPanel(), editing: { ...legacyPanel(), timelineHeight: 300 } };
  }
  let viewport = null;
  if (c.viewport !== null) {
    const v = object(c.viewport, ['x', 'y', 'zoom'], ['state', 'canvas', 'viewport']);
    viewport = {
      x: numeric(v.x, -1e6, 1e6, ['state', 'canvas', 'viewport', 'x']),
      y: numeric(v.y, -1e6, 1e6, ['state', 'canvas', 'viewport', 'y']),
      zoom: numeric(v.zoom, .2, 1.75, ['state', 'canvas', 'viewport', 'zoom']),
    };
  }
  // Construct in a fixed order so byte comparison is independent of JSON key
  // order. No clamping, coercion, stripping unknown keys, or entity mutations.
  return {
    version: oneOf(s.version, [1], ['state', 'version']),
    activeMode: oneOf(s.activeMode, ['canvas', 'editing'], ['state', 'activeMode']),
    canvas: {
      viewport,
      selectedId: id(c.selectedId, ['state', 'canvas', 'selectedId']),
      selectedEdgeId: id(c.selectedEdgeId, ['state', 'canvas', 'selectedEdgeId']),
      inspectorTab: oneOf(c.inspectorTab, ['settings', 'versions'], ['state', 'canvas', 'inspectorTab']),
      highlightedVersionId: id(c.highlightedVersionId, ['state', 'canvas', 'highlightedVersionId']),
      storyboardOpen: bool(c.storyboardOpen, ['state', 'canvas', 'storyboardOpen']),
      miniMap: bool(c.miniMap, ['state', 'canvas', 'miniMap']),
    },
    editing: {
      selectedClipId: id(e.selectedClipId, ['state', 'editing', 'selectedClipId']),
      quickAssetId: id(e.quickAssetId, ['state', 'editing', 'quickAssetId']),
      previewKind: oneOf(e.previewKind, ['timeline', 'source'], ['state', 'editing', 'previewKind']),
      playhead: numeric(e.playhead, 0, 18000, ['state', 'editing', 'playhead'], true),
      pixelsPerSecond: numeric(e.pixelsPerSecond, 28, 220, ['state', 'editing', 'pixelsPerSecond']),
      scrollLeft: numeric(e.scrollLeft, 0, 1e7, ['state', 'editing', 'scrollLeft']),
      scrollTop: numeric(e.scrollTop, 0, 1e6, ['state', 'editing', 'scrollTop']),
      timelineCollapsed: bool(e.timelineCollapsed, ['state', 'editing', 'timelineCollapsed']),
      // Missing only in legacy v1 records; an explicit value must be boolean.
      snappingEnabled: Object.hasOwn(e, 'snappingEnabled') ? bool(e.snappingEnabled, ['state', 'editing', 'snappingEnabled']) : true,
    },
    shared: {
      assetFilter: oneOf(shared.assetFilter, ['all', 'image', 'video', 'audio'], ['state', 'shared', 'assetFilter']),
      assetsCollapsed: bool(shared.assetsCollapsed, ['state', 'shared', 'assetsCollapsed']),
      inspectorCollapsed: bool(shared.inspectorCollapsed, ['state', 'shared', 'inspectorCollapsed']),
    },
    layout,
  };
}

export function createWorkspacePreferences(store: PreferencesStore) {
  const {db, tx} = store;
  // Only the explicit fresh42 application handle can use this fixed local
  // companion. Ordinary/reopened42 and restored43 gain no new permission.
  const candidateAssembly=getOpacityCandidateAssembly(store);
  const candidate=isOpacityCandidateApplicationStore(store)?candidateAssembly:null;
  const candidateCheckpoint=()=>{
    candidateAssembly?.checkpoint();
    if(candidateAssembly&&getOpacityCandidateAssembly(store)!==candidateAssembly)throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This internal candidate workspace is unavailable.',409);
    if(candidate&&(!isOpacityCandidateApplicationStore(store)||getOpacityCandidateAssembly(store)!==candidate))throw new AppError('RESTORE_OPERATION_UNAVAILABLE','This internal candidate workspace is unavailable.',409);
  };
  const requireProject = (projectId: string): void => {
    id(projectId, ['projectId'], false);
    if (!store.get('projects', projectId)) throw new AppError('NOT_FOUND', '找不到项目', 404, {projectId});
  };
  const current = (projectId: string): PreferencesRow|undefined => db.prepare('SELECT revision,state FROM workspace_preferences WHERE projectId=?').get(projectId) as PreferencesRow|undefined;
  // Normalize legacy v1 records in memory, without changing their stored bytes
  // or revision on reads or exact replay.
  const canonical = (state: string): string => JSON.stringify(parseWorkspacePreferencesState(JSON.parse(state)));
  const result = (projectId: string, row: PreferencesRow|undefined|null) => ({projectId, revision: row?.revision ?? 0, state: row ? parseWorkspacePreferencesState(JSON.parse(row.state)) : null});
  return {
    get(projectId: string) {
      candidateCheckpoint();
      requireProject(projectId);
      return result(projectId, current(projectId));
    },
    put(projectId: string, input: unknown, context: {signal?: AbortSignal} = {}) {
      candidateCheckpoint();
      // Candidate43 has no workspace.preferences.put execution capability.
      // Its DB is not registered in the historical restore WeakMap, so never
      // let that absence fall through to the ordinary unguarded write path.
      if(candidateAssembly?.getRestoreContext())throw new AppError('RESTORE_OPERATION_UNAVAILABLE','View preferences are read-only in this restored candidate application.',409);
      id(projectId, ['projectId'], false);
      const payload = object(input, ['expectedRevision', 'state'], []);
      const expectedRevision = numeric(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER, ['expectedRevision'], true);
      const state = JSON.stringify(parseWorkspacePreferencesState(payload.state));
      if (Buffer.byteLength(state) > MAX_WORKSPACE_PREFERENCES_BYTES) invalid(['state'], 'Preferences are too large');
      const identity=freezeRestoreInput({projectId,expectedRevision,state});
      const apply=()=>tx(() => {
        if(candidate)candidateCheckpoint();else refuseRestoredOperation(store as never,'workspace.preferences.put',identity);
        requireProject(projectId);
        const previous = current(projectId), revision = previous?.revision ?? 0;
        // Only an exact retry of the most recent accepted write is replayable.
        // An old renderer must never roll back a newer view, even to an equal
        // state that happened to occur at an earlier revision.
        if (previous && revision === expectedRevision + 1 && canonical(previous.state) === state) return result(projectId, previous);
        if (revision !== expectedRevision) throw new AppError('PREFERENCES_CONFLICT', '工作区视图已在其他窗口更新，请先重新读取', 409, {projectId, expectedRevision, currentRevision: revision});
        if (revision === Number.MAX_SAFE_INTEGER) throw new AppError('PREFERENCES_REVISION_EXHAUSTED', '工作区视图版本已达上限', 409, {projectId, currentRevision: revision});
        const next = {revision: revision + 1, state};
        if (previous) db.prepare('UPDATE workspace_preferences SET revision=?,state=? WHERE projectId=? AND revision=?').run(next.revision, state, projectId, revision);
        else db.prepare('INSERT INTO workspace_preferences(projectId,revision,state) VALUES(?,?,?)').run(projectId, next.revision, state);
        return result(projectId, next);
      });
      if(candidate){candidateCheckpoint();return apply();}
      if(!getWorkspaceRestoreContext(store))return apply();
      assertWorkspaceRestoreOrigin(store as never,context as unknown as {expectedWorkspaceOrigin?: unknown});
      return withRestoreInvocation(store as never,'workspace.preferences.put',identity,{signal:context.signal},apply);
    },
  };
}
