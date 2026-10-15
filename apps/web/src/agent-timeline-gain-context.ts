import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { AGENT_TIMELINE_GAIN_CONTEXT, isAgentTimelineGainReviewTarget, isAgentTimelineGainSource } from '../../../packages/contracts/src/agent-timeline-gain.ts';
import type { AgentTimelineGainProposal, AgentTimelineGainReviewTarget } from '../../../packages/contracts/src/agent-timeline-gain.ts';

export { AGENT_TIMELINE_GAIN_CONTEXT };
export const AGENT_TIMELINE_GAIN_POLICY = Object.freeze({ schemaVersion: 1, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192, minGain: 0, maxGain: 2 } as const);
export type AgentTimelineGainPolicy = Readonly<typeof AGENT_TIMELINE_GAIN_POLICY & { available: boolean; catalogHash: string }>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => { throw Object.assign(new Error('Invalid saved timeline gain metadata.'), { code: 'INVALID_RESPONSE' }); };
const publicFields = ['projectId', 'timelineId', 'clipId', 'trackId', 'expectedRevision', 'clipName', 'trackName', 'trackKind', 'fps', 'width', 'height', 'trackMuted', 'hasAudio'] as const;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function safeAgentTimelineGainPolicy(value: unknown): AgentTimelineGainPolicy {
  const fields = ['available', 'catalogHash', ...Object.keys(AGENT_TIMELINE_GAIN_POLICY)];
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== fields.length ||
      fields.some(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'); }) ||
      typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !Object.entries(AGENT_TIMELINE_GAIN_POLICY).every(([key, expected]) => value[key] === expected)) return invalid();
  return Object.freeze({ available: value.available, ...AGENT_TIMELINE_GAIN_POLICY, catalogHash: value.catalogHash });
}
export function agentTimelineGainAvailable(snapshot: unknown): boolean {
  return object(snapshot) && snapshot.scope === 'chat_and_reviewed_timeline_edits' && object(snapshot.timelineGainEdit) && snapshot.timelineGainEdit.available === true;
}
export function safeAgentTimelineGainTarget(value: unknown, projectId: string): AgentTimelineGainReviewTarget {
  if (!isAgentTimelineGainReviewTarget(value, { projectId })) return invalid();
  return Object.freeze({ projectId: value.projectId, timelineId: value.timelineId, clipId: value.clipId, trackId: value.trackId,
    expectedRevision: value.expectedRevision, clipName: value.clipName, trackName: value.trackName, trackKind: value.trackKind,
    fps: value.fps, width: value.width, height: value.height, trackMuted: value.trackMuted, hasAudio: true, gain: value.gain });
}
export function agentTimelineGainTargetPatch(value: unknown, projectId: string, blockedReason: unknown = '') {
  let target: AgentTimelineGainReviewTarget | null = null;
  try { if (value) target = safeAgentTimelineGainTarget(value, projectId); } catch { /* Invalid saved metadata is never an eligible selection. */ }
  return { timelineGainTarget: target, timelineGainBlockedReason: typeof blockedReason === 'string' ? blockedReason : '请先核对当前时间线状态。', consent: null };
}
export function agentTimelineGainApprovalIssue(proposal: AgentTimelineGainProposal, { target, blockedReason = '', contextMode }: { target?: unknown; blockedReason?: string; contextMode?: unknown } = {}): string {
  if (blockedReason) return blockedReason;
  if (contextMode !== AGENT_TIMELINE_GAIN_CONTEXT) return '请先选择“选中片段音量提议”范围，再核对这份固定差异。';
  if (!isAgentTimelineGainReviewTarget(target, { projectId: proposal.projectId })) return '请先选中这份提议对应的已保存有声片段。';
  if (publicFields.some(key => proposal.target[key] !== target[key]) || proposal.diff.before.gain !== target.gain)
    return '当前选择、已保存音量、轨道状态或时间线版本与提议不一致。旧提议不会自动重新基于新版本修改。';
  return '';
}
export const agentTimelineGainText = (gain: number): string => `${String(gain)} (${Number((gain * 100).toFixed(4))}%)${gain === 0 ? ' · 此片段静音' : ''}`;
export function agentTimelineGainOutboundConsent(snapshot: unknown, destination: unknown, value: unknown) {
  if (!agentTimelineGainAvailable(snapshot) || !object(snapshot) || typeof snapshot.projectId !== 'string' || !object(snapshot.settings) || !object(snapshot.settings.configuration)) return null;
  const configuration = snapshot.settings.configuration;
  try {
    const target = safeAgentTimelineGainTarget(value, snapshot.projectId), policy = safeAgentTimelineGainPolicy(snapshot.timelineGainEdit);
    return { destination, protocol: configuration.protocol, model: configuration.model, context: AGENT_TIMELINE_GAIN_CONTEXT,
      projectId: snapshot.projectId, ...AGENT_TIMELINE_GAIN_POLICY, catalogHash: policy.catalogHash,
      timelineId: target.timelineId, clipId: target.clipId, expectedRevision: target.expectedRevision, reviewTarget: target };
  } catch { return null; }
}

