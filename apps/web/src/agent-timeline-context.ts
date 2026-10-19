import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import { isAgentTimelineMoveReviewTarget, isAgentTimelineMoveProposal, agentTimelineMoveTargetFromTimeline, agentTimelineMoveReviewTarget, isAgentTimelineGainProposal, agentTimelineGainTargetFromTimeline, agentTimelineGainReviewTarget } from '@mioon/contracts';
import type { AgentTimelineMoveProposal, AgentTimelineMoveReviewTarget, AgentTimelineGainProposal } from '@mioon/contracts';

import { createAgentTimelineGainBrowser, agentTimelineGainApprovalIssue, agentTimelineGainApprovalIssueDescriptor } from './agent-timeline-gain-context.ts';
export { AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_POLICY, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineGainOutboundConsent, agentTimelineGainBlockedReason, agentTimelineGainBlockedDescriptor } from './agent-timeline-gain-context.ts';
export { isAgentTimelineMoveProposal, isAgentTimelineGainProposal };
export const { safeAgentTimelineGainProposal, makeAgentTimelineGainSelection } = createAgentTimelineGainBrowser({ isAgentTimelineGainProposal, agentTimelineGainTargetFromTimeline, agentTimelineGainReviewTarget });

// Browser projections contain only the exact consent/review metadata. The full
// frozen source identity belongs exclusively to the server's accepted intent.
export const AGENT_TIMELINE_CONTEXT = 'selected_timeline_clip_move';
export const AGENT_TIMELINE_LIMITS = Object.freeze({ schemaVersion: 1, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192, maxStartFrame: 18000, maxOccupiedIntervals: 99 });
export interface AgentTimelinePolicy {
  readonly available: boolean;
  readonly schemaVersion: 1;
  readonly maxModelRequests: 2;
  readonly maxToolCalls: 1;
  readonly maxResultBytes: 8192;
  readonly maxStartFrame: 18000;
  readonly maxOccupiedIntervals: 99;
  readonly catalogHash: string;
}
export interface AgentTimelineApprovalOptions {
  readonly target?: unknown;
  readonly blockedReason?: string;
  readonly contextMode?: unknown;
}
type AgentProposal=AgentTimelineMoveProposal|AgentTimelineGainProposal;
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
function invalid(): never {throw Object.assign(new Error('Invalid saved timeline move metadata.'), { code: 'INVALID_RESPONSE' });}
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) if (child !== null && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}
const publicFields=['projectId','timelineId','clipId','trackId','expectedRevision','clipName','trackName','trackKind','fps','width','height'] as const;
const timingFields=['startFrame','endFrame','durationFrames','timelineDurationFrames'] as const;
const publicTarget=(value: unknown): Record<string, unknown>=>isRecord(value)?value:{};
export function safeAgentTimelinePolicy(value: unknown): Readonly<AgentTimelinePolicy> {
  if (!isRecord(value) || typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
    !Object.entries(AGENT_TIMELINE_LIMITS).every(([key, expected]) => value[key] === expected)) invalid();
  return Object.freeze({ available: value.available, ...AGENT_TIMELINE_LIMITS, catalogHash: value.catalogHash });
}
export const agentTimelineAvailable = (snapshot: unknown): boolean => property(snapshot,'scope') === 'chat_and_reviewed_timeline_edits' && property(property(snapshot,'timelineEdit'),'available') === true;
export function safeAgentTimelineTarget(value: unknown, projectId: unknown): AgentTimelineMoveReviewTarget {
  if (!isAgentTimelineMoveReviewTarget(value, { projectId })) invalid();
  const target=publicTarget(value);
  const occupied=Array.isArray(target.occupiedIntervals)?target.occupiedIntervals:[] as unknown[];
  return freeze({ ...Object.fromEntries([...publicFields, ...timingFields].map(key => [key, property(target,key)])), occupiedIntervals: occupied.map(interval => ({ startFrame: Number(property(interval,'startFrame')), endFrame: Number(property(interval,'endFrame')) })) } as unknown as AgentTimelineMoveReviewTarget);
}
export const agentTimelineTargetKey = (value: unknown): string | null => value ? JSON.stringify(value) : null;
export function safeAgentTimelineProposal(value: unknown, projectId: unknown): AgentTimelineMoveProposal {
  if (!isAgentTimelineMoveProposal(value, { projectId })) invalid();
  const proposal=value, target=publicTarget(proposal.target), patch=isRecord(proposal.patch)?proposal.patch:{}, diff=isRecord(proposal.diff)?proposal.diff:{}, provenance=isRecord(proposal.provenance)?proposal.provenance:{};
  const rawBefore=property(diff,'before'),rawAfter=property(diff,'after'),before=isRecord(rawBefore)?rawBefore:{}, after=isRecord(rawAfter)?rawAfter:{};
  const result = {
    id: proposal.id, projectId, runId: proposal.runId, digest: proposal.digest, status: proposal.status, runStatus: proposal.runStatus, operation: proposal.operation,
    target: Object.fromEntries(publicFields.map(key => [key, property(target,key)])), patch: { startFrame: Number(property(patch,'startFrame')) },
    diff: Object.fromEntries(['before', 'after'].map(side => [side, Object.fromEntries(timingFields.map(key => [key, property(side==='before'?before:after,key)]))])),
    provenance: { runId: property(provenance,'runId') as string, toolCallId: property(provenance,'toolCallId') as string, toolName: property(provenance,'toolName') as string }, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt,
    ...(proposal.approval ? { approval: { requestId: proposal.approval.requestId, approvedAt: proposal.approval.approvedAt } } : {}),
    ...(proposal.outcome ? { outcome: proposal.outcome.status === 'applied' ? { status: 'applied' as const, timelineId: proposal.outcome.timelineId, clipId: proposal.outcome.clipId, revision: proposal.outcome.revision } : { status: 'not_applied' as const, code: proposal.outcome.code } } : {}),
  };
  return freeze(result) as unknown as AgentTimelineMoveProposal;
}
export function agentTimelineApprovalIssue(proposal: AgentProposal | null | undefined, { target, blockedReason = '', contextMode }: AgentTimelineApprovalOptions = {}): string {
  if (proposal?.operation !== 'timeline.clip.update') return '';
  if (isAgentTimelineGainProposal(proposal)) return agentTimelineGainApprovalIssue(proposal, { target, blockedReason, contextMode });
  if (!isAgentTimelineMoveProposal(proposal)) return '片段提议的类型或固定差异无效，不能批准。';
  if (blockedReason) return blockedReason;
  if (contextMode !== AGENT_TIMELINE_CONTEXT) return '请先选择“选中片段移动提议”范围，再核对这份固定差异。';
  if (!target) return '请先选中这份提议对应的已保存时间线片段。';
  const recorded=publicTarget(target);
  if (publicFields.some(key => property(proposal.target,key) !== property(recorded,key)) || timingFields.some(key => property(proposal.diff.before,key) !== property(recorded,key))) return '当前选择或已保存时间线版本与提议不一致。旧提议不会自动重新基于新版本修改。';
  return '';
}
export const agentTimelineFrameText = (frame: number,fps = 30): string => `${frame} 帧 / ${(frame / fps).toFixed(3)} 秒`;

