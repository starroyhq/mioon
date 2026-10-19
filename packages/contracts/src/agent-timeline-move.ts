import {isTimelineRecord, type TimelineRecord, type TimelineClipRecord, type TimelineTrackRecord} from './timeline-replacement.ts';
import {timelineOutputPreset} from './timeline-format.ts';
import {hasRequestNotAppliedProof} from './timeline-acknowledgement.ts';

type Rec = Record<string, unknown>;
// A closed Agent review contract, not a new mutation operation. Saved media
// ownership and receipt authenticity are checked inside the backend transaction.
export const AGENT_TIMELINE_MOVE_CONTEXT = 'selected_timeline_clip_move';
export const AGENT_TIMELINE_MOVE_PROVENANCE = 'project_selected_timeline_timing';
export const AGENT_TIMELINE_MOVE_LIMITS = Object.freeze({maxEndFrame: 18000, maxOccupiedIntervals: 99,
  targetBytes: 16 * 1024, proposalBytes: 16 * 1024});
export interface AgentTimelineMoveInterval {startFrame: number; endFrame: number}
export interface AgentTimelineMoveArguments {startFrame: number}
export interface AgentTimelineMoveTarget {
  projectId: string; timelineId: string; expectedRevision: number; fps: number; width: number; height: number;
  durationFrames: number; clip: TimelineClipRecord; track: TimelineTrackRecord;
  occupiedIntervals: AgentTimelineMoveInterval[]; remainingTimelineEndFrame: number; subtitleEndFrame: number;
}
export interface AgentTimelineMoveTiming {startFrame: number; endFrame: number; durationFrames: number; timelineDurationFrames: number}
export interface AgentTimelineMovePublicTarget {
  projectId: string; timelineId: string; clipId: string; trackId: string; expectedRevision: number;
  clipName: string; trackName: string; trackKind: 'video' | 'audio'; fps: number; width: number; height: number;
}
export interface AgentTimelineMoveReviewTarget extends AgentTimelineMovePublicTarget, AgentTimelineMoveTiming {
  occupiedIntervals: AgentTimelineMoveInterval[];
}
export interface AgentTimelineMoveModelContext {
  clip: {name: string; startFrame: number; durationFrames: number; endFrame: number};
  track: {name: string; kind: 'video' | 'audio'};
  fps: number;
  occupiedIntervals: AgentTimelineMoveInterval[];
  maxEndFrame: number;
}
export interface AgentTimelineMoveDiff {before: AgentTimelineMoveTiming; after: AgentTimelineMoveTiming}
export interface AgentTimelineMoveProvenance {runId: string; toolCallId: string; toolName: string}
export interface AgentTimelineMoveApproval {approvedAt: string; requestId: string}
export type AgentTimelineMoveOutcome =
  | {status: 'applied'; timelineId: string; clipId: string; revision: number}
  | {status: 'not_applied'; code: string};
export interface AgentTimelineMoveProposal {
  id: string; projectId: string; runId: string; runStatus: string; digest: string; status: string;
  operation: 'timeline.clip.update'; target: AgentTimelineMovePublicTarget; patch: AgentTimelineMoveArguments;
  diff: AgentTimelineMoveDiff; provenance: AgentTimelineMoveProvenance; createdAt: string; updatedAt: string;
  approval?: AgentTimelineMoveApproval; outcome?: AgentTimelineMoveOutcome;
}
export interface AgentTimelineMoveOptions {projectId?: unknown}

const encoder = new TextEncoder();
const integer = (value: unknown, min = 0, max = 18000): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && (value as unknown as {isWellFormed(): boolean}).isWellFormed();
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Rec => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = (value: unknown): value is string => text(value, 30) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const callId = (value: unknown): value is string => text(value, 256) && encoder.encode(value).byteLength <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const withinBytes = (value: unknown, max: number): boolean => encoder.encode(JSON.stringify(value)).byteLength <= max;

