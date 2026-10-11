import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@mioon/client';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '@mioon/contracts';

const projectId = '11111111-1111-4111-8111-111111111111';
const requestId = 'synthetic-review-recovery-001';
const env = {MIOON_TOKEN: 'synthetic-request-recovery-token-only'};
const input = {input: {projectId, requestId, name: 'Synthetic review', prompt: 'Synthetic prompt',
  providerId: 'openai', model: IMAGE_MODELS.openai, options: IMAGE_FIXED_OPTIONS}, settingsRevision: 1};
const response = body => ({ok: true, status: 200, json: async () => body});
const failures = [
  ['lost connection', 'BACKEND_UNAVAILABLE', async () => {throw Error('Synthetic connection loss');}],
  ['truncated JSON', 'BACKEND_PROTOCOL_ERROR', async () => ({...response(null), json: async () => {throw SyntaxError('Synthetic truncated JSON');}})],
  ['missing result', 'BACKEND_PROTOCOL_ERROR', async () => response({ok: true})],
  ['invalid result', 'BACKEND_PROTOCOL_ERROR', async () => response({ok: true, data: {}})],
];

for (const [failure, code, fetchFailure] of failures) {
  test(`image review preparation preserves its nested replay identity after ${failure}`, async () => {
    const requests = [];
    const client = createClient({env, fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return fetchFailure();
    }});
    await assert.rejects(client.rpc('image.review.prepare', input), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.operation, 'image.review.prepare');
      assert.equal(error.details.requestId, requestId);
      assert.equal(error.details.submissionMayHaveSucceeded, true);
      assert.match(error.details.recovery, /exact original input.*same requestId/);
      return true;
    });
    assert.deepEqual(requests, [{operation: 'image.review.prepare', input}], 'no retry or changed intent');
  });

  test(`image receipt lookup does not claim a submission outcome after ${failure}`, async () => {
    const requests = [], lookup = {projectId, requestId};
    const client = createClient({env, fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return fetchFailure();
    }});
    await assert.rejects(client.rpc('image.request.get', lookup), error => {
      assert.equal(error.code, code);
      assert.equal(Object.hasOwn(error.details, 'submissionMayHaveSucceeded'), false);
      assert.equal(Object.hasOwn(error.details, 'recovery'), false);
      assert.equal(Object.hasOwn(error.details, 'mutationOutcome'), false);
      return true;
    });
    assert.deepEqual(requests, [{operation: 'image.request.get', input: lookup}], 'one read, no mutation');
  });
}

test('transport failure keeps legacy keyless mutations keyless and keyed generation recoverable', async () => {
  for (const [operation, args] of [
    ['shot.create', {projectId, title: 'Legacy caller'}],
    ['generation.submit', {shotId: projectId, expectedRevision: 1, requestId, providerId: 'mock'}],
  ]) {
    let calls = 0;
    const client = createClient({env, fetchImpl: async () => {calls++; throw Error('Synthetic connection loss');}});
    await assert.rejects(client.rpc(operation, args), error => {
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      assert.equal(error.details.operation, operation);
      if (args.requestId) {
        assert.equal(error.details.requestId, requestId);
        assert.equal(error.details.submissionMayHaveSucceeded, true);
        assert.match(error.details.recovery, /same requestId/);
      } else assert.deepEqual(error.details, {operation});
      return true;
    });
    assert.equal(calls, 1);
  }
});

for (const operation of ['image.review.prepare', 'image.request.get']) {
  const args = operation === 'image.review.prepare' ? input : {projectId, requestId};
  for (const failure of ['timeout', 'abort']) {
    test(`${operation} keeps its recovery meaning on in-flight ${failure}`, async () => {
      const controller = new AbortController(), requests = [];
      const client = createClient({env, requestTimeoutMs: failure === 'timeout' ? 1 : 1000,
        fetchImpl: async (_url, options) => {
          requests.push(JSON.parse(options.body));
          if (failure === 'abort') controller.abort();
          else await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(options.signal.aborted, true);
          throw options.signal.reason;
        }});
      await assert.rejects(client.rpc(operation, args, {signal: controller.signal}), error => {
        assert.equal(error.code, failure === 'timeout' ? 'TIMEOUT' : 'INTERRUPTED');
        assert.equal(error.details.operation, operation);
        if (operation === 'image.review.prepare') {
          assert.equal(error.details.requestId, requestId);
          assert.equal(error.details.submissionMayHaveSucceeded, true);
          assert.match(error.details.recovery, /same requestId/);
        } else assert.deepEqual(error.details, {operation});
        return true;
      });
      assert.deepEqual(requests, [{operation, input: args}]);
    });
  }

  test(`${operation} aborted before dispatch sends nothing and claims no outcome`, async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = createClient({env, fetchImpl: async () => {calls++; throw Error('Unexpected dispatch');}});
    await assert.rejects(client.rpc(operation, args, {signal: controller.signal}), error => {
      assert.equal(error.code, 'INTERRUPTED');
      assert.deepEqual(error.details, {});
      return true;
    });
    assert.equal(calls, 0);
  });
}
