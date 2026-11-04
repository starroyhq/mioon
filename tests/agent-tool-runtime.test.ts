import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelToolArguments} from '../packages/business/src/agent/model-tool-arguments.ts';
import {inspectionArgumentSchemas} from '../packages/contracts/src/inspection.ts';

test('tool argument schema rejects duplicate and escaped duplicate properties, unknown keys and limit escalation', () => {
  for (const value of ['{"limit":2,"limit":10}', '{"limit":2,"li\\u006dit":10}'])
    assert.throws(() => parseModelToolArguments(value, 32 * 1024), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  for (const value of ['{"limit":26}', '{"limit":2,"authority":true}'])
    assert.equal(inspectionArgumentSchemas['asset.inspect'].safeParse(parseModelToolArguments(value, 32 * 1024)).success, false);
  for (const limit of [2, 25])
    assert.deepEqual(inspectionArgumentSchemas['asset.inspect'].parse(parseModelToolArguments(JSON.stringify({limit}), 32 * 1024)), {limit});
  const boundary = JSON.stringify({cursor: '中'}), bytes = Buffer.byteLength(boundary);
  assert.deepEqual(parseModelToolArguments(boundary, bytes), {cursor: '中'});
  assert.throws(() => parseModelToolArguments(boundary, bytes - 1), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  assert.throws(() => parseModelToolArguments('{"cursor":"\ud800"}', 32 * 1024), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
  assert.throws(() => parseModelToolArguments('{"nested":'.repeat(34) + '0' + '}'.repeat(34), 32 * 1024), {code: 'AGENT_CHAT_PROTOCOL_ERROR'});
});
