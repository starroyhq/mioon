import { isAgentTimelineMoveReviewTarget, isAgentTimelineMoveProposal, agentTimelineMoveTargetFromTimeline, agentTimelineMoveReviewTarget, isAgentTimelineGainProposal, agentTimelineGainTargetFromTimeline, agentTimelineGainReviewTarget } from '@mioon/contracts';

import { createAgentTimelineGainBrowser, agentTimelineGainApprovalIssue } from './agent-timeline-gain-context.ts';
export { AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_POLICY, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineGainOutboundConsent, agentTimelineGainBlockedReason } from './agent-timeline-gain-context.ts';
export { isAgentTimelineMoveProposal, isAgentTimelineGainProposal };
export const { safeAgentTimelineGainProposal, makeAgentTimelineGainSelection } = createAgentTimelineGainBrowser({ isAgentTimelineGainProposal, agentTimelineGainTargetFromTimeline, agentTimelineGainReviewTarget });

// Browser projections contain only the exact consent/review metadata. The full
// frozen source identity belongs exclusively to the server's accepted intent.
export const AGENT_TIMELINE_CONTEXT = 'selected_timeline_clip_move';
export const AGENT_TIMELINE_LIMITS = Object.freeze({ schemaVersion: 1, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192, maxStartFrame: 18000, maxOccupiedIntervals: 99 });
const invalid = () => { throw Object.assign(new Error('Invalid saved timeline move metadata.'), { code: 'INVALID_RESPONSE' }); };
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
const publicFields = ['projectId', 'timelineId', 'clipId', 'trackId', 'expectedRevision', 'clipName', 'trackName', 'trackKind', 'fps', 'width', 'height'];
const timingFields = ['startFrame', 'endFrame', 'durationFrames', 'timelineDurationFrames'];
export function safeAgentTimelinePolicy(value) {
  if (!value || typeof value.available !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.catalogHash) || !Object.entries(AGENT_TIMELINE_LIMITS).every(([key, expected]) => value[key] === expected)) invalid();
  return Object.freeze({ available: value.available, ...AGENT_TIMELINE_LIMITS, catalogHash: value.catalogHash });
}
export const agentTimelineAvailable = snapshot => snapshot?.scope === 'chat_and_reviewed_timeline_edits' && snapshot.timelineEdit?.available === true;
export function safeAgentTimelineTarget(value, projectId) {
  if (!isAgentTimelineMoveReviewTarget(value, { projectId })) invalid();
  return freeze({ ...Object.fromEntries([...publicFields, ...timingFields].map(key => [key, value[key]])), occupiedIntervals: value.occupiedIntervals.map(interval => ({ startFrame: interval.startFrame, endFrame: interval.endFrame })) });
}
export const agentTimelineTargetKey = value => value ? JSON.stringify(value) : null;
export function safeAgentTimelineProposal(value, projectId) {
  if (!isAgentTimelineMoveProposal(value, { projectId })) invalid();
  const result = {
    id: value.id, projectId, runId: value.runId, digest: value.digest, status: value.status, runStatus: value.runStatus, operation: value.operation,
    target: Object.fromEntries(publicFields.map(key => [key, value.target[key]])), patch: { startFrame: value.patch.startFrame },
    diff: Object.fromEntries(['before', 'after'].map(side => [side, Object.fromEntries(timingFields.map(key => [key, value.diff[side][key]]))])),
    provenance: { runId: value.provenance.runId, toolCallId: value.provenance.toolCallId, toolName: value.provenance.toolName }, createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.approval ? { approval: { requestId: value.approval.requestId, approvedAt: value.approval.approvedAt } } : {}),
    ...(value.outcome ? { outcome: value.outcome.status === 'applied' ? { status: 'applied', timelineId: value.outcome.timelineId, clipId: value.outcome.clipId, revision: value.outcome.revision } : { status: 'not_applied', code: value.outcome.code } } : {}),
  };
  return freeze(result);
}
export function agentTimelineApprovalIssue(proposal, { target, blockedReason = '', contextMode } = {}) {
  if (proposal?.operation !== 'timeline.clip.update') return '';
  if (isAgentTimelineGainProposal(proposal)) return agentTimelineGainApprovalIssue(proposal, { target, blockedReason, contextMode });
  if (!isAgentTimelineMoveProposal(proposal)) return '片段提议的类型或固定差异无效，不能批准。';
  if (blockedReason) return blockedReason;
  if (contextMode !== AGENT_TIMELINE_CONTEXT) return '请先选择“选中片段移动提议”范围，再核对这份固定差异。';
  if (!target) return '请先选中这份提议对应的已保存时间线片段。';
  if (publicFields.some(key => proposal.target[key] !== target[key]) || timingFields.some(key => proposal.diff.before[key] !== target[key])) return '当前选择或已保存时间线版本与提议不一致。旧提议不会自动重新基于新版本修改。';
  return '';
}
export const agentTimelineFrameText = (frame, fps = 30) => `${frame} 帧 / ${(frame / fps).toFixed(3)} 秒`;

// App calls this with the current saved timeline, never an inspector draft.
export function makeAgentTimelineClipSelection(timeline, clipId, projectId) {
  if (!timeline || timeline.projectId !== projectId || !clipId) return null;
  try {
    const target = agentTimelineMoveTargetFromTimeline(timeline, clipId);
    return target ? safeAgentTimelineTarget(agentTimelineMoveReviewTarget(target), projectId) : null;
  } catch { return null; }
}
