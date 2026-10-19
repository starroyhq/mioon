import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createClient} from '../packages/client/src/index.ts';
import {FRAME_MUTATION_OPERATIONS, FRAME_LIMITS, canonicalFrameInput} from '../packages/contracts/src/frame-extraction.ts';

const env = {MIOON_BASE_URL:'http://127.0.0.1:4318', MIOON_TOKEN:'synthetic-frame-client-token'};
const timestamp = '2026-10-11T00:00:00.000Z';
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const response = (body, status = 200) => ({status, ok:status >= 200 && status < 300, json:async () => body});
const success = data => response({ok:true, data});
const digest = input => createHash('sha256').update(canonicalFrameInput(input)).digest('hex');
const recovery = 'Replay the exact original input with the same requestId; do not invent a replacement ID.';
function record() {
  return {id:randomUUID(), projectId:randomUUID(), requestId:randomUUID(), sourceAssetId:randomUUID(), sourceHash:'a'.repeat(64),
    sourceFrame:12, fps:30, profileId:'local-png-1024-v1', state:'queued', revision:1, started:false,
    result:null, errorCode:null, createdAt:timestamp, updatedAt:timestamp};
}
function fixture(operation = 'frame.extract') {
  const value = record();
  if (operation === 'frame.extract') {
    const {projectId, sourceAssetId, sourceHash, sourceFrame, requestId} = value;
    return {operation, input:{projectId, sourceAssetId, sourceHash, sourceFrame, requestId}, value};
  }
  value.state = operation === 'frame.task.cancelQueued' ? 'cancelled_before_start' : 'persisting';
  value.started = operation === 'frame.task.recoverResult'; value.revision = 8;
  return {operation, input:{projectId:value.projectId, taskId:value.id, expectedRevision:7, requestId:randomUUID()}, value};
}
function harness(respond) {
  const calls = [];
  const client = createClient({env, fetchImpl:async (url, options) => {
    assert.equal(url, env.MIOON_BASE_URL + '/api/rpc'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    calls.push(JSON.parse(options.body)); return respond({call:calls.length, options});
  }});
  return {client, calls};
}
function uncertain(error, f, code = 'BACKEND_PROTOCOL_ERROR') {
  assert.equal(error.code, code);
  assert.deepEqual(error.details, {operation:f.operation, requestId:f.input.requestId, submissionMayHaveSucceeded:true, recovery});
  assert.ok(!JSON.stringify(error).includes(env.MIOON_TOKEN)); return true;
}
const proofFor = f => ({status:'not_accepted', operation:f.operation, projectId:f.input.projectId, requestId:f.input.requestId, inputHash:digest(f.input)});

for (const operation of FRAME_MUTATION_OPERATIONS) {
  test(`${operation}: strict historical acknowledgement retains exact input and only explicit replay sends again`, async () => {
    const f = fixture(operation), original = clone(f.input), expected = clone(f.value); freeze(f.input); freeze(f.value);
    const h = harness(() => success(f.value));
    assert.equal(await h.client.rpc(operation, f.input), f.value);
    assert.deepEqual(h.calls, [{operation, input:original}]);
    assert.equal(await h.client.rpc(operation, f.input), f.value);
    assert.deepEqual(h.calls, [1, 2].map(() => ({operation, input:original})));
    assert.deepEqual(f.input, original); assert.deepEqual(f.value, expected);
    if (operation !== 'frame.extract') assert.notEqual(f.value.requestId, f.input.requestId, 'task keeps initial extraction key');
  });
  test(`${operation}: malformed 200 acknowledgements retain caller identity without normalization`, async () => {
    const f = fixture(operation), original = clone(f.input); freeze(f.input);
    const invalid = [null, [], {}, 1, {...f.value, projectId:randomUUID()}, {...f.value, revision:'1'},
      {...f.value, revision:f.value.revision + 1}, {...f.value, started:!f.value.started}, {...f.value, fps:24},
      {...f.value, profileId:'custom'}, {...f.value, sourceHash:'A'.repeat(64)}, {...f.value, createdAt:'not-a-date'},
      {...f.value, sourceFrame:0.25}, {...f.value, errorCode:'error'}, {...f.value, relativePath:'/private/stage.png'},
      {...f.value, result:{assetId:randomUUID(), sha256:'b'.repeat(64), mimeType:'image/png', width:16, height:12, byteLength:1}}];
    for (const field of Object.keys(f.value)) { const value = clone(f.value); delete value[field]; invalid.push(value); }
    if (operation === 'frame.extract') invalid.push({...f.value, requestId:randomUUID()}, {...f.value, sourceAssetId:randomUUID()},
      {...f.value, sourceHash:'b'.repeat(64)}, {...f.value, sourceFrame:f.value.sourceFrame + 1});
    else invalid.push({...f.value, id:randomUUID()});
    for (const value of invalid) {
      const h = harness(() => success(value));
      await assert.rejects(h.client.rpc(operation, f.input), error => uncertain(error, f));
      assert.deepEqual(h.calls, [{operation, input:original}]); assert.deepEqual(f.input, original);
    }
  });
  test(`${operation}: lost/truncated/malformed transport never retries or replaces the original key`, async () => {
    const f = fixture(operation); freeze(f.input);
    for (const [respond, code] of [
      [() => response(null), 'BACKEND_PROTOCOL_ERROR'], [() => response({ok:true}), 'BACKEND_PROTOCOL_ERROR'],
      [() => response({ok:'true', data:f.value}), 'BACKEND_PROTOCOL_ERROR'],
      [() => response({ok:false, error:{code:'BROKEN'}}), 'BACKEND_PROTOCOL_ERROR'],
      [() => ({status:200, ok:true, json:async () => { throw Error('truncated JSON'); }}), 'BACKEND_PROTOCOL_ERROR'],
      [() => { throw Error('lost after possible commit'); }, 'BACKEND_UNAVAILABLE'],
    ]) {
      const h = harness(respond); await assert.rejects(h.client.rpc(operation, f.input), error => uncertain(error, f, code));
      assert.deepEqual(h.calls, [{operation, input:f.input}]);
    }
    const h = harness(({call}) => success(call === 1 ? {...f.value, projectId:randomUUID()} : f.value));
    await assert.rejects(h.client.rpc(operation, f.input), error => uncertain(error, f));
    assert.equal(h.calls.length, 1); assert.deepEqual(await h.client.rpc(operation, f.input), f.value);
    assert.deepEqual(h.calls, [1, 2].map(() => ({operation, input:f.input})));
  });
  test(`${operation}: only exact code/status/operation/project/key/input-hash refusal proof resolves uncertainty`, async () => {
    const f = fixture(operation), proof = proofFor(f);
    for (const [code, status] of Object.entries({FRAME_CAPACITY:507, FRAME_QUEUE_FULL:409, FRAME_REVISION_CONFLICT:409,
      FRAME_STATE_CONFLICT:409, FRAME_SOURCE_INVALID:409, FRAME_SOURCE_CHANGED:409, FRAME_RESULT_INVALID:409})) {
      const h = harness(() => response({ok:false, error:{code, message:'Refused.', details:{frameOutcome:proof}}}, status));
      await assert.rejects(h.client.rpc(operation, f.input), error => {
        assert.equal(error.code, code); assert.deepEqual(error.details, {frameOutcome:proof, operation, requestId:f.input.requestId, submissionMayHaveSucceeded:false}); return true;
      });
      assert.equal(h.calls.length, 1);
    }
    const invalid = [undefined, null, true, [], {}, {...proof, status:'failed'}, {...proof, outcome:'not_accepted'},
      {...proof, projectId:randomUUID()}, {...proof, requestId:randomUUID()}, {...proof, operation:'image.generate'},
      {...proof, inputHash:digest({...f.input, requestId:randomUUID()})}, {...proof, inputHash:'A'.repeat(64)},
      ...Object.keys(proof).map(field => { const result = {...proof}; delete result[field]; return result; })];
    const changedInputs = operation === 'frame.extract'
      ? [{...f.input, sourceFrame:f.input.sourceFrame + 1}, {...f.input, sourceAssetId:randomUUID()}, {...f.input, sourceHash:'b'.repeat(64)}]
      : [{...f.input, taskId:randomUUID()}, {...f.input, expectedRevision:f.input.expectedRevision + 1}];
    invalid.push(...changedInputs.map(input => ({...proof, inputHash:digest(input)})));
    for (const candidate of invalid) {
      const h = harness(() => response({ok:false, error:{code:'FRAME_STATE_CONFLICT', message:'not_accepted', details:{frameOutcome:candidate}}}, 409));
      await assert.rejects(h.client.rpc(operation, f.input), error => uncertain(error, f, 'FRAME_STATE_CONFLICT'));
      assert.equal(h.calls.length, 1);
    }
    for (const [code, status] of [['FRAME_STATE_CONFLICT',400], ['FRAME_CAPACITY',409], ['FRAME_REQUEST_CONFLICT',409],
      ['FRAME_NOT_FOUND',404], ['UNAUTHORIZED',401], ['FRAME_STORAGE_FAILED',503], ['FRAME_RESULT_INVALID',200]]) {
      const h = harness(() => response({ok:false, error:{code, message:'not_accepted', details:{frameOutcome:proof}}}, status));
      await assert.rejects(h.client.rpc(operation, f.input), error => uncertain(error, f, code));
      assert.equal(h.calls.length, 1);
    }
  });
}

test('frame input rejects overrides and absent keys before transport and never creates a request ID', async () => {
  const f = fixture(), h = harness(() => assert.fail('invalid input was sent'));
  const invalid = [{...f.input, requestId:undefined}, {...f.input, sourceFrame:'12'}, {...f.input, sourceHash:'A'.repeat(64)},
    {...f.input, timestamp:0.4}, {...f.input, path:'/private/video.mp4'}, {...f.input, profileId:'local-png-1024-v1'},
    {...f.input, providerId:'mock'}, {...f.input, command:'ffmpeg'}, {...f.input, outputName:'frame.png'}];
  for (const input of invalid) { const before = clone(input); freeze(input); await assert.rejects(h.client.rpc(f.operation, input), {code:'VALIDATION_ERROR'}); assert.deepEqual(input, before); }
  assert.deepEqual(h.calls, []);
});

test('frame abort after dispatch retains identity and does not send cancellation', async () => {
  const f = fixture(), controller = new AbortController(), h = harness(() => { controller.abort(); throw Error('abort'); });
  await assert.rejects(h.client.rpc(f.operation, f.input, {signal:controller.signal}), error => uncertain(error, f, 'INTERRUPTED'));
  assert.deepEqual(h.calls, [{operation:f.operation, input:f.input}]);
});

async function verifyRead(operation, input, value) {
  const original = clone(input), expected = clone(value); freeze(input); freeze(value);
  const h = harness(() => success(value)); assert.equal(await h.client.rpc(operation, input), value);
  assert.deepEqual(input, original); assert.deepEqual(value, expected); assert.deepEqual(h.calls, [{operation, input:original}]);
}
async function rejectRead(operation, input, values) {
  for (const value of values) {
    const h = harness(() => success(value));
    await assert.rejects(h.client.rpc(operation, input), error => { assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(error.details.submissionMayHaveSucceeded, undefined); return true; });
    assert.deepEqual(h.calls, [{operation, input}]);
  }
}
test('task reads bind project and target and validate strict result metadata', async () => {
  const value = record(), input = {projectId:value.projectId, taskId:value.id};
  await verifyRead('frame.task.get', input, value);
  const done = {...value, state:'succeeded', started:true, revision:4, result:{assetId:randomUUID(), sha256:'b'.repeat(64), mimeType:'image/png', width:16, height:12, byteLength:90}};
  await verifyRead('frame.task.get', input, done);
  await rejectRead('frame.task.get', input, [null, {}, {...value, projectId:randomUUID()}, {...value, id:randomUUID()},
    {...value, started:true}, {...value, snapshot:{}}, {...done, result:null}, {...done, result:{...done.result, assetId:value.sourceAssetId}},
    {...done, result:{...done.result, width:1025}}, {...done, result:{...done.result, byteLength:FRAME_LIMITS.resultBytes + 1}},
    {...done, result:{...done.result, bytes:'private'}}]);
});
test('request reads bind exact key/project and immutable operation acknowledgement without becoming writes', async () => {
  for (const operation of FRAME_MUTATION_OPERATIONS) {
    const f = fixture(operation), input = {projectId:f.input.projectId, requestId:f.input.requestId}, value = {...input, operation, response:f.value};
    await verifyRead('frame.request.get', input, null); await verifyRead('frame.request.get', input, value);
    await rejectRead('frame.request.get', input, [{}, {...value, projectId:randomUUID()}, {...value, requestId:randomUUID()},
      {...value, operation:'image.generate'}, {...value, response:{...f.value, projectId:randomUUID()}},
      {...value, response:null}, {...value, canonicalInput:f.input},
      {...value, response:{...f.value, state:'interrupted', errorCode:'FRAME_INTERRUPTED'}}]);
    const h = harness(() => { throw Error('lost read'); });
    await assert.rejects(h.client.rpc('frame.request.get', input), error => { assert.equal(error.code, 'BACKEND_UNAVAILABLE'); assert.deepEqual(error.details, {operation:'frame.request.get'}); return true; });
  }
});
test('list reads reject foreign/duplicate/oversized items and malformed cursors without pagination writes', async () => {
  const item = record(), input = {projectId:item.projectId, limit:2}, value = {projectId:item.projectId, items:[item], nextCursor:null};
  await verifyRead('frame.task.list', input, value); await verifyRead('frame.task.list', input, {...value, items:[]});
  await verifyRead('frame.task.list', {...input, cursor:'opaque-original-cursor'}, {...value, nextCursor:'opaque-next-cursor'});
  await rejectRead('frame.task.list', input, [null, [], {}, {...value, projectId:randomUUID()}, {...value, extra:true},
    {...value, items:null}, {...value, items:[null]}, {...value, items:[item, clone(item)]},
    {...value, items:[{...item, projectId:randomUUID()}]}, {...value, items:[{...item, rawBase64:'private'}]},
    {...value, items:[0, 1, 2].map(() => ({...item, id:randomUUID()}))},
    ...['', 'x'.repeat(769), 1, {}, []].map(nextCursor => ({...value, nextCursor}))]);
});
test('read errors remove an unverified frame refusal marker and do not claim uncertain submission', async () => {
  const f = fixture(), input = {projectId:f.input.projectId, requestId:f.input.requestId};
  const h = harness(() => response({ok:false, error:{code:'FRAME_NOT_FOUND', message:'Missing.', details:{frameOutcome:proofFor(f)}}}, 404));
  await assert.rejects(h.client.rpc('frame.request.get', input), error => { assert.deepEqual(error.details, {}); return true; });
});
