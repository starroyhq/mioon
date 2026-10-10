import assert from 'node:assert/strict';

const recovery = 'Replay the exact original input with the same requestId; do not invent a replacement ID.';
const recoveryFields = ['operation', 'requestId', 'submissionMayHaveSucceeded', 'recovery'];

// HTTP exposes the backend envelope; CLI/MCP add caller-owned recovery guidance.
// Verify each addition before comparing every unchanged backend error field.
export function assertClientRecoveryError(error, backendError, {operation, input}) {
  assert.equal(error.retryable, false, 'first-party transports never advertise an automatic retry');
  if (backendError.code === 'VALIDATION_ERROR') {
    for (const field of recoveryFields) assert.equal(Object.hasOwn(error.details, field), false, 'local pre-send validation is not an uncertain submission');
    assert.deepEqual(error, {...backendError, retryable: false});
    return;
  }
  const backendDetails = backendError.details || {};
  const proven = backendDetails.mutationOutcome === 'not_applied';
  if (proven) {
    assert.ok(operation.startsWith('timeline.') || ['reference.attach', 'reference.detach'].includes(operation));
    assert.equal(backendDetails.requestId, input.requestId, 'the backend proof belongs to the exact request');
    if (operation.startsWith('reference.')) {
      assert.equal(backendDetails.operation, operation, 'reference proof is operation-bound');
      assert.equal(backendDetails.projectId, input.projectId, 'reference proof is project-bound');
    }
  }
  assert.equal(error.details.operation, operation);
  assert.equal(error.details.requestId, input.requestId);
  assert.equal(error.details.submissionMayHaveSucceeded, !proven);
  if (proven) {
    assert.equal(error.details.mutationOutcome, 'not_applied');
    assert.equal(Object.hasOwn(error.details, 'recovery'), false, 'proven rollback has no ambiguous-replay guidance');
  } else {
    assert.equal(Object.hasOwn(error.details, 'mutationOutcome'), false, 'an uncertain error cannot release the key');
    assert.equal(error.details.recovery, recovery);
  }
  assert.deepEqual(error, {...backendError, retryable: false, details: {...backendDetails,
    operation, requestId: input.requestId, submissionMayHaveSucceeded: !proven, ...(!proven ? {recovery} : {})}},
  'all backend code, message and details remain unchanged alongside verified client-only metadata');
}
