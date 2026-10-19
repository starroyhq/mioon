import {isTimelineRecord} from './timeline-replacement.ts';
import {timelineOutputPreset} from './timeline-format.ts';
import {hasRequestNotAppliedProof} from './timeline-acknowledgement.ts';

// A closed Agent review contract, not a new mutation operation. Saved media
// ownership and receipt authenticity are checked inside the backend transaction.
export const AGENT_TIMELINE_MOVE_CONTEXT = 'selected_timeline_clip_move';
export const AGENT_TIMELINE_MOVE_PROVENANCE = 'project_selected_timeline_timing';
export const AGENT_TIMELINE_MOVE_LIMITS = Object.freeze({maxEndFrame: 18000, maxOccupiedIntervals: 99,
  targetBytes: 16 * 1024, proposalBytes: 16 * 1024});
const encoder = new TextEncoder();
const integer = (value, min = 0, max = 18000) => Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const text = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && value.isWellFormed();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = value => text(value, 30) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const callId = value => text(value, 256) && encoder.encode(value).byteLength <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const withinBytes = (value, max) => encoder.encode(JSON.stringify(value)).byteLength <= max;

// Inspect descriptors before reading values or serializing: reject getters,
// non-JSON values, hidden/symbol fields, sparse/extended arrays and deep trees.
// This is only a bounded data guard; the canonical clip schema remains below.
function boundedData(value, budget = 1200) {
  const ancestors = new Set();
  function visit(item, depth) {
    if (--budget < 0 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 4096 && item.isWellFormed();
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype || item.length > 100 : !object(item)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    if (array ? keys.length !== item.length + 1 : keys.length > 32) return false;
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || descriptor.get || descriptor.set || !descriptor.enumerable ||
          array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length) || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item); return true;
  }
  try { return visit(value, 0); } catch { return false; }
}

const targetFields = ['projectId', 'timelineId', 'expectedRevision', 'fps', 'width', 'height', 'durationFrames',
  'clip', 'track', 'occupiedIntervals', 'remainingTimelineEndFrame', 'subtitleEndFrame'];
const publicFields = ['projectId', 'timelineId', 'clipId', 'trackId', 'expectedRevision', 'clipName', 'trackName', 'trackKind', 'fps', 'width', 'height'];
const reviewFields = ['startFrame', 'endFrame', 'durationFrames', 'timelineDurationFrames', 'occupiedIntervals'];
const timingFields = ['startFrame', 'endFrame', 'durationFrames', 'timelineDurationFrames'];
function intervalsValid(value, startFrame, endFrame, remainingEnd) {
  if (!Array.isArray(value) || value.length > AGENT_TIMELINE_MOVE_LIMITS.maxOccupiedIntervals) return false;
  let previousEnd = 0;
  for (const interval of value) {
    if (!exact(interval, ['startFrame', 'endFrame']) || !integer(interval.startFrame) || !integer(interval.endFrame, 1) ||
        interval.startFrame >= interval.endFrame || interval.startFrame < previousEnd || interval.endFrame > remainingEnd ||
        interval.startFrame < endFrame && interval.endFrame > startFrame) return false;
    previousEnd = interval.endFrame;
  }
  return true;
}

export function isAgentTimelineMoveArguments(value) {
  return boundedData(value) && exact(value, ['startFrame']) && integer(value.startFrame);
}

