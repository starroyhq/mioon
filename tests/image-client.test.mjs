import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient} from '../packages/client/src/index.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_MUTATION_OPERATIONS} from '../packages/contracts/src/images.ts';

const env = {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: 'synthetic-image-client-token'};
const timestamp = '2026-10-10T12:00:00.000Z';
const clone = value => structuredClone(value);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const response = (body, status = 200) => ({status, ok: status >= 200 && status < 300, json: async () => body});
const success = data => response({ok: true, data});
function record() {
  return {id: randomUUID(), projectId: randomUUID(), groupId: randomUUID(), requestId: randomUUID(),
    name: 'Synthetic image', providerId: 'mock', model: IMAGE_MODELS.mock, prompt: 'Retain this exact prompt.',
    options: {...IMAGE_FIXED_OPTIONS}, state: 'queued', revision: 1, dispatched: false,
    versionId: null, errorCode: null, createdAt: timestamp, updatedAt: timestamp};
}
function fixture(operation, {existingGroup = false} = {}) {
  const value = record();
  if (operation === 'image.generate') {
    const {projectId, name, providerId, model, prompt, options, requestId} = value;
    return {operation, input: {projectId, name, providerId, model, prompt, options: clone(options), requestId,
      ...(existingGroup ? {groupId: value.groupId, expectedRevision: 7} : {})}, value};
  }
  value.state = operation === 'image.task.cancelQueued' ? 'cancelled_before_dispatch' : 'persisting';
  value.dispatched = operation === 'image.task.recoverResult'; value.revision = 8;
  return {operation, input: {projectId: value.projectId, taskId: value.id, expectedRevision: 7, requestId: randomUUID()}, value};
}
function harness(respond) {
  const calls = [];
  const client = createClient({env, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:4318/api/rpc');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    calls.push(JSON.parse(options.body));
    return respond({url, options, call: calls.length});
  }});
  return {client, calls};
}
function uncertain(error, operation, input, code = 'BACKEND_PROTOCOL_ERROR') {
  assert.equal(error.code, code);
  assert.deepEqual(error.details, {operation, requestId: input.requestId, submissionMayHaveSucceeded: true,
    recovery: 'Replay the exact original input with the same requestId; do not invent a replacement ID.'});
  assert.equal(error.exitCode, 4);
  assert.ok(!JSON.stringify(error).includes(env.MIOON_TOKEN));
  return true;
}

