import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectEntriesClient} from '../packages/client/src/project-entry.ts';
import {PROJECT_ENTRY_ERROR_STATUS, PROJECT_ENTRY_LIMITS} from '../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse} from '../packages/contracts/src/project-entry.ts';
import {ClientError} from '../packages/client/src/index.ts';

const env = {MIOON_BASE_URL: 'http://127.0.0.1:4318', MIOON_TOKEN: 'SYNTHETIC_PROJECT_ENTRIES_CLIENT_TOKEN'};
const instanceId = '00000000-0000-4000-8000-000000000002';
const value: ProjectEntriesResponse = {version: 1, appLibraryScope: 'a'.repeat(64), instanceId, registered: [{project: {
  projectId: '00000000-0000-4000-8000-000000000001', projectFile: '/projects/new/new.mioon', fileIdentity: {dev: '1', ino: '2'},
  name: '新项目', lastOpenedAt: null, summary: null}, availability: {state: 'missing'}, coverUrl: null}]};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});
const ok = (): Response => json({ok: true, data: value});

test('catalog client uses only the fixed authenticated read resource and resolves connection rotation afresh', async () => {
  const rotating = {...env}, calls: Array<{url: string; options: RequestInit}> = [];
  const client = createProjectEntriesClient({env: rotating, fetchImpl: async (url, options) => {calls.push({url: String(url), options: options!}); return ok();}});
  assert.deepEqual(await client.list(), value);
  rotating.MIOON_BASE_URL = 'http://localhost:4321'; rotating.MIOON_TOKEN += '_rotated';
  assert.deepEqual(await client.list(), value);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, env.MIOON_BASE_URL + '/api/project-entries');
  assert.equal(calls[1]!.url, rotating.MIOON_BASE_URL + '/api/project-entries');
  for (const [index, call] of calls.entries()) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.body, undefined);
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store');
    assert.equal(new Headers(call.options.headers).get('authorization'), 'Bearer ' + (index ? rotating.MIOON_TOKEN : env.MIOON_TOKEN));
  }
});

test('path, desktop modes and malformed options cannot dispatch catalog requests', async () => {
  let calls = 0; const client = createProjectEntriesClient({env, fetchImpl: async () => {calls++; return ok();}});
  for (const input of [{path: '/private'}, {mode: 'all'}, {cursor: 'old'}, {timeoutMs: 0}, {timeoutMs: 1.5}, {timeoutMs: 86_400_001}, {signal: {aborted: false}}]) {
    await assert.rejects(client.list(input as never), {code: 'VALIDATION_ERROR'});
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.list({signal: abort.signal}), {code: 'INTERRUPTED'});
  await assert.rejects(createProjectEntriesClient({env, requestTimeoutMs: Number.NaN, fetchImpl: async () => {calls++; return ok();}}).list(), {code: 'VALIDATION_ERROR'});
  assert.equal(calls, 0);
});

test('catalog responses require an exact envelope, authority, availability and project/cover binding', async () => {
  let response = ok(); const client = createProjectEntriesClient({env, fetchImpl: async () => response});
  const item = value.registered[0]!;
  for (const body of [{ok: true, data: value, path: '/private'}, {ok: true}, {ok: true, data: {...value, instanceId: 'wrong'}},
    {ok: true, data: {...value, appLibraryScope: 'wrong'}}, {ok: true, data: {...value, candidates: []}},
    {ok: true, data: {...value, registered: [item, item]}},
    {ok: true, data: {...value, registered: [{...item, availability: {state: 'invalid', reason: 'unknown'}}]}},
    {ok: true, data: {...value, registered: [{...item, coverUrl: '/media/private'}]}}]) {
    response = json(body); await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  for (const status of [201, 400, 500]) {response = json({ok: true, data: value}, status); await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});}
});

test('safe known server errors preserve their code/status without reflecting backend messages or details', async () => {
  const statuses = {...PROJECT_ENTRY_ERROR_STATUS, UNAUTHORIZED: 401, ORIGIN_REJECTED: 403, METHOD_NOT_ALLOWED: 405, VALIDATION_ERROR: 400, NOT_FOUND: 404,
    PROJECT_HOST_STOPPED: 503, APP_LIBRARY_INVALID: 422, APP_LIBRARY_LIMIT: 507, INTERNAL_ERROR: 500};
  for (const [code, status] of Object.entries(statuses)) {
    let calls = 0;
    const client = createProjectEntriesClient({env, fetchImpl: async () => {calls++; return json({ok: false, error: {code, message: 'PRIVATE response', details: {file: '/private'}, retryable: false}}, status);}});
    await assert.rejects(client.list(), error => {
      assert.ok(error instanceof ClientError); assert.equal(error.code, code); assert.equal(error.status, status);
      assert.deepEqual(error.details, {}); assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /PRIVATE|private/u); return true;
    });
    assert.equal(calls, 1);
  }
  for (const error of [{code: 'PRIVATE_CODE', message: '/private'}, {code: 'UNAUTHORIZED', message: '/private', approved: true}, {code: 'UNAUTHORIZED', message: '/private', retryable: true}]) {
    const client = createProjectEntriesClient({env, fetchImpl: async () => json({ok: false, error}, 401)});
    await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
});

test('invalid JSON, UTF-8, media type and advertised lengths fail closed', async () => {
  const replies = [new Response('{', {headers: {'content-type': 'application/json'}}),
    new Response(new Uint8Array([0xc3, 0x28]), {headers: {'content-type': 'application/json'}}),
    new Response('{}', {headers: {'content-type': 'text/plain'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '-1'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '3'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': String(PROJECT_ENTRY_LIMITS.responseBytes + 1)}})];
  for (const response of replies) await assert.rejects(createProjectEntriesClient({env, fetchImpl: async () => response}).list(), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('actual response bytes are capped and the stream is cancelled before parsing an oversized body', async () => {
  // Reuse one buffer: exercise the full public byte limit without allocating
  // hundreds of MiB merely to construct this hostile stream fixture.
  const chunk = new Uint8Array(4 * 1024 * 1024); let pulls = 0, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({pull(controller) {pulls++; controller.enqueue(chunk);}, cancel() {cancelled++;}});
  const client = createProjectEntriesClient({env, fetchImpl: async () => new Response(body, {headers: {'content-type': 'application/json'}})});
  await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  assert.equal(cancelled, 1); assert.ok(pulls <= PROJECT_ENTRY_LIMITS.responseBytes / chunk.byteLength + 2);
});

test('network loss, ignored-signal timeout and local cancellation never retry or leak raw transport failures', async () => {
  let calls = 0;
  const offline = createProjectEntriesClient({env, fetchImpl: async () => {calls++; throw Error('PRIVATE transport path');}});
  await assert.rejects(offline.list(), error => error instanceof ClientError && error.code === 'BACKEND_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 1);
  const timeout = createProjectEntriesClient({env, fetchImpl: async () => {calls++; return await new Promise<Response>(() => {});}});
  await assert.rejects(timeout.list({timeoutMs: 5}), {code: 'TIMEOUT'}); assert.equal(calls, 2);
  const controller = new AbortController();
  const stopped = createProjectEntriesClient({env, fetchImpl: async () => {calls++; controller.abort(); return await new Promise<Response>(() => {});}});
  await assert.rejects(stopped.list({signal: controller.signal}), {code: 'INTERRUPTED'}); assert.equal(calls, 3);
});