export function isAgentTimelineMoveTarget(value, {projectId} = {}) {
  if (!boundedData(value) || !exact(value, targetFields) || !uuid(value.projectId) || !uuid(value.timelineId) ||
      projectId !== undefined && value.projectId !== projectId || !integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
      !timelineOutputPreset(value) || !object(value.clip) || !object(value.track) ||
      !integer(value.durationFrames, 1) || !integer(value.remainingTimelineEndFrame) || !integer(value.subtitleEndFrame) ||
      value.subtitleEndFrame > value.durationFrames) return false;
  const endFrame = value.clip.startFrame + value.clip.durationFrames;
  // The existing validator owns all selected clip, optional provenance, fades,
  // rectangle, track and format rules. Synthetic aggregate-only fields are not
  // retained; source objects are passed through unchanged and never normalized.
  const mini = {id: value.timelineId, projectId: value.projectId, revision: value.expectedRevision,
    fps: value.fps, width: value.width, height: value.height, tracks: [value.track], clips: [value.clip],
    durationFrames: endFrame, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z'};
  return isTimelineRecord(mini, {projectId: value.projectId}) &&
    value.durationFrames === Math.max(endFrame, value.remainingTimelineEndFrame) &&
    intervalsValid(value.occupiedIntervals, value.clip.startFrame, endFrame, value.remainingTimelineEndFrame) &&
    withinBytes(value, AGENT_TIMELINE_MOVE_LIMITS.targetBytes);
}

/** Read-only projection from an already saved complete timeline. This does not
 * pin ownership or authorize sending: the server resolves the selection again. */
export function agentTimelineMoveTargetFromTimeline(timeline, clipId) {
  if (!boundedData(timeline, 12000) || !uuid(clipId) || !isTimelineRecord(timeline)) return null;
  const clip = timeline.clips.find(item => item.id === clipId);
  if (!clip) return null;
  const track = timeline.tracks.find(item => item.id === clip.trackId), other = timeline.clips.filter(item => item.id !== clipId);
  const target = {projectId: timeline.projectId, timelineId: timeline.id, expectedRevision: timeline.revision,
    fps: timeline.fps, width: timeline.width, height: timeline.height, durationFrames: timeline.durationFrames,
    clip, track, occupiedIntervals: other.filter(item => item.trackId === clip.trackId)
      .map(item => ({startFrame: item.startFrame, endFrame: item.startFrame + item.durationFrames})).sort((a, b) => a.startFrame - b.startFrame),
    remainingTimelineEndFrame: Math.max(0, ...other.map(item => item.startFrame + item.durationFrames)),
    subtitleEndFrame: Math.max(0, ...(timeline.subtitles?.cues ?? []).map(item => item.startFrame + item.durationFrames))};
  return isAgentTimelineMoveTarget(target) ? structuredClone(target) : null;
}

function publicTargetValid(value, projectId) {
  return uuid(value.projectId) && (projectId === undefined || value.projectId === projectId) && uuid(value.timelineId) &&
    uuid(value.clipId) && uuid(value.trackId) && integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) &&
    text(value.clipName, 200) && text(value.trackName, 150) && ['video', 'audio'].includes(value.trackKind) && Boolean(timelineOutputPreset(value));
}
export function isAgentTimelineMovePublicTarget(value, {projectId} = {}) {
  return boundedData(value) && exact(value, publicFields) && publicTargetValid(value, projectId);
}
export function agentTimelineMovePublicTarget(target) {
  if (!isAgentTimelineMoveTarget(target)) return null;
  return {projectId: target.projectId, timelineId: target.timelineId, clipId: target.clip.id, trackId: target.track.id,
    expectedRevision: target.expectedRevision, clipName: target.clip.name, trackName: target.track.name,
    trackKind: target.track.kind, fps: target.fps, width: target.width, height: target.height};
}
function timingValid(value) {
  return integer(value.startFrame) && integer(value.endFrame, 1) && integer(value.durationFrames, 1) &&
    value.endFrame === value.startFrame + value.durationFrames && integer(value.timelineDurationFrames, value.endFrame);
}
export function isAgentTimelineMoveReviewTarget(value, {projectId} = {}) {
  return boundedData(value) && exact(value, [...publicFields, ...reviewFields]) && publicTargetValid(value, projectId) && timingValid(value) &&
    intervalsValid(value.occupiedIntervals, value.startFrame, value.endFrame, value.timelineDurationFrames);
}
export function agentTimelineMoveReviewTarget(target) {
  const publicTarget = agentTimelineMovePublicTarget(target);
  return publicTarget && {...publicTarget, startFrame: target.clip.startFrame, endFrame: target.clip.startFrame + target.clip.durationFrames,
    durationFrames: target.clip.durationFrames, timelineDurationFrames: target.durationFrames, occupiedIntervals: structuredClone(target.occupiedIntervals)};
}

export function agentTimelineMoveModelContext(target) {
  if (!isAgentTimelineMoveTarget(target)) return null;
  // Construct each field explicitly. Never spread a saved clip, source, target,
  // subtitle or unrelated track into anything sent to a model.
  return {clip: {name: target.clip.name, startFrame: target.clip.startFrame, durationFrames: target.clip.durationFrames,
    endFrame: target.clip.startFrame + target.clip.durationFrames}, track: {name: target.track.name, kind: target.track.kind},
    fps: target.fps, occupiedIntervals: target.occupiedIntervals.map(({startFrame, endFrame}) => ({startFrame, endFrame})), maxEndFrame: 18000};
}

