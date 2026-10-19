/** Store-bound candidate reads and validation. Writes, history and receipts are
 * still performed only by the existing timeline transaction implementation. */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {
  captureOpacityTimelineRecord, captureOpacityTimelineIntent, captureOpacityTimelinePrepare,
  isOpacityTimelineMutationResponse, isOpacityTimelineTask,
  captureOpacityApplicationPrepare, isOpacityApplicationMutationResponse, isOpacityApplicationTask, captureRippleOpacityPrepare, isRippleOpacityMutationResponse,
} from '../../contracts/src/timeline-opacity-persistence.ts';
import {captureOpacityRenderInput, captureOpacityPreflightInput, captureOpacityCapabilitiesInput, createOpacityRenderSnapshotPlan, captureOpacityRenderSnapshot, captureOpacityPreparedSourceProjection, isOpacityRenderRecord} from '../../contracts/src/timeline-opacity-render-candidate.ts';
import {getOpacityCandidateAssembly, freezeOpacityCandidateInput, isOpacityCandidateApplicationStore} from './opacity-candidate-store.ts';
import {timelineExportRangeBoundsIssue} from './timeline-export-range.ts';

type Value = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
interface Graph {asset(id: unknown): unknown; clipSource(clip: unknown): unknown; version(id: unknown, shotId?: unknown, assetId?: unknown): unknown}
interface Timeline extends Value {id: string; projectId: string; revision: number; createdAt: string; updatedAt: string; durationFrames: number; tracks: Value[]; clips: Value[]}
const require = createRequire(import.meta.url);
// Literal fixed dependencies, never selected by caller, RPC or stored data.
const inspection: unknown = require('./inspection.ts');
const inputs: unknown = require('./timeline-inputs.ts');
const recovery: unknown = require('./timeline-recovery.ts');
const colour: unknown = require('./timeline-colour-business.ts');
const format: unknown = require('./timeline-format-receipts.ts');
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const clone = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const invalid = (): never => {throw new AppError('INVALID_TIMELINE_SNAPSHOT', '时间线或已保存的请求响应无效', 409);};
const unavailable = (): never => {throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '项目中的时间线或关联素材不可用', 404);};
function method(module: unknown, name: string): Method {
  if (!object(module) || typeof module[name] !== 'function') return invalid();
  return module[name] as Method;
}
function timeline(value: unknown, projectId: unknown): Timeline {
  try {const result = captureOpacityTimelineRecord(value, {projectId}).record;
    if (!object(result) || !Array.isArray(result.clips) || !Array.isArray(result.tracks)) return invalid();
    return result as Timeline;
  } catch {return invalid();}
}
function projected(value: Timeline): Timeline {
  return {...value, clips: value.clips.map(clip => {const result = {...clip};delete result.opacityEnvelope;return result;})};
}
const bounded = (column: string, bytes: number): string => `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${bytes} THEN ${column} END`;
const identity = (column: string): string => `${bounded(column, 36)} AS ${column}`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Only the private store lifecycle can provide the binding. Possession of a
 * database handle alone never establishes this candidate capability. */
