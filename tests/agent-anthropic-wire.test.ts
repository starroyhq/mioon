import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicMessages, anthropicToolContinuation} from '../packages/business/src/agent/anthropic-wire.ts';
import {normalizeToolCall, readToolRequestFields, validateReadTools} from '../packages/business/src/agent/tool-wire.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';

const configuration: AgentConfiguration = {presetId: 'custom', platformId: 'custom', baseUrl: 'https://messages.example.com/anthropic', model: 'synthetic-text-model', protocol: 'anthropic_messages'};
const use = (id: string, name = 'mioon_project_inspect', input: unknown = {}) => ({type: 'tool_use', id, name, input});
const result = (id: string) => ({type: 'tool_result', tool_use_id: id, content: '{"ok":true}'});

test('native history preserves system, ordered tool objects and results without mutating retained input', () => {
  const history = [{role: 'system', content: 'Host instruction'}, {role: 'user', content: 'Read saved data'},
    {role: 'assistant', content: [{type: 'text', text: 'Reading'}, use('tool_1'), use('tool_2')]},
    {role: 'user', content: [result('tool_1'), result('tool_2'), {type: 'text', text: 'Continue'}]}];
  const before = structuredClone(history), actual = anthropicMessages(Object.freeze(history));
  assert.equal(actual.system, 'Host instruction');
  assert.deepEqual(actual.messages, history.slice(1));
  assert.deepEqual(history, before);
  assert.notEqual(actual.messages[1]!.content, history[2]!.content);
});

test('native request history rejects orphan, duplicate, reordered or incomplete tool pairs and unsupported content', () => {
  const assistant = {role: 'assistant', content: [use('tool_1'), use('tool_2')]};
  const bad: unknown[][] = [
    [], [{role: 'developer', content: 'Override'}], [{role: 'user', content: 'First'}, {role: 'system', content: 'Override'}],
    [{role: 'user', content: 'Text', extra: 'field'}], [{role: 'user', content: [{type: 'image', source: {url: 'https://example.com/image'}}]}],
    [{role: 'assistant', content: [use('tool_1')]}], [{role: 'user', content: [result('tool_1')]}],
    [assistant, {role: 'user', content: [result('tool_2'), result('tool_1')]}],
    [assistant, {role: 'user', content: [result('tool_1')]}],
    [assistant, {role: 'user', content: [result('tool_1'), result('tool_1')]}],
    [assistant, {role: 'user', content: [{type: 'text', text: 'Before pending results'}, result('tool_1'), result('tool_2')]}],
    [{role: 'assistant', content: [use('tool_1'), use('tool_1')]}, {role: 'user', content: [result('tool_1'), result('tool_1')]}],
    [{role: 'assistant', content: [{...use('tool_1'), cache_control: {type: 'ephemeral'}}]}, {role: 'user', content: [result('tool_1')]}],
    [{role: 'assistant', content: [{type: 'thinking', thinking: 'private'}]}],
    [{role: 'assistant', content: [{type: 'server_tool_use', id: 'remote', name: 'web_search', input: {}}]}],
  ];
  for (const history of bad) assert.throws(() => anthropicMessages(history));
});

test('native tool input validation is bounded and rejects deep or circular retained structures', () => {
  let nested: unknown = {};
  for (let i = 0; i < 40; i++) nested = {child: nested};
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const input of [nested, circular, {value: 'x'.repeat(32 * 1024)}]) {
    assert.throws(() => anthropicMessages([{role: 'assistant', content: [use('tool_1', 'mioon_project_inspect', input)]}, {role: 'user', content: [result('tool_1')]}]), {code: 'AGENT_CHAT_VALIDATION'});
  }
});

function answerState() {
  const argumentsJson = '{ "limit" : 2, "cursor" : null }';
  const toolCall = normalizeToolCall({id: 'tool_1', name: 'mioon_asset_inspect', argumentsJson}, undefined);
  return {phase: 'answer', toolCall,
    providerOutput: {role: 'assistant', content: [{type: 'text', text: 'Read saved assets'}, use('tool_1', toolCall.name, {limit: 2, cursor: null})]},
    result: '{"items":[]}'};
}
test('read-tool continuation binds semantic Anthropic input to the exact original call and result', () => {
  const state = answerState(), before = structuredClone(state);
  validateReadTools(configuration, state);
  const messages = anthropicToolContinuation(state);
  assert.deepEqual(messages, [state.providerOutput, {role: 'user', content: [{type: 'tool_result', tool_use_id: state.toolCall.id, content: state.result}]}]);
  assert.deepEqual(state, before);
  const mutations = [
    (value: ReturnType<typeof answerState>) => {value.toolCall.id = 'other';},
    (value: ReturnType<typeof answerState>) => {value.toolCall.name = 'mioon_project_inspect';},
    (value: ReturnType<typeof answerState>) => {value.toolCall.argumentsJson = '{"limit":3,"cursor":null}';},
    (value: ReturnType<typeof answerState>) => {value.providerOutput.content.push(use('tool_2'));},
  ];
  for (const mutate of mutations) {const changed = structuredClone(state); mutate(changed); assert.throws(() => anthropicToolContinuation(changed));}
});

test('Anthropic tool schemas and final-answer cap are protocol-specific; OpenAI wire controls stay unchanged', () => {
  const request = readToolRequestFields(configuration, {phase: 'request'});
  assert.deepEqual(request.tool_choice, {type: 'auto', disable_parallel_tool_use: true});
  const tools = request.tools as {name: string; input_schema: unknown; function?: unknown; parameters?: unknown}[];
  assert.equal(tools.length, 4); assert.equal(tools[0]!.name, 'mioon_project_inspect');
  assert.ok(tools[0]!.input_schema); assert.equal(tools[0]!.function, undefined); assert.equal(tools[0]!.parameters, undefined);
  assert.deepEqual(readToolRequestFields(configuration, answerState()), {tools: [], tool_choice: {type: 'none'}});
  for (const protocol of ['chat_completions', 'responses'] as const) {
    const old: AgentConfiguration = {...configuration, protocol};
    const fields = readToolRequestFields(old, {phase: 'request'});
    assert.equal(fields.tool_choice, 'auto'); assert.equal(fields.parallel_tool_calls, false);
    assert.deepEqual(readToolRequestFields(old, {...answerState(), ...(protocol === 'responses' ? {toolCall: {...answerState().toolCall, itemId: 'item_1'}} : {})}), {tools: [], tool_choice: 'none', parallel_tool_calls: false});
  }
});
