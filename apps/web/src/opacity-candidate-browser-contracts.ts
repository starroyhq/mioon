/** Validation-only browser projections. These fixed checkers grant no server
 * profile or media authority; only the isolated application entry selects them. */
import {validateOpacityEnvelope} from '../../../packages/contracts/src/timeline-opacity-envelope.ts';
import {opacityCandidateTimelineProjection} from './clip-opacity-candidate-assembly.ts';
import {isOpacityRestoredApplicationInspection} from '../../../packages/contracts/src/opacity-restored-application.ts';

type Value = Record<string, unknown>;
export interface OpacityBrowserSchema {
  safeParse(value: unknown): {success: boolean; data?: unknown; error?: unknown};
  parse(value: unknown): unknown;
}
export interface OpacityBrowserLegacyContracts {
  readonly schemas: Readonly<Record<string, OpacityBrowserSchema>>;
  isTimelineRecord(value: unknown, options?: {projectId?: unknown}): boolean;
  isTimelineMutationResponse(operation: string, input: unknown, value: unknown): boolean;
  isTimelineRenderRecord(value: unknown, input: unknown): boolean;
  isEditTaskEnvelope(value: unknown): boolean;
  isEditTaskListEnvelope(value: unknown): boolean;
}
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function fail(): never {throw Object.assign(new Error('Invalid candidate application response.'), {code: 'BACKEND_PROTOCOL_ERROR'});}
function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, i) => same(item, right[i]));
  return object(left) && object(right) ? Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => own(right, key) && same(left[key], right[key])) : left === right;
}
/** The existing JS composition pins these concrete historical functions. No
 * HTTP value is accepted as a validator or application selector. */
