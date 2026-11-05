import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectHomeBackgroundController, HOME_BACKGROUND_LIMITS} from '../apps/web/src/project-home-background-state.ts';
import type {HomeBackgroundDirectory, HomeBackgroundReadInput, HomeBackgroundState} from '../apps/web/src/project-home-background-state.ts';
import type {ProjectEntry} from '../packages/contracts/src/project-entry.ts';
import {BACKGROUND_TASK_QUERY_LIMITS} from '../packages/contracts/src/background-task-query.ts';
import {createProjectHomeBackgroundClient, ProjectHomeBackgroundError} from '../apps/web/src/project-home-background-client.ts';

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const entry = (value: number): ProjectEntry => ({project: {projectId: id(value), projectFile: `/projects/${value}.mioon`, fileIdentity: {dev: '1', ino: String(value)}, name: `项目 ${value}`, lastOpenedAt: null, summary: null}, availability: {state: 'missing'}, coverUrl: null});
const directory = (epoch = 1, ids = [1, 2]): HomeBackgroundDirectory => ({appLibraryScope: 'a'.repeat(64), instanceId: id(9999), epoch, registered: ids.map(entry)});
const task = (value: number, taskCount = 1) => ({projectId: id(value), taskCount, reasonCodes: ['PROJECT_MISSING']});
const page = (values: ReturnType<typeof task>[], more = false) => ({version: 1, projects: values, nextCursor: more ? values.at(-1)!.projectId : null});
function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
const nextTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('only a complete current read publishes counts, restricted to registered project IDs', async () => {
  const second = deferred<unknown>(), calls: HomeBackgroundReadInput[] = [], updates: HomeBackgroundState[] = [];
  const controller = createProjectHomeBackgroundController({onChange: state => updates.push(state), readPage: async input => {calls.push(input); return calls.length === 1 ? page([task(1), task(2)], true) : second.promise;}});
  assert.deepEqual(controller.getState(), {kind: 'unknown', identity: null, tasks: null});
  await controller.refresh(directory()); assert.equal(calls.length, 0);
  controller.activate();
  const refreshing = controller.refresh(directory(1, [2, 3]));
  await nextTurn();
  assert.equal(controller.getState().kind, 'loading'); assert.equal(controller.getState().tasks, null);
  assert.deepEqual(updates.map(state => state.kind), ['loading']);
  assert.equal(calls[0]!.cursor, undefined); assert.equal(calls[1]!.cursor, id(2));
  second.resolve(page([task(3), task(4)])); await refreshing;
  const state = controller.getState(); assert.equal(state.kind, 'ready');
  assert.deepEqual(state.tasks, [task(2), task(3)]);
  assert.deepEqual(state.identity, {appLibraryScope: 'a'.repeat(64), instanceId: id(9999), epoch: 1});
  assert.deepEqual(updates.map(value => value.kind), ['loading', 'ready']);
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.tasks)); assert.ok(Object.isFrozen(state.tasks?.[0]?.reasonCodes));
  assert.equal(JSON.stringify(state).includes('/projects'), false);
});

test('network failure after a page keeps counts unknown; retry can establish a genuine zero', async () => {
  let calls = 0, failing = true;
  const controller = createProjectHomeBackgroundController({readPage: async () => {calls++; if (!failing) return page([]); if (calls === 1) return page([task(1)], true); throw Error('private transport failure');}});
  controller.activate(); await controller.refresh(directory());
  assert.deepEqual(controller.getState(), {kind: 'error', identity: {appLibraryScope: 'a'.repeat(64), instanceId: id(9999), epoch: 1}, tasks: null, error: 'unavailable', retryable: true});
  failing = false; await controller.refresh(directory());
  assert.equal(controller.getState().kind, 'ready'); assert.deepEqual(controller.getState().tasks, []);
});