for (const operation of IMAGE_MUTATION_OPERATIONS) {
  test(`${operation}: valid historical ACKs preserve exact request and receipt; no automatic second POST`, async () => {
    const f = fixture(operation), original = clone(f.input), expected = clone(f.value);
    freeze(f.input); freeze(f.value);
    const {client, calls} = harness(() => success(f.value));
    assert.equal(await client.rpc(operation, f.input), f.value);
    assert.deepEqual(calls, [{operation, input: original}]);
    assert.equal(await client.rpc(operation, f.input), f.value, 'only explicit caller replay sends a second request');
    assert.deepEqual(calls, [{operation, input: original}, {operation, input: original}]);
    assert.deepEqual(f.input, original); assert.deepEqual(f.value, expected);
    if (operation !== 'image.generate') assert.notEqual(f.value.requestId, f.input.requestId,
      'task DTO retains its original generation request ID, not the later cancel/recover mutation key');
  });

  test(`${operation}: forged or incomplete 200 ACKs remain uncertain without changing the caller key`, async () => {
    const f = fixture(operation, {existingGroup: true}), original = clone(f.input);
    freeze(f.input);
    const invalid = [null, [], {}, 1, {...f.value, projectId: randomUUID()}, {...f.value, revision: 0},
      {...f.value, revision: f.value.revision + 1}, {...f.value, dispatched: !f.value.dispatched},
      {...f.value, state: 'outcome_unknown', dispatched: true}, {...f.value, versionId: randomUUID()},
      {...f.value, options: {...f.value.options, n: 2}}, {...f.value, model: IMAGE_MODELS.openai},
      {...f.value, createdAt: 'not-a-date'}, {...f.value, stagedReceipt: {path: '/private/stage.png'}},
      {...f.value, dataBase64: 'not-an-allowed-field'}];
    for (const field of Object.keys(f.value)) { const value = clone(f.value); delete value[field]; invalid.push(value); }
    if (operation === 'image.generate') invalid.push({...f.value, requestId: randomUUID()},
      {...f.value, groupId: randomUUID()}, {...f.value, name: 'Different name'}, {...f.value, prompt: 'Different prompt'},
      {...f.value, providerId: 'openai', model: IMAGE_MODELS.openai});
    else invalid.push({...f.value, id: randomUUID()});
    for (const value of invalid) {
      const {client, calls} = harness(() => success(value));
      await assert.rejects(client.rpc(operation, f.input), error => uncertain(error, operation, original));
      assert.deepEqual(calls, [{operation, input: original}]);
      assert.deepEqual(f.input, original, 'unknown outcome never mutates the retained exact request');
    }
  });

  test(`${operation}: malformed envelopes, unreadable JSON and lost transport preserve recovery identity`, async () => {
    const f = fixture(operation), original = clone(f.input); freeze(f.input);
    const cases = [
      [() => response(null), 'BACKEND_PROTOCOL_ERROR'],
      [() => response({ok: true}), 'BACKEND_PROTOCOL_ERROR'],
      [() => response({ok: 'true', data: f.value}), 'BACKEND_PROTOCOL_ERROR'],
      [() => response({ok: false, error: {code: 'BROKEN'}}), 'BACKEND_PROTOCOL_ERROR'],
      [() => ({ok: true, status: 200, json: async () => { throw Error('synthetic truncated JSON'); }}), 'BACKEND_PROTOCOL_ERROR'],
      [() => { throw Error('synthetic connection lost after possible commit'); }, 'BACKEND_UNAVAILABLE'],
    ];
    for (const [respond, code] of cases) {
      const {client, calls} = harness(respond);
      await assert.rejects(client.rpc(operation, f.input), error => uncertain(error, operation, original, code));
      assert.deepEqual(calls, [{operation, input: original}]); assert.deepEqual(f.input, original);
    }
  });

  test(`${operation}: explicit replay after malformed ACK sends only the original complete input`, async () => {
    const f = fixture(operation, {existingGroup: true}), original = clone(f.input); freeze(f.input);
    const {client, calls} = harness(({call}) => success(call === 1 ? {...f.value, projectId: randomUUID()} : f.value));
    await assert.rejects(client.rpc(operation, f.input), error => uncertain(error, operation, original));
    assert.equal(calls.length, 1);
    assert.deepEqual(await client.rpc(operation, f.input), f.value);
    assert.deepEqual(calls, [{operation, input: original}, {operation, input: original}]);
    assert.deepEqual(f.input, original);
  });
}

test('image.generate accepts equivalent fixed-option key order but never supplies a missing request key', async () => {
  const f = fixture('image.generate');
  f.value.options = {n: 1, background: 'opaque', outputFormat: 'png', quality: 'low', size: '1024x1024'};
  const {client, calls} = harness(() => success(f.value));
  assert.deepEqual(await client.rpc(f.operation, f.input), f.value);
  const missing = clone(f.input); delete missing.requestId;
  await assert.rejects(client.rpc(f.operation, missing), {code: 'VALIDATION_ERROR'});
  assert.equal(calls.length, 1, 'invalid/missing-key input is rejected before any request');
  assert.equal(Object.hasOwn(missing, 'requestId'), false, 'client never invents a key');
});

test('image mutation abort after dispatch keeps its original identity and never submits cancellation', async () => {
  const f = fixture('image.generate'), controller = new AbortController(), original = clone(f.input);
  freeze(f.input);
  const {client, calls} = harness(() => { controller.abort(); throw Error('synthetic abort during response'); });
  await assert.rejects(client.rpc(f.operation, f.input, {signal: controller.signal}), error => {
    assert.equal(error.code, 'INTERRUPTED'); assert.equal(error.details.requestId, original.requestId);
    assert.equal(error.details.operation, f.operation); assert.equal(error.details.submissionMayHaveSucceeded, true);
    return true;
  });
  assert.deepEqual(calls, [{operation: f.operation, input: original}]);
  assert.deepEqual(f.input, original);
});

