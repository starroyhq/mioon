// Browser-only projections of the fixed, read-only Agent policy. Nothing here
// dispatches a tool, resolves a URL, or turns a saved permission into a new run.
export const AGENT_TYPED_CONTEXT = 'typed_chat_only';
export const AGENT_PROJECT_CONTEXT = 'project_inspection';
export const AGENT_INSPECTION_LIMITS = Object.freeze({ schemaVersion: 1, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192 });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = () => { throw Object.assign(new Error('Invalid Agent inspection response.'), { code: 'INVALID_RESPONSE' }); };
const bounded = (value, max) => { if (typeof value !== 'string' || new TextEncoder().encode(value).length > max) fail(); return value; };
const activityStatuses = new Set(['not_started', 'intent', 'dispatch_started', 'completed', 'unknown']);
const toolOperations = Object.freeze({ mioon_project_inspect: 'project.inspect', mioon_asset_inspect: 'asset.inspect', mioon_shot_inspect: 'shot.inspect', mioon_timeline_inspect: 'timeline.inspect' });

export function safeAgentInspectionPolicy(value) {
  if (!value || typeof value.available !== 'boolean' || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !Object.entries(AGENT_INSPECTION_LIMITS).every(([key, expected]) => value[key] === expected)) fail();
  return Object.freeze({ available: value.available, ...AGENT_INSPECTION_LIMITS, catalogHash: value.catalogHash });
}
export const agentInspectionAvailable = snapshot => snapshot?.scope === 'chat_and_project_inspection' && snapshot.inspection?.available === true;
export const agentRunContextMode = run => run?.contextMode === undefined ? AGENT_TYPED_CONTEXT : run.contextMode;
export function safeAgentRunInspection(value, projectId) {
  const contextMode = agentRunContextMode(value);
  if (![AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT].includes(contextMode)) fail();
  let provenance = null;
  if (contextMode === AGENT_PROJECT_CONTEXT) {
    const source = value.provenance;
    if (!source || source.category !== 'project_saved_text_metadata' || source.projectId !== projectId || !Array.isArray(source.sourceRunIds) || source.sourceRunIds.length > 12 || !source.sourceRunIds.every(uuid) || new Set(source.sourceRunIds).size !== source.sourceRunIds.length) fail();
    provenance = Object.freeze({ category: source.category, projectId, sourceRunIds: Object.freeze([...source.sourceRunIds]) });
  } else if (value.provenance !== undefined && value.provenance !== null) fail();
  if (value.activity !== undefined && (!Array.isArray(value.activity) || value.activity.length > 3)) fail();
  if (contextMode === AGENT_PROJECT_CONTEXT && !value.activity?.length) fail();
  const activity = (value.activity || []).map(item => {
    if (!item || !['model', 'tool'].includes(item.kind) || ![1, 2].includes(item.ordinal) || !activityStatuses.has(item.status) || !uuid(item.id)) fail();
    if (item.kind === 'model' && item.status === 'intent') fail();
    const safe = { id: item.id, kind: item.kind, ordinal: item.ordinal, status: item.status };
    if (item.kind === 'tool') {
      if (contextMode !== AGENT_PROJECT_CONTEXT || item.ordinal !== 1 || item.status === 'not_started' || !Object.hasOwn(toolOperations, item.name) || item.operation !== toolOperations[item.name]) fail();
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
  return { contextMode, provenance, activity: Object.freeze(activity) };
}
export const agentRunProvenanceEqual = (left, right) => agentRunContextMode(left) === agentRunContextMode(right) && JSON.stringify(left?.provenance || null) === JSON.stringify(right?.provenance || null);
export const agentRunActivityCompatible = (left, right) => (left?.activity || []).every((previous, index) => {
  const next = right?.activity?.[index];
  return next && ['id', 'kind', 'ordinal', 'name', 'operation'].every(key => previous[key] === next[key]) && (previous.resultJson === undefined || previous.resultJson === next.resultJson);
});
export function agentChatOutboundConsent(snapshot, contextMode = AGENT_TYPED_CONTEXT, destination) {
  const configuration = snapshot?.settings.configuration;
  if (!configuration || ![AGENT_TYPED_CONTEXT, AGENT_PROJECT_CONTEXT].includes(contextMode)) return null;
  const result = { destination, protocol: configuration.protocol, model: configuration.model, context: contextMode };
  if (contextMode === AGENT_PROJECT_CONTEXT) {
    if (!agentInspectionAvailable(snapshot)) return null;
    Object.assign(result, { projectId: snapshot.projectId, ...AGENT_INSPECTION_LIMITS, catalogHash: snapshot.inspection.catalogHash });
  }
  return result;
}
