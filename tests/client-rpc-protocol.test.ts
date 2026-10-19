import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@mioon/client';
import { rpc, ApiError } from '../apps/web/src/api.ts';
const projectId = '11111111-1111-4111-8111-111111111111';
const env = { MIOON_TOKEN: 'synthetic-client-protocol-token-only' };
const input = { projectId, title: 'Synthetic shot', requestId: 'original-mutation-request' };
interface ClientFailure {code?: string; details?: Record<string, unknown>; definitive?: boolean; status?: number}
const failureOf = (error: unknown): ClientFailure => error as ClientFailure;
type FetchHandler = (url: string, options: {body?: string; method?: string; signal?: AbortSignal}) => Promise<Response>;
const response = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);

test('shared client marks every malformed RPC envelope ambiguous and never retries', async () => {
  for (const body of [null, [], {}, { ok: true }, { ok: false }, { ok: false, error: { message: 'No code' } }]) {
    const requests: unknown[] = [];
    const client = createClient({ env, fetchImpl: (async (_url: string, options: {body?: string}) => { requests.push(JSON.parse(options.body!)); return response(body); }) as unknown as typeof fetch });
    await assert.rejects(client.rpc('shot.create', input), (error: unknown) => {
      const failure = failureOf(error);
      assert.equal(failure.code, 'BACKEND_PROTOCOL_ERROR');
      assert.equal(failure.details?.requestId, input.requestId);
      assert.equal(failure.details?.submissionMayHaveSucceeded, true);
      return true;
    });
    assert.deepEqual(requests, [{ operation: 'shot.create', input }]);
  }
});

test('shared client keeps caller input unchanged and does not invent optional IDs', async () => {
  const seen: unknown[] = [], client = createClient({ env, fetchImpl: (async (_url: string, options: {body?: string}) => { const body = JSON.parse(options.body!); seen.push(body); return response({ ok: true, data: { id: 'shot-a', projectId, revision: 1 } }); }) as unknown as typeof fetch });
  const unkeyed = { projectId, title: 'Legacy caller' };
  await client.rpc('shot.create', unkeyed);
  await client.rpc('shot.create', input);
  await client.rpc('shot.create', input);
  assert.deepEqual(seen.map(body => (body as {input?: unknown}).input), [unkeyed, input, input]);
  assert.equal(Object.hasOwn(unkeyed, 'requestId'), false);
});

test('shared client preserves backend rollback proof and legacy health response', async () => {
  const proof = { mutationOutcome: 'not_applied', requestId: input.requestId };
  await assert.rejects(createClient({ env, fetchImpl: (async () => response({ ok: false, error: { code: 'REVISION_CONFLICT', message: 'Changed', details: proof } }, 409)) as unknown as typeof fetch }).rpc('shot.create', input), (error: unknown) => {
    const failure = failureOf(error);
    assert.equal(failure.status, 409); assert.deepEqual(failure.details, proof); return true;
  });
  const client = createClient({ env, fetchImpl: (async (url: string) => url.endsWith('/health') ? response({ ok: true, service: 'mioon', version: 'test', sqlite: true }) : response({ ok: true, data: [] })) as unknown as typeof fetch });
  assert.equal((await client.doctor()).ready, true);
});

test('web RPC malformed success/error JSON remains ambiguous including non-JSON and contradictory status', async (t: TestContext) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  const cases: Array<[unknown, number]> = [[null, 200], [{}, 200], [{ ok: true }, 200], [{ ok: false }, 400], [{ ok: true, data: {} }, 503]];
  for (const [body, status] of cases) {
    globalThis.fetch = (async () => { calls++; return response(body, status); }) as unknown as typeof fetch;
    await assert.rejects(rpc('shot.create', input), (error: unknown) => { const failure = failureOf(error); return error instanceof ApiError && failure.code === 'BACKEND_PROTOCOL_ERROR' && failure.definitive === false; });
  }
  globalThis.fetch = (async () => { calls++; return { ...response(null), json: async () => { throw Error('Truncated response'); } }; }) as unknown as typeof fetch;
  await assert.rejects(rpc('shot.create', input), (error: unknown) => { const failure = failureOf(error); return failure.code === 'NETWORK' && failure.definitive === false; });
  assert.equal(calls, 6);
});