// App calls this with the current saved timeline, never an inspector draft.
export function makeAgentTimelineClipSelection(timeline: unknown, clipId: unknown, projectId: unknown): AgentTimelineMoveReviewTarget | null {
  if (!isRecord(timeline) || timeline.projectId !== projectId || !clipId) return null;
  try {
    const target = agentTimelineMoveTargetFromTimeline(timeline, clipId);
    return target ? safeAgentTimelineTarget(agentTimelineMoveReviewTarget(target), projectId) : null;
  } catch { return null; }
}

// Display-only companions keep legacy diagnostics and business identities unchanged.
export function agentTimelineApprovalIssueDescriptor(proposal: AgentProposal | null | undefined, { target, blockedReason = '', contextMode }: AgentTimelineApprovalOptions = {}) {
  if (proposal?.operation !== 'timeline.clip.update') return null;
  if (isAgentTimelineGainProposal(proposal)) return agentTimelineGainApprovalIssueDescriptor(proposal, { target, blockedReason, contextMode });
  if (!isAgentTimelineMoveProposal(proposal)) return localizedMessage('agent.move.state.invalidProposal');
  if (blockedReason) return localizedMessage('agent.gain.state.checkTimelineState');
  if (contextMode !== AGENT_TIMELINE_CONTEXT) return localizedMessage('agent.move.state.selectMoveScope');
  if (!target) return localizedMessage('agent.move.state.selectOriginalClip');
  const recorded=publicTarget(target);
  if (publicFields.some(key => property(proposal.target,key) !== property(recorded,key)) || timingFields.some(key => property(proposal.diff.before,key) !== property(recorded,key))) return localizedMessage('agent.move.state.targetMismatch');
  return null;
}

export const agentTimelineFrameDescriptor = (frame: number,fps = 30) => localizedMessage('agent.move.state.frameTime', { frame: frame, framefps: (frame / fps).toFixed(3) });
