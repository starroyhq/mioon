import {createHash} from 'node:crypto';
import {AppError, isAgentTimelineMoveTarget, isAgentTimelineMoveArguments, agentTimelineMoveTargetFromTimeline, agentTimelineMoveDiff, isAgentTimelineGainTarget, isAgentTimelineGainArguments, agentTimelineGainTargetFromTimeline, agentTimelineGainDiff, isTimelineMutationResponse} from '@mioon/contracts';
import {createTimelineRecoveryBoundary, readTimelineReceipt, invalidTimeline} from '../timeline-recovery.ts';

const operation = 'timeline.clip.update';
const canonical = value => JSON.stringify(value, (_, child) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const same = (left, right) => canonical(left) === canonical(right);
const unavailable = () => { throw new AppError('TIMELINE_SOURCE_UNAVAILABLE', '已选择的时间线片段不可用', 404); };
const conflict = () => { throw new AppError('AGENT_EDIT_CONFLICT', '已选择的时间线片段已改变，请重新查看。', 409); };
const invalid = () => { throw new AppError('AGENT_EDIT_VALIDATION', '时间线移动提案格式无效。', 400); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));

export function pinAgentTimelineMoveTarget(db, projectId, input) {
  if (!uuid(projectId) || !exact(input, ['timelineId', 'clipId', 'expectedRevision']) || !uuid(input.timelineId) || !uuid(input.clipId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) invalid();
  const timeline = createTimelineRecoveryBoundary(db, {projectId}).read();
  if (!timeline || timeline.id !== input.timelineId) unavailable();
  if (timeline.revision !== input.expectedRevision) conflict();
  return projectedTarget(timeline, projectId, input.clipId);
}
function projectedTarget(timeline, projectId, clipId) {
  const target = agentTimelineMoveTargetFromTimeline(timeline, clipId);
  if (!target || target.projectId !== projectId) unavailable();
  return target;
}

// Historical proposal visibility depends on current project/timeline ownership
// and its frozen source graph, not whether the current clip still exists.
export function assertAgentTimelineMoveOwnership(db, target) {
  if (!isAgentTimelineMoveTarget(target)) invalidTimeline();
  const boundary = createTimelineRecoveryBoundary(db, {projectId: target.projectId});
  const current = boundary.read();
  if (!current || current.id !== target.timelineId) unavailable();
  boundary.clipSource(target.clip);
  return current;
}

export function createAgentTimelineMoveBoundary(db, input, target) {
  if (!isAgentTimelineMoveTarget(target, {projectId: input?.projectId}) || !exact(input, ['projectId', 'clipId', 'expectedRevision', 'patch', 'requestId']) ||
      input.clipId !== target.clip.id || input.expectedRevision !== target.expectedRevision || !isAgentTimelineMoveArguments(input.patch) || !uuid(input.requestId)) invalid();
  const diff = agentTimelineMoveDiff(target, input.patch);
  if (!diff) invalid();
  const boundary = createTimelineRecoveryBoundary(db, input);
  const inside = () => { if (!db.isTransaction) throw new Error('Agent timeline scope requires the shared timeline transaction'); };
  return {...boundary,
    read(options) {
      inside();
      const current = boundary.read(options);
      if (!current || current.id !== target.timelineId) unavailable();
      // The existing CAS produces a request-bound rollback proof for stale
      // revisions. At the approved revision, full private identity must match.
      if (current.revision === target.expectedRevision &&
          !same(projectedTarget(current, input.projectId, target.clip.id), target)) unavailable();
      return current;
    },
    replay(op, text) {
      inside();
      if (op !== operation) invalidTimeline();
      const response = boundary.replay(op, text);
      const historical = projectedTarget({...response, revision: target.expectedRevision}, input.projectId, target.clip.id);
      if (!same(historical, {...target, durationFrames: diff.after.timelineDurationFrames, clip: {...target.clip, startFrame: input.patch.startFrame}})) invalidTimeline();
      return response;
    },
  };
}

export function readAgentTimelineMoveReceipt(db, input, target) {
  if (!db.isTransaction) throw new Error('Agent receipt reconciliation requires a transaction');
  const boundary = createAgentTimelineMoveBoundary(db, input, target);
  // Owner validation is performed even for receipt absence. It is a bounded
  // read, and can never create a timeline or serve as a mutation status probe.
  assertAgentTimelineMoveOwnership(db, target);
  const saved = readTimelineReceipt(db, input, operation);
  if (!saved) return null;
  const expected = createHash('sha256').update(canonical({operation, input})).digest('hex');
  if (saved.requestHash !== expected) invalidTimeline();
  const response = boundary.replay(operation, saved.response);
  return {status: 'applied', timelineId: response.id, clipId: target.clip.id, revision: response.revision};
}

// Read-only discovery/reconciliation needs a stable SQLite snapshot, never a
// write reservation. Mutation callers already own their shared transaction.
export function readAgentTimelineSnapshot(db, read) {
  if (db.isTransaction) return read();
  db.exec('BEGIN');
  try { const value = read(); db.exec('COMMIT'); return value; }
  catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

// Fixed additive gain binding; the existing move catalog and boundary are unchanged.
import {createAgentTimelineGainDomain} from './timeline-gain-domain.ts';
export const {pinAgentTimelineGainTarget, assertAgentTimelineGainOwnership, assertAgentTimelineGainTarget, createAgentTimelineGainBoundary, readAgentTimelineGainReceipt} = createAgentTimelineGainDomain({
  createBoundary: createTimelineRecoveryBoundary, readReceipt: readTimelineReceipt,
  isTarget: isAgentTimelineGainTarget, isArguments: isAgentTimelineGainArguments,
  targetFromTimeline: agentTimelineGainTargetFromTimeline, diff: agentTimelineGainDiff, isMutationResponse: isTimelineMutationResponse,
  fail(code) { throw new AppError(code, '已选择的音量提案或关联素材无法安全验证。', code === 'AGENT_EDIT_VALIDATION' ? 400 : code === 'TIMELINE_SOURCE_UNAVAILABLE' ? 404 : 409); },
});
