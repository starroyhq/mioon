import {AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_MOVE_PROVENANCE} from '@mioon/contracts';
import {agentChatError} from './chat-errors.mjs';
import {buildAgentRequest} from './agent-gateway.mjs';
import {toolScope} from './tool-wire.mjs';
import {READ_TOOL_LIMITS, READ_TOOL_OPERATIONS} from './read-tool-policy.mjs';

/** Bounded orchestration with a closed read-or-propose scope. Reads use the
 * branded inspection dispatcher; edits only create review proposals atomically.
 * Nothing here runs on startup, and no model output can apply a mutation. */
export async function runReadToolWorkflow({runId, projectId, configuration, messages, provenance,
  apiKey, gateway, selfPort, journal, inspection, editService, target, contextMode, control}) {
  const timelineEdit = contextMode === AGENT_TIMELINE_MOVE_CONTEXT;
  const scopeOptions = target ? {scope: timelineEdit ? AGENT_TIMELINE_MOVE_CONTEXT : 'selected_shot_edit'} : {}, scope = toolScope(scopeOptions);
  if (timelineEdit && !target) throw agentChatError('AGENT_CHAT_VALIDATION');
  const committed = operation => {
    const saved = control.commit(operation);
    if (saved.events?.length) control.publish(saved.events);
    return saved;
  };
  const first = control.commit(() => journal.steps(projectId, runId)).find(step => step.kind === 'model');
  if (!first || !control.live()) return;
  async function request(step, readTools) {
    if (!control.live()) return null;
    committed(() => journal.modelDispatch(runId, step.id));
    if (!control.live()) return null;
    let terminal = null;
    for await (const item of gateway({configuration: {...configuration}, apiKey, messages: structuredClone(messages),
      readTools: structuredClone(readTools), signal: control.signal, selfPort})) {
      if (!control.live()) return null;
      if (terminal) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
      if (item?.type === 'delta' && typeof item.text === 'string' && item.text.isWellFormed()) control.text(item.text);
      else if (item?.type === 'done') {
        if (item.finishReason === 'length') throw agentChatError('AGENT_CHAT_TRUNCATED');
        if (item.finishReason === 'content_filter') throw agentChatError('AGENT_CHAT_PROVIDER_ERROR');
        if (!['stop', 'tool_calls'].includes(item.finishReason)) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
        terminal = item;
      } else throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
    }
    if (!control.live()) return null;
    if (!terminal) throw agentChatError('AGENT_CHAT_TRUNCATED');
    if (readTools.phase === 'answer' && (terminal.finishReason !== 'stop' || terminal.toolCall)) throw agentChatError('AGENT_CHAT_TOOLS_UNSUPPORTED');
    if (terminal.finishReason === 'tool_calls') {
      const call = terminal.toolCall;
      if (!call || !terminal.providerOutput) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
      const parsed = scope.parse(call.name, call.argumentsJson);
      if (JSON.stringify(parsed.arguments) !== JSON.stringify(call.arguments)) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
    } else if (terminal.toolCall) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
    control.flush();
    if (!control.live()) return null;
    committed(() => journal.modelComplete(runId, step.id, {output: terminal}));
    return control.live() ? terminal : null;
  }
  const completed = await request(first, {phase: 'request', ...scopeOptions});
  if (!completed || !control.live() || completed.finishReason === 'stop') return;
  const call = completed.toolCall, parsed = scope.parse(call.name, call.argumentsJson);
  const toolProvenance = {category: timelineEdit ? AGENT_TIMELINE_MOVE_PROVENANCE : target ? 'project_selected_shot_text' : 'project_saved_text_metadata', projectId, operation: parsed.operation};
  const intent = committed(() => journal.toolIntent(runId, first.id, {toolCall: call, provenance: toolProvenance}));
  if (!control.live()) return;
  // Context identity and its capabilities are created solely by the backend.
  const inspectionScope = target ? null : inspection.createContext({projectId, capabilities: Object.values(READ_TOOL_OPERATIONS), maxCalls: 1,
    maxResultBytes: READ_TOOL_LIMITS.maxResultBytes - 1024, maxTotalBytes: READ_TOOL_LIMITS.maxResultBytes - 1024});
  const captured = committed(() => journal.captureTool(runId, intent.step.id, () => {
    if (!control.live()) throw agentChatError('AGENT_CHAT_ABORTED');
    if (target) {
      const proposal = editService.createInside({projectId, runId, target, changes: parsed.arguments, toolCall: call});
      const result = {kind: timelineEdit ? 'untrusted_timeline_clip_move_proposal' : 'untrusted_shot_update_proposal', operation: parsed.operation, status: 'pending_review',
        applied: false, proposalId: proposal.id, digest: proposal.digest};
      const resultJson = JSON.stringify(result);
      if (Buffer.byteLength(resultJson) > scope.limits.maxResultBytes) throw agentChatError('AGENT_CHAT_LIMIT');
      return {result, resultJson, provenance: toolProvenance};
    }
    let data;
    try { data = inspection.dispatch(inspectionScope, parsed.operation, parsed.dispatchArguments); }
    catch (error) {
      if (error?.code === 'INSPECTION_BUDGET_EXCEEDED') throw agentChatError('AGENT_CHAT_LIMIT');
      throw agentChatError('AGENT_CHAT_INSPECTION_UNAVAILABLE');
    }
    const result = {kind: 'untrusted_project_inspection', projectId, operation: parsed.operation, data};
    const resultJson = JSON.stringify(result);
    if (Buffer.byteLength(resultJson) > READ_TOOL_LIMITS.maxResultBytes) throw agentChatError('AGENT_CHAT_LIMIT');
    return {result, resultJson, provenance: toolProvenance};
  }));
  if (!control.live()) return;
  const resultJson = captured.step.observation?.resultJson;
  if (typeof resultJson !== 'string') throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE');
  const readTools = {phase: 'answer', ...scopeOptions, toolCall: call, providerOutput: completed.providerOutput, result: resultJson};
  const built = buildAgentRequest({configuration, messages, readTools, selfPort});
  const continuation = committed(() => journal.prepareContinuation(runId, {protocol: configuration.protocol,
    body: built.body, context: messages, provenance}));
  if (!control.live()) return;
  await request(continuation.step, readTools);
}