test('strict DTO failures never publish a partial list or a false zero', async () => {
  const invalid = [
    {...page([]), ignored: true}, {...page([task(1)]), version: 2},
    page([{...task(1), taskCount: 0}]), page([{...task(1), reasonCodes: ['PROJECT_MISSING', 'PROJECT_MISSING']}]),
    page([task(2), task(1)]), page([task(1), task(1)]),
    {...page([task(1)]), nextCursor: id(2)}, {...page([]), nextCursor: id(1)},
  ];
  for (const value of invalid) {
    const controller = createProjectHomeBackgroundController({readPage: async () => value});
    controller.activate(); await controller.refresh(directory());
    const state = controller.getState(); assert.equal(state.kind, 'error');
    if (state.kind === 'error') assert.equal(state.error, 'invalid-response');
    assert.equal(state.tasks, null);
  }
});

test('cross-page duplicates, loops and backwards pages fail instead of silently dropping records', async () => {
  for (const second of [page([task(1)], true), page([task(1)]), page([task(1), task(3)], true)]) {
    let calls = 0; const kinds: string[] = [];
    const controller = createProjectHomeBackgroundController({onChange: state => kinds.push(state.kind), readPage: async () => ++calls === 1 ? page([task(2)], true) : second});
    controller.activate(); await controller.refresh(directory());
    const state = controller.getState(); assert.equal(state.kind, 'error');
    if (state.kind === 'error') assert.equal(state.error, 'pagination');
    assert.equal(state.tasks, null); assert.deepEqual(kinds, ['loading', 'error']); assert.equal(calls, 2);
  }
});

test('application task and response byte budgets fail explicitly, including projects outside this directory', async () => {
  const tooManyTasks = page(Array.from({length: HOME_BACKGROUND_LIMITS.maxTasks / 512 + 1}, (_, index) => task(index + 1, 512)));
  const reasons = Array.from({length: 32}, (_, index) => `REASON_${String(index).padStart(2, '0')}_${'X'.repeat(90)}`);
  const tooManyBytes = page(Array.from({length: 100}, (_, index) => ({...task(index + 1), reasonCodes: reasons})));
  assert.ok(new TextEncoder().encode(JSON.stringify(tooManyBytes)).byteLength > BACKGROUND_TASK_QUERY_LIMITS.responseBytes);
  for (const value of [tooManyTasks, tooManyBytes]) {
    const controller = createProjectHomeBackgroundController({readPage: async () => value});
    controller.activate(); await controller.refresh(directory(1, []));
    const state = controller.getState(); assert.equal(state.kind, 'error');
    if (state.kind === 'error') assert.equal(state.error, 'budget');
    assert.equal(state.tasks, null);
  }
});

test('the complete application budget is accepted, while one additional indexed task refuses all pages', async () => {
  for (const extra of [0, 1]) {
    let calls = 0;
    const total = HOME_BACKGROUND_LIMITS.maxTasks + extra;
    const controller = createProjectHomeBackgroundController({readPage: async ({cursor}) => {
      calls++; const after = cursor ? Number(cursor.slice(-12)) : 0;
      const count = Math.min(100, total - after);
      return page(Array.from({length: count}, (_, index) => task(after + index + 1)), after + count < total);
    }});
    controller.activate(); await controller.refresh(directory());
    assert.equal(calls, Math.ceil(total / 100));
    const state = controller.getState();
    if (extra) {assert.equal(state.kind, 'error'); if (state.kind === 'error') assert.equal(state.error, 'budget'); assert.equal(state.tasks, null);}
    else {assert.equal(state.kind, 'ready'); assert.deepEqual(state.tasks, [task(1), task(2)]);}
  }
});

test('a new refresh aborts ignored-signal pages and fences success in the same project ID and a newer epoch', async () => {
  const first = deferred<unknown>(), inputs: HomeBackgroundReadInput[] = [], updates: HomeBackgroundState[] = [];
  const controller = createProjectHomeBackgroundController({onChange: state => updates.push(state), readPage: async input => {inputs.push(input); return inputs.length === 1 ? first.promise : page([task(1, 2)]);}});
  controller.activate(); const old = controller.refresh(directory(1));
  await controller.refresh(directory(2));
  assert.equal(inputs[0]!.signal.aborted, true); assert.equal(inputs[1]!.signal.aborted, false);
  first.resolve(page([task(1, 4)], true)); await old;
  assert.equal(inputs.length, 2);
  assert.equal(controller.getState().identity?.epoch, 2); assert.deepEqual(controller.getState().tasks, [task(1, 2)]);
  assert.deepEqual(updates.map(state => [state.kind, state.identity?.epoch]), [['loading', 1], ['loading', 2], ['ready', 2]]);
});

