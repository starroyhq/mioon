import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleRunContext, assembleModelInput, replayModelContext, selectTaskModelTools} from '../packages/business/src/agent/task-context-v2.ts';
import type {TaskContextPreviousRun, TaskRunContextInput} from '../packages/business/src/agent/task-context-v2.ts';
import {TASK_MODEL_LIMITS, buildTaskModelRequest, taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput, TaskToolDefinition} from '../packages/business/src/agent/task-gateway-v2.ts';
import {anthropicMessages} from '../packages/business/src/agent/anthropic-wire.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskNote, AgentTaskTier, AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';

const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const satisfies readonly AgentProtocol[];
const stamp = '2026-10-27T00:00:00.000Z';
const modelStepId = '00000000-0000-4000-8000-000000000001';
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function note(text: string, bound = false): AgentTaskNote {
  return {requestId: bound ? 'bound-note-request' : 'queued-note-request', text, createdAt: stamp, ...(bound ? {modelStepId} : {})};
}
function previous(text: string, reply: string, notes: AgentTaskNote[] = []): TaskContextPreviousRun {
  return {text, notes, steps: [{kind: 'model', status: 'completed', result: {text: reply}}]};
}
function configuration(protocol: AgentProtocol): AgentConfiguration {
  return {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
}
const tools: TaskToolDefinition[] = [
  {name: 'mioon_project_inspect', description: 'Inspect the current project.', parameters: {type: 'object', properties: {}, additionalProperties: false}},
  {name: 'mioon_shot_inspect', description: 'Inspect saved shots.', parameters: {type: 'object', properties: {limit: {type: 'integer', minimum: 1}}, additionalProperties: false}},
];
function output(protocol: AgentProtocol, calls: AgentTaskToolCall[]): TaskModelOutput {
  const text = 'Inspect both saved views.';
  const providerOutput: AgentTaskJson = protocol === 'anthropic_messages'
    ? {role: 'assistant', content: [{type: 'text', text}, ...calls.map(call => ({type: 'tool_use', id: call.id, name: call.name, input: call.arguments}))]}
    : protocol === 'responses'
      ? [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}, ...calls.map(call => ({type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed'}))]
      : {role: 'assistant', content: text, tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))};
  return {text, toolCalls: calls, providerOutput};
}
function callResults(body: string, protocol: AgentProtocol): {calls: string[]; results: {id: string; value: unknown}[]} {
  const wire = object(JSON.parse(body)), history = wire[protocol === 'responses' ? 'input' : 'messages'];
  assert.ok(Array.isArray(history));
  if (protocol === 'anthropic_messages') anthropicMessages(history as AgentTaskJson[]);
  const calls: string[] = [], results: {id: string; value: unknown}[] = [];
  for (const item of history) {
    const row = object(item);
    if (protocol === 'chat_completions') {
      if (Array.isArray(row.tool_calls)) calls.push(...row.tool_calls.map(value => String(object(value).id)));
      if (row.role === 'tool') results.push({id: String(row.tool_call_id), value: JSON.parse(String(row.content))});
    } else if (protocol === 'responses') {
      if (row.type === 'function_call') calls.push(String(row.call_id));
      if (row.type === 'function_call_output') results.push({id: String(row.call_id), value: JSON.parse(String(row.output))});
    } else if (Array.isArray(row.content)) {
      for (const item of row.content) {
        const block = object(item);
        if (block.type === 'tool_use') calls.push(String(block.id));
        if (block.type === 'tool_result') results.push({id: String(block.tool_use_id), value: JSON.parse(String(block.content))});
      }
    }
  }
  return {calls, results};
}

test('run context trims an entire oldest round only after the serialized UTF-8 limit is exceeded', () => {
  const oldNote = note('旧'.repeat(10000), true), recentNote = note('Keep the selected range.', true);
  const marker = taskResponseLanguageContext('zh-Hans'), text = '本轮消息';
  const recent = previous('Recent request.', 'Recent reply.', [recentNote]);
  const emptyContext: AgentTaskJson[] = [marker, {role: 'user', content: 'Old request.'}, {role: 'user', content: oldNote.text}, {role: 'assistant', content: ''}, {role: 'user', content: recent.text}, {role: 'user', content: recentNote.text}, {role: 'assistant', content: 'Recent reply.'}, {role: 'user', content: text}];
  const reply = 'x'.repeat(TASK_MODEL_LIMITS.historyBytes - bytes(emptyContext));
  const exact = freeze<TaskRunContextInput>({locale: 'zh-Hans', text, previousRuns: [previous('Old request.', reply, [oldNote]), recent]});
  const savedExact = JSON.stringify(exact), full = assembleRunContext(exact);
  assert.equal(full.metrics.historyBytes, TASK_MODEL_LIMITS.historyBytes);
  assert.deepEqual(full.metrics, {historyBytes: TASK_MODEL_LIMITS.historyBytes, retainedRuns: 2, trimmedRuns: 0});
  assert.ok(JSON.stringify(full.context).length < TASK_MODEL_LIMITS.historyBytes, 'Character count cannot substitute for UTF-8 bytes');
  assert.equal(JSON.stringify(exact), savedExact);

  const overflow = freeze<TaskRunContextInput>({...exact, previousRuns: [previous('Old request.', reply + '界', [oldNote]), recent]});
  const before = JSON.stringify(overflow), trimmed = assembleRunContext(overflow);
  assert.deepEqual(trimmed.context, [marker, {role: 'user', content: recent.text}, {role: 'user', content: recentNote.text}, {role: 'assistant', content: 'Recent reply.'}, {role: 'user', content: text}]);
  assert.deepEqual(trimmed.metrics, {historyBytes: bytes(trimmed.context), retainedRuns: 1, trimmedRuns: 1});
  assert.equal(JSON.stringify(overflow), before);
  assert.deepEqual(assembleRunContext(overflow), trimmed);
});

test('an explicitly empty saved history is distinct from missing legacy context', () => {
  assert.deepEqual(assembleModelInput({context: [], text: 'Do not reconstruct this saved history.'}).history, []);
  assert.deepEqual(assembleModelInput({text: 'Legacy user message.'}).history, [{role: 'user', content: 'Legacy user message.'}]);
});

for (const protocol of protocols) test(`${protocol}: frozen replay fragments preserve ordered multi-tool pairs and bind each note once`, () => {
  const calls: AgentTaskToolCall[] = [{id: 'first_read', name: tools[0]!.name, arguments: {}}, {id: 'second_read', name: tools[1]!.name, arguments: {limit: 2}}];
  const results = [{callId: calls[0]!.id, result: null}, {callId: calls[1]!.id, result: {shots: [{title: '镜头'}]}}];
  const source = freeze({context: [taskResponseLanguageContext('en'), {role: 'user', content: 'Read the saved project.'}], notes: [note('Bound before this reply.', true), note('Keep the original colours.')], tools, output: output(protocol, calls), results});
  const before = JSON.stringify(source);
  const fragments = [replayModelContext(protocol, {kind: 'notes', notes: source.notes, modelStepId}), replayModelContext(protocol, {kind: 'continuation', output: source.output, results: source.results})];
  const input = {context: source.context, text: 'Ignored fallback.', fragments, notes: source.notes, tools: source.tools};
  const first = assembleModelInput(input), second = assembleModelInput(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(first.pendingNotes, [source.notes[1]]);
  assert.equal(first.history.filter(value => object(value).content === source.notes[0]!.text).length, 1);
  assert.equal(first.history.filter(value => object(value).content === source.notes[1]!.text).length, 1);
  assert.deepEqual(first.metrics, {historyBytes: bytes(first.history), toolCount: tools.length});
  const body = buildTaskModelRequest(configuration(protocol), first.history, first.tools);
  const paired = callResults(body, protocol);
  assert.deepEqual(paired.calls, calls.map(call => call.id));
  assert.deepEqual(paired.results, results.map(result => ({id: result.callId, value: result.result})));
});

for (const protocol of protocols) test(`${protocol}: a capacity probe counts supplied persisted text without changing frozen history or notes`, () => {
  const source = freeze({context: [taskResponseLanguageContext('en'), {role: 'user', content: 'Saved request.'}, {role: 'assistant', content: 'h'.repeat(TASK_MODEL_LIMITS.historyBytes - 512)}], notes: [note('Already in the saved request.', true), note('Queued after the request.')]});
  const before = JSON.stringify(source);
  const known = assembleModelInput({context: source.context, text: 'Do not replace the saved history.', notes: source.notes});
  assert.ok(known.metrics.historyBytes < TASK_MODEL_LIMITS.historyBytes);
  assert.doesNotThrow(() => buildTaskModelRequest(configuration(protocol), known.history, known.tools));
  const partial = replayModelContext(protocol, {kind: 'partial', text: 'p'.repeat(1024)});
  const withPersistedText = assembleModelInput({context: source.context, text: 'Do not replace the saved history.', fragments: [partial], notes: source.notes});
  assert.ok(withPersistedText.metrics.historyBytes > TASK_MODEL_LIMITS.historyBytes);
  assert.throws(() => buildTaskModelRequest(configuration(protocol), withPersistedText.history, withPersistedText.tools), {code: 'AGENT_CHAT_LIMIT'});
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(assembleModelInput({context: source.context, text: 'Do not replace the saved history.', notes: source.notes}), known);
});

test('catalog diagnostics retain host catalog order when their selected names arrive in reverse order', () => {
  const catalog = freeze<(TaskToolDefinition & {risk: AgentTaskTier})[]>([{...tools[0]!, risk: 'read_only'}, {name: 'mioon_shot_update', description: 'Update a shot.', parameters: {type: 'object', properties: {}}, risk: 'local_reversible'}, {...tools[1]!, risk: 'read_only'}]);
  const before = JSON.stringify(catalog), selected = selectTaskModelTools(catalog, {profile: 'catalog', toolNames: [catalog[2]!.name, catalog[0]!.name]});
  assert.deepEqual(selected.map(tool => tool.name), [catalog[0]!.name, catalog[2]!.name]);
  assert.equal(JSON.stringify(catalog), before);
});
