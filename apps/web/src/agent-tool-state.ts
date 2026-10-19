import { AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_POLICY, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch, agentTimelineGainOutboundConsent } from './agent-timeline-gain-context.ts';
export { AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_POLICY, agentTimelineGainAvailable, safeAgentTimelineGainPolicy, safeAgentTimelineGainTarget, agentTimelineGainTargetPatch };
import { AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_LIMITS, agentTimelineAvailable, safeAgentTimelinePolicy, safeAgentTimelineTarget, agentTimelineTargetKey, agentTimelineFrameText } from './agent-timeline-context.ts';
export { AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_LIMITS, agentTimelineAvailable, safeAgentTimelinePolicy, safeAgentTimelineTarget, agentTimelineTargetKey, agentTimelineFrameText };
// Browser-only projections of fixed, bounded Agent policies. Nothing here
// dispatches a tool, resolves a URL, or turns a saved permission into a new run.
export const AGENT_TYPED_CONTEXT = 'typed_chat_only';
export const AGENT_PROJECT_CONTEXT = 'project_inspection';
export const AGENT_EDIT_CONTEXT = 'selected_shot_edit';
export const AGENT_EDIT_LIMITS = Object.freeze({ schemaVersion: 1, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192, maxTitleChars: 150, maxPromptChars: 5000, maxTitleBytes: 600, maxPromptBytes: 20000 });
export const AGENT_INSPECTION_LIMITS = Object.freeze({ schemaVersion: 1, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192 });
export type AgentContextMode = typeof AGENT_TYPED_CONTEXT | typeof AGENT_PROJECT_CONTEXT | typeof AGENT_EDIT_CONTEXT | typeof AGENT_TIMELINE_CONTEXT | typeof AGENT_TIMELINE_GAIN_CONTEXT;
export interface AgentCapabilityView { available?: unknown; catalogHash?: unknown; [key: string]: unknown }
export interface AgentSettingsSnapshotLike { configuration?: { protocol?: unknown; model?: unknown; [key: string]: unknown } | null; [key: string]: unknown }
export interface AgentSnapshotLike {
  scope?: unknown;
  projectId?: string;
  inspection?: AgentCapabilityView | null;
  edit?: AgentCapabilityView | null;
  timelineEdit?: AgentCapabilityView | null;
  timelineGainEdit?: unknown;
  settings?: AgentSettingsSnapshotLike | null;
  [key: string]: unknown;
}
export interface AgentProvenanceView { category?: unknown; projectId?: unknown; sourceRunIds?: unknown; [key: string]: unknown }
export interface AgentActivityView { id?: unknown; kind?: unknown; ordinal?: unknown; status?: unknown; name?: unknown; operation?: unknown; resultJson?: unknown; [key: string]: unknown }
export interface AgentRunLike {
  contextMode?: unknown;
  provenance?: AgentProvenanceView | null;
  activity?: readonly AgentActivityView[] | null;
  editTarget?: unknown;
  [key: string]: unknown;
}
export interface AgentSafeActivity { id: string; kind: 'model' | 'tool'; ordinal: 1 | 2; status: 'not_started' | 'intent' | 'dispatch_started' | 'completed' | 'unknown'; name?: string; operation?: string; resultJson?: string }
export interface AgentRunInspection {
  contextMode: AgentContextMode;
  provenance: { category: string; projectId: string; sourceRunIds: readonly string[] } | null;
  activity: readonly AgentSafeActivity[];
  editTarget?: unknown;
}
export interface AgentOutboundConsent {
  destination: unknown; protocol: unknown; model: unknown; context: AgentContextMode;
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail: () => never = () => { throw Object.assign(new Error('Invalid Agent inspection response.'), { code: 'INVALID_RESPONSE' }); };
const bounded = (value: unknown, max: number): string => { if (typeof value !== 'string' || new TextEncoder().encode(value).length > max) fail(); return value; };
const activityStatuses = new Set(['not_started', 'intent', 'dispatch_started', 'completed', 'unknown']);
const toolOperations: Record<string, string> = Object.freeze({ mioon_project_inspect: 'project.inspect', mioon_asset_inspect: 'asset.inspect', mioon_shot_inspect: 'shot.inspect', mioon_timeline_inspect: 'timeline.inspect', mioon_propose_shot_update: 'shot.update', mioon_propose_timeline_clip_move: 'timeline.clip.update', mioon_propose_timeline_clip_gain: 'timeline.clip.update' });
const contextModes: readonly string[] = [AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT];

export function safeAgentInspectionPolicy(value: unknown) {
  if (!isRecord(value) || typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !Object.entries(AGENT_INSPECTION_LIMITS).every(([key, expected]) => value[key] === expected)) fail();
  return Object.freeze({ available: value.available, ...AGENT_INSPECTION_LIMITS, catalogHash: value.catalogHash });
}
export function safeAgentEditPolicy(value: unknown) {
  if (!isRecord(value) || typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !Object.entries(AGENT_EDIT_LIMITS).every(([key, expected]) => value[key] === expected)) fail();
  return Object.freeze({ available: value.available, ...AGENT_EDIT_LIMITS, catalogHash: value.catalogHash });
}
export const agentInspectionAvailable = (snapshot: AgentSnapshotLike | null | undefined): boolean => typeof snapshot?.scope === 'string' && ['chat_and_project_inspection', 'chat_and_reviewed_shot_edits', 'chat_and_reviewed_timeline_edits'].includes(snapshot.scope) && snapshot.inspection?.available === true;
export const agentEditAvailable = (snapshot: AgentSnapshotLike | null | undefined): boolean => typeof snapshot?.scope === 'string' && ['chat_and_reviewed_shot_edits', 'chat_and_reviewed_timeline_edits'].includes(snapshot.scope) && snapshot.edit?.available === true;
export function safeAgentEditTarget(value: unknown, projectId: unknown, pinned = true) {
  if (!isRecord(value) || !uuid(pinned ? value.shotId : value.id) || !Number.isSafeInteger(pinned ? value.expectedRevision : value.revision) || Number(pinned ? value.expectedRevision : value.revision) < 1 || pinned && value.projectId !== projectId) fail();
  const title = bounded(value.title, AGENT_EDIT_LIMITS.maxTitleBytes), prompt = bounded(value.prompt, AGENT_EDIT_LIMITS.maxPromptBytes);
  if (!title.trim() || title.length > AGENT_EDIT_LIMITS.maxTitleChars || prompt.length > AGENT_EDIT_LIMITS.maxPromptChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(title + prompt) || [title, prompt].some(text => typeof (text as { isWellFormed?: () => boolean }).isWellFormed === 'function' && !(text as unknown as { isWellFormed: () => boolean }).isWellFormed())) fail();
  return Object.freeze({ projectId, shotId: pinned ? uuid(value.shotId) ? value.shotId : '' : uuid(value.id) ? value.id : '', expectedRevision: Number(pinned ? value.expectedRevision : value.revision), title, prompt });
}
export const agentEditTargetKey = (value: unknown): string | null => value ? JSON.stringify(value) : null;
export const agentRunContextMode = (run: unknown): AgentContextMode => { const value = isRecord(run) ? run : {}; return value.contextMode === undefined ? AGENT_TYPED_CONTEXT : value.contextMode as AgentContextMode; };
export function safeAgentRunInspection(value: unknown, projectId: string): AgentRunInspection {
  const contextMode = agentRunContextMode(value as AgentRunLike);
  if (!contextModes.includes(contextMode)) fail();
  let provenance: AgentRunInspection['provenance'] = null;
  const run = isRecord(value) ? value : {};
  if ([AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode)) {
    const source = isRecord(run.provenance) ? run.provenance : null;
    if (!source || source.category !== (contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? 'project_selected_timeline_audio_gain' : contextMode === AGENT_TIMELINE_CONTEXT ? 'project_selected_timeline_timing' : contextMode === AGENT_EDIT_CONTEXT ? 'project_selected_shot_text' : 'project_saved_text_metadata') || source.projectId !== projectId || !Array.isArray(source.sourceRunIds) || source.sourceRunIds.length > 12 || !source.sourceRunIds.every(uuid) || new Set(source.sourceRunIds).size !== source.sourceRunIds.length) fail();
    const sourceRunIds = source.sourceRunIds as string[];
    provenance = Object.freeze({ category: source.category as string, projectId, sourceRunIds: Object.freeze([...sourceRunIds]) });
  } else if (run.provenance !== undefined && run.provenance !== null) fail();
  const rawActivity = run.activity;
  if (rawActivity !== undefined && (!Array.isArray(rawActivity) || rawActivity.length > 3)) fail();
  if (contextMode !== AGENT_TYPED_CONTEXT && !(Array.isArray(rawActivity) && rawActivity.length)) fail();
  const activityItems = Array.isArray(rawActivity) ? rawActivity as AgentActivityView[] : [];
  const activity = activityItems.map(item => {
    if (!isRecord(item) || !['model', 'tool'].includes(item.kind as string) || ![1, 2].includes(item.ordinal as number) || !activityStatuses.has(item.status as string) || !uuid(item.id)) fail();
    if (item.kind === 'model' && item.status === 'intent') fail();
    const safe: AgentSafeActivity = { id: item.id as string, kind: item.kind as 'model' | 'tool', ordinal: item.ordinal as 1 | 2, status: item.status as AgentSafeActivity['status'] };
    if (item.kind === 'tool') {
      if (contextMode === AGENT_TYPED_CONTEXT || (contextMode === AGENT_EDIT_CONTEXT) !== (item.name === 'mioon_propose_shot_update') || (contextMode === AGENT_TIMELINE_CONTEXT) !== (item.name === 'mioon_propose_timeline_clip_move') || (contextMode === AGENT_TIMELINE_GAIN_CONTEXT) !== (item.name === 'mioon_propose_timeline_clip_gain') || item.ordinal !== 1 || item.status === 'not_started' || !Object.hasOwn(toolOperations, item.name as string) || item.operation !== toolOperations[item.name as string]) fail();
      Object.assign(safe, { name: item.name as string, operation: item.operation as string });
      if ((item.status === 'completed') !== (item.resultJson !== undefined)) fail();
      if (item.resultJson !== undefined) {
        safe.resultJson = bounded(item.resultJson, AGENT_INSPECTION_LIMITS.maxResultBytes);
        try { JSON.parse(safe.resultJson); } catch { fail(); }
      }
    }
    return Object.freeze(safe);
  });
  if (new Set(activity.map(item => item.id)).size !== activity.length || activity.filter(item => item.kind === 'tool').length > 1 || contextMode === AGENT_TYPED_CONTEXT && activity.length > 0 || new Set(activity.map(item => `${item.kind}:${item.ordinal}`)).size !== activity.length || activity.some((item, index) => `${item.kind}:${item.ordinal}` !== ['model:1', 'tool:1', 'model:2'][index])) fail();
  const editTarget = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? safeAgentTimelineGainTarget(run.editTarget, projectId) : contextMode === AGENT_TIMELINE_CONTEXT ? safeAgentTimelineTarget(run.editTarget, projectId) : contextMode === AGENT_EDIT_CONTEXT ? safeAgentEditTarget(run.editTarget, projectId) : null;
  if (![AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode) && run.editTarget != null) fail();
  return { contextMode, provenance, activity: Object.freeze(activity), ...(editTarget ? { editTarget } : {}) };
}
export const agentRunProvenanceEqual = (left: unknown, right: unknown): boolean => { const a = isRecord(left) ? left : {}, b = isRecord(right) ? right : {}; return agentRunContextMode(a) === agentRunContextMode(b) && JSON.stringify(a.provenance || null) === JSON.stringify(b.provenance || null) && agentEditTargetKey(a.editTarget) === agentEditTargetKey(b.editTarget); };
const activityProgress: Record<string, number> = { not_started: 0, intent: 1, dispatch_started: 2, unknown: 3, completed: 4 };
export const agentRunActivityCompatible = (left: unknown, right: unknown): boolean => { const a = isRecord(left) && Array.isArray(left.activity) ? left.activity as AgentActivityView[] : [], b = isRecord(right) && Array.isArray(right.activity) ? right.activity as AgentActivityView[] : []; return a.every((previous, index) => {
  const nextRecord = b[index];
  if (!nextRecord) return false;
  const previousRecord = previous as AgentActivityView;
  return activityProgress[nextRecord.status as string] >= activityProgress[previousRecord.status as string] && ['id', 'kind', 'ordinal', 'name', 'operation'].every(key => previousRecord[key] === nextRecord[key]) && (previousRecord.resultJson === undefined || previousRecord.resultJson === nextRecord.resultJson);
}); };
export function agentChatOutboundConsent(snapshot: AgentSnapshotLike | null | undefined, contextMode: string = AGENT_TYPED_CONTEXT, destination: unknown, editTarget: unknown): AgentOutboundConsent | null {
  const configuration = snapshot?.settings?.configuration;
  if (!configuration || !contextModes.includes(contextMode)) return null;
  const result: AgentOutboundConsent = { destination, protocol: configuration.protocol, model: configuration.model, context: contextMode as AgentContextMode };
  if (contextMode === AGENT_PROJECT_CONTEXT) {
    if (!agentInspectionAvailable(snapshot)) return null;
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_INSPECTION_LIMITS, catalogHash: snapshot.inspection?.catalogHash });
  }
  if (contextMode === AGENT_EDIT_CONTEXT) {
    if (!agentEditAvailable(snapshot)) return null;
    let target; try { target = safeAgentEditTarget(editTarget, snapshot.projectId); } catch { return null; }
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_EDIT_LIMITS, catalogHash: snapshot.edit?.catalogHash, shotId: target.shotId, expectedRevision: target.expectedRevision });
  }
  if (contextMode === AGENT_TIMELINE_CONTEXT) {
    if (!agentTimelineAvailable(snapshot)) return null;
    let target; try { target = safeAgentTimelineTarget(editTarget, snapshot.projectId); } catch { return null; }
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_TIMELINE_LIMITS, catalogHash: snapshot.timelineEdit?.catalogHash, timelineId: target.timelineId, clipId: target.clipId, expectedRevision: target.expectedRevision });
  }
  if (contextMode === AGENT_TIMELINE_GAIN_CONTEXT) return agentTimelineGainOutboundConsent(snapshot, destination, editTarget) as AgentOutboundConsent | null;
  return result;
}