// Inspect descriptors before reading values or serializing: reject getters,
// non-JSON values, hidden/symbol fields, sparse/extended arrays and deep trees.
// This is only a bounded data guard; the canonical clip schema remains below.
function boundedData(value: unknown, budget = 1200): boolean {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (--budget < 0 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 4096 && (item as unknown as {isWellFormed(): boolean}).isWellFormed();
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype || item.length > 100 : !object(item)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    if (array ? keys.length !== item.length + 1 : keys.length > 32) return false;
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
      if (typeof key !== 'string' || !descriptor || descriptor.get || descriptor.set || !descriptor.enumerable ||
          array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= (item as unknown[]).length) || !visit(descriptor.value, depth + 1)) return false;
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
function intervalsValid(value: unknown, startFrame: unknown, endFrame: unknown, remainingEnd: unknown): boolean {
  if (!Array.isArray(value) || value.length > AGENT_TIMELINE_MOVE_LIMITS.maxOccupiedIntervals) return false;
  const start = startFrame as number, end = endFrame as number, remaining = remainingEnd as number;
  let previousEnd = 0;
  for (const interval of value) {
    if (!exact(interval, ['startFrame', 'endFrame']) || !integer(interval.startFrame) || !integer(interval.endFrame, 1) ||
        interval.startFrame >= interval.endFrame || interval.startFrame < previousEnd || interval.endFrame > remaining ||
        interval.startFrame < end && interval.endFrame > start) return false;
    previousEnd = interval.endFrame;
  }
  return true;
}

export function isAgentTimelineMoveArguments(value: unknown): value is AgentTimelineMoveArguments {
  return boundedData(value) && exact(value, ['startFrame']) && integer(value.startFrame);
}

export function isAgentTimelineMoveTarget(value: unknown, {projectId}: AgentTimelineMoveOptions = {}): value is AgentTimelineMoveTarget {
  if (!boundedData(value) || !exact(value, targetFields) || !uuid(value.projectId) || !uuid(value.timelineId) ||
      projectId !== undefined && value.projectId !== projectId || !integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
      !timelineOutputPreset(value) || !object(value.clip) || !object(value.track) ||
      !integer(value.durationFrames, 1) || !integer(value.remainingTimelineEndFrame) || !integer(value.subtitleEndFrame) ||
      value.subtitleEndFrame > value.durationFrames) return false;
  const target = value as unknown as AgentTimelineMoveTarget;
  const endFrame = target.clip.startFrame + target.clip.durationFrames;
  // The existing validator owns all selected clip, optional provenance, fades,
  // rectangle, track and format rules. Synthetic aggregate-only fields are not
  // retained; source objects are passed through unchanged and never normalized.
  const mini: TimelineRecord = {id: target.timelineId, projectId: target.projectId, revision: target.expectedRevision,
    fps: target.fps, width: target.width, height: target.height, tracks: [target.track], clips: [target.clip],
    durationFrames: endFrame, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z'};
  return isTimelineRecord(mini, {projectId: target.projectId}) &&
    target.durationFrames === Math.max(endFrame, target.remainingTimelineEndFrame) &&
    intervalsValid(target.occupiedIntervals, target.clip.startFrame, endFrame, target.remainingTimelineEndFrame) &&
    withinBytes(value, AGENT_TIMELINE_MOVE_LIMITS.targetBytes);
}

/** Read-only projection from an already saved complete timeline. This does not
 * pin ownership or authorize sending: the server resolves the selection again. */
export function agentTimelineMoveTargetFromTimeline(timeline: unknown, clipId: unknown): AgentTimelineMoveTarget | null {
  if (!boundedData(timeline, 12000) || !uuid(clipId) || !isTimelineRecord(timeline)) return null;
  const clip = timeline.clips.find(item => item.id === clipId);
  if (!clip) return null;
  const track = timeline.tracks.find(item => item.id === clip.trackId), other = timeline.clips.filter(item => item.id !== clipId);
  const subtitles = timeline.subtitles as {cues?: {startFrame: number; durationFrames: number}[]} | null | undefined;
  const target: AgentTimelineMoveTarget = {projectId: timeline.projectId, timelineId: timeline.id, expectedRevision: timeline.revision,
    fps: timeline.fps, width: timeline.width, height: timeline.height, durationFrames: timeline.durationFrames,
    clip, track: track as TimelineTrackRecord, occupiedIntervals: other.filter(item => item.trackId === clip.trackId)
      .map(item => ({startFrame: item.startFrame, endFrame: item.startFrame + item.durationFrames})).sort((a, b) => a.startFrame - b.startFrame),
    remainingTimelineEndFrame: Math.max(0, ...other.map(item => item.startFrame + item.durationFrames)),
    subtitleEndFrame: Math.max(0, ...(subtitles?.cues ?? []).map(item => item.startFrame + item.durationFrames))};
  return isAgentTimelineMoveTarget(target) ? structuredClone(target) : null;
}

function publicTargetValid(value: Rec, projectId: unknown): boolean {
  return uuid(value.projectId) && (projectId === undefined || value.projectId === projectId) && uuid(value.timelineId) &&
    uuid(value.clipId) && uuid(value.trackId) && integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) &&
    text(value.clipName, 200) && text(value.trackName, 150) && ['video', 'audio'].includes(value.trackKind as string) && Boolean(timelineOutputPreset(value));
}
export function isAgentTimelineMovePublicTarget(value: unknown, {projectId}: AgentTimelineMoveOptions = {}): value is AgentTimelineMovePublicTarget {
  return boundedData(value) && exact(value, publicFields) && publicTargetValid(value, projectId);
}
export function agentTimelineMovePublicTarget(target: unknown): AgentTimelineMovePublicTarget | null {
  if (!isAgentTimelineMoveTarget(target)) return null;
  return {projectId: target.projectId, timelineId: target.timelineId, clipId: target.clip.id, trackId: target.track.id,
    expectedRevision: target.expectedRevision, clipName: target.clip.name, trackName: target.track.name,
    trackKind: target.track.kind, fps: target.fps, width: target.width, height: target.height};
}
function timingValid(value: Rec): boolean {
  const timing = value as Partial<AgentTimelineMoveTiming>;
  return integer(timing.startFrame) && integer(timing.endFrame, 1) && integer(timing.durationFrames, 1) &&
    timing.endFrame === timing.startFrame! + timing.durationFrames! && integer(timing.timelineDurationFrames, timing.endFrame);
}
export function isAgentTimelineMoveReviewTarget(value: unknown, {projectId}: AgentTimelineMoveOptions = {}): value is AgentTimelineMoveReviewTarget {
  if (!boundedData(value) || !exact(value, [...publicFields, ...reviewFields]) || !publicTargetValid(value, projectId) || !timingValid(value)) return false;
  return intervalsValid(value.occupiedIntervals, value.startFrame, value.endFrame, value.timelineDurationFrames);
}
export function agentTimelineMoveReviewTarget(target: unknown): AgentTimelineMoveReviewTarget | null {
  const publicTarget = agentTimelineMovePublicTarget(target);
  if (!publicTarget || !isAgentTimelineMoveTarget(target)) return null;
  return {...publicTarget, startFrame: target.clip.startFrame, endFrame: target.clip.startFrame + target.clip.durationFrames,
    durationFrames: target.clip.durationFrames, timelineDurationFrames: target.durationFrames, occupiedIntervals: structuredClone(target.occupiedIntervals)};
}

export function agentTimelineMoveModelContext(target: unknown): AgentTimelineMoveModelContext | null {
  if (!isAgentTimelineMoveTarget(target)) return null;
  // Construct each field explicitly. Never spread a saved clip, source, target,
  // subtitle or unrelated track into anything sent to a model.
  return {clip: {name: target.clip.name, startFrame: target.clip.startFrame, durationFrames: target.clip.durationFrames,
    endFrame: target.clip.startFrame + target.clip.durationFrames}, track: {name: target.track.name, kind: target.track.kind},
    fps: target.fps, occupiedIntervals: target.occupiedIntervals.map(({startFrame, endFrame}) => ({startFrame, endFrame})), maxEndFrame: 18000};
}

export function agentTimelineMoveDiff(target: unknown, changes: unknown): AgentTimelineMoveDiff | null {
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
export function isAgentTimelineMoveProposal(value: unknown, {projectId}: AgentTimelineMoveOptions = {}): value is AgentTimelineMoveProposal {
  if (!boundedData(value) || !exact(value, proposalFields, ['approval', 'outcome']) || !uuid(value.id) || !uuid(value.runId) ||
      !hash(value.digest) || !statuses.includes(value.status as string) || !runStatuses.includes(value.runStatus as string) ||
      value.operation !== 'timeline.clip.update' || !isAgentTimelineMovePublicTarget(value.target, {projectId: value.projectId}) ||
      projectId !== undefined && value.projectId !== projectId || !isAgentTimelineMoveArguments(value.patch) ||
      !exact(value.diff, ['before', 'after']) || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) return false;
  const proposal = value as unknown as Rec;
  const diff = proposal.diff as Rec;
  const before = diff.before as Rec, after = diff.after as Rec;
  if (![before, after].every(item => exact(item, timingFields) && timingValid(item)) ||
      before.startFrame === after.startFrame || before.durationFrames !== after.durationFrames || after.startFrame !== (proposal.patch as Rec).startFrame) return false;
  // Public review has no other-track data. Validate that a single unchanged
  // remaining-media endpoint could produce both totals, without inventing it.
  const remainingEnd = Math.min(before.timelineDurationFrames as number, after.timelineDurationFrames as number);
  if (Math.max(before.endFrame as number, remainingEnd) !== before.timelineDurationFrames ||
      Math.max(after.endFrame as number, remainingEnd) !== after.timelineDurationFrames) return false;
  const provenance = proposal.provenance as Rec;
  if (!exact(provenance, ['runId', 'toolCallId', 'toolName']) || provenance.runId !== proposal.runId ||
      provenance.toolName !== 'mioon_propose_timeline_clip_move' || !callId(provenance.toolCallId)) return false;
  const unapproved = ['pending', 'rejected', 'cancelled'].includes(proposal.status as string), terminal = ['applied', 'failed'].includes(proposal.status as string);
  if (unapproved !== !Object.hasOwn(proposal, 'approval') || terminal !== Object.hasOwn(proposal, 'outcome') ||
      !unapproved && proposal.runStatus !== 'completed') return false;
  const approval = proposal.approval as Rec;
  if (!unapproved && (!exact(approval, ['approvedAt', 'requestId']) || !timestamp(approval.approvedAt) || !uuid(approval.requestId))) return false;
  const outcome = proposal.outcome as Rec;
  if (proposal.status === 'applied' && (!exact(outcome, ['status', 'timelineId', 'clipId', 'revision']) ||
      outcome.status !== 'applied' || outcome.timelineId !== (proposal.target as Rec).timelineId ||
      outcome.clipId !== (proposal.target as Rec).clipId || outcome.revision !== ((proposal.target as Rec).expectedRevision as number) + 1)) return false;
  if (proposal.status === 'failed') {
    if (!exact(outcome, ['status', 'code']) || outcome.status !== 'not_applied' || !text(outcome.code, 100)) return false;
    // Reuse only the shared code vocabulary. This synthesized shape is NOT an
    // application proof; only the backend's original transaction proof can
    // authorize this DTO status. Browser validation does not release a key.
    const input = {projectId: proposal.projectId, expectedRevision: (proposal.target as Rec).expectedRevision,
      clipId: (proposal.target as Rec).clipId, requestId: approval.requestId, patch: proposal.patch};
    if (!hasRequestNotAppliedProof({code: outcome.code, status: 409,
      details: {mutationOutcome: 'not_applied', requestId: input.requestId}}, input, {operation: proposal.operation as string})) return false;
  }
  return withinBytes(value, AGENT_TIMELINE_MOVE_LIMITS.proposalBytes);
}
