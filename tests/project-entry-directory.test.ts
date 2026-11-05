import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT_ENTRY_LIMITS} from '../packages/contracts/src/project-entry.ts';
import type {ProjectEntriesResponse, ProjectEntryAvailability} from '../packages/contracts/src/project-entry.ts';
import {PROJECT_INVALID_REASONS} from '../packages/contracts/src/project-file.ts';
import {createProjectEntryDirectoryClient, ProjectEntryDirectoryError, readBoundedJsonResponse} from '../apps/web/src/project-entry-directory-client.ts';
import {createProjectEntryDirectoryController} from '../apps/web/src/project-entry-directory-state.ts';

const scope = 'a'.repeat(64), otherScope = 'b'.repeat(64);
const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function snapshot(instanceId = id(1), appLibraryScope = scope): ProjectEntriesResponse {
  const availability: ProjectEntryAvailability[] = [
    ...(['open', 'busy', 'available', 'locked', 'missing'] as const).map(state => ({state})),
    ...PROJECT_INVALID_REASONS.map(reason => ({state: 'invalid' as const, reason})),
  ];
  return {version: 1, appLibraryScope, instanceId, registered: availability.map((value, index) => ({
    project: {projectId: id(index + 10), name: `项目 ${index}`, projectFile: `/projects/${index}.mioon`,
      fileIdentity: {dev: '1', ino: String(index + 1)}, lastOpenedAt: null, summary: null}, availability: value, coverUrl: null,
  }))};
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json; charset=utf-8'}});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {resolve = accept; reject = fail;});
  return {promise, resolve, reject};
}

test('browser directory reads only the fixed same-origin URL and preserves every availability and nullable summary', async () => {
  const calls: Array<{url: string; options: RequestInit}> = [], value = snapshot();
  const client = createProjectEntryDirectoryClient({fetcher: async (url, options) => {calls.push({url: String(url), options: options!}); return json({ok: true, data: value});}});
  assert.deepEqual(await client.list(), value);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/project-entries');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.body, undefined); assert.equal(new Headers(calls[0].options.headers).get('authorization'), null);
  for (const input of [{path: '/private'}, {mode: 'all'}, {cursor: 'old'}, {signal: {}}, null]) {
    await assert.rejects(client.list(input as never), {code: 'VALIDATION_ERROR'});
  }
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(client.list({signal: stopped.signal}), {code: 'INTERRUPTED'});
  assert.equal(calls.length, 1);
});

