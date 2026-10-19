import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startChatQaMock} from './agent-chat-qa-mock.ts';
import {streamAgentResponse} from '../packages/business/src/agent/agent-gateway.ts';
import {CHAT_SYSTEM_INSTRUCTION} from '../packages/business/src/agent/chat-policy.ts';

test('graphical QA fixture genuinely exercises both independent production protocol adapters', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-responses-qa-'));
  const mock = await startChatQaMock({directory});
  t.after(async () => { await mock.close(); await rm(directory, {recursive: true, force: true}); });
  for (const protocol of ['chat_completions', 'responses']) {
    const configuration = {protocol, presetId: 'ollama', platformId: 'local', baseUrl: mock.baseUrl, model: 'qwen3:8b'};
    const events = [];
    for await (const event of streamAgentResponse({configuration, apiKey: null, messages: [
      {role: 'system', content: CHAT_SYSTEM_INSTRUCTION}, {role: 'user', content: 'mock:normal synthetic QA'},
    ], signal: new AbortController().signal, selfPort: 4318})) events.push(event);
    assert.equal(events.at(-1).type, 'done');
    assert.ok(events.filter(event => event.type === 'delta').map(event => event.text).join('').includes('🎬'));
    assert.equal(mock.snapshot().requests.at(-1).protocol, protocol);
  }
  assert.equal(mock.snapshot().requests.length, 2);
  assert.equal(mock.snapshot().requests.some(request => request.authorizationPresent), false);
});
