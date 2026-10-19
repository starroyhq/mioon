import test from 'node:test';
interface ClientFailure {code?: string; details?: Record<string, unknown>}
const failureOf = (error: unknown): ClientFailure => error as ClientFailure;
type ResponseLike = Response;
import assert from 'node:assert/strict';
import {createClient} from '@mioon/client';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS} from '@mioon/contracts';

const projectId = '11111111-1111-4111-8111-111111111111';
const requestId = 'synthetic-review-recovery-001';
const env = {MIOON_TOKEN: 'synthetic-request-recovery-token-only'};
const input = {input: {projectId, requestId, name: 'Synthetic review', prompt: 'Synthetic prompt',
  providerId: 'openai', model: IMAGE_MODELS.openai, options: IMAGE_FIXED_OPTIONS}, settingsRevision: 1};
const response = (body: unknown): ResponseLike => ({ok: true, status: 200, json: async () => body} as unknown as ResponseLike);
const failures: Array<[string, string, () => Promise<unknown>]> = [
  ['lost connection', 'BACKEND_UNAVAILABLE', async () => {throw Error('Synthetic connection loss');}],
  ['truncated JSON', 'BACKEND_PROTOCOL_ERROR', async () => ({...response(null), json: async () => {throw SyntaxError('Synthetic truncated JSON');}})],
  ['missing result', 'BACKEND_PROTOCOL_ERROR', async () => response({ok: true})],
  ['invalid result', 'BACKEND_PROTOCOL_ERROR', async () => response({ok: true, data: {}})],
];

for (const [failure, code, fetchFailure] of failures) {
  test(`image review preparation preserves its nested replay identity after ${failure}`, async () => {
    const requests: unknown[] = [];
    const client = createClient({env, fetchImpl: (async (_url: string, options: {body?: string}) => {
      requests.push(JSON.parse(options.body!));
      return fetchFailure();
    }) as unknown as typeof fetch});
    await assert.rejects(client.rpc('image.review.prepare', input), (error: unknown) => {
      const failure = failureOf(error);
      assert.equal(failure.code, code);
      assert.equal(failure.details?.operation, 'image.review.prepare');
      assert.equal(failure.details?.requestId, requestId);
      assert.equal(failure.details?.submissionMayHaveSucceeded, true);
      assert.match(failure.details?.recovery as string, /exact original input.*same requestId/);
      return true;
    });
    assert.deepEqual(requests, [{operation: 'image.review.prepare', input}], 'no retry or changed intent');
  });

  test(`image receipt lookup does not claim a submission outcome after ${failure}`, async () => {
    const requests: unknown[] = [], lookup = {projectId, requestId};
    const client = createClient({env, fetchImpl: (async (_url: string, options: {body?: string}) => {
      requests.push(JSON.parse(options.body!));
      return fetchFailure();
    }) as unknown as typeof fetch});
    await assert.rejects(client.rpc('image.request.get', lookup), (error: unknown) => {
      const failure = failureOf(error);
      assert.equal(failure.code, code);
      assert.equal(Object.hasOwn(failure.details ?? {}, 'submissionMayHaveSucceeded'), false);
      assert.equal(Object.hasOwn(failure.details ?? {}, 'recovery'), false);
      assert.equal(Object.hasOwn(failure.details ?? {}, 'mutationOutcome'), false);
      return true;
    });
    assert.deepEqual(requests, [{operation: 'image.request.get', input: lookup}], 'one read, no mutation');
  });
}

test('transport failure keeps legacy keyless mutations keyless and keyed generation recoverable', async () => {
  const transportCases: Array<[string, Record<string, unknown>]> = [
    ['shot.create', {projectId, title: 'Legacy caller'}],
    ['generation.submit', {shotId: projectId, expectedRevision: 1, requestId, providerId: 'mock'}],
  ];
  for (const [operation, args] of transportCases) {
    let calls = 0;
    const client = createClient({env, fetchImpl: (async () => {calls++; throw Error('Synthetic connection loss');}) as unknown as typeof fetch});
    await assert.rejects(client.rpc(operation, args), (error: unknown) => {
      const failure = failureOf(error);
      assert.equal(failure.code, 'BACKEND_UNAVAILABLE');
      assert.equal(failure.details?.operation, operation);
      if (args.requestId) {
        assert.equal(failure.details?.requestId, requestId);
        assert.equal(failure.details?.submissionMayHaveSucceeded, true);
        assert.match(failure.details?.recovery as string, /same requestId/);
      } else assert.deepEqual(failure.details, {operation});
      return true;
    });
    assert.equal(calls, 1);
  }
});

for (const operation of ['image.review.prepare', 'image.request.get']) {
  const args = operation === 'image.review.prepare' ? input : {projectId, requestId};
  for (const failure of ['timeout', 'abort']) {
    test(`${operation} keeps its recovery meaning on in-flight ${failure}`, async () => {
      const controller = new AbortController(), requests: unknown[] = [];
      const client = createClient({env, requestTimeoutMs: failure === 'timeout' ? 1 : 1000,
        fetchImpl: (async (_url: string, options: {body?: string; signal?: AbortSignal}) => {
          requests.push(JSON.parse(options.body!));
          if (failure === 'abort') controller.abort();
          else await new Promise<void>(resolve => setTimeout(resolve, 20));
          assert.equal(options.signal?.aborted, true);
          throw (options.signal as AbortSignal).reason;
        }) as unknown as typeof fetch});
      await assert.rejects(client.rpc(operation, args, {signal: controller.signal}), (error: unknown) => {
        const failureResult = failureOf(error);
        assert.equal(failureResult.code, failure === 'timeout' ? 'TIMEOUT' : 'INTERRUPTED');
        assert.equal(failureResult.details?.operation, operation);
        if (operation === 'image.review.prepare') {
          assert.equal(failureResult.details?.requestId, requestId);
          assert.equal(failureResult.details?.submissionMayHaveSucceeded, true);
          assert.match(failureResult.details?.recovery as string, /same requestId/);
        } else assert.deepEqual(failureResult.details, {operation});
        return true;
      });
      assert.deepEqual(requests, [{operation, input: args}]);
    });
  }

  test(`${operation} aborted before dispatch sends nothing and claims no outcome`, async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = createClient({env, fetchImpl: (async () => {calls++; throw Error('Unexpected dispatch');}) as unknown as typeof fetch});
    await assert.rejects(client.rpc(operation, args, {signal: controller.signal}), (error: unknown) => {
      const failureResult = failureOf(error);
      assert.equal(failureResult.code, 'INTERRUPTED');
      assert.deepEqual(failureResult.details, {});
      return true;
    });
    assert.equal(calls, 0);
  });
}