async function verifyRead(operation, input, value) {
  const original = clone(input), expected = clone(value); freeze(input); freeze(value);
  const {client, calls} = harness(() => success(value));
  assert.equal(await client.rpc(operation, input), value);
  assert.deepEqual(input, original); assert.deepEqual(value, expected);
  assert.deepEqual(calls, [{operation, input: original}]);
}
async function rejectRead(operation, input, values) {
  const original = clone(input); freeze(input);
  for (const value of values) {
    const {client, calls} = harness(() => success(value));
    await assert.rejects(client.rpc(operation, input), error => {
      assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR');
      assert.equal(error.details.submissionMayHaveSucceeded, undefined, 'read DTO rejection does not imply generation');
      return true;
    });
    assert.deepEqual(calls, [{operation, input: original}]); assert.deepEqual(input, original);
  }
}

test('image task and group reads bind exact project and target without normalization', async () => {
  const task = record(), taskInput = {projectId: task.projectId, taskId: task.id};
  await verifyRead('image.task.get', taskInput, task);
  await rejectRead('image.task.get', taskInput, [null, {}, {...task, id: randomUUID()},
    {...task, projectId: randomUUID()}, {...task, relativePath: '/private/image.png'},
    {...task, state: 'succeeded', versionId: null}, {...task, revision: '1'}]);
  const group = {id: task.groupId, projectId: task.projectId, name: task.name, revision: 1,
    headVersionId: null, activeTaskId: task.id, createdAt: timestamp, updatedAt: timestamp};
  const groupInput = {projectId: task.projectId, groupId: group.id};
  await verifyRead('image.group.get', groupInput, group);
  await rejectRead('image.group.get', groupInput, [null, {}, {...group, id: randomUUID()},
    {...group, projectId: randomUUID()}, {...group, revision: 0}, {...group, headVersionId: 'bad-id'},
    {...group, snapshot: {prompt: 'private snapshot'}}]);
});

test('image request lookup binds project/key and returns a valid immutable receipt for each mutation', async () => {
  for (const operation of IMAGE_MUTATION_OPERATIONS) {
    const f = fixture(operation), input = {projectId: f.input.projectId, requestId: f.input.requestId};
    const value = {...input, operation, response: f.value};
    await verifyRead('image.request.get', input, value);
    await verifyRead('image.request.get', input, null);
    await rejectRead('image.request.get', input, [{}, {...value, projectId: randomUUID()},
      {...value, requestId: randomUUID()}, {...value, operation: 'generation.submit'},
      {...value, response: {...f.value, projectId: randomUUID()}}, {...value, response: null},
      {...value, canonicalInput: f.input}]);
    if (operation === 'image.generate') await rejectRead('image.request.get', input,
      [{...value, response: {...f.value, requestId: randomUUID()}}]);
  }
});

test('image request lookup rejects impossible original-receipt operation/state combinations', async () => {
  for (const operation of IMAGE_MUTATION_OPERATIONS) {
    const f = fixture(operation), input = {projectId: f.input.projectId, requestId: f.input.requestId};
    const value = {...input, operation, response: f.value};
    const wrongState = operation === 'image.generate' ? {...f.value, state: 'succeeded', dispatched: true, versionId: randomUUID()}
      : {...f.value, state: 'queued', dispatched: false, revision: 1};
    await rejectRead('image.request.get', input, [{...value, response: wrongState}]);
  }
});

