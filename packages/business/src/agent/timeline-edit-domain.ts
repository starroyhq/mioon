import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {AppError, isAgentTimelineMoveTarget, isAgentTimelineMoveArguments, agentTimelineMoveTargetFromTimeline, agentTimelineMoveDiff, isAgentTimelineGainTarget, isAgentTimelineGainArguments, agentTimelineGainTargetFromTimeline, agentTimelineGainDiff, isTimelineMutationResponse} from '@mioon/contracts';
import type {AgentTimelineMoveTarget, AgentTimelineMoveArguments} from '@mioon/contracts';
import {createTimelineRecoveryBoundary, readTimelineReceipt, invalidTimeline} from '../timeline-recovery.ts';
import type {TimelineRecord, TimelineClipRecord} from '../timeline-inputs.ts';
import {createAgentTimelineGainDomain} from './timeline-gain-domain.ts';

const operation = 'timeline.clip.update';
const canonical = (value: unknown): string => JSON.stringify(value, (_key, child: unknown) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
function unavailable(): never { throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '已选择的时间线片段不可用', 404); }
function conflict(): never { throw new AppError('AGENT_EDIT_CONFLICT', '已选择的时间线片段已改变，请重新查看。', 409); }
function invalid(): never { throw new AppError('AGENT_EDIT_VALIDATION', '时间线移动提案格式无效。', 400); }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const exact = (value: unknown, keys: readonly string[]): boolean => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));

export interface AgentTimelineMoveInput {projectId: string; clipId: string; expectedRevision: number; patch: Record<string, unknown>; requestId: string}
export interface AgentTimelineMoveBoundary {
  read(options?: {legacyMissingProject?: boolean; sourceSemantics?: boolean}): TimelineRecord | null;
  replay(operation: string, text: string): unknown;
  asset(id: string): unknown;
  clipSource(clip: TimelineClipRecord): unknown;
  [key: string]: unknown;
}

export function pinAgentTimelineMoveTarget(db: DatabaseSync, projectId: string, input: unknown): AgentTimelineMoveTarget {
  if (!uuid(projectId) || !exact(input, ['timelineId', 'clipId', 'expectedRevision']) || !uuid((input as {timelineId?: unknown}).timelineId) || !uuid((input as {clipId?: unknown}).clipId) ||
    !Number.isSafeInteger((input as {expectedRevision?: unknown}).expectedRevision) || ((input as {expectedRevision: number}).expectedRevision) < 1) invalid();
  const value = input as {timelineId: string; clipId: string; expectedRevision: number};
  const timeline = createTimelineRecoveryBoundary(db, {projectId, requestId: ''}).read();
  if (!timeline || timeline.id !== value.timelineId) unavailable();
  if (timeline.revision !== value.expectedRevision) conflict();
  return projectedTarget(timeline, projectId, value.clipId);
}
function projectedTarget(timeline: unknown, projectId: string, clipId: string): AgentTimelineMoveTarget {
  const target = agentTimelineMoveTargetFromTimeline(timeline, clipId);
  if (!target || target.projectId !== projectId) unavailable();
  return target;
}

// Historical proposal visibility depends on current project/timeline ownership
// and its frozen source graph, not whether the current clip still exists.
export function assertAgentTimelineMoveOwnership(db: DatabaseSync, target: unknown): TimelineRecord {
  if (!isAgentTimelineMoveTarget(target)) invalidTimeline();
  const move = target as AgentTimelineMoveTarget;
  const boundary = createTimelineRecoveryBoundary(db, {projectId: move.projectId, requestId: ''});
  const current = boundary.read();
  if (!current || current.id !== move.timelineId) unavailable();
  boundary.clipSource(move.clip as unknown as TimelineClipRecord);
  return current;
}

export function createAgentTimelineMoveBoundary(db: DatabaseSync, input: AgentTimelineMoveInput, target: unknown): AgentTimelineMoveBoundary {
  if (!isAgentTimelineMoveTarget(target, {projectId: input?.projectId}) || !exact(input, ['projectId', 'clipId', 'expectedRevision', 'patch', 'requestId']) ||
      !isAgentTimelineMoveArguments(input.patch)) invalid();
  const move = target as AgentTimelineMoveTarget;
  if (input.clipId !== move.clip.id || input.expectedRevision !== move.expectedRevision) invalid();
  const diff = agentTimelineMoveDiff(move, input.patch);
  if (!diff) invalid();
  const boundary = createTimelineRecoveryBoundary(db, {projectId: input.projectId, clipId: input.clipId, expectedRevision: input.expectedRevision, patch: input.patch, requestId: input.requestId});
  const inside = () => { if (!db.isTransaction) throw new Error('Agent timeline scope requires the shared timeline transaction'); };
  return {...boundary,
    read(options?: {legacyMissingProject?: boolean; sourceSemantics?: boolean}) {
      inside();
      const current = boundary.read(options);
      if (!current || current.id !== move.timelineId) unavailable();
      // The existing CAS produces a request-bound rollback proof for stale
      // revisions. At the approved revision, full private identity must match.
      if (current.revision === move.expectedRevision &&
          !same(projectedTarget(current, input.projectId, move.clip.id), move)) unavailable();
      return current;
    },
    replay(op: string, text: string) {
      inside();
      if (op !== operation) invalidTimeline();
      const response = boundary.replay(op, text);
      const historical = projectedTarget({...(response as Record<string, unknown>), revision: move.expectedRevision}, input.projectId, move.clip.id);
      if (!same(historical, {...move, durationFrames: diff.after.timelineDurationFrames, clip: {...move.clip, startFrame: (input.patch as unknown as AgentTimelineMoveArguments).startFrame}})) invalidTimeline();
      return response;
    },
  };
}

