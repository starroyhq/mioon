import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicMessages} from '../packages/business/src/agent/anthropic-wire.ts';

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