test('browser directory validates exact success and error envelopes while retaining safe auth code and status', async () => {
  let response = json({ok: true, data: snapshot()});
  const client = createProjectEntryDirectoryClient({fetcher: async () => response});
  for (const body of [{ok: true}, {ok: true, data: snapshot(), extra: true},
    {ok: true, data: {...snapshot(), candidates: []}}, {ok: true, data: {...snapshot(), instanceId: 'bad'}},
    {ok: true, data: {...snapshot(), registered: [snapshot().registered[0], snapshot().registered[0]]}}]) {
    response = json(body); await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  response = json({ok: true, data: snapshot()}, 201); await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  for (const [code, status] of [['UNAUTHORIZED', 401], ['ORIGIN_REJECTED', 403], ['PROJECT_ENTRY_SCOPE_MISMATCH', 409]] as const) {
    response = json({ok: false, error: {code, message: 'PRIVATE /secret', details: {token: 'PRIVATE'}, retryable: false}}, status);
    await assert.rejects(client.list(), error => {
      assert.ok(error instanceof ProjectEntryDirectoryError); assert.equal(error.code, code); assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /PRIVATE|secret/u); assert.equal(error.cause, undefined); return true;
    });
  }
  for (const body of [{ok: false, error: {code: 'UNAUTHORIZED', message: 'denied', retryable: true}},
    {ok: false, error: {code: 'UNAUTHORIZED', message: 'denied', details: []}},
    {ok: false, error: {code: 'PRIVATE_CODE', message: 'denied'}},
    {ok: false, error: {code: 'UNAUTHORIZED', message: 'denied', extra: true}}]) {
    response = json(body, 401); await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  response = json({ok: false, error: {code: 'UNAUTHORIZED', message: 'denied'}}, 403);
  await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('bounded JSON reads split UTF-8 correctly and rejects malformed or oversized responses before use', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({name: '中文项目'}));
  const stream = new ReadableStream<Uint8Array>({start(controller) {
    for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close();
  }});
  assert.deepEqual(await readBoundedJsonResponse(new Response(stream, {headers: {'content-type': 'application/json', 'content-length': String(encoded.length)}}), {maxBytes: encoded.length}), {name: '中文项目'});
  let cancelled = 0;
  const oversized = new ReadableStream<Uint8Array>({pull(controller) {controller.enqueue(new Uint8Array(17));}, cancel() {cancelled++;}});
  await assert.rejects(readBoundedJsonResponse(new Response(oversized, {headers: {'content-type': 'application/json'}}), {maxBytes: 16}), {code: 'BACKEND_PROTOCOL_ERROR'});
  assert.equal(cancelled, 1);
  for (const response of [new Response(new Uint8Array([0xc3, 0x28]), {headers: {'content-type': 'application/json'}}),
    new Response('{', {headers: {'content-type': 'application/json'}}), new Response('{}', {headers: {'content-type': 'text/plain'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '3'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '-1'}})]) {
    await assert.rejects(readBoundedJsonResponse(response, {maxBytes: 32}), {code: 'BACKEND_PROTOCOL_ERROR'});
  }
  const client = createProjectEntryDirectoryClient({fetcher: async () => new Response('{}', {headers: {'content-type': 'application/json', 'content-length': String(PROJECT_ENTRY_LIMITS.responseBytes + 1)}})});
  await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('timeout, caller abort and a stalled body settle without replay or raw network errors', async () => {
  let calls = 0;
  const unavailable = createProjectEntryDirectoryClient({fetcher: async () => {calls++; throw Error('PRIVATE transport');}});
  await assert.rejects(unavailable.list(), error => error instanceof ProjectEntryDirectoryError && error.code === 'BACKEND_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  const timeout = createProjectEntryDirectoryClient({timeoutMs: 5, fetcher: async () => {calls++; return new Promise<Response>(() => {});}});
  await assert.rejects(timeout.list(), {code: 'TIMEOUT'});
  const abort = new AbortController();
  const pending = createProjectEntryDirectoryClient({fetcher: async () => {calls++; abort.abort(); return new Promise<Response>(() => {});}}).list({signal: abort.signal});
  await assert.rejects(pending, {code: 'INTERRUPTED'}); assert.equal(calls, 3);
  let cancelled = 0;
  const stalled = new ReadableStream<Uint8Array>({pull() {return new Promise<void>(() => {});}, cancel() {cancelled++;}});
  const signal = new AbortController(), reading = readBoundedJsonResponse(new Response(stalled, {headers: {'content-type': 'application/json'}}), {signal: signal.signal, maxBytes: 32});
  signal.abort(); await assert.rejects(reading, {code: 'INTERRUPTED'}); assert.equal(cancelled, 1);
});

test('directory controller publishes validated whole snapshots, and only a valid same-library instance advances epoch', async () => {
  let value: unknown = snapshot(), calls = 0;
  const controller = createProjectEntryDirectoryController({read: async () => {calls++; return value;}, expectedScope: () => scope});
  assert.equal(await controller.refresh(), false); assert.equal(calls, 0);
  controller.activate(); assert.equal(await controller.refresh(), true);
  assert.deepEqual(controller.getState().snapshot, snapshot()); assert.equal(controller.getState().epoch, 1);
  assert.equal(Object.isFrozen(controller.getState().snapshot?.registered[0].project.fileIdentity), true);
  value = {...snapshot(id(2)), registered: [{...snapshot().registered[0], availability: {state: 'deleted'}}]};
  assert.equal(await controller.refresh(), false); assert.equal(controller.getState().phase, 'error');
  assert.equal(controller.getState().snapshot, null); assert.equal(controller.getState().epoch, 1);
  value = snapshot(id(2)); assert.equal(await controller.refresh(), true); assert.equal(controller.getState().epoch, 2);
  assert.equal(await controller.refresh(), true); assert.equal(controller.getState().epoch, 2);
  value = {...snapshot(id(2)), registered: []}; assert.equal(await controller.refresh(), true);
  assert.deepEqual(controller.getState().snapshot?.registered, []); assert.equal(controller.getState().epoch, 2);
  controller.dispose();
});

test('a verified library change is sticky and clears prior rows across refresh and reactivation', async () => {
  let expected = scope, value = snapshot(), calls = 0;
  const controller = createProjectEntryDirectoryController({read: async () => {calls++; return value;}, expectedScope: () => expected});
  controller.activate(); assert.equal(await controller.refresh(), true);
  expected = otherScope;
  assert.equal(await controller.refresh(), false); assert.equal(calls, 1, 'A changed external authority must stop before dispatch.');
  assert.equal(controller.getState().phase, 'blocked'); assert.equal(controller.getState().snapshot, null);
  assert.equal(controller.getState().error?.code, 'PROJECT_ENTRY_SCOPE_MISMATCH');
  controller.dispose(); controller.activate(); expected = scope; value = snapshot();
  assert.equal(await controller.refresh(), false); assert.equal(calls, 1);
  const changed = createProjectEntryDirectoryController({read: async () => value});
  changed.activate(); await changed.refresh(); value = snapshot(id(2), otherScope);
  assert.equal(await changed.refresh(), false); assert.equal(changed.getState().phase, 'blocked'); assert.equal(changed.getState().snapshot, null);
  changed.dispose(); controller.dispose();
});

test('new reads and activation generations abort and discard late success and failure responses', async () => {
  const requests: Array<{signal: AbortSignal; reply: ReturnType<typeof deferred<unknown>>}> = [];
  const controller = createProjectEntryDirectoryController({read: ({signal}) => {const reply = deferred<unknown>(); requests.push({signal, reply}); return reply.promise;}});
  controller.activate(); const older = controller.refresh(), newer = controller.refresh();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].reply.resolve(snapshot(id(2))); assert.equal(await newer, true);
  requests[0].reply.resolve(snapshot(id(1), otherScope)); assert.equal(await older, false);
  assert.equal(controller.getState().snapshot?.instanceId, id(2)); assert.equal(controller.getState().epoch, 1);
  const disposed = controller.refresh(); controller.dispose(); assert.equal(requests[2].signal.aborted, true);
  controller.activate(); const fresh = controller.refresh(); requests[3].reply.resolve(snapshot(id(3))); await fresh;
  requests[2].reply.reject(new ProjectEntryDirectoryError('UNAUTHORIZED', 401)); assert.equal(await disposed, false);
  assert.equal(controller.getState().phase, 'ready'); assert.equal(controller.getState().snapshot?.instanceId, id(3));
  assert.equal(controller.getState().epoch, 2); controller.dispose();
});

test('retiring an ignored-signal read settles the caller without publishing over its replacement', async () => {
  let calls = 0;
  const controller = createProjectEntryDirectoryController({read: async () => ++calls === 1 ? new Promise<unknown>(() => {}) : snapshot()});
  controller.activate(); const retired = controller.refresh();
  assert.equal(await controller.refresh(), true); assert.equal(await retired, false);
  assert.equal(controller.getState().phase, 'ready'); assert.equal(controller.getState().snapshot?.appLibraryScope, scope);
  controller.dispose();
});

test('external scope is checked again after reads and network/auth failures never become empty ready directories', async () => {
  let expected = scope;
  const reply = deferred<unknown>(), guarded = createProjectEntryDirectoryController({read: () => reply.promise, expectedScope: () => expected});
  guarded.activate(); const reading = guarded.refresh(); expected = otherScope; reply.resolve(snapshot());
  assert.equal(await reading, false); assert.equal(guarded.getState().phase, 'blocked'); assert.equal(guarded.getState().snapshot, null); guarded.dispose();
  let error: unknown = new ProjectEntryDirectoryError('UNAUTHORIZED', 401);
  const controller = createProjectEntryDirectoryController({read: async () => {throw error;}}); controller.activate();
  await controller.refresh(); assert.equal(controller.getState().phase, 'error'); assert.deepEqual(controller.getState().error, {code: 'UNAUTHORIZED', status: 401});
  error = Error('PRIVATE network'); await controller.refresh(); assert.equal(controller.getState().phase, 'error');
  assert.deepEqual(controller.getState().error, {code: 'BACKEND_UNAVAILABLE'}); assert.equal(controller.getState().snapshot, null); controller.dispose();
});
