import {AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_MOVE_PROVENANCE, AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_PROVENANCE} from '@mioon/contracts';
import {agentChatError, errorCode} from './chat-errors.ts';
import {buildAgentRequest} from './agent-gateway.ts';
import type {AgentGateway, AgentStreamDone} from './agent-gateway.ts';
import type {AgentConfiguration} from './config.ts';
import {toolScope} from './tool-wire.ts';
import type {WireMessage, ToolCall} from './tool-wire.ts';
import {READ_TOOL_LIMITS, READ_TOOL_OPERATIONS} from './read-tool-policy.ts';
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
import type {ChatJournal, ChatStoredEvent} from './chat-journal.ts';
import type {ChatStep} from './chat-step-journal.ts';

export interface InspectionService {
  createContext(input: {projectId: string; capabilities: unknown; maxCalls: number; maxResultBytes: number; maxTotalBytes: number}): unknown;
  dispatch(context: unknown, operation: string, arguments_: Record<string, unknown>): unknown;
}
export interface EditProposalService {
  createInside(input: {projectId: string; runId: string; target: unknown; changes: Record<string, unknown>; toolCall: ToolCall}): {id: string; digest: string};
}
export interface WorkflowControl {
  signal?: AbortSignal;
  live(): boolean;
  commit<T>(operation: () => T): T;
  publish(events: ChatStoredEvent[]): void;
  beforeSubmit?: () => void;
  flush(): void;
  text(text: string): void;
}
export interface ReadToolWorkflowOptions {
  runId: string;
  projectId: string;
  configuration: AgentConfiguration;
  messages: readonly WireMessage[];
  provenance: unknown;
  apiKey?: string | null;
  gateway: AgentGateway;
  selfPort?: number;
  journal: ChatJournal;
  inspection: InspectionService;
  editService?: EditProposalService;
  target?: unknown;
  contextMode: string;
  control: WorkflowControl;
}

/** Bounded orchestration with a closed read-or-propose scope. Reads use the
 * branded inspection dispatcher; edits only create review proposals atomically.
 * Nothing here runs on startup, and no model output can apply a mutation. */
export async function runReadToolWorkflow({runId, projectId, configuration, messages, provenance,
  apiKey, gateway, selfPort, journal, inspection, editService, target, contextMode, control}: ReadToolWorkflowOptions): Promise<void> {
  const timelineEdit = contextMode === AGENT_TIMELINE_MOVE_CONTEXT, timelineGain = contextMode === AGENT_TIMELINE_GAIN_CONTEXT;
  const scopeOptions = target ? {scope: timelineGain ? AGENT_TIMELINE_GAIN_CONTEXT : timelineEdit ? AGENT_TIMELINE_MOVE_CONTEXT : 'selected_shot_edit'} : {}, scope = toolScope(scopeOptions);
  if ((timelineEdit || timelineGain) && !target) throw agentChatError('AGENT_CHAT_VALIDATION');
  const committed = <T>(operation: () => T): T => {
    const saved = control.commit(operation);
    const events = (saved as {events?: ChatStoredEvent[]} | null | undefined)?.events;
    if (events?.length) control.publish(events);
    return saved;
  };
  const first = committed(() => journal.steps(projectId, runId)).find(step => step.kind === 'model');
  if (!first || !control.live()) return;
  async function request(step: ChatStep, readTools: unknown): Promise<AgentStreamDone | null> {
    if (!control.live()) return null;
    control.beforeSubmit?.();
    committed(() => journal.modelDispatch(runId, step.id));
    if (!control.live()) return null;
    let terminal: AgentStreamDone | null = null;
    for await (const item of gateway({configuration: {...configuration}, apiKey, messages: structuredClone(messages) as WireMessage[],
      readTools: structuredClone(readTools), signal: control.signal, selfPort, ...(control.beforeSubmit ? {beforeSubmit: control.beforeSubmit} : {})})) {
      if (!control.live()) return null;
      if (terminal) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
      if (item?.type === 'delta' && typeof item.text === 'string' && wellFormed(item.text)) control.text(item.text);
      else if (item?.type === 'done') {
        if (item.finishReason === 'length') throw agentChatError('AGENT_CHAT_TRUNCATED');
        if (item.finishReason === 'content_filter') throw agentChatError('AGENT_CHAT_PROVIDER_ERROR');
        if (!['stop', 'tool_calls'].includes(item.finishReason)) throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
        terminal = item;
      } else throw agentChatError('AGENT_CHAT_PROTOCOL_ERROR');
    }
    if (!control.live()) return null;
    if (!terminal) throw agentChatError('AGENT_CHAT_TRUNCATED');
    if (readTools !== null && (readTools as {phase?: unknown}).phase === 'answer' && (terminal.finishReason !== 'stop' || terminal.toolCall)) throw agentChatError('AGENT_CHAT_TOOLS_UNSUPPORTED');
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
  control.beforeSubmit?.();
  const call = completed.toolCall as ToolCall, parsed = scope.parse(call.name, call.argumentsJson);
  const toolProvenance = {category: timelineGain ? AGENT_TIMELINE_GAIN_PROVENANCE : timelineEdit ? AGENT_TIMELINE_MOVE_PROVENANCE : target ? 'project_selected_shot_text' : 'project_saved_text_metadata', projectId, operation: parsed.operation};
  const intent = committed(() => journal.toolIntent(runId, first.id, {toolCall: call, provenance: toolProvenance}));
  if (!control.live()) return;
  // Publishing the durable intent can reenter the host and revoke authority.
  control.beforeSubmit?.();
  // Context identity and its capabilities are created solely by the backend.
  const inspectionScope = target ? null : inspection.createContext({projectId, capabilities: Object.values(READ_TOOL_OPERATIONS), maxCalls: 1,
    maxResultBytes: READ_TOOL_LIMITS.maxResultBytes - 1024, maxTotalBytes: READ_TOOL_LIMITS.maxResultBytes - 1024});
  const captured = committed(() => journal.captureTool(runId, intent.step.id, () => {
    if (!control.live()) throw agentChatError('AGENT_CHAT_ABORTED');
    // captureTool commits dispatch_started separately. Recheck after that
    // boundary, with no async gap before the synchronous tool effect.
    control.beforeSubmit?.();
    if (target) {
      const proposal = (editService as EditProposalService).createInside({projectId, runId, target, changes: parsed.arguments, toolCall: call});
      const result = {kind: timelineGain ? 'untrusted_timeline_clip_gain_proposal' : timelineEdit ? 'untrusted_timeline_clip_move_proposal' : 'untrusted_shot_update_proposal', operation: parsed.operation, status: 'pending_review',
        applied: false, proposalId: proposal.id, digest: proposal.digest};
      const resultJson = JSON.stringify(result);
      if (Buffer.byteLength(resultJson) > scope.limits.maxResultBytes) throw agentChatError('AGENT_CHAT_LIMIT');
      return {result, resultJson, provenance: toolProvenance};
    }
    let data;
    try { data = inspection.dispatch(inspectionScope, parsed.operation, parsed.dispatchArguments); }
    catch (error) {
      if (errorCode(error) === 'INSPECTION_BUDGET_EXCEEDED') throw agentChatError('AGENT_CHAT_LIMIT');
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
