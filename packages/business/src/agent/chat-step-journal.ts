import {createHash, randomUUID} from 'node:crypto';
import {types, isDeepStrictEqual} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {agentChatError} from './chat-errors.ts';
import {exactObject} from './config.ts';
import {EDIT_TOOL_LIMITS, EDIT_CAPABILITY_FIELDS, editToolPolicy, validEditText, selectedShotMessage, parseEditToolArguments} from './edit-tool-policy.ts';
import {deriveAgentEndpoint, AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_MOVE_PROVENANCE, isAgentTimelineMoveTarget, AGENT_TIMELINE_GAIN_CONTEXT, AGENT_TIMELINE_GAIN_PROVENANCE, isAgentTimelineGainTarget, agentTimelineGainReviewTarget, agentTimelineGainModelContext} from '@mioon/contracts';
import {TIMELINE_EDIT_TOOL_LIMITS, TIMELINE_EDIT_CAPABILITY_FIELDS, timelineEditToolPolicy, selectedTimelineClipMessage, parseTimelineEditToolArguments} from './timeline-edit-tool-policy.ts';
import {buildAgentRequest} from './agent-gateway.ts';
import {anthropicMessages} from './anthropic-wire.ts';
import {TIMELINE_GAIN_EDIT_TOOL_LIMITS, timelineGainEditToolPolicy, selectedTimelineGainMessage, parseTimelineGainEditToolArguments, parseTimelineGainConsent, timelineGainConsentMatches} from './timeline-gain-tool-policy.ts';
import type {ChatRun, ChatStoredEvent, ChatProvenance, ChatActivityEntry} from './chat-journal.ts';
import type {ToolCall, WireMessage} from './tool-wire.ts';

