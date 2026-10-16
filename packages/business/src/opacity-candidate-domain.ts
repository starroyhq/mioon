/** Store-bound candidate reads and validation. Writes, history and receipts are
 * still performed only by the existing timeline transaction implementation. */
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {
  captureOpacityTimelineRecord, captureOpacityTimelineIntent, captureOpacityTimelinePrepare,
  isOpacityTimelineMutationResponse, isOpacityTimelineTask,
} from '../../contracts/src/timeline-opacity-persistence.ts';
import {getOpacityCandidateAssembly} from './opacity-candidate-store.ts';

type Value = Record<string, unknown>;
type Method = (...args: unknown[]) => unknown;
interface Graph {asset(id: unknown): unknown; clipSource(clip: unknown): unknown; version(id: unknown, shotId?: unknown, assetId?: unknown): unknown}
interface Timeline extends Value {id: string; projectId: string; revision: number; createdAt: string; updatedAt: string; durationFrames: number; tracks: Value[]; clips: Value[]}
const require = createRequire(import.meta.url);
// Literal fixed dependencies, never selected by caller, RPC or stored data.
const inspection: unknown = require('./inspection.mjs');
const inputs: unknown = require('./timeline-inputs.mjs');
const recovery: unknown = require('./timeline-recovery.mjs');
const colour: unknown = require('./timeline-colour-business.ts');
const format: unknown = require('./timeline-format-receipts.mjs');
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
  const checkpoint = (): void => {
    boundAssembly.checkpoint();
    if (getOpacityCandidateAssembly(store) !== boundAssembly || !boundAssembly.ownsLock()) throw new AppError('EDIT_TASK_OWNER_REQUIRED', '只有持有工作区锁的后端可以修改编辑任务。', 403);
  };
  const parse = (operation: string, input: unknown): Value => {checkpoint();return captureOpacityTimelineIntent(operation, input).input;};
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
      const maxBytes = operation === 'timeline.loudness.apply' ? 327680 : 262144;
      const row = db.prepare(`SELECT ${bounded('requestHash', 64)} AS requestHash,${bounded('response', maxBytes)} AS response FROM timeline_requests WHERE requestId=?`).get(input.requestId);
      if (!row) return null;
      if (typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash) || typeof row.response !== 'string') return invalid();
      return {requestHash: row.requestHash, response: row.response};
    }
    function replay(operation: string, text: unknown): unknown {
      checkpoint();const maxBytes = operation === 'timeline.loudness.apply' ? 327680 : 262144;
      if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) return invalid();
      const saved = receipt(operation);
      if (!saved || saved.requestHash !== digest({operation, input}) || saved.response !== text) return invalid();
      let response: unknown;try {response = JSON.parse(text);} catch {return invalid();}
      if (!isOpacityTimelineMutationResponse(operation, input, response)) return invalid();
      if (operation === 'timeline.format.set') method(format, 'readTimelineFormatProvenance')(db, input, saved.requestHash);
      const loudness = operation === 'timeline.loudness.apply';
      const current = read({sourceSemantics: !loudness});
      const historical = loudness && object(response) ? timeline(response.timeline, projectId) : validateReadonly(response);
      if (loudness) sources(historical);
      if (!current) return unavailable();
      if (current.id !== historical.id || current.revision < historical.revision) return invalid();
      return loudness ? response : historical;
    }
    function verify(operation: string, response: unknown, requestHash: unknown): void {
      checkpoint();
      if (!isOpacityTimelineMutationResponse(operation, input, response) || requestHash !== digest({operation, input})) return invalid();
      const current = read();if (!current) return unavailable();
      validateReadonly(response);
      if (JSON.stringify(current) !== JSON.stringify(response)) return invalid();
      const saved = receipt(operation);
      if (!saved || saved.requestHash !== requestHash || saved.response !== JSON.stringify(response)) return invalid();
    }
    return Object.freeze({read, asset, inputAsset, clipSource, version, sources, validate, validateReadonly, restored, replay, verify});
  }
  return Object.freeze({
    parse, boundary, admit,
    capturePrepare: (value: unknown) => {checkpoint();return captureOpacityTimelinePrepare(value);},
    captureIntent: (operation: string, value: unknown) => {checkpoint();return captureOpacityTimelineIntent(operation, value);},
    isTask: (value: unknown) => {checkpoint();return isOpacityTimelineTask(value);},
    isMutationResponse: (operation: string, input: unknown, response: unknown) => {checkpoint();return isOpacityTimelineMutationResponse(operation, input, response);},
  });
}