test('image profile DTO accepts explicit configured activation but rejects inconsistent state, forged live evidence and private fields', async () => {
  const mock = {providerId: 'mock', model: IMAGE_MODELS.mock, name: 'Mock', enabled: true, isMock: true,
    evidence: 'deterministic-mock', options: {...IMAGE_FIXED_OPTIONS}};
  const openai = {providerId: 'openai', model: IMAGE_MODELS.openai, name: 'OpenAI', enabled: false, isMock: false,
    evidence: 'offline-tested-not-live', options: {...IMAGE_FIXED_OPTIONS}};
  const value = {items: [mock, openai], liveEnabled: false};
  await verifyRead('image.profile.list', {}, value);
  await verifyRead('image.profile.list', {}, {...value,items:[mock,{...openai,enabled:true}],liveEnabled:true});
  await rejectRead('image.profile.list', {}, [null, [], {}, {...value, liveEnabled: true},
    {...value, items: [mock, mock]}, {...value, items: [mock, {...openai, enabled: true}]},
    {...value, items: [mock, {...openai, apiKey: 'never-allowed'}]}, {...value, items:[mock,{...openai,evidence:'live-verified'}]},
    {...value, items: [{...mock, options: {...mock.options, quality: 'high'}}]},
    {...value, endpoint: 'https://unrequested.example'}]);
});

function pageFixture(operation) {
  const task = record(), input = {projectId: task.projectId, limit: 2};
  let item;
  if (operation === 'image.task.list') { input.groupId = task.groupId; item = task; }
  else if (operation === 'image.group.list') item = {id: task.groupId, projectId: task.projectId, name: task.name,
    revision: 1, headVersionId: null, activeTaskId: task.id, createdAt: timestamp, updatedAt: timestamp};
  else {
    input.groupId = task.groupId;
    item = {id: randomUUID(), projectId: task.projectId, groupId: task.groupId, taskId: task.id, number: 1,
      assetId: randomUUID(), sha256: 'a'.repeat(64), mimeType: 'image/png', width: 1024, height: 1024,
      byteLength: 19648, isMock: true, providerId: 'mock', model: IMAGE_MODELS.mock,
      options: {...IMAGE_FIXED_OPTIONS}, createdAt: timestamp};
  }
  return {input, item, value: {projectId: input.projectId, items: [item], nextCursor: null}};
}

for (const operation of ['image.task.list', 'image.group.list', 'image.version.list']) {
  test(`${operation}: pages reject foreign/duplicate/oversized or malformed records and cursors`, async () => {
    const {input, item, value} = pageFixture(operation);
    await verifyRead(operation, input, value);
    await verifyRead(operation, input, {...value, items: [], nextCursor: null});
    const invalid = [null, [], {}, {...value, projectId: randomUUID()}, {...value, extra: true},
      {...value, items: null}, {...value, items: [null]}, {...value, items: [item, clone(item)]},
      {...value, items: [{...item, projectId: randomUUID()}]}, {...value, items: [{...item, rawBase64: 'forbidden'}]},
      {...value, items: [0, 1, 2].map(() => ({...item, id: randomUUID()}))},
      ...['', 'x'.repeat(769), 1, {}, []].map(nextCursor => ({...value, nextCursor}))];
    if (input.groupId) invalid.push({...value, items: [{...item, groupId: randomUUID()}]});
    if (operation === 'image.version.list') invalid.push({...value, items: [{...item, isMock: false}]},
      {...value, items: [{...item, width: 2048}]}, {...value, items: [{...item, sha256: 'not-a-hash'}]},
      {...value, items: [{...item, byteLength: 31 * 1024 * 1024}]});
    await rejectRead(operation, input, invalid);
  });
}

test('fresh-client request lookup after an uncertain generation is only a read and retains the same recovery key', async () => {
  const f = fixture('image.generate'), original = clone(f.input); freeze(f.input);
  const first = harness(() => { throw Error('synthetic dropped acknowledgement'); });
  await assert.rejects(first.client.rpc(f.operation, f.input), error => uncertain(error, f.operation, original, 'BACKEND_UNAVAILABLE'));
  const input = {projectId: original.projectId, requestId: original.requestId};
  const receipt = {...input, operation: f.operation, response: f.value};
  const fresh = harness(() => success(receipt));
  assert.deepEqual(await fresh.client.rpc('image.request.get', input), receipt);
  assert.deepEqual(first.calls, [{operation: f.operation, input: original}]);
  assert.deepEqual(fresh.calls, [{operation: 'image.request.get', input}]);
  assert.deepEqual(f.input, original);
});
