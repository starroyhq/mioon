import {AppError, schemas} from '@mioon/contracts';

// This is a renderer-only whitelist, deliberately separate from operation
// schemas and project/timeline records. Free text and request recovery IDs do
// not belong here. Keep its bounds aligned with apps/web/src/workspace-state.js.
export const MAX_WORKSPACE_PREFERENCES_BYTES = 16 * 1024;
const entityId = schemas['project.get'].shape.projectId;
const invalid = (path, message) => { throw new AppError('VALIDATION_ERROR', '工作区偏好字段无效', 400, {issues: [{path, message}]}); };
function object(value, keys, path, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, 'Expected an object');
  const actual = Reflect.ownKeys(value);
  if (keys.some(key => !Object.hasOwn(value, key)) || actual.some(key => !keys.includes(key) && !optional.includes(key))) invalid(path, 'Expected exactly the documented fields');
  return value;
}
function oneOf(value, choices, path) {
  if (!choices.includes(value)) invalid(path, 'Invalid preference value');
  return value;
}
function numeric(value, min, max, path, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) invalid(path, 'Number is outside the supported range');
  return Object.is(value, -0) ? 0 : value;
}
function id(value, path, nullable = true) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > 199 || !entityId.safeParse(value).success) invalid(path, 'Expected a valid entity ID');
  return value;
}
const bool = (value, path) => oneOf(value, [true, false], path);

export function parseWorkspacePreferencesState(value) {
  const s = object(value, ['version', 'activeMode', 'canvas', 'editing', 'shared'], ['state']);
  const c = object(s.canvas, ['viewport', 'selectedId', 'selectedEdgeId', 'inspectorTab', 'highlightedVersionId', 'storyboardOpen', 'miniMap'], ['state', 'canvas']);
  const e = object(s.editing, ['selectedClipId', 'quickAssetId', 'previewKind', 'playhead', 'pixelsPerSecond', 'scrollLeft', 'scrollTop', 'timelineCollapsed'], ['state', 'editing'], ['snappingEnabled']);
  const shared = object(s.shared, ['assetFilter', 'assetsCollapsed', 'inspectorCollapsed'], ['state', 'shared']);
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
  };
}

export function createWorkspacePreferences(store) {
  const {db, tx} = store;
  const requireProject = projectId => {
    id(projectId, ['projectId'], false);
    if (!store.get('projects', projectId)) throw new AppError('NOT_FOUND', '找不到项目', 404, {projectId});
  };
  const current = projectId => db.prepare('SELECT revision,state FROM workspace_preferences WHERE projectId=?').get(projectId);
  // Normalize legacy v1 records in memory, without changing their stored bytes
  // or revision on reads or exact replay.
  const canonical = state => JSON.stringify(parseWorkspacePreferencesState(JSON.parse(state)));
  const result = (projectId, row) => ({projectId, revision: row?.revision ?? 0, state: row ? parseWorkspacePreferencesState(JSON.parse(row.state)) : null});
  return {
    get(projectId) {
      requireProject(projectId);
      return result(projectId, current(projectId));
    },
    put(projectId, input) {
      id(projectId, ['projectId'], false);
      const payload = object(input, ['expectedRevision', 'state'], []);
      const expectedRevision = numeric(payload.expectedRevision, 0, Number.MAX_SAFE_INTEGER, ['expectedRevision'], true);
      const state = JSON.stringify(parseWorkspacePreferencesState(payload.state));
      if (Buffer.byteLength(state) > MAX_WORKSPACE_PREFERENCES_BYTES) invalid(['state'], 'Preferences are too large');
      return tx(() => {
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
    },
  };
}