// The legacy barrel supplies the canonical saved-timeline and receipt guards.
// This narrow adapter keeps new checked code independent of that unchecked graph.
interface GainContracts {
  isAgentTimelineGainProposal: (value: unknown, options?: { projectId?: unknown }) => value is AgentTimelineGainProposal;
  agentTimelineGainTargetFromTimeline: (timeline: unknown, clipId: unknown, source: unknown) => unknown;
  agentTimelineGainReviewTarget: (target: unknown) => unknown;
}
export function createAgentTimelineGainBrowser(contracts: GainContracts) {
  return {
    isAgentTimelineGainProposal: contracts.isAgentTimelineGainProposal,
    safeAgentTimelineGainProposal(value: unknown, projectId: string): AgentTimelineGainProposal {
      if (!contracts.isAgentTimelineGainProposal(value, { projectId })) return invalid();
      return freeze(structuredClone(value));
    },
    makeAgentTimelineGainSelection(timeline: unknown, clipId: unknown, projectId: unknown, assets: unknown): AgentTimelineGainReviewTarget | null {
      if (!object(timeline) || timeline.projectId !== projectId || typeof projectId !== 'string' || typeof clipId !== 'string' || !Array.isArray(timeline.clips) || !Array.isArray(assets)) return null;
      const clip: unknown = timeline.clips.find((item: unknown) => object(item) && item.id === clipId);
      if (!object(clip)) return null;
      const matches: unknown[] = assets.filter((item: unknown) => object(item) && item.id === clip.assetId);
      if (matches.length !== 1 || !object(matches[0])) return null;
      const asset = matches[0];
      if (asset.projectId !== projectId) return null;
      const source = { id: asset.id, sha256: asset.sha256, mimeType: asset.mimeType, hasAudio: asset.hasAudio };
      if (!isAgentTimelineGainSource(source)) return null;
      try {
        const target = contracts.agentTimelineGainTargetFromTimeline(timeline, clipId, source);
        return target ? safeAgentTimelineGainTarget(contracts.agentTimelineGainReviewTarget(target), projectId) : null;
      } catch { return null; }
    },
  };
}
export function agentTimelineGainBlockedReason({ connected, dirty, recoveredDraft, pending }: { connected: boolean; dirty: boolean; recoveredDraft: boolean; pending: boolean }): string {
  if (!connected) return '请等待当前项目连接与数据加载完成。';
  if (dirty || recoveredDraft) return '请先保存或放弃属性面板及已恢复的本地片段草稿，再审阅片段音量。草稿不会自动发送、清除或标记为已保存。';
  if (pending) return '有时间线操作正在处理或待确认，请先在任务中心核对。';
  return '';
}

// Display-only companions keep legacy diagnostics and business identities unchanged.
export function agentTimelineGainApprovalIssueDescriptor(proposal: AgentTimelineGainProposal, { target, blockedReason = '', contextMode }: { target?: unknown; blockedReason?: string; contextMode?: unknown } = {}): DisplayMessage | null {
  if (blockedReason) return localizedMessage('agent.gain.state.checkTimelineState');
  if (contextMode !== AGENT_TIMELINE_GAIN_CONTEXT) return localizedMessage('agent.gain.state.selectGainScope');
  if (!isAgentTimelineGainReviewTarget(target, { projectId: proposal.projectId })) return localizedMessage('agent.gain.state.selectOriginalAudioClip');
  if (publicFields.some(key => proposal.target[key] !== target[key]) || proposal.diff.before.gain !== target.gain)
    return localizedMessage('agent.gain.state.targetMismatch');
  return null;
}

export function agentTimelineGainBlockedDescriptor({ connected, dirty, recoveredDraft, pending }: { connected: boolean; dirty: boolean; recoveredDraft: boolean; pending: boolean }): DisplayMessage | null {
  if (!connected) return localizedMessage('agent.gain.state.waitForProject');
  if (dirty || recoveredDraft) return localizedMessage('agent.gain.state.resolveDrafts');
  if (pending) return localizedMessage('agent.gain.state.pendingTimelineOperation');
  return null;
}
