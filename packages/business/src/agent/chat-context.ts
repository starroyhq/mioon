import {parseTimelineGainConsent, timelineGainConsentMatches, selectedTimelineGainMessage, TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION, TIMELINE_GAIN_EDIT_TOOL_LIMITS} from './timeline-gain-tool-policy.ts';
import {exactObject} from './config.ts';
import {AGENT_PROTOCOLS, AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT, agentTimelineGainModelContext} from '@mioon/contracts';
import {agentChatError} from './chat-errors.ts';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.ts';
import {EDIT_CAPABILITY_FIELDS, EDIT_TOOL_SYSTEM_INSTRUCTION, EDIT_TOOL_LIMITS, editToolCapability, selectedShotMessage} from './edit-tool-policy.ts';
import {READ_TOOL_SYSTEM_INSTRUCTION, READ_TOOL_LIMITS, readToolCapability} from './read-tool-policy.ts';

import {TIMELINE_EDIT_CAPABILITY_FIELDS, TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION, TIMELINE_EDIT_TOOL_LIMITS, timelineEditToolCapability, selectedTimelineClipMessage} from './timeline-edit-tool-policy.ts';

const baseFields = ['destination', 'protocol', 'model', 'context'];
const inspectionFields = ['projectId', 'schemaVersion', 'catalogHash', 'maxModelRequests', 'maxToolCalls', 'maxResultBytes'];
export function parseChatConsent(value) {
  if (value?.context === AGENT_TIMELINE_GAIN_CONTEXT) return parseTimelineGainConsent(value);
  const mode = value?.context, fields = mode === AGENT_TIMELINE_MOVE_CONTEXT ? ['projectId', ...TIMELINE_EDIT_CAPABILITY_FIELDS, 'timelineId', 'clipId', 'expectedRevision'] : mode === 'selected_shot_edit' ? ['projectId', ...EDIT_CAPABILITY_FIELDS, 'shotId', 'expectedRevision'] : mode === 'project_inspection' ? inspectionFields : [];
  if (!['typed_chat_only', 'project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT].includes(mode) ||
      !exactObject(value, [...baseFields, ...fields]) ||
      typeof value.destination !== 'string' || value.destination.length > 2080 ||
      typeof value.protocol !== 'string' || !Object.hasOwn(AGENT_PROTOCOLS, value.protocol) ||
      typeof value.model !== 'string' || value.model.length > 200) throw agentChatError('AGENT_CHAT_VALIDATION');
  if (mode !== 'typed_chat_only' && (typeof value.projectId !== 'string' || value.projectId.length !== 36 ||
      !Number.isSafeInteger(value.schemaVersion) || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !['maxModelRequests', 'maxToolCalls', 'maxResultBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0))) throw agentChatError('AGENT_CHAT_VALIDATION');
  if (mode === 'selected_shot_edit' && (typeof value.shotId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.shotId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 ||
    EDIT_CAPABILITY_FIELDS.filter(key => key.startsWith('max')).some(key => !Number.isSafeInteger(value[key]) || value[key] < 1))) throw agentChatError('AGENT_CHAT_VALIDATION');
  if (mode === AGENT_TIMELINE_MOVE_CONTEXT && (['timelineId', 'clipId'].some(key => typeof value[key] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value[key])) ||
    !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 ||
    TIMELINE_EDIT_CAPABILITY_FIELDS.filter(key => key.startsWith('max')).some(key => !Number.isSafeInteger(value[key]) || value[key] < 1))) throw agentChatError('AGENT_CHAT_VALIDATION');
  return Object.fromEntries([...baseFields, ...fields].map(key => [key, value[key]]));
}
export function inspectionConsentMatches(consent, projectId, available) {
  const capability = readToolCapability(available);
  return capability.available && consent.projectId === projectId && inspectionFields.filter(key => key !== 'projectId').every(key => consent[key] === capability[key]);
}
export function editConsentMatches(consent, projectId, available) {
  const capability = editToolCapability(available);
  return capability.available && consent.projectId === projectId && EDIT_CAPABILITY_FIELDS.every(key => consent[key] === capability[key]);
}
export function timelineEditConsentMatches(consent, projectId, available) {
  const capability = timelineEditToolCapability(available);
  return capability.available && consent.projectId === projectId && TIMELINE_EDIT_CAPABILITY_FIELDS.every(key => consent[key] === capability[key]);
}
export {timelineGainConsentMatches};
/** Provenance filtering precedes text selection. Viewing history never adds it. */
export function selectChatContext(runs, message, mode, limits, target) {
  const inspection = mode === 'project_inspection', edit = mode === 'selected_shot_edit', timelineEdit = mode === AGENT_TIMELINE_MOVE_CONTEXT, timelineGain = mode === AGENT_TIMELINE_GAIN_CONTEXT;
  if (edit) message = selectedShotMessage(message, target);
  if (timelineEdit) message = selectedTimelineClipMessage(message, target);
  if (timelineGain) message = selectedTimelineGainMessage(message, target, agentTimelineGainModelContext);
  const instruction = timelineGain ? TIMELINE_GAIN_EDIT_TOOL_SYSTEM_INSTRUCTION : timelineEdit ? TIMELINE_EDIT_TOOL_SYSTEM_INSTRUCTION : edit ? EDIT_TOOL_SYSTEM_INSTRUCTION : inspection ? READ_TOOL_SYSTEM_INSTRUCTION : CHAT_SYSTEM_INSTRUCTION;
  const maximum = timelineGain ? TIMELINE_GAIN_EDIT_TOOL_LIMITS.maxContextBytes : timelineEdit ? TIMELINE_EDIT_TOOL_LIMITS.maxContextBytes : edit ? EDIT_TOOL_LIMITS.maxContextBytes : inspection ? READ_TOOL_LIMITS.maxContextBytes : limits.contextBytes;
  const selected = [];
  let size = Buffer.byteLength(instruction) + Buffer.byteLength(message);
  if (size > maximum) throw agentChatError('AGENT_CHAT_LIMIT');
  for (const run of [...runs].reverse()) {
    if (run.status !== 'completed') continue;
    // A project-mode answer remains project-derived even when no call occurred.
    // Journal validation distinguishes genuine legacy typed runs from corrupt
    // project-data rows that lost their immutable provenance. Edit data is never
    // eligible for inspection context, and selected edits use typed history only.
    if (run.contextMode === 'selected_shot_edit' || run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT || run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT || !inspection && (run.contextMode || run.provenance)) continue;
    if (target && run.projectId !== target.projectId) continue;
    const pairBytes = Buffer.byteLength(run.userText) + Buffer.byteLength(run.assistantText);
    if (selected.length >= limits.historyRuns || size + pairBytes > maximum) break;
    selected.unshift(run); size += pairBytes;
  }
  return {messages: [{role: 'system', content: instruction}, ...selected.flatMap(run => [
    {role: 'user', content: run.userText}, {role: 'assistant', content: run.assistantText}]), {role: 'user', content: message}],
    sourceRunIds: selected.map(run => run.id)};
}
