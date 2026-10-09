import {createHash, randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {agentChatError} from './chat-errors.mjs';
import {exactObject} from './config.mjs';
import {deriveAgentEndpoint} from '@mioon/contracts';

// This module persists evidence, never acquires authority or dispatches a tool.
// Only captureTool's trusted synchronous callback may perform the shared read.
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const OPERATIONS = ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect'];
const STATUSES = ['not_started', 'intent', 'dispatch_started', 'completed', 'unknown'];
const bad = () => { throw agentChatError('AGENT_CHAT_STORAGE_UNAVAILABLE'); };
const full = () => { throw agentChatError('AGENT_CHAT_STORAGE_LIMIT'); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const text = (value, maximum, minimum = 0) => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maximum && value.length >= minimum;
const encode = value => JSON.stringify(value);
const same = (a, b) => encode(a) === encode(b);
const now = () => new Date().toISOString();
const size = value => Buffer.byteLength(value) + 512;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, required, optional = []) {
  return object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
// Descriptor-first copying avoids evaluating getters/toJSON hooks. This is a
// narrow trusted-backend API, but a provider-shaped value is still untrusted.
function json(value, maximum = MAX_STEP_BYTES) {
  let nodes = 0;
  function copy(item, depth = 0) {
    if (++nodes > 20000 || depth > 30) bad();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || types.isProxy(item)) bad();
    const array = Array.isArray(item);
    if (!array && !object(item) || array && Object.getPrototypeOf(item) !== Array.prototype) bad();
    const result = array ? [] : {};
    if (array && item.length > 10000) bad();
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') ||
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
function parse(value, maximum) {
  if (!text(value, maximum, 1)) bad();
  try { return json(JSON.parse(value), maximum); } catch { bad(); }
}
function provenance(value, projectId, observation = false) {
  if (!exactObject(value, observation ? ['category', 'projectId', 'operation'] : ['category', 'projectId', 'sourceRunIds']) ||
    value.category !== 'project_saved_text_metadata' || value.projectId !== projectId) bad();
  if (observation ? !OPERATIONS.includes(value.operation) : !Array.isArray(value.sourceRunIds) || value.sourceRunIds.length > 12 ||
    value.sourceRunIds.some(id => !uuid(id)) || new Set(value.sourceRunIds).size !== value.sourceRunIds.length) bad();
}
function request(value, run, round) {
  if (!exactObject(value, ['protocol', 'body', 'context', 'provenance']) || value.protocol !== run.configuration.protocol ||
    !['chat_completions', 'responses'].includes(value.protocol)) bad();
  provenance(value.provenance, run.projectId);
  if (!same(value.provenance, run.provenance) || !Array.isArray(value.context) || value.context.length > 64) bad();
  json(value.context, MAX_BODY_BYTES);
  const body = parse(value.body, MAX_BODY_BYTES);
  const allowed = ['model', 'messages', 'input', 'instructions', 'stream', 'store', 'max_tokens', 'max_completion_tokens', 'max_output_tokens',
    'thinking', 'enable_thinking', 'provider', 'reasoning_effort', 'reasoning', 'truncation', 'tools', 'tool_choice', 'parallel_tool_calls'];
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || body.model !== run.configuration.model || body.stream !== true ||
    Object.hasOwn(body, 'store') && body.store !== false) bad();
  if (value.protocol === 'chat_completions' ? !Array.isArray(body.messages) || Object.hasOwn(body, 'input') :
    !Array.isArray(body.input) || !text(body.instructions, 32768) || Object.hasOwn(body, 'messages') || body.store !== false) bad();
  if (round === 2 && (Object.hasOwn(body, 'tools') && (!Array.isArray(body.tools) || body.tools.length) ||
    Object.hasOwn(body, 'tool_choice') && body.tool_choice !== 'none')) bad();
  return body;
}
function toolCall(value) {
  if (!keys(value, ['id', 'name', 'arguments', 'argumentsJson'], ['itemId']) || !text(value.id, 256, 1) || /[\x00-\x20\x7f]/u.test(value.id) ||
    !text(value.name, 100, 1) || Object.hasOwn(value, 'itemId') && (!text(value.itemId, 256, 1) || /[\x00-\x20\x7f]/u.test(value.itemId)) ||
    !object(value.arguments) || !same(parse(value.argumentsJson, 2048), value.arguments)) bad();
}
function output(value, protocol) {
  if (!keys(value, ['type', 'finishReason'], ['toolCall', 'providerOutput', 'usage']) || value.type !== 'done' || !['stop', 'tool_calls'].includes(value.finishReason)) bad();
  json(value, MAX_OUTPUT_BYTES);
  if (Object.hasOwn(value, 'usage') && (!keys(value.usage, [], ['prompt_tokens', 'completion_tokens', 'total_tokens']) ||
    Object.values(value.usage).some(count => !Number.isSafeInteger(count) || count < 0 || count > 10000000) ||
    value.usage.completion_tokens > 2048)) bad();
  if (value.finishReason === 'tool_calls') {
    toolCall(value.toolCall);
    if ((protocol === 'responses') !== Object.hasOwn(value.toolCall, 'itemId')) bad();
    if (protocol === 'chat_completions') {
      const message = value.providerOutput;
      if (!keys(message, ['role', 'content', 'tool_calls'], ['refusal']) || message.role !== 'assistant' || message.content !== null && !text(message.content, 256 * 1024) ||
        Object.hasOwn(message, 'refusal') && !text(message.refusal, 256 * 1024) ||
        !Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) bad();
      const call = message.tool_calls[0];
      if (!exactObject(call, ['id', 'type', 'function']) || call.id !== value.toolCall.id || call.type !== 'function' ||
        !exactObject(call.function, ['name', 'arguments']) || call.function.name !== value.toolCall.name || call.function.arguments !== value.toolCall.argumentsJson) bad();
    } else {
      if (!Array.isArray(value.providerOutput) || value.providerOutput.length > 64) bad();
      const calls = value.providerOutput.filter(item => item?.type === 'function_call');
      if (calls.length !== 1) bad();
      const call = calls[0];
      if (!keys(call, ['type', 'id', 'call_id', 'name', 'arguments'], ['status']) || call.call_id !== value.toolCall.id || call.id !== value.toolCall.itemId ||
        call.name !== value.toolCall.name || call.arguments !== value.toolCall.argumentsJson || Object.hasOwn(call, 'status') && call.status !== 'completed') bad();
      const ids = new Set();
      for (const item of value.providerOutput) {
        if (!text(item.id, 256, 1) || ids.has(item.id)) bad(); ids.add(item.id);
        if (item.type === 'function_call') continue;
        if (!keys(item, ['id', 'type', 'role', 'status', 'content'], ['phase']) || item.type !== 'message' || item.role !== 'assistant' ||
          item.status !== 'completed' || !Array.isArray(item.content) || !item.content.length || item.content.length > 128 ||
          Object.hasOwn(item, 'phase') && item.phase !== null && item.phase !== '') bad();
        for (const part of item.content) {
          if (part?.type === 'output_text') {
            if (!keys(part, ['type', 'text'], ['annotations', 'logprobs']) || !text(part.text, 256 * 1024)) bad();
            for (const key of ['annotations', 'logprobs']) if (Object.hasOwn(part, key) && part[key] !== null && (!Array.isArray(part[key]) || part[key].length)) bad();
          } else if (!exactObject(part, ['type', 'refusal']) || part.type !== 'refusal' || !text(part.refusal, 256 * 1024)) bad();
        }
      }
    }
  } else if (Object.hasOwn(value, 'toolCall') || Object.hasOwn(value, 'providerOutput')) bad();
}
function activity(step) {
  return {id: step.id, kind: step.kind, ordinal: step.ordinal, status: step.status,
    ...(step.kind === 'tool' ? {name: step.intent.toolCall.name, operation: step.intent.provenance.operation,
      ...(step.observation ? {resultJson: step.observation.resultJson} : {})} : {})};
}
function continuation(requestValue, run, steps) {
  const body = request(requestValue, run, 2), first = parse(steps[0].request.body, MAX_BODY_BYTES), tool = steps[1];
  if (!tool?.observation || !same(requestValue.context, steps[0].request.context)) bad();
  // The local continuation is reconstructed solely from committed evidence.
  // Provider response IDs cannot stand in for this exact saved context.
  if (requestValue.protocol === 'chat_completions') {
    const expected = [...first.messages, steps[0].output.providerOutput,
      {role: 'tool', tool_call_id: tool.intent.toolCall.id, content: tool.observation.resultJson}];
    if (!same(body.messages, expected)) bad();
  } else {
    const expected = [...first.input, ...steps[0].output.providerOutput,
      {type: 'function_call_output', call_id: tool.intent.toolCall.id, output: tool.observation.resultJson}];
    if (!same(body.input, expected)) bad();
  }
  for (const key of Object.keys(first)) if (!['messages', 'input', 'tools', 'tool_choice', 'parallel_tool_calls'].includes(key) && !same(body[key], first[key])) bad();
}
export function validateInspectionRunFields(run) {
  const has = ['contextMode', 'provenance', 'activity'].some(key => Object.hasOwn(run, key));
  if (!has) return false;
  if (run.contextMode !== 'project_inspection' || !Array.isArray(run.activity) || run.activity.length < 1 || run.activity.length > 3) bad();
  provenance(run.provenance, run.projectId);
  let models = 0, tools = 0;
  for (const item of run.activity) {
    if (!keys(item, ['id', 'kind', 'ordinal', 'status'], item?.kind === 'tool' ? ['name', 'operation', 'resultJson'] : []) ||
      !uuid(item.id) || !['model', 'tool'].includes(item.kind) || !STATUSES.includes(item.status)) bad();
    if (item.kind === 'model') { if (item.ordinal !== ++models || models > 2 || item.status === 'intent') bad(); }
    else {
      if (item.ordinal !== ++tools || tools > 1 || models !== 1 || !text(item.name, 100, 1) || !OPERATIONS.includes(item.operation) || item.status === 'not_started') bad();
      if (Object.hasOwn(item, 'resultJson')) { if (item.status !== 'completed') bad(); parse(item.resultJson, 8192); }
      else if (item.status === 'completed') bad();
    }
  }
  if (models === 0 || models === 2 && tools !== 1 || new Set(run.activity.map(item => item.id)).size !== run.activity.length) bad();
  return true;
}

export function createChatStepJournal({store, readRun, row, account, saveRun, appendEvent, revision}) {
  const {db} = store;
  const select = `SELECT id,runId,projectId,position,kind,status,bytes,CASE WHEN length(CAST(data AS BLOB))<=${MAX_STEP_BYTES} THEN data ELSE NULL END AS data FROM agent_chat_steps`;
  function accepted(run) {
    const stored = db.prepare(`SELECT CASE WHEN length(CAST(acceptance AS BLOB))<=${MAX_STEP_BYTES} THEN acceptance ELSE NULL END AS acceptance FROM agent_chat_requests WHERE requestId=?`).get(run.requestId);
    const value = parse(stored?.acceptance, MAX_STEP_BYTES);
    if (value.version !== 1) bad();
    const inspection = validateInspectionRunFields(run);
    if (!Object.hasOwn(value, 'execution')) { if (inspection || value.consent?.context !== 'typed_chat_only') bad(); return null; }
    if (!inspection) bad();
    validateAcceptance(value, run);
    if (!same(value.execution.request.provenance, run.provenance)) bad();
    return value.execution;
  }
  function validateAcceptance(value, run) {
    if (!exactObject(value, ['version', 'instanceId', 'acceptedAt', 'expectedSettingsRevision', 'expectedConversationRevision', 'configuration', 'consent', 'messages', 'execution']) ||
      value.version !== 1 || !uuid(value.instanceId) || value.acceptedAt !== run.createdAt ||
      !Number.isSafeInteger(value.expectedSettingsRevision) || value.expectedSettingsRevision < 0 ||
      !Number.isSafeInteger(value.expectedConversationRevision) || value.expectedConversationRevision < 0 ||
      !same(value.configuration, run.configuration) || !same(value.messages, value.execution.request.context)) bad();
    validateExecution(value.execution, run);
    const consent = value.consent, policy = value.execution.policy;
    const consentFields = ['destination', 'protocol', 'model', 'context', 'projectId', 'schemaVersion', 'catalogHash', 'maxModelRequests', 'maxToolCalls', 'maxResultBytes'];
    if (!exactObject(consent, consentFields) || consent.destination !== deriveAgentEndpoint(run.configuration) ||
      consent.protocol !== run.configuration.protocol || consent.model !== run.configuration.model ||
      consentFields.slice(3).some(key => consent[key] !== policy[key])) bad();
    const messages = value.messages;
    if (messages.length !== 2 * run.provenance.sourceRunIds.length + 2 ||
      messages.some((message, index) => !exactObject(message, ['role', 'content']) || !text(message.content, 32768) ||
        message.role !== (index === 0 ? 'system' : index % 2 ? 'user' : 'assistant')) || messages.at(-1).content !== run.userText) bad();
    const body = parse(value.execution.request.body, MAX_BODY_BYTES);
    if (value.execution.request.protocol === 'chat_completions' ? !same(body.messages, messages) :
      body.instructions !== messages[0].content || !same(body.input, messages.slice(1))) bad();
  }
  function validateExecution(execution, run) {
    if (!exactObject(execution, ['version', 'policy', 'request']) || execution.version !== 1) bad();
    const policy = execution.policy;
    if (!exactObject(policy, ['schemaVersion', 'projectId', 'context', 'maxModelRequests', 'maxToolCalls', 'maxResultBytes', 'catalog', 'catalogHash']) ||
      policy.schemaVersion !== 1 || policy.projectId !== run.projectId || policy.context !== 'project_inspection' ||
      policy.maxModelRequests !== 2 || policy.maxToolCalls !== 1 || policy.maxResultBytes !== 8192 ||
      !Array.isArray(policy.catalog) || policy.catalog.length !== 4 || !/^[a-f0-9]{64}$/u.test(policy.catalogHash) ||
      createHash('sha256').update(encode(policy.catalog)).digest('hex') !== policy.catalogHash) bad();
    json(policy.catalog, 32768); request(execution.request, run, 1);
    for (const id of run.provenance.sourceRunIds) {
      const source = db.prepare('SELECT projectId,status FROM agent_chat_runs WHERE id=?').get(id);
      if (!source || source.projectId !== run.projectId || source.status !== 'completed' || id === run.id) bad();
    }
  }
  function readSteps(run) {
    const execution = accepted(run), rows = db.prepare(`${select} WHERE runId=? ORDER BY position LIMIT 4`).all(run.id);
    if (!execution) { if (rows.length) bad(); return []; }
    if (!rows.length || rows.length > 3) bad();
    const steps = rows.map((entry, index) => {
      const step = parse(entry.data, MAX_STEP_BYTES);
      const core = ['version', 'id', 'runId', 'projectId', 'position', 'kind', 'ordinal', 'status', 'createdAt'];
      if (!keys(step, [...core, ...(step.kind === 'model' ? ['requestId', 'request'] : ['modelStepId', 'intent'])],
        ['dispatchStartedAt', 'completedAt', ...(step.kind === 'model' ? ['output'] : ['observation'])]) || step.version !== 1 ||
        !uuid(step.id) || !timestamp(step.createdAt) || step.runId !== run.id || step.projectId !== run.projectId || step.position !== index + 1 ||
        !STATUSES.includes(step.status) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) bad();
      for (const key of ['id', 'runId', 'projectId', 'position', 'kind', 'status']) if (step[key] !== entry[key]) bad();
      if (Object.hasOwn(step, 'dispatchStartedAt') && !timestamp(step.dispatchStartedAt) || Object.hasOwn(step, 'completedAt') && !timestamp(step.completedAt)) bad();
      if (['not_started', 'intent'].includes(step.status) && Object.hasOwn(step, 'dispatchStartedAt')) bad();
      if (['dispatch_started', 'completed'].includes(step.status) && !timestamp(step.dispatchStartedAt) || (step.status === 'completed') !== Object.hasOwn(step, 'completedAt')) bad();
      if (step.kind === 'model') {
        if (!uuid(step.requestId) || ![1, 2].includes(step.ordinal) || step.position !== (step.ordinal === 1 ? 1 : 3) || step.status === 'intent' ||
          step.ordinal === 1 && step.requestId !== run.modelRequestId || (step.status === 'completed') !== Object.hasOwn(step, 'output')) bad();
        request(step.request, run, step.ordinal);
        if (step.ordinal === 1 && !same(step.request, execution.request)) bad();
        if (step.output) {
          output(step.output, step.request.protocol);
          if (step.ordinal === 2 && step.output.finishReason !== 'stop' || step.output.toolCall &&
            !execution.policy.catalog.some(definition => definition.name === step.output.toolCall.name)) bad();
        }
      } else if (step.kind === 'tool') {
        if (step.ordinal !== 1 || step.position !== 2 || !uuid(step.modelStepId) || step.status === 'not_started' ||
          !exactObject(step.intent, ['toolCall', 'provenance']) || (step.status === 'completed') !== Object.hasOwn(step, 'observation')) bad();
        toolCall(step.intent.toolCall); provenance(step.intent.provenance, run.projectId, true);
        if (step.observation) validateObservation(step.observation, step, run);
      } else bad();
      return step;
    });
    if (steps[1] && (steps[0].status !== 'completed' || steps[1].modelStepId !== steps[0].id || !same(steps[1].intent.toolCall, steps[0].output.toolCall))) bad();
    if (steps[2] && steps[1].status !== 'completed') bad();
    if (steps[2]) continuation(steps[2].request, run, steps);
    if (run.status === 'running' && steps.some(step => step.status === 'unknown') ||
      run.status === 'completed' && (steps.some(step => step.status !== 'completed') || steps.at(-1).kind !== 'model' || steps.at(-1).output.finishReason !== 'stop') ||
      run.status !== 'running' && steps.some(step => !['completed', 'unknown'].includes(step.status))) bad();
    if (run.modelRequestState === 'not_started' && Object.hasOwn(steps[0], 'dispatchStartedAt') ||
      run.modelRequestState !== 'not_started' && !Object.hasOwn(steps[0], 'dispatchStartedAt')) bad();
    if (!same(run.activity, steps.map(activity))) bad();
    return steps;
  }
  function validateObservation(value, step, run) {
    if (!exactObject(value, ['result', 'resultJson', 'provenance']) || !same(parse(value.resultJson, 8192), value.result) ||
      !same(value.provenance, step.intent.provenance)) bad();
    provenance(value.provenance, run.projectId, true);
  }
  function write(step, previousBytes = 0) {
    const data = encode(step); if (Buffer.byteLength(data) > MAX_STEP_BYTES) full();
    const count = size(data);
    if (previousBytes) db.prepare('UPDATE agent_chat_steps SET status=?,data=?,bytes=? WHERE id=?').run(step.status, data, count, step.id);
    else db.prepare('INSERT INTO agent_chat_steps(id,runId,projectId,position,kind,status,data,bytes) VALUES(?,?,?,?,?,?,?,?)').run(step.id, step.runId, step.projectId, step.position, step.kind, step.status, data, count);
    return count - previousBytes;
  }
  function changed(previous, run, steps, step, delta) {
    run.activity = steps.map(activity); run.updatedAt = now(); run.lastEventId++;
    const rev = revision(run.projectId), event = appendEvent(run, 'snapshot', rev);
    account(delta + saveRun(previous, run) + event.bytes);
    return {run, step, revision: rev, events: [event.event]};
  }
  function inside(runId, stepId, operation) {
    const previous = row(runId), run = readRun(previous);
    if (!run || run.contextMode !== 'project_inspection') bad();
    const steps = readSteps(run), step = steps.find(item => item.id === stepId);
    if (!step) bad();
    return operation(previous, run, steps, step);
  }
  function replay(run, step) { return {run, step, revision: revision(run.projectId), events: []}; }
  function running(run) { if (run.status !== 'running') bad(); }
  function update(step) { return write(step, db.prepare('SELECT bytes FROM agent_chat_steps WHERE id=?').get(step.id).bytes); }
  return Object.freeze({
    validate(run) { readSteps(run); },
    validateAcceptance,
    initialize(run, input) {
      const execution = json(input), step = {version: 1, id: randomUUID(), runId: run.id, projectId: run.projectId, position: 1,
        kind: 'model', ordinal: 1, status: 'not_started', createdAt: run.createdAt, requestId: run.modelRequestId, request: execution.request};
      run.contextMode = 'project_inspection'; run.provenance = structuredClone(execution.request.provenance); run.activity = [activity(step)];
      validateExecution(execution, run);
      return {execution, step, insert: () => write(step)};
    },
    steps(projectId, runId) {
      const stored = row(runId);
      if (!stored || stored.projectId !== projectId) throw agentChatError('AGENT_CHAT_NOT_FOUND');
      const run = readRun(stored);
      return readSteps(run);
    },
    modelDispatch(runId, stepId) {
      return store.tx(() => inside(runId, stepId, (previous, run, steps, step) => {
        running(run); if (step.kind !== 'model' || step.status !== 'not_started') bad();
        step.status = 'dispatch_started'; step.dispatchStartedAt = now();
        if (step.ordinal === 1) { run.modelRequestState = 'dispatch_started'; run.modelRequestStartedAt = step.dispatchStartedAt; }
        return changed(previous, run, steps, step, update(step));
      }));
    },
    modelComplete(runId, stepId, supplied) {
      const value = json(supplied);
      if (!exactObject(value, ['output'])) bad();
      return store.tx(() => inside(runId, stepId, (previous, run, steps, step) => {
        if (step.kind !== 'model') bad(); output(value.output, step.request.protocol);
        if (value.output.toolCall && !accepted(run).policy.catalog.some(definition => definition.name === value.output.toolCall.name)) bad();
        if (step.status === 'completed') { if (!same(step.output, value.output)) bad(); return replay(run, step); }
        running(run); if (step.status !== 'dispatch_started' || step.ordinal === 2 && value.output.finishReason !== 'stop') bad();
        step.output = value.output; step.status = 'completed'; step.completedAt = now();
        return changed(previous, run, steps, step, update(step));
      }));
    },
    toolIntent(runId, modelStepId, supplied) {
      const intent = json(supplied);
      return store.tx(() => inside(runId, modelStepId, (previous, run, steps, model) => {
        if (model.kind !== 'model' || model.ordinal !== 1 || model.status !== 'completed' || model.output.finishReason !== 'tool_calls' ||
          !exactObject(intent, ['toolCall', 'provenance']) || !same(intent.toolCall, model.output.toolCall)) bad();
        provenance(intent.provenance, run.projectId, true);
        if (steps[1]) { if (!same(steps[1].intent, intent)) bad(); return replay(run, steps[1]); }
        running(run);
        const step = {version: 1, id: randomUUID(), runId, projectId: run.projectId, position: 2, kind: 'tool', ordinal: 1,
          status: 'intent', createdAt: now(), modelStepId, intent};
        steps.push(step); return changed(previous, run, steps, step, write(step));
      }));
    },
    captureTool(runId, stepId, dispatch) {
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
        const value = json(raw, 32768); validateObservation(value, step, run);
        step.observation = value; step.status = 'completed'; step.completedAt = now();
        return changed(previous, run, steps, step, update(step));
      }));
      return {...captured, events: [...started.events, ...captured.events]};
    },
    prepareContinuation(runId, supplied) {
      const next = json(supplied);
      return store.tx(() => {
        const previous = row(runId), run = readRun(previous);
        if (!run || run.contextMode !== 'project_inspection') bad();
        const steps = readSteps(run); request(next, run, 2);
        if (steps[2]) { if (!same(steps[2].request, next)) bad(); return replay(run, steps[2]); }
        running(run); if (steps.length !== 2 || steps[1].status !== 'completed') bad();
        continuation(next, run, steps);
        const step = {version: 1, id: randomUUID(), runId, projectId: run.projectId, position: 3, kind: 'model', ordinal: 2,
          status: 'not_started', createdAt: now(), requestId: randomUUID(), request: next};
        steps.push(step); return changed(previous, run, steps, step, write(step));
      });
    },
    finish(run, status) {
      const steps = readSteps(run); let delta = 0;
      if (!steps.length) return delta;
      if (status === 'completed' && (steps.at(-1).kind !== 'model' || steps.at(-1).status !== 'completed' || steps.at(-1).output.finishReason !== 'stop')) bad();
      for (const step of steps) if (!['completed', 'unknown'].includes(step.status)) { step.status = 'unknown'; delta += update(step); }
      run.activity = steps.map(activity); return delta;
    },
  });
}