// This module persists evidence, never acquires authority or dispatches a tool.
// Only captureTool's trusted synchronous callback may perform the shared read.
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const OPERATIONS: readonly string[] = ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect', 'shot.update', 'timeline.clip.update'];
const isProposal = (mode: string | undefined): boolean => mode !== undefined && ['selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(mode);
const operationMatches = (operation: string | undefined, mode: string | undefined): boolean => (operation === 'shot.update') === (mode === 'selected_shot_edit') &&
  (operation === 'timeline.clip.update') === (mode === AGENT_TIMELINE_MOVE_CONTEXT || mode === AGENT_TIMELINE_GAIN_CONTEXT);
const STATUSES: readonly string[] = ['not_started', 'intent', 'dispatch_started', 'completed', 'unknown'];
function bad(): never { throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE'); }
function full(): never { throw agentChatError('AGENT_CHAT_STORAGE_LIMIT'); }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const wellFormed = (value: string): boolean => Buffer.from(value, 'utf8').toString('utf8') === value;
const text = (value: unknown, maximum: number, minimum = 0): value is string => typeof value === 'string' && wellFormed(value) && Buffer.byteLength(value) <= maximum && value.length >= minimum;
const encode = (value: unknown): string => JSON.stringify(value);
const same = (a: unknown, b: unknown): boolean => encode(a) === encode(b);
const now = (): string => new Date().toISOString();
const size = (value: string): number => Buffer.byteLength(value) + 512;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

export interface ChatObservationProvenance {category: string; projectId: string; operation: string}
export interface ChatRequestRecord {protocol: string; body: string; context: unknown[]; provenance: ChatProvenance; [key: string]: unknown}
export interface ChatToolIntent {toolCall: ToolCall; provenance: ChatObservationProvenance}
export interface ChatOutput {
  type: 'done';
  finishReason: string;
  toolCall?: ToolCall;
  providerOutput?: unknown;
  usage?: Record<string, number>;
  [key: string]: unknown;
}
export interface ChatObservation {result: Record<string, unknown>; resultJson: string; provenance: ChatObservationProvenance}
export interface ChatPolicy {context: string; catalog: Array<{name: string; [key: string]: unknown}>; [key: string]: unknown}
export interface ChatExecution {
  version: number;
  policy: ChatPolicy;
  request: ChatRequestRecord;
  target?: unknown;
  [key: string]: unknown;
}
export interface ChatStep {
  version: number;
  id: string;
  runId: string;
  projectId: string;
  position: number;
  kind: 'model' | 'tool';
  ordinal: number;
  status: string;
  createdAt: string;
  requestId?: string;
  request?: ChatRequestRecord;
  modelStepId?: string;
  intent?: ChatToolIntent;
  dispatchStartedAt?: string;
  completedAt?: string;
  output?: ChatOutput;
  observation?: ChatObservation;
  [key: string]: unknown;
}
export interface ChatStepJournalOptions {
  store: {db: DatabaseSync; tx<T>(operation: () => T): T};
  readRun: (row: unknown) => ChatRun | null;
  row: (runId: string) => unknown;
  account: (delta: number) => void;
  saveRun: (previous: {bytes: number}, run: ChatRun) => number;
  appendEvent: (run: ChatRun, type: 'snapshot' | 'delta' | 'terminal', revision: number, text?: string) => {event: ChatStoredEvent; bytes: number};
  revision: (projectId: string) => number;
}
interface RunRowLike {bytes: number}
interface StepRow {id: string; runId: string; projectId: string; position: number; kind: string; status: string; bytes: number; data: string | null}

// Descriptor-first copying avoids evaluating getters/toJSON hooks. This is a
// narrow trusted-backend API, but a provider-shaped value is still untrusted.
function json(value: unknown, maximum = MAX_STEP_BYTES): unknown {
  let nodes = 0;
  function copy(item: unknown, depth = 0): unknown {
    if (++nodes > 20000 || depth > 30) bad();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item)) bad();
    const array = Array.isArray(item);
    if (array) { if (Object.getPrototypeOf(item) !== Array.prototype) bad(); }
    else if (!object(item)) bad();
    const result: Record<string, unknown> = array ? [] as unknown as Record<string, unknown> : {};
    if (array && item.length > 10000) bad();
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined ||
        /^(?:__proto__|constructor|prototype|toJSON|apiKey|authorization|headers|credential|credentials|accessToken|access_token|encrypted_content)$/iu.test(key) ||
        array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) bad();
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && Object.keys(result).length !== item.length) bad();
    return result;
  }
  const result = copy(value), encoded = encode(result);
  if (!text(encoded, maximum)) bad();
  return result;
}
function parse(value: unknown, maximum: number): unknown {
  if (!text(value, maximum, 1)) bad();
  try { return json(JSON.parse(value), maximum); } catch { bad(); }
}
const provenanceCategories: readonly string[] = ['project_saved_text_metadata', 'project_selected_shot_text', AGENT_TIMELINE_MOVE_PROVENANCE, AGENT_TIMELINE_GAIN_PROVENANCE];
function provenance(value: unknown, projectId: string, observation = false): void {
  if (!exactObject(value, observation ? ['category', 'projectId', 'operation'] : ['category', 'projectId', 'sourceRunIds']) ||
    !provenanceCategories.includes(value.category as string) || value.projectId !== projectId) bad();
  if (observation && ((value.category === 'project_selected_shot_text') !== (value.operation === 'shot.update') ||
    ((value.category === AGENT_TIMELINE_MOVE_PROVENANCE || value.category === AGENT_TIMELINE_GAIN_PROVENANCE) !== (value.operation === 'timeline.clip.update')))) bad();
  if (observation) {
    if (!OPERATIONS.includes(value.operation as string)) bad();
  } else {
    const sourceRunIds = value.sourceRunIds;
    if (!Array.isArray(sourceRunIds) || sourceRunIds.length > 12 || sourceRunIds.some(id => !uuid(id)) || new Set(sourceRunIds).size !== sourceRunIds.length) bad();
  }
}
function request(value: unknown, run: ChatRun, round: number): Record<string, unknown> {
  if (!exactObject(value, ['protocol', 'body', 'context', 'provenance']) || value.protocol !== run.configuration.protocol ||
    !['chat_completions', 'responses', 'anthropic_messages'].includes(value.protocol as string)) bad();
  provenance(value.provenance, run.projectId);
  if (!same(value.provenance, run.provenance) || !Array.isArray(value.context) || value.context.length > 64) bad();
  json(value.context, MAX_BODY_BYTES);
  const body = parse(value.body, MAX_BODY_BYTES);
  const allowed = value.protocol === 'anthropic_messages' ? ['model', 'messages', 'system', 'stream', 'max_tokens', 'thinking', 'tools', 'tool_choice'] : ['model', 'messages', 'input', 'instructions', 'stream', 'store', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
    'thinking', 'enable_thinking', 'provider', 'reasoning_effort', 'reasoning', 'truncation', 'tools', 'tool_choice', 'parallel_tool_calls'];
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || body.model !== run.configuration.model || body.stream !== true ||
    Object.hasOwn(body, 'store') && body.store !== false) bad();
  if (value.protocol === 'anthropic_messages') {
    if (!Array.isArray(body.messages) || !text(body.system, 32768, 1) || !Number.isSafeInteger(body.max_tokens) || (body.max_tokens as number)<1 || (body.max_tokens as number)>2048 ||
      !exactObject(body.thinking, ['type']) || body.thinking.type !== 'disabled') bad();
  } else if (value.protocol === 'chat_completions' ? !Array.isArray(body.messages) || Object.hasOwn(body, 'input') :
    !Array.isArray(body.input) || !text(body.instructions, 32768) || Object.hasOwn(body, 'messages') || body.store !== false) bad();
  if (round === 2 && (Object.hasOwn(body, 'tools') && (!Array.isArray(body.tools) || body.tools.length) ||
    Object.hasOwn(body, 'tool_choice') && (value.protocol === 'anthropic_messages'
      ? !exactObject(body.tool_choice, ['type']) || body.tool_choice.type !== 'none'
      : body.tool_choice !== 'none'))) bad();
  return body;
}
function toolCall(value: unknown, mode: string | undefined): void {
  if (!keys(value, ['id', 'name', 'arguments', 'argumentsJson'], ['itemId']) || !text(value.id, 256, 1) || /[\x00-\x20\x7f]/u.test(value.id) ||
    !text(value.name, 100, 1) || Object.hasOwn(value, 'itemId') && (!text(value.itemId, 256, 1) || /[\x00-\x20\x7f]/u.test(value.itemId)) ||
    !object(value.arguments) || !same(parse(value.argumentsJson, mode === AGENT_TIMELINE_GAIN_CONTEXT ? TIMELINE_GAIN_EDIT_TOOL_LIMITS.maxArgumentsBytes : mode === AGENT_TIMELINE_MOVE_CONTEXT ? TIMELINE_EDIT_TOOL_LIMITS.maxArgumentsBytes : mode === 'selected_shot_edit' ? EDIT_TOOL_LIMITS.maxArgumentsBytes : 2048), value.arguments)) bad();
}
function output(value: unknown, protocol: string, mode: string | undefined): void {
  if (!keys(value, ['type', 'finishReason'], ['toolCall', 'providerOutput', 'usage']) || value.type !== 'done' || !['stop', 'tool_calls'].includes(value.finishReason as string)) bad();
  json(value, MAX_OUTPUT_BYTES);
  if (Object.hasOwn(value, 'usage')) {
    if (!keys(value.usage, [], ['prompt_tokens', 'completion_tokens', 'total_tokens'])) bad();
    const usage = value.usage;
    if (Object.values(usage).some(count => !Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 10000000) || (usage.completion_tokens as number) > 2048) bad();
  }
  if (value.finishReason === 'tool_calls') {
    toolCall(value.toolCall, mode);
    if (isProposal(mode)) { try { (mode === AGENT_TIMELINE_GAIN_CONTEXT ? parseTimelineGainEditToolArguments : mode === AGENT_TIMELINE_MOVE_CONTEXT ? parseTimelineEditToolArguments : parseEditToolArguments)((value.toolCall as ToolCall).name, (value.toolCall as ToolCall).argumentsJson); } catch { bad(); } }
    if ((protocol === 'responses') !== Object.hasOwn(value.toolCall as object, 'itemId')) bad();
    if (protocol === 'chat_completions') {
      const message = value.providerOutput;
      if (!keys(message, ['role', 'content', 'tool_calls'], ['refusal']) || message.role !== 'assistant' || message.content !== null && !text(message.content, 256 * 1024) ||
        Object.hasOwn(message, 'refusal') && !text(message.refusal, 256 * 1024) ||
        !Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) bad();
      const call = message.tool_calls[0];
      if (!exactObject(call, ['id', 'type', 'function']) || call.id !== (value.toolCall as ToolCall).id || call.type !== 'function' ||
        !exactObject(call.function, ['name', 'arguments']) || call.function.name !== (value.toolCall as ToolCall).name || call.function.arguments !== (value.toolCall as ToolCall).argumentsJson) bad();
    } else if (protocol === 'anthropic_messages') {
      const message = value.providerOutput;
      if (!exactObject(message, ['role', 'content']) || message.role !== 'assistant' || !Array.isArray(message.content) || !message.content.length || message.content.length > 128) bad();
      let calls = 0;
      for (const block of message.content) {
        if (object(block) && block.type === 'text') {
          if (!exactObject(block, ['type', 'text']) || !text(block.text, 256 * 1024)) bad();
        } else {
          const expected = value.toolCall as ToolCall;
          if (!exactObject(block, ['type', 'id', 'name', 'input']) || block.type !== 'tool_use' || ++calls !== 1 || block.id !== expected.id || block.name !== expected.name || !isDeepStrictEqual(block.input, expected.arguments)) bad();
        }
      }
      if (calls !== 1) bad();
    } else {
      if (!Array.isArray(value.providerOutput) || value.providerOutput.length > 64) bad();
      const providerOutput = value.providerOutput as unknown[];
      const calls = providerOutput.filter(item => object(item) && item.type === 'function_call');
      if (calls.length !== 1) bad();
      const call = calls[0];
      if (!keys(call, ['type', 'id', 'call_id', 'name', 'arguments'], ['status']) || call.call_id !== (value.toolCall as ToolCall).id || call.id !== (value.toolCall as ToolCall).itemId ||
        call.name !== (value.toolCall as ToolCall).name || call.arguments !== (value.toolCall as ToolCall).argumentsJson || Object.hasOwn(call, 'status') && call.status !== 'completed') bad();
      const ids = new Set<unknown>();
      for (const item of providerOutput) {
        const itemId = object(item) ? item.id : undefined;
        if (!text(itemId, 256, 1) || ids.has(itemId)) bad(); ids.add(itemId);
        if (object(item) && item.type === 'function_call') continue;
        if (!keys(item, ['id', 'type', 'role', 'status', 'content'], ['phase']) || item.type !== 'message' || item.role !== 'assistant' ||
          item.status !== 'completed' || !Array.isArray(item.content) || !item.content.length || item.content.length > 128 ||
          Object.hasOwn(item, 'phase') && item.phase !== null && item.phase !== '') bad();
        for (const part of item.content as unknown[]) {
          if (object(part) && part.type === 'output_text') {
            if (!keys(part, ['type', 'text'], ['annotations', 'logprobs']) || !text(part.text, 256 * 1024)) bad();
            for (const partKey of ['annotations', 'logprobs']) if (Object.hasOwn(part, partKey) && part[partKey] !== null && (!Array.isArray(part[partKey]) || (part[partKey] as unknown[]).length)) bad();
          } else if (!exactObject(part, ['type', 'refusal']) || part.type !== 'refusal' || !text(part.refusal, 256 * 1024)) bad();
        }
      }
    }
  } else if (Object.hasOwn(value, 'toolCall') || Object.hasOwn(value, 'providerOutput')) bad();
}
function activity(step: ChatStep): ChatActivityEntry {
  if (step.kind === 'tool') {
    const intent = step.intent as ChatToolIntent;
    return {id: step.id, kind: step.kind, ordinal: step.ordinal, status: step.status,
      name: intent.toolCall.name, operation: intent.provenance.operation,
      ...(step.observation ? {resultJson: step.observation.resultJson} : {})};
  }
  return {id: step.id, kind: step.kind, ordinal: step.ordinal, status: step.status};
}
function continuation(requestValue: unknown, run: ChatRun, steps: ChatStep[]): void {
  const body = request(requestValue, run, 2), first = parse(steps[0].request?.body, MAX_BODY_BYTES) as Record<string, unknown>, tool = steps[1];
  if (!tool?.observation || !same((requestValue as Record<string, unknown>).context, steps[0].request?.context)) bad();
  // The local continuation is reconstructed solely from committed evidence.
  // Provider response IDs cannot stand in for this exact saved context.
  if ((requestValue as Record<string, unknown>).protocol === 'chat_completions') {
    const expected = [...(first.messages as unknown[]), (steps[0].output as ChatOutput).providerOutput,
      {role: 'tool', tool_call_id: (tool.intent as ChatToolIntent).toolCall.id, content: tool.observation.resultJson}];
    if (!same(body.messages, expected)) bad();
  } else if ((requestValue as Record<string, unknown>).protocol === 'anthropic_messages') {
    const expected = [...(first.messages as unknown[]), (steps[0].output as ChatOutput).providerOutput,
      {role: 'user', content: [{type: 'tool_result', tool_use_id: (tool.intent as ChatToolIntent).toolCall.id, content: tool.observation.resultJson}]}];
    if (!same(body.messages, expected)) bad();
  } else {
    const expected = [...(first.input as unknown[]), ...((steps[0].output as ChatOutput).providerOutput as unknown[]),
      {type: 'function_call_output', call_id: (tool.intent as ChatToolIntent).toolCall.id, output: tool.observation.resultJson}];
    if (!same(body.input, expected)) bad();
  }
  for (const key of Object.keys(first)) if (!['messages', 'input', 'tools', 'tool_choice', 'parallel_tool_calls'].includes(key) && !same(body[key], first[key])) bad();
  if (run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT || run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT || run.configuration.protocol === 'anthropic_messages') {
    let expected: string;
    try {
      expected = buildAgentRequest({configuration: run.configuration, messages: (requestValue as Record<string, unknown>).context as WireMessage[], readTools: {phase: 'answer', ...(run.contextMode === 'project_inspection' ? {} : {scope: run.contextMode}),
        toolCall: (tool.intent as ChatToolIntent).toolCall, providerOutput: (steps[0].output as ChatOutput).providerOutput, result: tool.observation.resultJson}}).body;
    } catch { bad(); }
    if ((requestValue as Record<string, unknown>).body !== expected) bad();
  }
}
function validateTarget(target: unknown, projectId: string, mode: string): void {
  if (mode === AGENT_TIMELINE_GAIN_CONTEXT) { if (!isAgentTimelineGainTarget(target, {projectId})) bad(); return; }
  if (mode === AGENT_TIMELINE_MOVE_CONTEXT) { if (!isAgentTimelineMoveTarget(target, {projectId})) bad(); return; }
  if (!exactObject(target, ['projectId', 'shotId', 'expectedRevision', 'title', 'prompt']) || target.projectId !== projectId ||
    !uuid(target.shotId) || !Number.isSafeInteger(target.expectedRevision) || (target.expectedRevision as number) < 0 ||
    !validEditText(target.title, 'title') || !validEditText(target.prompt, 'prompt')) bad();
}
export function validateInspectionRunFields(run: ChatRun): boolean {
  const has = ['contextMode', 'provenance', 'activity', 'editTarget'].some(key => Object.hasOwn(run, key));
  if (!has) return false;
  if (!['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string) || !Array.isArray(run.activity) || run.activity.length < 1 || run.activity.length > 3) bad();
  if (!run.provenance) bad();
  provenance(run.provenance, run.projectId);
  const runProvenance = run.provenance;
  const edit = run.contextMode === 'selected_shot_edit', timelineEdit = run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT, timelineGain = run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT;
  if ((runProvenance.category === 'project_selected_shot_text') !== edit || (runProvenance.category === AGENT_TIMELINE_MOVE_PROVENANCE) !== timelineEdit || (runProvenance.category === AGENT_TIMELINE_GAIN_PROVENANCE) !== timelineGain ||
    Object.hasOwn(run, 'editTarget') !== (edit || timelineEdit || timelineGain)) bad();
  if (edit || timelineEdit || timelineGain) validateTarget(run.editTarget, run.projectId, run.contextMode as string);
  let models = 0, tools = 0;
  for (const item of run.activity as ChatActivityEntry[]) {
    if (!keys(item, ['id', 'kind', 'ordinal', 'status'], item.kind === 'tool' ? ['name', 'operation', 'resultJson'] : []) ||
      !uuid(item.id) || !['model', 'tool'].includes(item.kind as string) || !STATUSES.includes(item.status as string)) bad();
    if (item.kind === 'model') { if (item.ordinal !== ++models || models > 2 || item.status === 'intent') bad(); }
    else {
      if (item.ordinal !== ++tools || tools > 1 || models !== 1 || !text(item.name, 100, 1) || !OPERATIONS.includes(item.operation as string) || !operationMatches(item.operation, run.contextMode) || item.status === 'not_started') bad();
      if (Object.hasOwn(item, 'resultJson')) { if (item.status !== 'completed') bad(); parse(item.resultJson, 8192); }
      else if (item.status === 'completed') bad();
    }
  }
  if (models === 0 || models === 2 && tools !== 1 || new Set((run.activity as ChatActivityEntry[]).map(item => item.id)).size !== run.activity!.length) bad();
  return true;
}

export function createChatStepJournal({store, readRun, row, account, saveRun, appendEvent, revision}: ChatStepJournalOptions) {
  const {db} = store;
  const select = `SELECT id,runId,projectId,position,kind,status,bytes,CASE WHEN length(CAST(data AS BLOB))<=${MAX_STEP_BYTES} THEN data ELSE NULL END AS data FROM agent_chat_steps`;
  function accepted(run: ChatRun): ChatExecution | null {
    const stored = db.prepare(`SELECT CASE WHEN length(CAST(acceptance AS BLOB))<=${MAX_STEP_BYTES} THEN acceptance ELSE NULL END AS acceptance FROM agent_chat_requests WHERE requestId=?`).get(run.requestId) as {acceptance?: string | null} | undefined;
    const value = parse(stored?.acceptance, MAX_STEP_BYTES);
    if (!object(value) || value.version !== 1) bad();
    const inspection = validateInspectionRunFields(run);
    if (!Object.hasOwn(value, 'execution')) { if (inspection || (value.consent as {context?: unknown} | undefined)?.context !== 'typed_chat_only') bad(); return null; }
    if (!inspection) bad();
    validateAcceptance(value, run);
    if (!same((value.execution as ChatExecution).request.provenance, run.provenance)) bad();
    return value.execution as ChatExecution;
  }
  function validateAcceptance(value: unknown, run: ChatRun): void {
    if (!exactObject(value, ['version', 'instanceId', 'acceptedAt', 'expectedSettingsRevision', 'expectedConversationRevision', 'configuration', 'consent', 'messages', 'execution']) ||
      value.version !== 1 || !uuid(value.instanceId) || value.acceptedAt !== run.createdAt ||
      !Number.isSafeInteger(value.expectedSettingsRevision) || (value.expectedSettingsRevision as number) < 0 ||
      !Number.isSafeInteger(value.expectedConversationRevision) || (value.expectedConversationRevision as number) < 0 ||
      !same(value.configuration, run.configuration) || !same(value.messages, (value.execution as ChatExecution).request.context)) bad();
    validateExecution(value.execution, run);
    const execution = value.execution as ChatExecution, consent = value.consent as Record<string, unknown>, policy = execution.policy;
    const edit = run.contextMode === 'selected_shot_edit', timelineEdit = run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT, timelineGain = run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT;
    const consentFields = ['destination', 'protocol', 'model', 'context', 'projectId', ...(timelineEdit ? [...TIMELINE_EDIT_CAPABILITY_FIELDS, 'timelineId', 'clipId', 'expectedRevision'] : edit ? [...EDIT_CAPABILITY_FIELDS, 'shotId', 'expectedRevision'] : ['schemaVersion', 'catalogHash', 'maxModelRequests', 'maxToolCalls', 'maxResultBytes'])];
    const executionTarget = execution.target as Record<string, unknown>;
    if (timelineGain) {
      try { parseTimelineGainConsent(consent); } catch { bad(); }
      if (consent.destination !== deriveAgentEndpoint(run.configuration) || consent.protocol !== run.configuration.protocol || consent.model !== run.configuration.model ||
        !timelineGainConsentMatches(consent as never, run.projectId, true) || !isDeepStrictEqual(consent.reviewTarget, agentTimelineGainReviewTarget(execution.target))) bad();
    } else if (!exactObject(consent, consentFields) || consent.destination !== deriveAgentEndpoint(run.configuration) ||
      consent.protocol !== run.configuration.protocol || consent.model !== run.configuration.model ||
      consentFields.slice(3).some(key => consent[key] !== (timelineEdit && key === 'clipId' ? (executionTarget.clip as {id?: unknown} | undefined)?.id : ['shotId', 'timelineId', 'expectedRevision'].includes(key) ? executionTarget[key] : policy[key]))) bad();
    const messages = value.messages as Array<Record<string, unknown>>;
    if (messages.length !== 2 * (run.provenance as ChatProvenance).sourceRunIds.length + 2 ||
      messages.some((message, index) => !exactObject(message, ['role', 'content']) || !text(message.content, 32768) ||
        message.role !== (index === 0 ? 'system' : index % 2 ? 'user' : 'assistant')) || (messages.at(-1) as {content?: unknown}).content !== (timelineGain ? selectedTimelineGainMessage(run.userText, run.editTarget, agentTimelineGainModelContext) : timelineEdit ? selectedTimelineClipMessage(run.userText, run.editTarget) : edit ? selectedShotMessage(run.userText, run.editTarget as {title: string; prompt: string}) : run.userText)) bad();
    const body = parse(execution.request.body, MAX_BODY_BYTES) as Record<string, unknown>;
    if (execution.request.protocol === 'anthropic_messages') {
      let native:ReturnType<typeof anthropicMessages>;
      try {native = anthropicMessages(messages);} catch {bad();}
      if (body.system !== native.system || !same(body.messages, native.messages)) bad();
    } else if (execution.request.protocol === 'chat_completions' ? !same(body.messages, messages) :
      body.instructions !== messages[0].content || !same(body.input, messages.slice(1))) bad();
    if (timelineEdit || timelineGain || execution.request.protocol === 'anthropic_messages') {
      let expected: string;
      try { expected = buildAgentRequest({configuration: run.configuration, messages: messages as WireMessage[], readTools: {phase: 'request', ...(run.contextMode === 'project_inspection' ? {} : {scope: run.contextMode})}}).body; } catch { bad(); }
      if (execution.request.body !== expected) bad();
    }
  }
  function validateExecution(execution: unknown, run: ChatRun): void {
    const edit = run.contextMode === 'selected_shot_edit', timelineEdit = run.contextMode === AGENT_TIMELINE_MOVE_CONTEXT, timelineGain = run.contextMode === AGENT_TIMELINE_GAIN_CONTEXT;
    if (!exactObject(execution, ['version', 'policy', 'request', ...(edit || timelineEdit || timelineGain ? ['target'] : [])]) || execution.version !== 1) bad();
    const policy = execution.policy as ChatPolicy;
    if (timelineEdit !== (run.provenance?.category === AGENT_TIMELINE_MOVE_PROVENANCE) || timelineGain !== (run.provenance?.category === AGENT_TIMELINE_GAIN_PROVENANCE)) bad();
    if (edit || timelineEdit || timelineGain) {
      validateTarget(execution.target, run.projectId, run.contextMode as string);
      if (!same(execution.target, run.editTarget) || !same(policy, (timelineGain ? timelineGainEditToolPolicy : timelineEdit ? timelineEditToolPolicy : editToolPolicy)(run.projectId))) bad();
    } else if (!exactObject(policy, ['schemaVersion', 'projectId', 'context', 'maxModelRequests', 'maxToolCalls', 'maxResultBytes', 'catalog', 'catalogHash']) ||
      policy.schemaVersion !== 1 || policy.projectId !== run.projectId || policy.context !== 'project_inspection' ||
      policy.maxModelRequests !== 2 || policy.maxToolCalls !== 1 || policy.maxResultBytes !== 8192 ||
      !Array.isArray(policy.catalog) || policy.catalog.length !== 4 || !/^[a-f0-9]{64}$/u.test(policy.catalogHash as string) ||
      createHash('sha256').update(encode(policy.catalog)).digest('hex') !== policy.catalogHash) bad();
    const executionRequest = execution.request as ChatRequestRecord;
    json(policy.catalog, 32768); request(executionRequest, run, 1);
    for (const [index, id] of (run.provenance as ChatProvenance).sourceRunIds.entries()) {
      const source = db.prepare('SELECT projectId,status FROM agent_chat_runs WHERE id=?').get(id) as {projectId?: string; status?: string} | undefined;
      if (!source || source.projectId !== run.projectId || source.status !== 'completed' || id === run.id) bad();
      if (timelineEdit || timelineGain) {
        const sourceData = parse((row(id) as {data?: unknown} | undefined)?.data, MAX_STEP_BYTES);
        if (!object(sourceData) || ['contextMode', 'provenance', 'activity', 'editTarget'].some(key => Object.hasOwn(sourceData, key)) ||
          sourceData.projectId !== run.projectId || sourceData.id !== id ||
          !same(executionRequest.context.slice(1 + 2 * index, 3 + 2 * index), [{role: 'user', content: sourceData.userText}, {role: 'assistant', content: sourceData.assistantText}])) bad();
      }
    }
  }
  function readSteps(run: ChatRun): ChatStep[] {
    const execution = accepted(run), rows = db.prepare(`${select} WHERE runId=? ORDER BY position LIMIT 4`).all(run.id) as unknown as StepRow[];
    if (!execution) { if (rows.length) bad(); return []; }
    if (!rows.length || rows.length > 3) bad();
    const steps = rows.map((entry, index) => {
      const step = parse(entry.data, MAX_STEP_BYTES);
      if (!object(step)) bad();
      const record = step as ChatStep;
      const core = ['version', 'id', 'runId', 'projectId', 'position', 'kind', 'ordinal', 'status', 'createdAt'];
      if (!keys(step, [...core, ...(record.kind === 'model' ? ['requestId', 'request'] : ['modelStepId', 'intent'])],
        ['dispatchStartedAt', 'completedAt', ...(record.kind === 'model' ? ['output'] : ['observation'])]) || record.version !== 1 ||
        !uuid(record.id) || !timestamp(record.createdAt) || record.runId !== run.id || record.projectId !== run.projectId || record.position !== index + 1 ||
        !STATUSES.includes(record.status) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) bad();
      for (const key of ['id', 'runId', 'projectId', 'position', 'kind', 'status']) if (record[key] !== entry[key as keyof StepRow]) bad();
      if (Object.hasOwn(record, 'dispatchStartedAt') && !timestamp(record.dispatchStartedAt) || Object.hasOwn(record, 'completedAt') && !timestamp(record.completedAt)) bad();
      if (['not_started', 'intent'].includes(record.status) && Object.hasOwn(record, 'dispatchStartedAt')) bad();
      if (['dispatch_started', 'completed'].includes(record.status) && !timestamp(record.dispatchStartedAt) || (record.status === 'completed') !== Object.hasOwn(record, 'completedAt')) bad();
      if (record.kind === 'model') {
        if (!uuid(record.requestId) || ![1, 2].includes(record.ordinal) || record.position !== (record.ordinal === 1 ? 1 : 3) || record.status === 'intent' ||
          record.ordinal === 1 && record.requestId !== run.modelRequestId || (record.status === 'completed') !== Object.hasOwn(record, 'output')) bad();
        request(record.request, run, record.ordinal);
        if (record.ordinal === 1 && !same(record.request, execution.request)) bad();
        if (record.output) {
          output(record.output, (record.request as ChatRequestRecord).protocol, run.contextMode);
          if (record.ordinal === 2 && record.output.finishReason !== 'stop' || record.output.toolCall &&
            !execution.policy.catalog.some(definition => definition.name === record.output!.toolCall!.name)) bad();
        }
      } else if (record.kind === 'tool') {
        if (record.ordinal !== 1 || record.position !== 2 || !uuid(record.modelStepId) || record.status === 'not_started' ||
          !exactObject(record.intent, ['toolCall', 'provenance']) || (record.status === 'completed') !== Object.hasOwn(record, 'observation')) bad();
        toolCall((record.intent as ChatToolIntent).toolCall, run.contextMode); provenance((record.intent as ChatToolIntent).provenance, run.projectId, true);
        if ((record.intent as ChatToolIntent).provenance.category !== run.provenance?.category || !operationMatches((record.intent as ChatToolIntent).provenance.operation, run.contextMode)) bad();
        if (record.observation) validateObservation(record.observation, record, run);
      } else bad();
      return record;
    });
    if (steps[1] && (steps[0].status !== 'completed' || steps[1].modelStepId !== steps[0].id || !same(steps[1].intent?.toolCall, steps[0].output?.toolCall))) bad();
    if (steps[2] && steps[1].status !== 'completed') bad();
    if (steps[2]) continuation(steps[2].request, run, steps);
    if (run.status === 'running' && steps.some(step => step.status === 'unknown') ||
      run.status === 'completed' && (steps.some(step => step.status !== 'completed') || steps.at(-1)?.kind !== 'model' || steps[steps.length - 1].output?.finishReason !== 'stop') ||
      run.status !== 'running' && steps.some(step => !['completed', 'unknown'].includes(step.status))) bad();
    if (run.modelRequestState === 'not_started' && Object.hasOwn(steps[0], 'dispatchStartedAt') ||
      run.modelRequestState !== 'not_started' && !Object.hasOwn(steps[0], 'dispatchStartedAt')) bad();
    if (!same(run.activity, steps.map(activity))) bad();
    return steps;
  }
  function validateObservation(value: unknown, step: ChatStep, run: ChatRun): void {
    const observation = value as ChatObservation;
    if (!exactObject(value, ['result', 'resultJson', 'provenance']) || !same(parse(observation.resultJson, 8192), observation.result) ||
      !same(observation.provenance, step.intent?.provenance)) bad();
    provenance(observation.provenance, run.projectId, true);
  }
  function write(step: ChatStep, previousBytes = 0): number {
    const data = encode(step); if (Buffer.byteLength(data) > MAX_STEP_BYTES) full();
    const count = size(data);
    if (previousBytes) db.prepare('UPDATE agent_chat_steps SET status=?,data=?,bytes=? WHERE id=?').run(step.status, data, count, step.id);
    else db.prepare('INSERT INTO agent_chat_steps(id,runId,projectId,position,kind,status,data,bytes) VALUES(?,?,?,?,?,?,?,?)').run(step.id, step.runId, step.projectId, step.position, step.kind, step.status, data, count);
    return count - previousBytes;
  }
  function changed(previous: {bytes: number}, run: ChatRun, steps: ChatStep[], step: ChatStep, delta: number) {
    run.activity = steps.map(activity); run.updatedAt = now(); run.lastEventId++;
    const rev = revision(run.projectId), event = appendEvent(run, 'snapshot', rev);
    account(delta + saveRun(previous, run) + event.bytes);
    return {run, step, revision: rev, events: [event.event]};
  }
  function inside<T>(runId: string, stepId: string, operation: (previous: {bytes: number}, run: ChatRun, steps: ChatStep[], step: ChatStep) => T): T {
    const previous = row(runId) as {bytes: number};
    const run = readRun(previous);
    if (!run || !['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string)) bad();
    const steps = readSteps(run), step = steps.find(item => item.id === stepId);
    if (!step) bad();
    return operation(previous, run, steps, step);
  }
  function replay(run: ChatRun, step: ChatStep) { return {run, step, revision: revision(run.projectId), events: [] as ChatStoredEvent[]}; }
  function running(run: ChatRun): void { if (run.status !== 'running') bad(); }
  function update(step: ChatStep): number { return write(step, (db.prepare('SELECT bytes FROM agent_chat_steps WHERE id=?').get(step.id) as {bytes: number}).bytes); }
  return Object.freeze({
    validate(run: ChatRun): void { readSteps(run); },
    validateAcceptance,
    initialize(run: ChatRun, input: unknown) {
      const execution = json(input) as ChatExecution, step: ChatStep = {version: 1, id: randomUUID(), runId: run.id, projectId: run.projectId, position: 1,
        kind: 'model', ordinal: 1, status: 'not_started', createdAt: run.createdAt, requestId: run.modelRequestId, request: execution.request};
      run.contextMode = execution.policy?.context;
      if (isProposal(run.contextMode)) run.editTarget = structuredClone(execution.target);
      run.provenance = structuredClone(execution.request.provenance); run.activity = [activity(step)];
      validateExecution(execution, run);
      return {execution, step, insert: (): number => write(step)};
    },
    steps(projectId: string, runId: string): ChatStep[] {
      const stored = row(runId) as {projectId?: string} | undefined;
      if (!stored || stored.projectId !== projectId) throw agentChatError('AGENT_CHAT_NOT_FOUND');
      const run = readRun(stored);
      if (!run) bad();
      return readSteps(run);
    },
    modelDispatch(runId: string, stepId: string) {
      return store.tx(() => inside(runId, stepId, (previous, run, steps, step) => {
        running(run); if (step.kind !== 'model' || step.status !== 'not_started') bad();
        step.status = 'dispatch_started'; step.dispatchStartedAt = now();
        if (step.ordinal === 1) { run.modelRequestState = 'dispatch_started'; run.modelRequestStartedAt = step.dispatchStartedAt; }
        return changed(previous, run, steps, step, update(step));
      }));
    },
    modelComplete(runId: string, stepId: string, supplied: unknown) {
      const value = json(supplied);
      if (!exactObject(value, ['output'])) bad();
      return store.tx(() => inside(runId, stepId, (previous, run, steps, step) => {
        const suppliedOutput = value.output as ChatOutput;
        if (step.kind !== 'model') bad(); output(suppliedOutput, (step.request as ChatRequestRecord).protocol, run.contextMode);
        if (suppliedOutput.toolCall && !(accepted(run) as ChatExecution).policy.catalog.some(definition => definition.name === suppliedOutput.toolCall!.name)) bad();
        if (step.status === 'completed') { if (!same(step.output, suppliedOutput)) bad(); return replay(run, step); }
        running(run); if (step.status !== 'dispatch_started' || step.ordinal === 2 && suppliedOutput.finishReason !== 'stop') bad();
        step.output = suppliedOutput; step.status = 'completed'; step.completedAt = now();
        return changed(previous, run, steps, step, update(step));
      }));
    },
    toolIntent(runId: string, modelStepId: string, supplied: unknown) {
      const intent = json(supplied);
      return store.tx(() => inside(runId, modelStepId, (previous, run, steps, model) => {
        const suppliedIntent = intent as ChatToolIntent;
        if (model.kind !== 'model' || model.ordinal !== 1 || model.status !== 'completed' || model.output?.finishReason !== 'tool_calls' ||
          !exactObject(intent, ['toolCall', 'provenance']) || !same(suppliedIntent.toolCall, model.output?.toolCall)) bad();
        provenance(suppliedIntent.provenance, run.projectId, true);
        if (suppliedIntent.provenance.category !== run.provenance?.category || !operationMatches(suppliedIntent.provenance.operation, run.contextMode)) bad();
        if (steps[1]) { if (!same(steps[1].intent, suppliedIntent)) bad(); return replay(run, steps[1]); }
        running(run);
        const step: ChatStep = {version: 1, id: randomUUID(), runId, projectId: run.projectId, position: 2, kind: 'tool', ordinal: 1,
          status: 'intent', createdAt: now(), modelStepId, intent: suppliedIntent};
        steps.push(step); return changed(previous, run, steps, step, write(step));
      }));
    },
    captureTool(runId: string, stepId: string, dispatch: () => unknown) {
      if (typeof dispatch !== 'function' || dispatch.constructor?.name === 'AsyncFunction') bad();
      // A separate committed boundary makes a failed/uncertain capture forever
      // non-retryable, including through another window or journal instance.
      const started = store.tx(() => inside(runId, stepId, (previous, run, steps, step) => {
        if (step.kind !== 'tool') bad();
        if (step.status === 'completed') return replay(run, step);
        running(run); if (step.status !== 'intent') bad();
        step.status = 'dispatch_started'; step.dispatchStartedAt = now();
        return changed(previous, run, steps, step, update(step));
      }));
      if (started.step.status === 'completed') return started;
      const captured = store.tx(() => inside(runId, stepId, (previous, run, steps, step) => {
        running(run); if (step.status !== 'dispatch_started') bad();
        const raw = dispatch();
        if (types.isPromise(raw)) bad();
        const value = json(raw, 32768) as ChatObservation; validateObservation(value, step, run);
        step.observation = value; step.status = 'completed'; step.completedAt = now();
        return changed(previous, run, steps, step, update(step));
      }));
      return {...captured, events: [...started.events, ...captured.events]};
    },
    prepareContinuation(runId: string, supplied: unknown) {
      const next = json(supplied);
      return store.tx(() => {
        const previous = row(runId) as {bytes: number}, run = readRun(previous);
        if (!run || !['project_inspection', 'selected_shot_edit', AGENT_TIMELINE_MOVE_CONTEXT, AGENT_TIMELINE_GAIN_CONTEXT].includes(run.contextMode as string)) bad();
        const steps = readSteps(run); request(next, run, 2);
        if (steps[2]) { if (!same(steps[2].request, next)) bad(); return replay(run, steps[2]); }
        running(run); if (steps.length !== 2 || steps[1].status !== 'completed') bad();
        continuation(next, run, steps);
        const step: ChatStep = {version: 1, id: randomUUID(), runId, projectId: run.projectId, position: 3, kind: 'model', ordinal: 2,
          status: 'not_started', createdAt: now(), requestId: randomUUID(), request: next as ChatRequestRecord};
        steps.push(step); return changed(previous, run, steps, step, write(step));
      });
    },
    finish(run: ChatRun, status: string): number {
      const steps = readSteps(run); let delta = 0;
      if (!steps.length) return delta;
      if (status === 'completed' && (steps.at(-1)?.kind !== 'model' || steps[steps.length - 1].status !== 'completed' || steps[steps.length - 1].output?.finishReason !== 'stop')) bad();
      for (const step of steps) if (!['completed', 'unknown'].includes(step.status)) { step.status = 'unknown'; delta += update(step); }
      run.activity = steps.map(activity); return delta;
    },
  });
}
