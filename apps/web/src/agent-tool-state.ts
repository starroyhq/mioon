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
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = () => { throw Object.assign(new Error('Invalid Agent inspection response.'), { code: 'INVALID_RESPONSE' }); };
const bounded = (value, max) => { if (typeof value !== 'string' || new TextEncoder().encode(value).length > max) fail(); return value; };
const activityStatuses = new Set(['not_started', 'intent', 'dispatch_started', 'completed', 'unknown']);
const toolOperations = Object.freeze({ mioon_project_inspect: 'project.inspect', mioon_asset_inspect: 'asset.inspect', mioon_shot_inspect: 'shot.inspect', mioon_timeline_inspect: 'timeline.inspect', mioon_propose_shot_update: 'shot.update', mioon_propose_timeline_clip_move: 'timeline.clip.update', mioon_propose_timeline_clip_gain: 'timeline.clip.update' });

export function safeAgentInspectionPolicy(value) {
  if (!value || typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !Object.entries(AGENT_INSPECTION_LIMITS).every(([key, expected]) => value[key] === expected)) fail();
  return Object.freeze({ available: value.available, ...AGENT_INSPECTION_LIMITS, catalogHash: value.catalogHash });
}
export function safeAgentEditPolicy(value) {
  if (!value || typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !Object.entries(AGENT_EDIT_LIMITS).every(([key, expected]) => value[key] === expected)) fail();
  return Object.freeze({ available: value.available, ...AGENT_EDIT_LIMITS, catalogHash: value.catalogHash });
}
export const agentInspectionAvailable = snapshot => ['chat_and_project_inspection', 'chat_and_reviewed_shot_edits', 'chat_and_reviewed_timeline_edits'].includes(snapshot?.scope) && snapshot.inspection?.available === true;
export const agentEditAvailable = snapshot => ['chat_and_reviewed_shot_edits', 'chat_and_reviewed_timeline_edits'].includes(snapshot?.scope) && snapshot.edit?.available === true;
export function safeAgentEditTarget(value, projectId, pinned = true) {
  if (!value || !uuid(pinned ? value.shotId : value.id) || !Number.isSafeInteger(pinned ? value.expectedRevision : value.revision) || (pinned ? value.expectedRevision : value.revision) < 1 || (pinned && value.projectId !== projectId)) fail();
  const title = bounded(value.title, AGENT_EDIT_LIMITS.maxTitleBytes), prompt = bounded(value.prompt, AGENT_EDIT_LIMITS.maxPromptBytes);
  if (!title.trim() || title.length > AGENT_EDIT_LIMITS.maxTitleChars || prompt.length > AGENT_EDIT_LIMITS.maxPromptChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(title + prompt) || [title, prompt].some(text => typeof text.isWellFormed === 'function' && !text.isWellFormed())) fail();
  return Object.freeze({ projectId, shotId: pinned ? value.shotId : value.id, expectedRevision: pinned ? value.expectedRevision : value.revision, title, prompt });
}
export const agentEditTargetKey = value => value ? JSON.stringify(value) : null;
export const agentRunContextMode = run => run?.contextMode === undefined ? AGENT_TYPED_CONTEXT : run.contextMode;
export function safeAgentRunInspection(value, projectId) {
  const contextMode = agentRunContextMode(value);
  if (![AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode)) fail();
  let provenance = null;
  if ([AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode)) {
    const source = value.provenance;
    if (!source || source.category !== (contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? 'project_selected_timeline_audio_gain' : contextMode === AGENT_TIMELINE_CONTEXT ? 'project_selected_timeline_timing' : contextMode === AGENT_EDIT_CONTEXT ? 'project_selected_shot_text' : 'project_saved_text_metadata') || source.projectId !== projectId || !Array.isArray(source.sourceRunIds) || source.sourceRunIds.length > 12 || !source.sourceRunIds.every(uuid) || new Set(source.sourceRunIds).size !== source.sourceRunIds.length) fail();
    provenance = Object.freeze({ category: source.category, projectId, sourceRunIds: Object.freeze([...source.sourceRunIds]) });
  } else if (value.provenance !== undefined && value.provenance !== null) fail();
  if (value.activity !== undefined && (!Array.isArray(value.activity) || value.activity.length > 3)) fail();
  if (contextMode !== AGENT_TYPED_CONTEXT && !value.activity?.length) fail();
  const activity = (value.activity || []).map(item => {
    if (!item || !['model', 'tool'].includes(item.kind) || ![1, 2].includes(item.ordinal) || !activityStatuses.has(item.status) || !uuid(item.id)) fail();
    if (item.kind === 'model' && item.status === 'intent') fail();
    const safe = { id: item.id, kind: item.kind, ordinal: item.ordinal, status: item.status };
    if (item.kind === 'tool') {
      if (contextMode === AGENT_TYPED_CONTEXT || (contextMode === AGENT_EDIT_CONTEXT) !== (item.name === 'mioon_propose_shot_update') || (contextMode === AGENT_TIMELINE_CONTEXT) !== (item.name === 'mioon_propose_timeline_clip_move') || (contextMode === AGENT_TIMELINE_GAIN_CONTEXT) !== (item.name === 'mioon_propose_timeline_clip_gain') || item.ordinal !== 1 || item.status === 'not_started' || !Object.hasOwn(toolOperations, item.name) || item.operation !== toolOperations[item.name]) fail();
      Object.assign(safe, { name: item.name, operation: item.operation });
      if ((item.status === 'completed') !== (item.resultJson !== undefined)) fail();
      if (item.resultJson !== undefined) {
        safe.resultJson = bounded(item.resultJson, AGENT_INSPECTION_LIMITS.maxResultBytes);
        try { JSON.parse(safe.resultJson); } catch { fail(); }
      }
    }
    return Object.freeze(safe);
  });
  if (new Set(activity.map(item => item.id)).size !== activity.length || activity.filter(item => item.kind === 'tool').length > 1 || (contextMode === AGENT_TYPED_CONTEXT && activity.length > 0) || new Set(activity.map(item => `${item.kind}:${item.ordinal}`)).size !== activity.length || activity.some((item, index) => `${item.kind}:${item.ordinal}` !== ['model:1', 'tool:1', 'model:2'][index])) fail();
  const editTarget = contextMode === AGENT_TIMELINE_GAIN_CONTEXT ? safeAgentTimelineGainTarget(value.editTarget, projectId) : contextMode === AGENT_TIMELINE_CONTEXT ? safeAgentTimelineTarget(value.editTarget, projectId) : contextMode === AGENT_EDIT_CONTEXT ? safeAgentEditTarget(value.editTarget, projectId) : null;
  if (![AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode) && value.editTarget != null) fail();
  return { contextMode, provenance, activity: Object.freeze(activity), ...(editTarget ? { editTarget } : {}) };
}
export const agentRunProvenanceEqual = (left, right) => agentRunContextMode(left) === agentRunContextMode(right) && JSON.stringify(left?.provenance || null) === JSON.stringify(right?.provenance || null) && agentEditTargetKey(left?.editTarget) === agentEditTargetKey(right?.editTarget);
export const agentRunActivityCompatible = (left, right) => (left?.activity || []).every((previous, index) => {
  const next = right?.activity?.[index];
  const progress = { not_started: 0, intent: 1, dispatch_started: 2, unknown: 3, completed: 4 };
  return next && progress[next.status] >= progress[previous.status] && ['id', 'kind', 'ordinal', 'name', 'operation'].every(key => previous[key] === next[key]) && (previous.resultJson === undefined || previous.resultJson === next.resultJson);
});
export function agentChatOutboundConsent(snapshot, contextMode = AGENT_TYPED_CONTEXT, destination, editTarget) {
  const configuration = snapshot?.settings.configuration;
  if (!configuration || ![AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT, AGENT_EDIT_CONTEXT, AGENT_TIMELINE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(contextMode)) return null;
  const result = { destination, protocol: configuration.protocol, model: configuration.model, context: contextMode };
  if (contextMode === AGENT_PROJECT_CONTEXT) {
    if (!agentInspectionAvailable(snapshot)) return null;
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_INSPECTION_LIMITS, catalogHash: snapshot.inspection.catalogHash });
  }
  if (contextMode === AGENT_EDIT_CONTEXT) {
    if (!agentEditAvailable(snapshot)) return null;
    let target; try { target = safeAgentEditTarget(editTarget, snapshot.projectId); } catch { return null; }
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_EDIT_LIMITS, catalogHash: snapshot.edit.catalogHash, shotId: target.shotId, expectedRevision: target.expectedRevision });
  }
  if (contextMode === AGENT_TIMELINE_CONTEXT) {
    if (!agentTimelineAvailable(snapshot)) return null;
    let target; try { target = safeAgentTimelineTarget(editTarget, snapshot.projectId); } catch { return null; }
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_TIMELINE_LIMITS, catalogHash: snapshot.timelineEdit.catalogHash, timelineId: target.timelineId, clipId: target.clipId, expectedRevision: target.expectedRevision });
  }
  if (contextMode === AGENT_TIMELINE_GAIN_CONTEXT) return agentTimelineGainOutboundConsent(snapshot, destination, editTarget);
  return result;
}
