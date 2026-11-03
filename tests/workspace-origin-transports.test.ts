














import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@mioon/client';
const projectId = '33333333-3333-4333-8333-333333333333';
const input = Object.freeze({projectId, title:'Current project edit', requestId:'original-edit'});
const env = {MIOON_TOKEN:'synthetic-client-refusal-token'};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json'}});
test('SDK rejects retired inspection locally and retains original uncertainty on unknown backend refusal', async () => {
  let inspected = 0;
  const unknown = createClient({env, fetchImpl: async () => {inspected++; return response({ok:true,data:{restored:false}});}});
  await assert.rejects(unknown.rpc('workspace.restore.inspect', {}), {code:'UNKNOWN_OPERATION'});
  assert.equal(inspected, 0);
  for (const code of ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'] as const) {
    let calls = 0;
    const client = createClient({ env, fetchImpl: async () => { calls++; return response({ ok: false, error: { code, message: 'Held', details: { mutationOutcome: 'not_applied', requestId: input.requestId } } }, 409); } });
    await assert.rejects(client.rpc('shot.create', input), error => {
      assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code, code); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).details.operation, 'shot.create');
      assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).details.requestId, input.requestId); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).details.submissionMayHaveSucceeded, true);
      assert.equal(Object.hasOwn((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).details, 'mutationOutcome'), false); return true;
    });
    assert.equal(calls, 1);
  }
});