test('scope and backend replacement fence old failures even when epoch and project IDs repeat', async () => {
  for (const replacement of [{appLibraryScope: 'b'.repeat(64)}, {instanceId: id(9998)}]) {
    const old = deferred<unknown>(); let calls = 0;
    const controller = createProjectHomeBackgroundController({readPage: async () => ++calls === 1 ? old.promise : page([])});
    controller.activate(); const first = controller.refresh(directory());
    await controller.refresh({...directory(), ...replacement});
    old.reject(Error('old backend failed')); await first;
    assert.equal(controller.getState().kind, 'ready'); assert.deepEqual(controller.getState().tasks, []);
    assert.deepEqual(controller.getState().identity, {appLibraryScope: 'a'.repeat(64), instanceId: id(9999), epoch: 1, ...replacement});
  }
});

test('invalidation and disposal abort pending reads, remove zero-count authority and suppress old callbacks', async () => {
  for (const action of ['invalidate', 'dispose'] as const) {
    const pending = deferred<unknown>(); let signal: AbortSignal | null = null;
    const updates: HomeBackgroundState[] = [];
    const controller = createProjectHomeBackgroundController({onChange: state => updates.push(state), readPage: async input => {signal = input.signal; return pending.promise;}});
    controller.activate(); const reading = controller.refresh(directory()); let settled = false;
    void reading.then(() => {settled = true;});
    controller[action](); const count = updates.length;
    assert.equal((signal as AbortSignal | null)?.aborted, true);
    assert.deepEqual(controller.getState(), {kind: 'unknown', identity: null, tasks: null});
    await nextTurn(); assert.equal(settled, true, 'retired refresh settles even when the port ignores abort');
    pending.resolve(page([task(1)], true)); await reading;
    assert.equal(updates.length, count); assert.deepEqual(controller.getState(), {kind: 'unknown', identity: null, tasks: null});
  }
});

test('synchronous view cleanup on loading prevents even the first page from dispatching', async () => {
  let calls = 0;
  const controller = createProjectHomeBackgroundController({onChange: state => {if (state.kind === 'loading') controller.dispose();}, readPage: async () => {calls++; return page([]);}});
  controller.activate(); await controller.refresh(directory()); assert.equal(calls, 0); assert.equal(controller.getState().kind, 'unknown');
});

test('invalid directory authority cannot dispatch and a captured directory cannot be changed by its caller', async () => {
  let calls = 0;
  const invalid = [{...directory(), epoch: -1}, {...directory(), appLibraryScope: 'invalid'}, {...directory(), instanceId: 'invalid'}, {...directory(), registered: [entry(1), entry(1)]}];
  const controller = createProjectHomeBackgroundController({readPage: async () => {calls++; return page([]);}}); controller.activate();
  for (const value of invalid) {await controller.refresh(value); const state = controller.getState(); assert.equal(state.kind, 'error'); if (state.kind === 'error') assert.equal(state.error, 'invalid-directory');}
  assert.equal(calls, 0);
  const pending = deferred<unknown>(), selected = directory(), captured = createProjectHomeBackgroundController({readPage: async () => pending.promise});
  captured.activate(); const reading = captured.refresh(selected);
  selected.registered.splice(0, selected.registered.length, entry(3));
  pending.resolve(page([task(1), task(3)])); await reading;
  assert.deepEqual(captured.getState().tasks, [task(1)]);
});

const backgroundJson = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8'}});
const backgroundOk = (): Response => backgroundJson({ok: true, data: page([task(1)])});

