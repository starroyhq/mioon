import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {REFERENCE_MUTATION_OPERATIONS, REFERENCE_RESPONSE_BYTES, isReferenceMutationResponse, isReferenceShotRecord, isReferenceEdgeRecord, hasRequestNotAppliedProof} from '@mioon/contracts';
import {createClient} from '@mioon/client';

const env = {MIOON_TOKEN: 'synthetic-reference-response-token'};
const clone = value => structuredClone(value);
const response = (data, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => data});
const success = data => response({ok: true, data});
const frozen = value => {
  if (value && typeof value === 'object') {Object.values(value).forEach(frozen); Object.freeze(value);}
  return value;
};
function fixture(operation, {noop = false} = {}) {
  const projectId = randomUUID(), source = randomUUID(), target = randomUUID(), sourceAssetId = randomUUID();
  const edge = {id: randomUUID(), projectId, source, target, kind: 'reference', role: 'first_frame', sourceAssetId, createdAt: '2024-01-01T00:00:00.000Z'};
  const attach = operation === 'reference.attach';
  const input = {projectId, requestId: randomUUID(), expectedShotRevision: 7,
    ...(attach ? {sourceNodeId: source, targetShotId: target, expectedSourceRevision: 3, role: 'first_frame'} : {edgeId: edge.id})};
  const shot = {id: target, projectId, title: 'Historical shot', prompt: '', referenceAssetIds: attach ? [sourceAssetId] : [],
    aspectRatio: '9:16', duration: 2, parameters: {}, position: {x: 80, y: -100}, orderIndex: 0, revision: attach && noop ? 7 : 8,
    selectedVersionId: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:01.000Z'};
  return {input, value: {edge, shot, ...(attach ? {} : {detached: true})}};
}

test('reference acknowledgement allowlist is exact and immutable', () => {
  assert.deepEqual(REFERENCE_MUTATION_OPERATIONS, ['reference.attach', 'reference.detach']);
  assert.equal(Object.isFrozen(REFERENCE_MUTATION_OPERATIONS), true);
  const {input, value} = fixture('reference.attach');
  for (const operation of [undefined, '', 'edge.create', 'edge.delete', 'shot.update', 'timeline.undo', 'generation.submit'])
    assert.equal(isReferenceMutationResponse(operation, input, value), false);
});

test('complete legacy, existing-binding no-op and historical reference results remain exact and read-only', async () => {
  for (const [operation, options] of [['reference.attach', {}], ['reference.attach', {noop: true}], ['reference.detach', {}]]) {
    const {input, value} = fixture(operation, options), before = clone(value), beforeInput = clone(input), calls = [];
    frozen(input); frozen(value);
    assert.equal(isReferenceShotRecord(value.shot, {projectId: input.projectId}), true);
    assert.equal(isReferenceEdgeRecord(value.edge, {projectId: input.projectId}), true);
    assert.equal(isReferenceMutationResponse(operation, input, value), true);
    const client = createClient({env, fetchImpl: async (_url, options) => {calls.push(JSON.parse(options.body)); return success(value);}});
    // No current edge or latest shot is required to acknowledge a stored result.
    // The caller may replay it after detach, rebinding or unrelated shot edits.
    assert.equal(await client.rpc(operation, input), value);
    assert.equal(await client.rpc(operation, input), value);
    assert.deepEqual(calls, [{operation, input: beforeInput}, {operation, input: beforeInput}]);
    assert.deepEqual(value, before); assert.deepEqual(input, beforeInput);
    assert.deepEqual(value.shot.parameters, {}, 'No provider defaults are introduced');
  }
});

test('every known optional parameter and selected version remains valid without normalization', () => {
  const scenarios = ['success', 'failure', 'delay', 'timeout', 'unknown', 'reject', 'download_fail_once', 'rejected_before_accept', 'accepted_then_response_lost', 'poll_timeout_then_recover', 'terminal_failure'];
  for (const operation of REFERENCE_MUTATION_OPERATIONS) for (const parameters of [{}, {seed: -1}, {seed: Number.MAX_VALUE}, {delayMs: 0}, {delayMs: 120000}, ...scenarios.map(scenario => ({scenario}))]) {
    const {input, value} = fixture(operation); value.shot.parameters = parameters; value.shot.selectedVersionId = randomUUID();
    const before = clone(value); frozen(value);
    assert.equal(isReferenceMutationResponse(operation, input, value), true);
    assert.deepEqual(value, before);
  }
});

test('reference acknowledgement input identity is complete, strict and safe-integer bounded', () => {
  for (const operation of REFERENCE_MUTATION_OPERATIONS) {
    const {input, value} = fixture(operation);
    const invalid = [null, [], {}, 4, {...input, extra: true}, {...input, requestId: 'short'}, {...input, requestId: 'x'.repeat(201)},
      {...input, projectId: 'not-a-uuid'}, {...input, expectedShotRevision: 0}, {...input, expectedShotRevision: 1.5},
      {...input, expectedShotRevision: Number.MAX_SAFE_INTEGER + 1}, {...input, expectedShotRevision: NaN}];
    if (operation === 'reference.attach') invalid.push({...input, sourceNodeId: 'bad'}, {...input, targetShotId: 'bad'}, {...input, role: 'last_frame'}, {...input, expectedSourceRevision: 0}, {...input, expectedSourceRevision: 1.5});
    else invalid.push({...input, edgeId: 'bad'});
    for (const key of Object.keys(input)) {const missing = {...input}; delete missing[key]; invalid.push(missing, {...input, [key]: undefined});}
    for (const candidate of invalid) assert.equal(isReferenceMutationResponse(operation, candidate, value), false, operation);
    const inherited = Object.create(input);
    assert.equal(isReferenceMutationResponse(operation, inherited, value), false, 'Inherited fields cannot supply request identity');
  }
});

test('malformed reference 200s preserve caller operation and request key and never auto-resubmit', async () => {
  for (const operation of REFERENCE_MUTATION_OPERATIONS) {
    const {input, value} = fixture(operation);
    const edit = change => {const result = clone(value); change(result); return result;};
    const invalid = [null, [], {}, 7, 'reference',
      edit(v => delete v.edge), edit(v => delete v.shot), edit(v => v.extra = true),
      edit(v => v.edge = []), edit(v => v.shot = null), edit(v => v.edge.id = 'bad'), edit(v => v.shot.id = 'bad'),
      edit(v => v.shot.projectId = randomUUID()), edit(v => v.edge.projectId = randomUUID()),
      edit(v => v.edge.projectId = v.shot.projectId = randomUUID()),
      edit(v => v.edge.target = randomUUID()), edit(v => v.edge.kind = 'decorative'), edit(v => v.edge.role = 'last_frame'),
      edit(v => v.edge.source = 'bad'), edit(v => v.edge.sourceAssetId = 'bad'), edit(v => v.edge.createdAt = 'invalid'),
      edit(v => v.edge.extra = true), edit(v => v.shot.extra = true),
      edit(v => v.shot.title = ''), edit(v => v.shot.title = 'x'.repeat(151)), edit(v => v.shot.prompt = 'x'.repeat(5001)),
      edit(v => v.shot.prompt = null), edit(v => v.shot.duration = 21), edit(v => v.shot.duration = 0),
      edit(v => v.shot.duration = 1.5), edit(v => v.shot.aspectRatio = '2:1'), edit(v => v.shot.orderIndex = -1),
      edit(v => v.shot.revision = input.expectedShotRevision - 1), edit(v => v.shot.revision = input.expectedShotRevision + 2),
      edit(v => v.shot.revision = Number.MAX_SAFE_INTEGER + 1), edit(v => v.shot.selectedVersionId = 'bad'),
      edit(v => v.shot.createdAt = ''), edit(v => v.shot.updatedAt = 'invalid'),
      edit(v => v.shot.referenceAssetIds = null), edit(v => v.shot.referenceAssetIds = ['bad']),
      edit(v => v.shot.referenceAssetIds = Array(9).fill(v.edge.sourceAssetId)),
      edit(v => v.shot.parameters = []), edit(v => v.shot.parameters = {extra: true}),
      edit(v => v.shot.parameters = {scenario: 'invented'}), edit(v => v.shot.parameters = {seed: 0.5}),
      edit(v => v.shot.parameters = {seed: Infinity}), edit(v => v.shot.parameters = {delayMs: -1}),
      edit(v => v.shot.parameters = {delayMs: 120001}), edit(v => v.shot.parameters = {scenario: undefined}),
      edit(v => v.shot.position = {x: 0}), edit(v => v.shot.position = {x: NaN, y: 0}),
      edit(v => v.shot.position = {x: 0, y: Infinity}), edit(v => v.shot.position.extra = true),
    ];
    for (const key of Object.keys(value.shot)) invalid.push(edit(v => delete v.shot[key]));
    for (const key of Object.keys(value.edge)) invalid.push(edit(v => delete v.edge[key]));
    if (operation === 'reference.attach') invalid.push(
      edit(v => v.edge.source = randomUUID()), edit(v => v.edge.target = v.shot.id = randomUUID()),
      edit(v => v.shot.referenceAssetIds = []), edit(v => v.shot.referenceAssetIds = [randomUUID()]),
      edit(v => v.shot.referenceAssetIds.push(v.edge.sourceAssetId)), edit(v => v.detached = true), edit(v => v.detached = false));
    else invalid.push(edit(v => v.edge.id = randomUUID()), edit(v => v.shot.revision = input.expectedShotRevision),
      edit(v => v.shot.referenceAssetIds = [v.edge.sourceAssetId]), edit(v => delete v.detached), edit(v => v.detached = false));
    for (const [index, candidate] of invalid.entries()) {
      assert.equal(isReferenceMutationResponse(operation, input, candidate), false, `${operation} malformed case ${index}`);
      const calls = [];
      const client = createClient({env, fetchImpl: async (_url, options) => {calls.push(JSON.parse(options.body)); return success(candidate);}});
      await assert.rejects(client.rpc(operation, input), error => {
        assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(error.details.operation, operation);
        assert.equal(error.details.requestId, input.requestId); assert.equal(error.details.submissionMayHaveSucceeded, true);
        assert.equal(Object.hasOwn(error.details, 'mutationOutcome'), false);
        assert.match(error.details.recovery, /exact original input.*same requestId/); return true;
      });
      assert.deepEqual(calls, [{operation, input}], 'Malformed acknowledgement cannot cause a second request');
    }
  }
});

test('maximum escaped historical fields fit the reference byte bound without discarding valid data', async () => {
  assert.equal(REFERENCE_RESPONSE_BYTES, 64 * 1024);
  for (const operation of REFERENCE_MUTATION_OPERATIONS) {
    const {input, value} = fixture(operation);
    input.expectedShotRevision = Number.MAX_SAFE_INTEGER - 1; input.requestId = '\u0000'.repeat(200);
    Object.assign(value.shot, {title: '\u0001'.repeat(150), prompt: '\u0000'.repeat(5000), selectedVersionId: randomUUID(),
      revision: Number.MAX_SAFE_INTEGER, orderIndex: Number.MAX_SAFE_INTEGER, duration: 20,
      position: {x: Number.MAX_VALUE, y: -Number.MAX_VALUE}, parameters: {scenario: 'accepted_then_response_lost', delayMs: 120000, seed: -Number.MAX_VALUE}});
    const at = '\t'.repeat(35) + 'Mon, 01 Jan 2024 00:00:00 GMT';
    value.shot.createdAt = at; value.shot.updatedAt = at; value.edge.createdAt = at;
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    assert.ok(bytes > 31000, `JSON escaping is represented in the cap fixture: ${bytes}`);
    assert.ok(bytes < REFERENCE_RESPONSE_BYTES, `Every bounded field fits: ${bytes}`);
    const before = clone(value); frozen(value); frozen(input);
    assert.equal(isReferenceMutationResponse(operation, input, value), true);
    const client = createClient({env, fetchImpl: async () => success(value)});
    assert.deepEqual(await client.rpc(operation, input), before); assert.deepEqual(value, before);
  }
});

test('maximum revision still acknowledges an existing binding but cannot acknowledge a new increment', () => {
  const {input, value} = fixture('reference.attach', {noop: true});
  input.expectedShotRevision = Number.MAX_SAFE_INTEGER; value.shot.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(isReferenceMutationResponse('reference.attach', input, value), true);
  value.shot.revision++;
  assert.equal(isReferenceMutationResponse('reference.attach', input, value), false);
  const detached = fixture('reference.detach'); detached.input.expectedShotRevision = Number.MAX_SAFE_INTEGER;
  detached.value.shot.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(isReferenceMutationResponse('reference.detach', detached.input, detached.value), false);
});

const safeCodes = ['REVISION_CONFLICT', 'REFERENCE_CONNECTED', 'REFERENCE_SELECTION_EXISTS', 'INVALID_REFERENCE_SOURCE', 'INVALID_REFERENCE_EDGE', 'REFERENCE_REVISION_LIMIT'];
const proof = (operation, input) => ({mutationOutcome: 'not_applied', operation, projectId: input.projectId, requestId: input.requestId});
test('reference rejection proof requires its own exact operation, project, request and reference-only safe code', () => {
  for (const operation of REFERENCE_MUTATION_OPERATIONS) {
    const {input} = fixture(operation), details = proof(operation, input);
    const error = {code: 'REVISION_CONFLICT', status: 409, details};
    for (const code of safeCodes) {
      assert.equal(hasRequestNotAppliedProof({...error, code}, input, {operation}), true, code);
      assert.equal(hasRequestNotAppliedProof({...error, code, status: undefined, definitive: true}, input, {operation}), true, code);
    }
    for (const code of ['INVALID_CLIP_TYPE', 'SOURCE_BOUNDS', 'SOURCE_UNCHANGED', 'TIMELINE_LIMIT', 'PREFLIGHT_STALE', 'TIMELINE_REVISION_LIMIT', 'NOTHING_TO_UNDO', 'NOTHING_TO_REDO',
      'NOT_FOUND', 'CROSS_PROJECT_REFERENCE', 'IDEMPOTENCY_CONFLICT', 'INVALID_REFERENCE_RECORD', 'REFERENCE_STATE_CONFLICT', 'UNAUTHORIZED', 'ORIGIN_REJECTED', 'BACKEND_PROTOCOL_ERROR', 'INTERNAL_ERROR'])
      assert.equal(hasRequestNotAppliedProof({...error, code}, input, {operation}), false, code);
    for (const status of [200, 401, 403, 500, undefined]) assert.equal(hasRequestNotAppliedProof({...error, status}, input, {operation}), false);
    for (const key of ['mutationOutcome', 'operation', 'projectId', 'requestId']) {
      const missing = {...details}; delete missing[key];
      assert.equal(hasRequestNotAppliedProof({...error, details: missing}, input, {operation}), false, `Missing ${key}`);
      const inherited = Object.assign(Object.create({[key]: details[key]}), missing);
      assert.equal(hasRequestNotAppliedProof({...error, details: inherited}, input, {operation}), false, `Inherited ${key}`);
    }
    for (const changed of [{requestId: randomUUID()}, {projectId: randomUUID()}, {operation: 'timeline.clip.update'}, {operation: operation === 'reference.attach' ? 'reference.detach' : 'reference.attach'}, {mutationOutcome: 'applied'}])
      assert.equal(hasRequestNotAppliedProof({...error, details: {...details, ...changed}}, input, {operation}), false);
    assert.equal(hasRequestNotAppliedProof(error, {...input, projectId: 'invalid'}, {operation}), false);
  }
});

test('shared client releases only exact reference prewrite proofs and leaves ambiguous errors replayable', async () => {
  for (const operation of REFERENCE_MUTATION_OPERATIONS) {
    const {input} = fixture(operation), exact = proof(operation, input);
    const cases = [
      ...safeCodes.map(code => [409, code, exact, true]),
      [400, 'INVALID_REFERENCE_SOURCE', exact, true],
      [409, 'REVISION_CONFLICT', {}, false],
      [409, 'REVISION_CONFLICT', {mutationOutcome: 'not_applied', requestId: input.requestId}, false],
      [409, 'REVISION_CONFLICT', {...exact, projectId: randomUUID()}, false],
      [409, 'REVISION_CONFLICT', {...exact, requestId: randomUUID()}, false],
      [409, 'REVISION_CONFLICT', {...exact, operation: 'timeline.undo'}, false],
      [409, 'REVISION_CONFLICT', {...exact, operation: operation === 'reference.attach' ? 'reference.detach' : 'reference.attach'}, false],
      [409, 'INVALID_CLIP_TYPE', exact, false], [409, 'SOURCE_UNCHANGED', exact, false],
      [409, 'IDEMPOTENCY_CONFLICT', exact, false], [404, 'NOT_FOUND', exact, false],
      [400, 'CROSS_PROJECT_REFERENCE', exact, false], [409, 'INVALID_REFERENCE_RECORD', exact, false],
      [409, 'REFERENCE_STATE_CONFLICT', exact, false], [401, 'REVISION_CONFLICT', exact, false],
      [403, 'REVISION_CONFLICT', exact, false], [500, 'REVISION_CONFLICT', exact, false],
    ];
    for (const [status, code, details, proven] of cases) {
      const calls = [], client = createClient({env, fetchImpl: async (_url, options) => {
        calls.push(JSON.parse(options.body)); return response({ok: false, error: {code, message: 'Synthetic reference rejection', details}}, status);
      }});
      await assert.rejects(client.rpc(operation, input), error => {
        assert.equal(error.code, code); assert.equal(error.status, status);
        assert.equal(error.details.operation, operation); assert.equal(error.details.requestId, input.requestId);
        assert.equal(error.details.submissionMayHaveSucceeded, !proven);
        assert.equal(Object.hasOwn(error.details, 'mutationOutcome'), proven);
        assert.equal(Object.hasOwn(error.details, 'recovery'), !proven);
        if (proven) assert.equal(error.details.projectId, input.projectId);
        return true;
      });
      assert.deepEqual(calls, [{operation, input}]);
    }
  }
});

test('legacy timeline optional proof identity and timeline safe-code acceptance are unchanged', () => {
  const operation = 'timeline.clip.update', input = {projectId: randomUUID(), requestId: randomUUID(), expectedRevision: 1};
  const legacy = {status: 409, code: 'INVALID_CLIP_TYPE', details: {mutationOutcome: 'not_applied', requestId: input.requestId}};
  assert.equal(hasRequestNotAppliedProof(legacy, input, {operation}), true);
  assert.equal(hasRequestNotAppliedProof({...legacy, status: undefined, definitive: true}, input, {operation}), true);
  for (const code of safeCodes.filter(code => code !== 'REVISION_CONFLICT'))
    assert.equal(hasRequestNotAppliedProof({...legacy, code}, input, {operation}), false, 'Reference codes cannot widen legacy timeline proof acceptance');
});
