import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openLegacyWorkspaceStore} from '../packages/business/src/db.ts';
import {collectTaskRequestFingerprints,readTaskRequestFingerprintFixture} from './helpers/agent-task-request-fingerprints-v2.ts';

test('the legacy workspace path retains all 99 pre-R2 request bytes without project rules functionality', {timeout:180_000}, async()=>{
 const expected:unknown=JSON.parse(readFileSync(new URL('./fixtures/agent-task-legacy-request-fingerprints-v2.json',import.meta.url),'utf8'));
 assert.ok(expected!==null&&typeof expected==='object'&&'requests' in expected);
 const actual=await collectTaskRequestFingerprints({openStore:openLegacyWorkspaceStore});
 assert.equal(actual.length,99);
 assert.deepEqual(actual,expected.requests,'Legacy requests retain the main 9f5fd08b baseline; R2 changes native tools only.');
 const diagnostics=actual.filter(row=>row.scenario.startsWith('diagnostic'));
 assert.equal(diagnostics.length,12);
 assert.deepEqual(diagnostics,readTaskRequestFingerprintFixture().requests.filter(row=>row.scenario.startsWith('diagnostic')));
});
