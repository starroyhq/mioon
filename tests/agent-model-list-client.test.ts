import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentClient, AGENT_COMMAND_SCHEMAS} from '../packages/client/src/agent.ts';
import {AGENT_MODEL_LIST_LIMITS} from '../packages/contracts/src/agent-model-list.ts';
import type {AgentModelListResult} from '../packages/contracts/src/agent-model-list.ts';

const env = {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: 'synthetic-model-list-client-token'};
const selection = {presetId: 'openai', platformId: 'global', baseUrl: 'https://api.openai.com/v1', protocol: 'chat_completions'};
const location = {serviceKey: 'openai', expectedSettingsRevision: 7, selection};
const request = {...location, credential: {source: 'input', value: 'synthetic-model-list-client-only-key'}};
const fetchedAt = '2026-11-04T08:00:00.000Z';
const success = {outcome: 'success', models: [{id: 'gpt-4.1-mini', adaptation: 'adapted'}], complete: true, source: 'current_protocol', fetchedAt} as const;
const ok = (data: unknown) => new Response(JSON.stringify({ok: true, data}), {headers: {'content-type': 'application/json'}});

test('model list and read-only cache use isolated management POST routes without command catalog exposure', async () => {
  const calls: {url: string; init: RequestInit}[] = [];
  const client = createAgentClient({env, fetchImpl: async (url, init) => {
    calls.push({url: String(url), init: init!});
    return ok(String(url).endsWith('/cache') ? {status: 'hit', result: success} : success);
  }});
  assert.deepEqual(await client.modelsList(request), success);
  assert.deepEqual(await client.modelsCache(location), {status: 'hit', result: success});
  assert.deepEqual(calls.map(call => call.url), [env.MIOON_BASE_URL + '/api/agent/models/list', env.MIOON_BASE_URL + '/api/agent/models/cache']);
  for (const call of calls) {
    assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
    assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${env.MIOON_TOKEN}`);
    assert.equal(call.url.includes(request.credential.value), false);
  }
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), request);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), location);
  assert.equal(JSON.stringify(calls[1]!).includes(request.credential.value), false);
  assert.equal(Object.keys(AGENT_COMMAND_SCHEMAS).some(command => command.includes('model')), false);
});

test('all five provider outcomes stay strict data while invalid requests never dispatch', async () => {
  let calls = 0;
  const results: AgentModelListResult[] = [success as unknown as AgentModelListResult,
    {outcome: 'invalid_key', reason: 'rejected'}, {outcome: 'unavailable', reason: 'not_provided'},
    {outcome: 'unreachable', reason: 'connection_failed'}, {outcome: 'network_denied', reason: 'policy'}];
  const client = createAgentClient({env, fetchImpl: async () => {calls++; return ok(results.shift());}});
  for (const outcome of ['success', 'invalid_key', 'unavailable', 'unreachable', 'network_denied']) assert.equal((await client.modelsList(request)).outcome, outcome);
  for (const invalid of [{...request, url: 'https://evil.example.com'}, {...request, credential: {source: 'saved', value: 'secret'}}, {...request, credential: {source: 'input', value: 'x'.repeat(8193)}}, {...request, selection: {...selection, model: 'injected'}}]) {
    await assert.rejects(client.modelsList(invalid), {code: 'VALIDATION_ERROR'});
  }
  await assert.rejects(client.modelsCache({...location, credential: {source: 'none'}}), {code: 'VALIDATION_ERROR'});
  assert.equal(calls, 5);
});

test('model results and cache may exceed broker size but never the independent wire limit', async () => {
  const models = Array.from({length: 800}, (_, index) => ({id: `unverified-${index}-${'x'.repeat(90)}`, adaptation: 'unverified' as const}));
  const large = {...success, models};
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 64 * 1024);
  let response: unknown = large;
  const client = createAgentClient({env, fetchImpl: async () => ok(response)});
  assert.equal((await client.modelsList(request)).outcome, 'success');
  response = {status: 'hit', result: large};
  const cached = await client.modelsCache(location); assert.equal(cached.status, 'hit');
  if (cached.status === 'hit') assert.equal(cached.result.models.length, 800);
  response = {...large, ignored: 'x'.repeat(AGENT_MODEL_LIST_LIMITS.resultBytes)};
  await assert.rejects(client.modelsList(request), {code: 'BACKEND_PROTOCOL_ERROR'});
  response = {...success, models: [{id: request.credential.value, adaptation: 'unverified'}]};
  await assert.rejects(client.modelsList(request), {code: 'BACKEND_PROTOCOL_ERROR'});
  response = {...success, arbitraryProviderText: 'must not pass'};
  await assert.rejects(client.modelsList(request), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('list requests support cancellation and timeout without mutation recovery or retry', async () => {
  let calls = 0;
  const client = createAgentClient({env, fetchImpl: async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error('synthetic cancelled request'));
      else init?.signal?.addEventListener('abort', () => reject(new Error('synthetic cancelled request')), {once: true});
    });
  }});
  const already = new AbortController(); already.abort();
  await assert.rejects(client.modelsList(request, {signal: already.signal}), {code: 'INTERRUPTED'}); assert.equal(calls, 0);
  const cancel = new AbortController(), pending = client.modelsList(request, {signal: cancel.signal});
  setTimeout(() => cancel.abort(), 10);
  await assert.rejects(pending, error => {
    assert.equal((error as {code: string}).code, 'INTERRUPTED');
    assert.equal(JSON.stringify(error).includes(request.credential.value), false); return true;
  });
  // A timer keeps the process alive while AbortSignal.timeout's unref timer is
  // under observation; it is never a transport retry or an extra request.
  const keepAlive = setTimeout(() => {}, 1000);
  try {await assert.rejects(client.modelsList(request, {timeoutMs: 10}), {code: 'TIMEOUT'});}
  finally {clearTimeout(keepAlive);}
  assert.equal(calls, 2);
});