export function readAgentTimelineMoveReceipt(db: DatabaseSync, input: AgentTimelineMoveInput, target: unknown): {status: 'applied'; timelineId: string; clipId: string; revision: number} | null {
  if (!db.isTransaction) throw new Error('Agent receipt reconciliation requires a transaction');
  const boundary = createAgentTimelineMoveBoundary(db, input, target);
  // Owner validation is performed even for receipt absence. It is a bounded
  // read, and can never create a timeline or serve as a mutation status probe.
  assertAgentTimelineMoveOwnership(db, target);
  const saved = readTimelineReceipt(db, {projectId: input.projectId, clipId: input.clipId, expectedRevision: input.expectedRevision, patch: input.patch, requestId: input.requestId}, operation);
  if (!saved) return null;
  const expected = createHash('sha256').update(canonical({operation, input})).digest('hex');
  if (saved.requestHash !== expected) invalidTimeline();
  const response = boundary.replay(operation, saved.response as string) as {id: string; revision: number};
  return {status: 'applied', timelineId: response.id, clipId: (target as AgentTimelineMoveTarget).clip.id, revision: response.revision};
}

// Read-only discovery/reconciliation needs a stable SQLite snapshot, never a
// write reservation. Mutation callers already own their shared transaction.
export function readAgentTimelineSnapshot<T>(db: DatabaseSync, read: () => T): T {
  if (db.isTransaction) return read();
  db.exec('BEGIN');
  try { const value = read(); db.exec('COMMIT'); return value; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// Fixed additive gain binding; the existing move catalog and boundary are unchanged.
type GainDomainOptions = Parameters<typeof createAgentTimelineGainDomain>[0];
export const {pinAgentTimelineGainTarget, assertAgentTimelineGainOwnership, assertAgentTimelineGainTarget, createAgentTimelineGainBoundary, readAgentTimelineGainReceipt} = createAgentTimelineGainDomain({
  createBoundary(db: DatabaseSync, input: {projectId: string}) {
    // Read-only pinning passes only the project scope; a real gain transaction
    // passes the complete mutation input, which the shared recovery boundary
    // needs for its exact response verification and idempotent replay. Passing
    // the narrowed shape would make verify() reject a valid timeline response.
    const recoveryInput = Object.hasOwn(input, 'requestId') ? input : {projectId: input.projectId, requestId: ''};
    return createTimelineRecoveryBoundary(db, recoveryInput as never) as unknown as ReturnType<GainDomainOptions['createBoundary']>;
  },
  readReceipt(db: DatabaseSync, input: Parameters<GainDomainOptions['readReceipt']>[1], operationName: string) {
    const row = readTimelineReceipt(db, {projectId: input.projectId, clipId: input.clipId, expectedRevision: input.expectedRevision, patch: input.patch, requestId: input.requestId}, operationName);
    return row === null || row === undefined ? row : {requestHash: row.requestHash as string, response: row.response as string};
  },
  isTarget: isAgentTimelineGainTarget,
  isArguments: isAgentTimelineGainArguments,
  targetFromTimeline: agentTimelineGainTargetFromTimeline as unknown as GainDomainOptions['targetFromTimeline'],
  diff: agentTimelineGainDiff as unknown as GainDomainOptions['diff'],
  isMutationResponse: isTimelineMutationResponse as unknown as GainDomainOptions['isMutationResponse'],
  fail(code: 'TIMELINE_SOURCE_UNAVAILABLE' | 'AGENT_EDIT_CONFLICT' | 'AGENT_EDIT_VALIDATION' | 'INVALID_TIMELINE_SNAPSHOT'): never {
    throw new AppError(code, '已选择的音量提案或关联素材无法安全验证。', code === 'AGENT_EDIT_VALIDATION' ? 400 : code === 'TIMELINE_SOURCE_UNAVAILABLE' ? 404 : 409);
  },
});