test('background HTTP uses a fixed same-origin GET with after and the maximum bounded page size', async () => {
  const requests: {url: string; options: RequestInit}[] = [];
  const client = createProjectHomeBackgroundClient({fetcher: async (url, options) => {requests.push({url: String(url), options: options!}); return backgroundOk();}});
  assert.deepEqual(Object.keys(client), ['list']);
  assert.deepEqual(await client.list(), page([task(1)]));
  assert.deepEqual(await client.list({cursor: id(2)}), page([task(1)]));
  assert.equal(requests[0]!.url, '/api/background-tasks?limit=100');
  assert.equal(requests[1]!.url, `/api/background-tasks?limit=100&after=${id(2)}`);
  for (const {options} of requests) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual([...new Headers(options.headers).keys()], []);
  }
});

test('background HTTP invalid input or pre-aborted signals never dispatch and cannot select another resource', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {calls++; return backgroundOk();};
  const client = createProjectHomeBackgroundClient({fetcher});
  for (const options of [{cursor: '../private'}, {cursor: 'A'.repeat(36)}, {cursor: null}, {cursor: ''}, {path: '/private'}, {limit: 1}, {after: id(1)}, {body: {}}, {signal: {aborted: false}}, []])
    await assert.rejects(client.list(options as never), {code: 'VALIDATION_ERROR'});
  for (const timeoutMs of [0, -1, 0.5, Number.NaN, 86_400_001]) await assert.rejects(createProjectHomeBackgroundClient({fetcher, timeoutMs}).list(), {code: 'VALIDATION_ERROR'});
  await assert.rejects(createProjectHomeBackgroundClient({fetcher: null as never}).list(), {code: 'VALIDATION_ERROR'});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.list({signal: abort.signal}), {code: 'INTERRUPTED'});
  assert.equal(calls, 0);
});

test('background HTTP rejects malformed success envelopes and DTOs rather than reporting zero', async () => {
  const invalid = [
    {ok: true, data: page([]), extra: true}, {ok: true}, {ok: true, error: {}}, {ok: false, data: page([])},
    {ok: true, data: {...page([]), extra: true}}, {ok: true, data: {...page([]), version: 2}},
    {ok: true, data: page([task(2), task(1)])}, {ok: true, data: {...page([task(1)]), nextCursor: id(2)}},
    {ok: true, data: {...page([task(1)]), projects: [{...task(1), projectFile: '/private'}]}},
  ];
  for (const value of invalid) await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => backgroundJson(value)}).list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  for (const status of [201, 400, 500]) await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => backgroundJson({ok: true, data: page([])}, status)}).list(), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('background HTTP retains known authentication and service code/status without exposing backend prose or details', async () => {
  const statuses = {UNAUTHORIZED: 401, ORIGIN_REJECTED: 403, METHOD_NOT_ALLOWED: 405, VALIDATION_ERROR: 400, NOT_FOUND: 404,
    BACKGROUND_TASK_QUERY_UNAVAILABLE: 503, BACKGROUND_TASK_QUERY_LIMIT: 413, PROJECT_HOST_STOPPED: 503,
    APP_LIBRARY_INVALID: 422, APP_LIBRARY_LIMIT: 507, INTERNAL_ERROR: 500};
  for (const [code, status] of Object.entries(statuses)) {
    let calls = 0;
    const client = createProjectHomeBackgroundClient({fetcher: async () => {calls++; return backgroundJson({ok: false, error: {code, message: 'PRIVATE response', details: {file: '/private'}, retryable: false}}, status);}});
    await assert.rejects(client.list(), error => {
      assert.ok(error instanceof ProjectHomeBackgroundError); assert.equal(error.code, code); assert.equal(error.status, status);
      assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /PRIVATE|private/u); assert.equal(Object.hasOwn(error, 'details'), false); return true;
    });
    assert.equal(calls, 1);
  }
  for (const error of [{code: 'PRIVATE_CODE', message: '/private'}, {code: 'UNAUTHORIZED', message: '/private', approved: true},
    {code: 'UNAUTHORIZED', message: '/private', retryable: true}, {code: 'UNAUTHORIZED', message: ''}, {code: 'UNAUTHORIZED', message: '/private', details: []}])
    await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => backgroundJson({ok: false, error}, 401)}).list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => backgroundJson({ok: false, error: {code: 'UNAUTHORIZED', message: 'x'}}, 403)}).list(), {code: 'BACKEND_PROTOCOL_ERROR'});
});