export function agentTimelineMoveDiff(target, changes) {
  if (!isAgentTimelineMoveTarget(target) || !isAgentTimelineMoveArguments(changes)) return null;
  const startFrame = changes.startFrame, endFrame = startFrame + target.clip.durationFrames;
  const timelineDurationFrames = Math.max(endFrame, target.remainingTimelineEndFrame);
  if (startFrame === target.clip.startFrame || endFrame > 18000 || timelineDurationFrames < target.subtitleEndFrame ||
      target.occupiedIntervals.some(item => item.startFrame < endFrame && item.endFrame > startFrame)) return null;
  return {before: {startFrame: target.clip.startFrame, endFrame: target.clip.startFrame + target.clip.durationFrames,
    durationFrames: target.clip.durationFrames, timelineDurationFrames: target.durationFrames},
  after: {startFrame, endFrame, durationFrames: target.clip.durationFrames, timelineDurationFrames}};
}

const statuses = ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled'];
const runStatuses = ['running', 'completed', 'stopped', 'failed', 'interrupted'];
const proposalFields = ['id', 'projectId', 'runId', 'runStatus', 'digest', 'status', 'operation', 'target', 'patch', 'diff', 'provenance', 'createdAt', 'updatedAt'];
export function isAgentTimelineMoveProposal(value, {projectId} = {}) {
  if (!boundedData(value) || !exact(value, proposalFields, ['approval', 'outcome']) || !uuid(value.id) || !uuid(value.runId) ||
      !hash(value.digest) || !statuses.includes(value.status) || !runStatuses.includes(value.runStatus) ||
      value.operation !== 'timeline.clip.update' || !isAgentTimelineMovePublicTarget(value.target, {projectId: value.projectId}) ||
      projectId !== undefined && value.projectId !== projectId || !isAgentTimelineMoveArguments(value.patch) ||
      !exact(value.diff, ['before', 'after']) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return false;
  const {before, after} = value.diff;
  if (![before, after].every(item => exact(item, timingFields) && timingValid(item)) ||
      before.startFrame === after.startFrame || before.durationFrames !== after.durationFrames || after.startFrame !== value.patch.startFrame) return false;
  // Public review has no other-track data. Validate that a single unchanged
  // remaining-media endpoint could produce both totals, without inventing it.
  const remainingEnd = Math.min(before.timelineDurationFrames, after.timelineDurationFrames);
  if (Math.max(before.endFrame, remainingEnd) !== before.timelineDurationFrames ||
      Math.max(after.endFrame, remainingEnd) !== after.timelineDurationFrames) return false;
  if (!exact(value.provenance, ['runId', 'toolCallId', 'toolName']) || value.provenance.runId !== value.runId ||
      value.provenance.toolName !== 'mioon_propose_timeline_clip_move' || !callId(value.provenance.toolCallId)) return false;
  const unapproved = ['pending', 'rejected', 'cancelled'].includes(value.status), terminal = ['applied', 'failed'].includes(value.status);
  if (unapproved !== !Object.hasOwn(value, 'approval') || terminal !== Object.hasOwn(value, 'outcome') ||
      !unapproved && value.runStatus !== 'completed') return false;
  if (!unapproved && (!exact(value.approval, ['approvedAt', 'requestId']) || !timestamp(value.approval.approvedAt) || !uuid(value.approval.requestId))) return false;
  if (value.status === 'applied' && (!exact(value.outcome, ['status', 'timelineId', 'clipId', 'revision']) ||
      value.outcome.status !== 'applied' || value.outcome.timelineId !== value.target.timelineId ||
      value.outcome.clipId !== value.target.clipId || value.outcome.revision !== value.target.expectedRevision + 1)) return false;
  if (value.status === 'failed') {
    if (!exact(value.outcome, ['status', 'code']) || value.outcome.status !== 'not_applied' || !text(value.outcome.code, 100)) return false;
    // Reuse only the shared code vocabulary. This synthesized shape is NOT an
    // application proof; only the backend's original transaction proof can
    // authorize this DTO status. Browser validation does not release a key.
    const input = {projectId: value.projectId, expectedRevision: value.target.expectedRevision,
      clipId: value.target.clipId, requestId: value.approval.requestId, patch: value.patch};
    if (!hasRequestNotAppliedProof({code: value.outcome.code, status: 409,
      details: {mutationOutcome: 'not_applied', requestId: input.requestId}}, input, {operation: value.operation})) return false;
  }
  return withinBytes(value, AGENT_TIMELINE_MOVE_LIMITS.proposalBytes);
}
