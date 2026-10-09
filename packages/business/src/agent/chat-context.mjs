import {exactObject} from './config.mjs';
import {AGENT_PROTOCOLS} from '@mioon/contracts';
import {agentChatError} from './chat-errors.mjs';
import {CHAT_SYSTEM_INSTRUCTION} from './chat-policy.mjs';
import {READ_TOOL_SYSTEM_INSTRUCTION, READ_TOOL_LIMITS, readToolCapability} from './read-tool-policy.mjs';

const baseFields = ['destination', 'protocol', 'model', 'context'];
const inspectionFields = ['projectId', 'schemaVersion', 'catalogHash', 'maxModelRequests', 'maxToolCalls', 'maxResultBytes'];
export function parseChatConsent(value) {
  const mode = value?.context;
  if (!['typed_chat_only', 'project_inspection'].includes(mode) ||
      !exactObject(value, [...baseFields, ...(mode === 'project_inspection' ? inspectionFields : [])]) ||
      typeof value.destination !== 'string' || value.destination.length > 2080 ||
      typeof value.protocol !== 'string' || !Object.hasOwn(AGENT_PROTOCOLS, value.protocol) ||
      typeof value.model !== 'string' || value.model.length > 200) throw agentChatError('AGENT_CHAT_VALIDATION');
  if (mode === 'project_inspection' && (typeof value.projectId !== 'string' || value.projectId.length !== 36 ||
      !Number.isSafeInteger(value.schemaVersion) || typeof value.catalogHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalogHash) ||
      !['maxModelRequests', 'maxToolCalls', 'maxResultBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0))) throw agentChatError('AGENT_CHAT_VALIDATION');
  return Object.fromEntries([...baseFields, ...(mode === 'project_inspection' ? inspectionFields : [])].map(key => [key, value[key]]));
}
export function inspectionConsentMatches(consent, projectId, available) {
  const capability = readToolCapability(available);
  return capability.available && consent.projectId === projectId && inspectionFields.filter(key => key !== 'projectId').every(key => consent[key] === capability[key]);
}
/** Provenance filtering precedes text selection. Viewing history never adds it. */
export function selectChatContext(runs, message, mode, limits) {
  const inspection = mode === 'project_inspection';
  const instruction = inspection ? READ_TOOL_SYSTEM_INSTRUCTION : CHAT_SYSTEM_INSTRUCTION;
  const maximum = inspection ? READ_TOOL_LIMITS.maxContextBytes : limits.contextBytes;
  const selected = [];
  let size = Buffer.byteLength(instruction) + Buffer.byteLength(message);
  if (size > maximum) throw agentChatError('AGENT_CHAT_LIMIT');
  for (const run of [...runs].reverse()) {
    if (run.status !== 'completed') continue;
    // A project-mode answer remains project-derived even when no call occurred.
    // Journal validation distinguishes genuine legacy typed runs from corrupt
    // new inspection rows that lost their immutable provenance.
    if (!inspection && (run.contextMode === 'project_inspection' || run.provenance)) continue;
    const pairBytes = Buffer.byteLength(run.userText) + Buffer.byteLength(run.assistantText);
    if (selected.length >= limits.historyRuns || size + pairBytes > maximum) break;
    selected.unshift(run); size += pairBytes;
  }
  return {messages: [{role: 'system', content: instruction}, ...selected.flatMap(run => [
    {role: 'user', content: run.userText}, {role: 'assistant', content: run.assistantText}]), {role: 'user', content: message}],
    sourceRunIds: selected.map(run => run.id)};
}