export function createOpacityCandidateDomain(store: unknown) {
  const assembly = getOpacityCandidateAssembly(store);
  if (!assembly || !object(store) || !(store.db instanceof DatabaseSync)) throw new AppError('OPACITY_CANDIDATE_STORE_REQUIRED', '透明度候选工作区未装配。', 409);
  const db = store.db;
  const boundAssembly = assembly;
  const application = isOpacityCandidateApplicationStore(store);
  const originalMutationResponse = application ? isOpacityApplicationMutationResponse : isOpacityTimelineMutationResponse;
  const mutationResponse = (operation:string,input:unknown,value:unknown):boolean => operation==='timeline.clip.rippleRemove' && assembly.rippleRemove ? isRippleOpacityMutationResponse(input,value) : originalMutationResponse(operation,input,value);
  const checkpoint = (): void => {
    boundAssembly.checkpoint();
    if (getOpacityCandidateAssembly(store) !== boundAssembly || !boundAssembly.ownsLock()) throw new AppError('EDIT_TASK_OWNER_REQUIRED', '只有持有工作区锁的后端可以修改编辑任务。', 403);
  };
  /** A captured application add is readable history, never a new43 intent.
   * Bind its original request to the exact immutable task row and hold rather
   * than broadening the restored prepare, mutation or dispatch grammar. */
  function capturedClipAdd(input: unknown, taskId?: unknown): Value | null {
    checkpoint();
    if (!boundAssembly.getRestoreContext() || !object(input) || !uuid(input.projectId) || typeof input.requestId !== 'string') return null;
    const rows = db.prepare(`SELECT t.id,t.projectId,t.operation,${bounded('t.input', 8192)} AS input,t.requestId,t.digest
      FROM edit_tasks t JOIN workspace_restore_holds h ON h.kind='edit_tasks' AND h.id=t.id AND h.capturedRowid=t.rowid
      AND h.projectId=t.projectId AND h.namespace=t.lane AND h.requestId=t.requestId AND h.operation=t.operation
      WHERE t.projectId=? AND t.requestId=? AND t.operation='timeline.clip.add' AND t.lane='timeline:mutation'
      AND t.executionEpoch='captured' LIMIT 2`).all(input.projectId, input.requestId);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (taskId !== undefined && row.id !== taskId || typeof row.input !== 'string' || row.digest !== digest({operation: row.operation, input})) return null;
    let original: unknown; try {original = JSON.parse(row.input);} catch {return null;}
    return object(original) && canonical(original) === canonical(input) ? row : null;
  }
  const parse = (operation: string, input: unknown): Value => {
    checkpoint();
    if (operation === 'timeline.export.preflight') return captureOpacityPreflightInput(input);
    if (operation === 'timeline.export.capabilities') return captureOpacityCapabilitiesInput(input);
    if (operation !== 'timeline.render') return captureOpacityTimelineIntent(operation, input).input;
    return captureOpacityRenderInput(input);
  };
  function freezeRenderSnapshot(value: unknown, assets: unknown, exportSettings: unknown, input: unknown): Value {
    checkpoint();
    if (!object(input) || !['preview', 'export'].includes(String(input.purpose))) return invalid();
    const checked = timeline(value, input.projectId);
    const projection = method(inputs, 'freezeTimelineSnapshot')(projected(checked), assets, exportSettings, input);
    if (!object(projection)) return invalid();
    const raw = {...projection, timeline: clone(checked)};
    const purpose = input.purpose as 'preview' | 'export';
    const plan = createOpacityRenderSnapshotPlan(raw, purpose);
    return captureOpacityRenderSnapshot({...raw, ...(plan ? {opacityPlan: plan} : {})}, purpose).snapshot;
  }
  function readPreflightSnapshot(value: unknown) {
    checkpoint();
    const input = captureOpacityPreflightInput(value), outer = db.isTransaction;
    if (!outer) db.exec('BEGIN DEFERRED');
    try {
      const reader = boundary(input), checked = reader.read({legacyMissingProject: true, sourceSemantics: false});
      if (!checked) return Object.freeze({timeline: null, snapshot: null, legacyValidationSnapshot: null});
      // These two normal blocked reports need no renderable snapshot. All
      // nonempty in-range reads use exactly the actual render freezer below.
      if (!checked.clips.length || timelineExportRangeBoundsIssue(input, checked.durationFrames))
        return freezeOpacityCandidateInput({timeline: checked, snapshot: null, legacyValidationSnapshot: null});
      // Render admission validates a detached editable value before freezing.
      // Preserve its exact source/fade/audio refusal rather than letting the
      // complete frozen-record validator collapse it to a generic error.
      reader.validate(clone(checked));
      const purpose = input.purpose === 'preview' ? 'preview' : 'export';
      const frozen = freezeRenderSnapshot(checked, reader.sources(checked), input.exportSettings, {...input, purpose});
      const {snapshot, sourceValidationSnapshot} = captureOpacityPreparedSourceProjection(frozen, purpose);
      return freezeOpacityCandidateInput({timeline: checked, snapshot, legacyValidationSnapshot: sourceValidationSnapshot});
    } finally {if (!outer && db.isTransaction) db.exec('COMMIT');}
  }
  function admit(value: unknown, related: {before?: unknown; after?: unknown; response?: unknown; related?: unknown} = {}): void {
    checkpoint();
    for (const [record, candidate] of Object.entries({timeline: value, before: related.before, after: related.after, response: related.response ?? value})) {
      if (candidate === undefined) continue;
      const actualBytes = Buffer.byteLength(JSON.stringify(candidate));
      if (actualBytes > 262144) throw new AppError('TIMELINE_OPACITY_ENVELOPE_LIMIT', '时间线透明度关键帧超过完整记录保存上限。', 409, {record, maxBytes: 262144, actualBytes});
    }
  }
  function boundary(value: unknown) {
    checkpoint();
    if (!object(value) || !uuid(value.projectId)) return invalid();
    const input = value, projectId = value.projectId;
    const guarded = <T>(fn: () => T): T => {
      checkpoint();
      try {return fn();} catch (error) {if (object(error) && error.code === 'INSPECTION_UNAVAILABLE') return unavailable();throw error;}
    };
    function graph(): Graph {
      const result = guarded(() => method(inspection, 'createOwnedMediaGraphReader')(db, projectId));
      if (!object(result) || !['asset', 'clipSource', 'version'].every(key => typeof result[key] === 'function')) return invalid();
      return result as unknown as Graph;
    }
    const asset = (id: unknown): unknown => guarded(() => graph().asset(id));
    const clipSource = (clip: unknown): unknown => guarded(() => graph().clipSource(clip));
    const version = (id: unknown, shotId?: unknown, assetId?: unknown): unknown => guarded(() => graph().version(id, shotId, assetId));
    const inputAsset = (id: unknown): unknown => guarded(() => {
      if (!uuid(id)) return invalid();
      const row = db.prepare(`SELECT ${identity('projectId')} FROM assets WHERE id=?`).get(id);
      if (!row) throw new AppError('NOT_FOUND', '找不到记录', 404, {id});
      if (row.projectId !== projectId) throw new AppError('CROSS_PROJECT_REFERENCE', '素材不属于此项目');
      return asset(id);
    });
    function sources(checked: Timeline): Map<string, unknown> {
      checkpoint();const assets = new Map<string, unknown>(), seen = new Set<string>();
      for (const clip of checked.clips) {
        const key = JSON.stringify([clip.assetId, ...['versionId', 'shotId', 'jobId'].map(field => [own(clip, field), clip[field]])]);
        if (seen.has(key)) continue;
        if (typeof clip.assetId !== 'string') return invalid();
        assets.set(clip.assetId, clipSource(clip));seen.add(key);
      }
      try {method(colour, 'validateTimelineColourBindings')(db, projected(checked), assets);}
      catch (error) {
        if (object(error) && ['TIMELINE_COLOUR_SOURCE_MISMATCH', 'TIMELINE_COLOUR_LOOK_UNAVAILABLE'].includes(String(error.code))) throw new AppError(String(error.code), String(error.message), typeof error.status === 'number' ? error.status : 409);
        throw error;
      }
      return assets;
    }
    function validate(value: unknown): unknown {
      checkpoint();
      if (!object(value) || !Array.isArray(value.clips)) return invalid();
      // Existing mutation callbacks update editable fields before recomputing
      // aggregate duration. Compute only that derived field, then strictly
      // capture all original fields before source or history work.
      let end = 0;
      for (const clip of value.clips as unknown[]) {
        if (!object(clip) || typeof clip.startFrame !== 'number' || typeof clip.durationFrames !== 'number') return invalid();
        end = Math.max(end, clip.startFrame + clip.durationFrames);
      }
      const checked = timeline({...value, durationFrames: end}, projectId), assets = sources(checked), projection = projected(checked);
      method(inputs, 'validateSavedTimeline')(projection, {
        track: (_timeline: unknown, id: unknown) => {
          const found = checked.tracks.find(track => track.id === id);
          if (!found) throw new AppError('TRACK_NOT_FOUND', '轨道不属于此时间线', 404, {trackId: id});return found;
        },
        asset: (_projectId: unknown, id: unknown) => typeof id === 'string' ? assets.get(id) : undefined,
      });
      admit(checked);value.durationFrames = checked.durationFrames;
      return value;
    }
    function validateReadonly(value: unknown): Timeline {
      const checked = timeline(value, projectId);
      try {const copy = clone(checked);validate(copy);if (!object(copy) || copy.durationFrames !== checked.durationFrames) return invalid();}
      catch (error) {
        if (object(error) && ['TIMELINE_SOURCE_UNAVAILABLE', 'INSPECTION_BUDGET_EXCEEDED'].includes(String(error.code))) throw error;
        return invalid();
      }
      return checked;
    }
    function read(options: {legacyMissingProject?: boolean; sourceSemantics?: boolean} = {}): Timeline | null {
      checkpoint();
      if (options.legacyMissingProject && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new AppError('NOT_FOUND', '找不到记录', 404, {id: projectId});
      graph();
      const row = db.prepare(`SELECT ${identity('id')},${identity('projectId')},${bounded('data', 262144)} AS data FROM timelines WHERE projectId=? LIMIT 1`).get(projectId);
      if (!row) return null;
      if (typeof row.data !== 'string' || !uuid(row.id) || row.projectId !== projectId) return unavailable();
      let decoded: unknown;try {decoded = JSON.parse(row.data);} catch {return unavailable();}
      if (!object(decoded) || decoded.id !== row.id || decoded.projectId !== projectId) return unavailable();
      const checked = timeline(decoded, projectId);
      if (options.sourceSemantics !== false) return validateReadonly(checked);
      sources(checked);return checked;
    }
    function restored(current: unknown, text: unknown): Timeline {
      checkpoint();if (typeof text !== 'string' || Buffer.byteLength(text) > 262144) return invalid();
      let saved: unknown;try {saved = JSON.parse(text);} catch {return invalid();}
      const result = method(recovery, 'restoreTimelineEditableSnapshot')(current, saved);
      return validateReadonly(result);
    }
    function receipt(operation: string): {requestHash: string; response: string} | null {
      checkpoint();if (typeof input.requestId !== 'string') return invalid();
      const maxBytes = operation === 'timeline.render' ? 4 * 1024 * 1024 : operation === 'timeline.loudness.apply' ? 327680 : 262144;
      const row = db.prepare(`SELECT ${bounded('requestHash', 64)} AS requestHash,${bounded('response', maxBytes)} AS response FROM timeline_requests WHERE requestId=?`).get(input.requestId);
      if (!row) return null;
      if (typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash) || typeof row.response !== 'string') return invalid();
      return {requestHash: row.requestHash, response: row.response};
    }
    function replay(operation: string, text: unknown): unknown {
      checkpoint();const maxBytes = operation === 'timeline.render' ? 4 * 1024 * 1024 : operation === 'timeline.loudness.apply' ? 327680 : 262144;
      if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) return invalid();
      const saved = receipt(operation);
      if (!saved || saved.requestHash !== digest({operation, input}) || saved.response !== text) return invalid();
      let response: unknown;try {response = JSON.parse(text);} catch {return invalid();}
      // Existing42 application adds can contain opacity in both the intent
      // and their retained ACK. Only their captured task and captured receipt
      // select this read-only predicate; new43 validation stays unchanged.
      const capturedAdd = operation === 'timeline.clip.add' && capturedClipAdd(input) &&
        db.prepare("SELECT 1 FROM workspace_restore_holds WHERE kind='timeline_requests' AND id=? AND namespace='timeline' AND requestId=?").get(String(input.requestId), String(input.requestId));
      if (!(operation === 'timeline.render' ? isOpacityRenderRecord(response, input) :
        capturedAdd ? isOpacityApplicationMutationResponse(operation, input, response) : mutationResponse(operation, input, response))) return invalid();
      if (operation === 'timeline.format.set') method(format, 'readTimelineFormatProvenance')(db, input, saved.requestHash);
      const loudness = operation === 'timeline.loudness.apply';
      const render = operation === 'timeline.render';
      const current = read({sourceSemantics: !loudness && !render});
      const historical = render ? renderSources(response, true) : loudness && object(response) ? timeline(response.timeline, projectId) : validateReadonly(response);
      if (loudness) sources(historical);
      if (!current) return unavailable();
      if (current.id !== historical.id || current.revision < historical.revision) return invalid();
      if (render) {renderRecord(response);return response;}
      return loudness ? response : historical;
    }
    function renderRecord(response: unknown): Value {
      checkpoint();
      if (!object(response) || typeof response.id !== 'string') return invalid();
      const row = db.prepare(`SELECT ${identity('id')},${identity('projectId')},${bounded('data', 4 * 1024 * 1024)} AS data FROM exports WHERE id=? AND projectId=?`).get(response.id, projectId);
      let current: unknown;try {current = typeof row?.data === 'string' ? JSON.parse(row.data) : undefined;} catch {return unavailable();}
      if (!row || !object(current) || row.id !== response.id || row.projectId !== projectId || !isOpacityRenderRecord(current, input)) return unavailable();
      for (const field of ['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision']) if (current[field] !== response[field]) return invalid();
      if (JSON.stringify(current.snapshot) !== JSON.stringify(response.snapshot)) return invalid();
      if (current.assetId !== null) asset(current.assetId);
      return current;
    }
    function renderSources(response: unknown, historical = false): Timeline {
      if (!object(response) || !object(response.snapshot) || !Array.isArray(response.snapshot.assets)) return invalid();
      const checked = timeline(response.snapshot.timeline, projectId);
      if (historical) sources(checked);else validateReadonly(checked);
      for (const frozen of response.snapshot.assets) {
        if (!object(frozen)) return invalid();
        const source = asset(frozen.id);
        if (!object(source) || source.sha256 !== frozen.sha256 || source.mimeType !== frozen.mimeType ||
          own(frozen, 'relativePath') && source.relativePath !== frozen.relativePath || !historical &&
          (['duration', 'width', 'height'].some(field => own(frozen, field) && source[field] !== frozen[field]) || typeof frozen.hasAudio === 'boolean' && source.hasAudio !== frozen.hasAudio)) return unavailable();
      }
      return checked;
    }
    function verify(operation: string, response: unknown, requestHash: unknown): void {
      checkpoint();
      if (!(operation === 'timeline.render' ? isOpacityRenderRecord(response, input) : mutationResponse(operation, input, response)) || requestHash !== digest({operation, input})) return invalid();
      const current = read();if (!current) return unavailable();
      if (operation === 'timeline.render') {
        const rendered = renderSources(response);
        if (current.id !== rendered.id || JSON.stringify(renderRecord(response)) !== JSON.stringify(response)) return invalid();
      } else {
        validateReadonly(response);
        if (JSON.stringify(current) !== JSON.stringify(response)) return invalid();
      }
      const saved = receipt(operation);
      if (!saved || saved.requestHash !== requestHash || saved.response !== JSON.stringify(response)) return invalid();
    }
    return Object.freeze({read, asset, inputAsset, clipSource, version, sources, validate, validateReadonly, restored, replay, verify});
  }
  return Object.freeze({
    parse, boundary, admit, freezeRenderSnapshot, readPreflightSnapshot,
    capturePrepare: (value: unknown) => {checkpoint();return assembly.rippleRemove ? captureRippleOpacityPrepare(value,application) : application ? captureOpacityApplicationPrepare(value) : captureOpacityTimelinePrepare(value);},
    captureIntent: (operation: string, value: unknown) => {checkpoint();return captureOpacityTimelineIntent(operation, value);},
    isTask: (value: unknown) => {checkpoint();
      if (assembly.rippleRemove && object(value) && value.operation==='timeline.clip.rippleRemove') return isOpacityTimelineTask(value);
      if (application) return isOpacityApplicationTask(value);
      if (isOpacityTimelineTask(value)) return true;
      return isOpacityApplicationTask(value) && object(value) && value.operation === 'timeline.clip.add' && capturedClipAdd(value.input, value.id) !== null;
    },
    isMutationResponse: (operation: string, input: unknown, response: unknown) => {checkpoint();return operation === 'timeline.render' ? isOpacityRenderRecord(response, input) : mutationResponse(operation, input, response);},
  });
}