test('web RPC preserves a valid definite no-commit proof and exact serialized payload', async (t: TestContext) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const proof = { mutationOutcome: 'not_applied', requestId: input.requestId }; let sent: unknown;
  globalThis.fetch = (async (_url: string, options: {body?: string}) => { sent = JSON.parse(options.body!); return response({ ok: false, error: { code: 'REVISION_CONFLICT', message: 'Changed', details: proof } }, 409); }) as unknown as typeof fetch;
  await assert.rejects(rpc('shot.create', input), (error: unknown) => { const failure = failureOf(error); return failure.definitive === true && failure.details?.requestId === input.requestId && failure.details?.mutationOutcome === 'not_applied'; });
  assert.deepEqual(sent, { operation: 'shot.create', input });
});

const entityId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const otherProject = '44444444-4444-4444-8444-444444444444';
const mutations: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['shot.create', { projectId, title: 'Create' }, { id: entityId, projectId, revision: 1 }],
  ['shot.update', { shotId: entityId, expectedRevision: 1, patch: { prompt: 'Update' } }, { id: entityId, projectId, revision: 2 }],
  ['shot.reorder', { projectId, expectedRevision: 1, shotIds: [entityId] }, { id: projectId, revision: 2 }],
  ['node.create', { projectId, type: 'text', position: { x: 0, y: 0 } }, { id: entityId, projectId, revision: 1 }],
  ['node.update', { nodeId: entityId, expectedRevision: 1, patch: { text: 'Update' } }, { id: entityId, projectId, revision: 2 }],
  ['version.select', { shotId: entityId, versionId, expectedRevision: 1 }, { id: entityId, projectId, revision: 2, selectedVersionId: versionId }],
];

test('shared client accepts exact valid responses for all six mutations, keyed and legacy unkeyed', async () => {
  for (const [operation, data, result] of mutations) {
    let calls = 0;
    const client = createClient({ env, fetchImpl: (async () => { calls++; return response({ ok: true, data: result }); }) as unknown as typeof fetch });
    assert.deepEqual(await client.rpc(operation, data), result);
    assert.deepEqual(await client.rpc(operation, { ...data, requestId: input.requestId }), result);
    assert.equal(calls, 2);
  }
});

test('shared client rejects malformed six-op data with original key guidance and no retry', async () => {
  for (const [operation, data, valid] of mutations) {
    const invalid: unknown[] = [null, {}, [], 42, { ...valid, id: '' }, { ...valid, revision: 0 }, { ...valid, revision: '2' }, { ...valid, revision: 1.5 }];
    if (operation.endsWith('.create')) invalid.push({ ...valid, projectId: otherProject });
    if (data.shotId || data.nodeId || operation === 'shot.reorder') invalid.push({ ...valid, id: otherProject });
    if (operation !== 'shot.reorder') { const missingProject = { ...valid }; delete missingProject.projectId; invalid.push(missingProject); }
    if (operation === 'version.select') invalid.push({ ...valid, selectedVersionId: otherProject });
    for (const result of invalid) {
      let calls = 0;
      const client = createClient({ env, fetchImpl: (async () => { calls++; return response({ ok: true, data: result }); }) as unknown as typeof fetch });
      await assert.rejects(client.rpc(operation, { ...data, requestId: input.requestId }), (error: unknown) => {
        const failure = failureOf(error);
        assert.equal(failure.code, 'BACKEND_PROTOCOL_ERROR');
        assert.equal(failure.details?.operation, operation); assert.equal(failure.details?.requestId, input.requestId);
        assert.equal(failure.details?.submissionMayHaveSucceeded, true); assert.match(failure.details?.recovery as string, /exact original input/);
        return true;
      });
      assert.equal(calls, 1, operation);
    }
  }
});