test('background HTTP bounded reader rejects malformed JSON, UTF-8, media type and advertised byte lengths', async () => {
  const invalid = [new Response('{', {headers: {'content-type': 'application/json'}}),
    new Response(new Uint8Array([0xc3, 0x28]), {headers: {'content-type': 'application/json'}}),
    new Response('{}', {headers: {'content-type': 'text/plain'}}), new Response(null, {headers: {'content-type': 'application/json'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '-1'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '3'}}),
    new Response('{}', {headers: {'content-type': 'application/json', 'content-length': String(BACKGROUND_TASK_QUERY_LIMITS.responseBytes + 1)}})];
  for (const response of invalid) await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => response}).list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  const raw = JSON.stringify({ok: true, data: page([])}).padEnd(BACKGROUND_TASK_QUERY_LIMITS.responseBytes, ' ');
  assert.deepEqual(await createProjectHomeBackgroundClient({fetcher: async () => new Response(raw, {headers: {'content-type': 'application/json', 'content-length': String(BACKGROUND_TASK_QUERY_LIMITS.responseBytes)}})}).list(), page([]));
});

test('background HTTP cancels a stream exceeding 256 KiB before accepting its data', async () => {
  const chunk = new Uint8Array(64 * 1024); let pulls = 0, cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({pull(controller) {pulls++; controller.enqueue(chunk);}, cancel() {cancelled++;}});
  const client = createProjectHomeBackgroundClient({fetcher: async () => new Response(stream, {headers: {'content-type': 'application/json'}})});
  await assert.rejects(client.list(), {code: 'BACKEND_PROTOCOL_ERROR'});
  assert.equal(cancelled, 1); assert.ok(pulls <= BACKGROUND_TASK_QUERY_LIMITS.responseBytes / chunk.byteLength + 2);
});

test('background HTTP network loss, ignored-signal deadlines and local abort never retry', async () => {
  let calls = 0;
  await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => {calls++; throw Error('PRIVATE transport');}}).list(), error =>
    error instanceof ProjectHomeBackgroundError && error.code === 'BACKEND_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 1);
  await assert.rejects(createProjectHomeBackgroundClient({timeoutMs: 5, fetcher: async () => {calls++; return new Promise<Response>(() => {});}}).list(), {code: 'TIMEOUT'});
  assert.equal(calls, 2);
  const abort = new AbortController();
  await assert.rejects(createProjectHomeBackgroundClient({fetcher: async () => {calls++; abort.abort(); return new Promise<Response>(() => {});}}).list({signal: abort.signal}), {code: 'INTERRUPTED'});
  assert.equal(calls, 3);
});

test('background HTTP deadline and caller abort cancel a body whose stream ignores fetch signal', async () => {
  for (const localAbort of [false, true]) {
    let cancelled = 0, fetched!: () => void;
    const started = new Promise<void>(resolve => {fetched = resolve;});
    const stream = new ReadableStream<Uint8Array>({pull() {}, cancel() {cancelled++;}});
    const abort = new AbortController();
    const client = createProjectHomeBackgroundClient({timeoutMs: localAbort ? 30_000 : 5, fetcher: async () => {fetched(); return new Response(stream, {headers: {'content-type': 'application/json'}});}});
    const reading = client.list({signal: abort.signal}); await started; if (localAbort) abort.abort();
    await assert.rejects(reading, {code: localAbort ? 'INTERRUPTED' : 'TIMEOUT'});
    await nextTurn(); assert.equal(cancelled, 1);
  }
});
