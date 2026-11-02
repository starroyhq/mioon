import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReadToolArguments, READ_TOOL_CATALOG_HASH} from '../packages/business/src/agent/read-tool-policy.ts';

test('tool argument schema rejects duplicate and escaped duplicate properties, unknown keys and limit escalation', () => {
  assert.equal(READ_TOOL_CATALOG_HASH.length, 64);
  for (const value of ['{"limit":2,"limit":10,"cursor":null}', '{"limit":2,"li\\u006dit":10,"cursor":null}', '{"limit":11,"cursor":null}', '{"limit":2,"cursor":null,"authority":true}'] as const)
    assert.throws(() => parseReadToolArguments('mioon_asset_inspect', value));
  assert.deepEqual(parseReadToolArguments('mioon_asset_inspect', '{"limit":2,"cursor":null}').dispatchArguments, {limit: 2});
});