export function createOpacityCandidateBrowserContracts(legacy: OpacityBrowserLegacyContracts) {
const {schemas: legacySchemas, isTimelineRecord: legacyTimeline, isTimelineMutationResponse: legacyMutation,
  isTimelineRenderRecord: legacyRender, isEditTaskEnvelope, isEditTaskListEnvelope} = legacy;
function isOpacityCandidateBrowserTimeline(value: unknown, options: {projectId?: unknown} = {}): boolean {
  try {
    if (!object(value) || typeof value.projectId !== 'string' || options.projectId !== undefined && value.projectId !== options.projectId) return false;
    const projected = opacityCandidateTimelineProjection(value, value.projectId);
    return projected !== null && legacyTimeline(projected, options);
  } catch {return false;}
}
function timeline(value: unknown): Value {
  if (!object(value) || !isOpacityCandidateBrowserTimeline(value)) return fail();
  const projected = opacityCandidateTimelineProjection(value, String(value.projectId));
  if (!object(projected)) return fail();
  return projected;
}
function intent(operation: string, value: unknown, sentinel = 0): Value {
  if (!object(value) || bytes(value) > 8192) return fail();
  if (operation !== 'timeline.clip.update' && operation !== 'timeline.clip.add') return value;
  const fields = operation === 'timeline.clip.update' ? value.patch : value;
  if (!object(fields)) return fail();
  const projected = {...fields};
  if (own(fields, 'opacityEnvelope')) {
    validateOpacityEnvelope(fields.opacityEnvelope, typeof fields.durationFrames === 'number' ? fields.durationFrames : 18000);
    delete projected.opacityEnvelope;
    if (operation === 'timeline.clip.update' && !Object.keys(projected).length) projected.gain = sentinel;
  }
  return operation === 'timeline.clip.update' ? {...value, patch: projected} : projected;
}
function isOpacityCandidateBrowserMutation(operation: string, input: unknown, value: unknown): boolean {
  try {
    if (operation === 'timeline.render') return isOpacityCandidateBrowserRender(value, input);
    if (!object(input) || !object(value)) return false;
    const projected = timeline(value);
    const target: unknown = Array.isArray(value.clips) ? value.clips.find((clip: unknown) => object(clip) && clip.id === input.clipId) : undefined;
    if (operation === 'timeline.clip.update' && object(input.patch) && own(input.patch, 'opacityEnvelope')) {
      if (!object(target) || !own(target, 'opacityEnvelope') || !same(target.opacityEnvelope, input.patch.opacityEnvelope)) return false;
    }
    if (operation === 'timeline.clip.add') {
      if (!Array.isArray(value.clips)) return false;
      return value.clips.some((clip: unknown) => {
        if (!object(clip) || own(clip, 'opacityEnvelope') !== own(input, 'opacityEnvelope') || own(input, 'opacityEnvelope') && !same(clip.opacityEnvelope, input.opacityEnvelope)) return false;
        const selected: Value = {...projected, clips: [{...clip}], durationFrames: Number(clip.startFrame) + Number(clip.durationFrames)};
        delete (selected.clips as Value[])[0]!.opacityEnvelope;delete selected.subtitles;
        return legacyMutation(operation, intent(operation, input), selected);
      });
    }
    return legacyMutation(operation, intent(operation, input, object(target) && typeof target.gain === 'number' ? target.gain : 0), projected);
  } catch {return false;}
}
function snapshot(value: unknown): Value {
  if (!object(value) || !object(value.timeline) || !Array.isArray(value.timeline.clips) || !Array.isArray(value.assets) || bytes(value) > 262144) return fail();
  const projectedTimeline = timeline(value.timeline), plan: Value[] = [];
  for (const clip of value.timeline.clips as unknown[]) {
    if (!object(clip) || !own(clip, 'opacityEnvelope') || clip.opacityEnvelope === null) continue;
    const asset: unknown = value.assets.find((item: unknown) => object(item) && item.id === clip.assetId);
    if (!object(asset)) return fail();
    const colours = object(value.colourPlan) && Array.isArray(value.colourPlan.clips) ? value.colourPlan.clips : [];
    plan.push({clipId: clip.id, trackId: clip.trackId, assetId: clip.assetId, assetSha256: asset.sha256,
      alphaMode: colours.some((item: unknown) => object(item) && item.clipId === clip.id && item.kind === 'image') ? 'premultiplied' : 'straight'});
  }
  const expected = plan.length ? {profileId: 'mioon-clip-opacity-render-v1', clock: 'clip-local-30fps-integer-v1',
    interpolation: 'linear-held-endpoints-v1', membership: 'half-open-v1', stage: 'post-normalize-pre-overlay-v1', clips: plan} : undefined;
  if (own(value, 'opacityPlan') !== (expected !== undefined) || expected !== undefined && !same(expected, value.opacityPlan)) return fail();
  const projected: Value = {...value, timeline: projectedTimeline};delete projected.opacityPlan;
  return projected;
}
function isOpacityCandidateBrowserRender(value: unknown, input: unknown): boolean {
  try {return object(value) && bytes(value) <= 4 * 1024 * 1024 && legacyRender({...value, snapshot: snapshot(value.snapshot)}, input);} catch {return false;}
}
function task(value: unknown, result?: unknown): Value {
  if (!object(value) || typeof value.operation !== 'string' || bytes(value) > 16384) return fail();
  let sentinel = 0;
  if (object(result) && Array.isArray(result.clips) && object(value.input)) {
    const clipId = value.input.clipId;
    const target: unknown = result.clips.find((clip: unknown) => object(clip) && clip.id === clipId);
    if (object(target) && typeof target.gain === 'number') sentinel = target.gain;
  }
  return {...value, input: intent(value.operation, value.input, sentinel)};
}
function isOpacityCandidateBrowserTaskEnvelope(value: unknown): boolean {
  try {
    if (!object(value) || !object(value.task)) return false;
    if (typeof value.task.operation !== 'string' || !value.task.operation.startsWith('timeline.')) return isEditTaskEnvelope(value);
    const projected: Value = {...value, task: task(value.task, value.result)};
    if (own(value, 'result')) {
      if (typeof value.task.operation !== 'string' || !isOpacityCandidateBrowserMutation(value.task.operation, value.task.input, value.result)) return false;
      projected.result = timeline(value.result);
    }
    return isEditTaskEnvelope(projected);
  } catch {return false;}
}
function isOpacityCandidateBrowserTaskList(value: unknown): boolean {
  try {return object(value) && Array.isArray(value.items) && isEditTaskListEnvelope({...value, items: value.items.map(item => task(item))});} catch {return false;}
}
const candidateSchemas: Record<string, OpacityBrowserSchema> = {...legacySchemas};
for (const operation of ['timeline.clip.update', 'timeline.clip.add'] as const) {
  const old = legacySchemas[operation];
  if (!old) return fail();
  const parse = old.safeParse.bind(old);
  const safeParse = (value: unknown) => {
    try {const result = parse(intent(operation, value));return result.success ? {success: true as const, data: value} : result;} catch {return {success: false as const, error: parse({}).error};}
  };
  candidateSchemas[operation] = Object.freeze({safeParse, parse(value: unknown) {if (!safeParse(value).success) return fail();return value;}});
}
const opacityCandidateBrowserSchemas = Object.freeze(candidateSchemas);
/** Project data is kept raw. Only timeline and timeline export values use
 * the checked projection; every original old field remains legacy-validated. */
function isWorkspaceInspection(value: unknown): boolean {
  // The ordinary42 application discloses only this fixed object. Historical
  // profiles and optional audio/volume grants remain with the legacy entry.
  return object(value) && Object.keys(value).length === 1 && value.restored === false || isOpacityRestoredApplicationInspection(value);
}
function validateOpacityCandidateProjectSnapshot(value: unknown, projectId?: unknown, workspace?: unknown): boolean {
  try {
    if (!object(value) || !object(value.project) || typeof value.project.id !== 'string' || projectId !== undefined && value.project.id !== projectId) return false;
    const owner = value.project.id;
    if (value.timeline !== null && value.timeline !== undefined && !isOpacityCandidateBrowserTimeline(value.timeline, {projectId: value.project.id})) return false;
    if (!Array.isArray(value.exports) || value.exports.some(item => !object(item) || typeof item.id !== 'string' || item.projectId !== owner) ||
        new Set(value.exports.map(item => (item as Value).id)).size !== value.exports.length) return false;
    if (isOpacityRestoredApplicationInspection(workspace)) {
      if (!object(workspace) || !object(value.restore) || Object.keys(value.restore).sort().join(',') !== 'heldExportIds,workspaceOrigin' ||
          value.restore.workspaceOrigin !== workspace.workspaceOrigin || !Array.isArray(value.restore.heldExportIds) || value.restore.heldExportIds.length > 20000 ||
          new Set(value.restore.heldExportIds).size !== value.restore.heldExportIds.length ||
          value.restore.heldExportIds.some((id: unknown) => typeof id !== 'string' || !(value.exports as unknown[]).some(item => object(item) && item.id === id && item.projectId === owner))) return false;
    } else if (own(value, 'restore')) return false;
    return value.exports.every((item: unknown) => {
      if (!object(item) || item.mode !== 'timeline') return true;
      if (!object(item.snapshot) || !object(item.snapshot.timeline)) return false;
      const input: Value = {projectId: item.projectId, requestId: item.requestId, expectedRevision: item.timelineRevision, purpose: item.purpose};
      for (const field of ['deliveryName', 'exportRange']) if (own(item.snapshot, field)) input[field] = item.snapshot[field];
      if (object(item.snapshot.delivery)) input.exportSettings = item.snapshot.delivery.exportSettings;
      return isOpacityCandidateBrowserRender(item, input);
    });
  } catch {return false;}
}
return Object.freeze({schemas: opacityCandidateBrowserSchemas, isTimelineRecord: isOpacityCandidateBrowserTimeline,
  isTimelineMutationResponse: isOpacityCandidateBrowserMutation, isTimelineRenderRecord: isOpacityCandidateBrowserRender,
  isTaskEnvelope: isOpacityCandidateBrowserTaskEnvelope, isTaskList: isOpacityCandidateBrowserTaskList,
  isWorkspaceInspection, isRestoredWorkspace: isOpacityRestoredApplicationInspection,
  validateProjectSnapshot: validateOpacityCandidateProjectSnapshot});
}
