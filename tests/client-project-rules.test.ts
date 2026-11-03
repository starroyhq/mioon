import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProjectRulesClient} from '../packages/client/src/project-rules.ts';

const projectId = randomUUID(), requestId = randomUUID(), hash = 'a'.repeat(64);
const env = {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: 'SYNTHETIC_RULES_CLIENT_TOKEN_1234567890'};
const snapshot = {projectId, file: 'AGENTS.md', exists: true, text: 'exact\r\n', hash, trust: 'trusted', maxBytes: 8192, readError: null, pendingWrites: false};
const user = {text: '', revision: 0, updatedAt: null, maxBytes: 8192};
const ok = (data: unknown) => new Response(JSON.stringify({ok: true, data}), {headers: {'content-type': 'application/json'}});

test('rules client keeps project IDs in the path, forwards stable CAS keys and explicitly reconciles', async () => {
  const calls: Array<{url: string; options?: RequestInit}> = [];
  const client = createProjectRulesClient({env, fetchImpl: async (url, options) => {
    calls.push({url: String(url), options});
    if (String(url).includes('/requests/')) return ok(String(url).includes('/user-rules/') ? {requestId, status: 'applied', result: user} : {projectId, requestId, status: 'applied', state: 'completed', result: snapshot});
    return ok(String(url).includes('/user-rules') ? user : snapshot);
  }});
  assert.deepEqual(await client.get({projectId}), snapshot);
  const save = {projectId, requestId, expectedHash: null, text: '\r\n'};
  await client.save(save); assert.deepEqual(JSON.parse(String(calls.at(-1)!.options!.body)), {requestId, expectedHash: null, text: '\r\n'}); assert.equal(calls.at(-1)!.options!.method, 'PUT');
  await client.enable({projectId, requestId, expectedHash: hash}); assert.equal(calls.at(-1)!.url, env.MIOON_BASE_URL + `/api/projects/${projectId}/rules/enable`);
  await client.lookup({projectId, requestId}); assert.equal(calls.at(-1)!.options!.method, 'GET');
  await client.reconcile({projectId, requestId}); assert.equal(calls.at(-1)!.options!.method, 'POST'); assert.equal(calls.at(-1)!.options!.body, '{}');
  await client.getUser(); await client.saveUser({requestId, expectedRevision: 0, text: ''}); await client.lookupUser({requestId});
  assert.equal(calls.length, 8);
  for (const call of calls) {assert.equal(call.options!.redirect, 'error'); assert.equal(new Headers(call.options!.headers).get('authorization'), `Bearer ${env.MIOON_TOKEN}`);}
});

test('invalid rules authority and text never dispatch and never invent replay IDs', async () => {
  let calls = 0; const client = createProjectRulesClient({env, fetchImpl: async () => {calls++; return ok(snapshot);}});
  for (const extra of [{approved: true}, {trust: true}, {path: '/private'}, {text: '\ud800'}, {text: 'x'.repeat(8193)}]) await assert.rejects(client.save({projectId, requestId, expectedHash: null, text: '', ...extra}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(client.save({projectId, expectedHash: null, text: ''}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(client.enable({projectId, requestId, expectedHash: null}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(client.get({projectId, path: 'AGENTS.md'}), {code: 'VALIDATION_ERROR'});
  assert.equal(calls, 0);
});

test('response snapshots and receipts must match the addressed project and original request', async () => {
  let reply: unknown = {...snapshot, projectId: randomUUID()};
  const client = createProjectRulesClient({env, fetchImpl: async () => ok(reply)});
  await assert.rejects(client.get({projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  reply = {...snapshot, path: '/private/project'}; await assert.rejects(client.get({projectId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  reply = {projectId, requestId: randomUUID(), status: 'not_applied', state: null, result: null};
  await assert.rejects(client.lookup({projectId, requestId}), {code: 'BACKEND_PROTOCOL_ERROR'});
  reply = {requestId: randomUUID(), status: 'not_applied', result: null};
  await assert.rejects(client.lookupUser({requestId}), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('lost or malformed write responses are uncertain and never cause retry, GET or reconciliation', async () => {
  for (const malformed of [false, true]) {
    let calls = 0; const client = createProjectRulesClient({env, fetchImpl: async () => {calls++; if (malformed) return ok({...snapshot, hash: 'invalid'}); throw Error('PRIVATE transport detail');}});
    await assert.rejects(client.save({projectId, requestId, expectedHash: null, text: ''}), error => {
      assert.equal(calls, 1); assert.ok(error instanceof Error && 'code' in error && 'details' in error); assert.equal(error.code, 'MIO_RULES_WRITE_UNCERTAIN');
      assert.deepEqual(error.details, {requestId, lookup: `/api/projects/${projectId}/rules/requests/${requestId}`, outcomeUnknown: true});
      assert.doesNotMatch(error.message, /PRIVATE/u); return true;
    });
  }
});

test('unknown server failures and cancellation after dispatch retain an uncertain original write identity', async () => {
  let calls = 0;
  const unknown = createProjectRulesClient({env, fetchImpl: async () => {calls++; return new Response(JSON.stringify({ok: false, error: {code: 'PRIVATE_FAILURE', message: '/private'}}), {status: 500, headers: {'content-type': 'application/json'}});}});
  await assert.rejects(unknown.saveUser({requestId, expectedRevision: 0, text: ''}), {code: 'MIO_RULES_WRITE_UNCERTAIN'}); assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = createProjectRulesClient({env, fetchImpl: async () => {controller.abort(); throw Error('SYNTHETIC cancellation');}});
  await assert.rejects(cancelled.saveUser({requestId, expectedRevision: 0, text: ''}, {signal: controller.signal}), error => {
    assert.ok(error instanceof Error && 'code' in error && 'details' in error); assert.equal(error.code, 'INTERRUPTED');
    assert.deepEqual(error.details, {requestId, lookup: `/api/user-rules/requests/${requestId}`, outcomeUnknown: true}); return true;
  });
});

test('closed backend errors are sanitized, oversized responses fail and local abort never dispatches', async () => {
  const client = createProjectRulesClient({env, fetchImpl: async () => new Response(JSON.stringify({ok: false, error: {code: 'MIO_RULES_CONFLICT', message: 'PRIVATE body', path: '/private'}}), {status: 409, headers: {'content-type': 'application/json'}})});
  await assert.rejects(client.saveUser({requestId, expectedRevision: 0, text: ''}), error => error instanceof Error && 'code' in error && error.code === 'MIO_RULES_CONFLICT' && !error.message.includes('PRIVATE'));
  const oversized = createProjectRulesClient({env, fetchImpl: async () => ok('x'.repeat(70 * 1024))});
  await assert.rejects(oversized.getUser(), {code: 'BACKEND_PROTOCOL_ERROR'});
  let calls = 0; const abort = new AbortController(); abort.abort();
  const cancelled = createProjectRulesClient({env, fetchImpl: async () => {calls++; return ok(user);}});
  await assert.rejects(cancelled.getUser({signal: abort.signal}), {code: 'INTERRUPTED'}); assert.equal(calls, 0);
});
