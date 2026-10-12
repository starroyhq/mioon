import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createLastProjectClient, lastProjectFailure } from '../apps/web/src/last-project-client.ts';
import { createLastProjectController } from '../apps/web/src/last-project-state.ts';

const id = n => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = 'a'.repeat(64), instanceId = id(90), stamp = '2026-10-12T18:00:00.000Z';
const record = (projectId = null, revision = projectId ? 1 : 0, extra = {}) => ({ supported: true, workspaceScope: scope, instanceId, revision, projectId, updatedAt: projectId ? stamp : null, targetStatus: projectId ? 'matching' : 'unset', ...extra });
const unsupported = { supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED' };
const response = data => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
const failure = (code, status, extra = {}) => new Response(JSON.stringify({ ok: false, error: { code, message: 'Opaque service response', details: {}, retryable: false, ...extra } }), { status });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let n = 0; n < 35; n++) await Promise.resolve(); };
const input = (projectId = id(1)) => ({ workspaceScope: scope, instanceId, expectedRevision: 0, projectId });
function harness(t, { initial = record(), get, put } = {}) {
  let stored = structuredClone(initial), epoch = 0;
  const calls = [], changes = [];
  const client = createLastProjectClient(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, body, init });
    if (init.method === 'GET') { const value = get ? await get(structuredClone(stored)) : structuredClone(stored); return value instanceof Response ? value : response(value); }
    if (put) { const value = await put(body, structuredClone(stored)); return value instanceof Response ? value : response(value); }
    if (body.workspaceScope !== stored.workspaceScope) return failure('LAST_PROJECT_SCOPE_MISMATCH', 409);
    if (body.instanceId !== stored.instanceId) return failure('LAST_PROJECT_STALE_INSTANCE', 409);
    if (body.expectedRevision !== stored.revision) return failure('LAST_PROJECT_CONFLICT', 409);
    stored = record(body.projectId, body.expectedRevision + 1);
    return response(stored);
  });
  const controller = createLastProjectController({ client, getEpoch: () => epoch, onChange: value => changes.push(value) });
  t.after(() => controller.dispose());
  return { controller, calls, changes, current: () => structuredClone(stored), replace: value => { stored = structuredClone(value); },
    navigate: next => { epoch = next; controller.invalidateNavigation(next); }, open: (projectId, currentEpoch = epoch) => controller.rememberOpened(projectId, currentEpoch) };
}
const puts = h => h.calls.filter(call => call.method === 'PUT');
async function rejected(fetcher, method = 'put') {
  try { await createLastProjectClient(fetcher)[method](method === 'put' ? input() : undefined); }
  catch (error) { return lastProjectFailure(error); }
  assert.fail('Expected the real client to reject this response');
}

test('actual client uses private fixed GET without query and strict write input', async () => {
  const requests = [], client = createLastProjectClient(async (url, init) => { requests.push({ url, init }); return response(record()); });
  assert.deepEqual(await client.get(), record());
  assert.equal(requests[0].url, '/api/last-project'); assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[0].init.credentials, 'same-origin'); assert.equal(requests[0].init.cache, 'no-store');
  await assert.rejects(client.put({ ...input(), extra: true })); assert.equal(requests.length, 1);
  await assert.rejects(client.put({ ...input(), projectId: '../project' })); assert.equal(requests.length, 1);
});

test('success, unsupported, malformed JSON, surplus keys, bad IDs and bounded bytes are validated', async () => {
  assert.deepEqual(await createLastProjectClient(async () => response(unsupported)).get(), unsupported);
  for (const data of [ { ...record(), extra: true }, { ...record(), projectId: id(1) }, record(id(1), 0), record(id(1), 1, { instanceId: 'wrong' }),
    record(id(1), 1, { updatedAt: 'not-a-date' }), { supported: false, reason: 'OTHER' }, { ...unsupported, projectId: null } ]) {
    assert.equal((await rejected(async () => response(data), 'get')).kind, 'unknown');
  }
  for (const value of [new Response('{', { status: 200 }), new Response(JSON.stringify({ ok: true, data: record(), extra: true })),
    new Response(JSON.stringify({ ok: true, data: record() }), { status: 201 }), new Response(' '.repeat(4097)),
    new Response(new Uint8Array([0xff, 0xff]), { status: 200 })]) {
    assert.equal((await rejected(async () => value, 'get')).code, 'LAST_PROJECT_PROTOCOL_UNKNOWN');
  }
});

test('failure classification requires bounded exact code/status and strict error envelope, never message guessing', async () => {
  assert.equal((await rejected(async () => failure('LAST_PROJECT_CONFLICT', 409))).kind, 'conflict');
  assert.equal((await rejected(async () => failure('LAST_PROJECT_CONFLICT', 500))).kind, 'unknown');
  assert.equal((await rejected(async () => failure('LAST_PROJECT_STORAGE_UNAVAILABLE', 503))).kind, 'unavailable');
  assert.equal((await rejected(async () => failure('LAST_PROJECT_NOT_FOUND', 404))).kind, 'refused');
  assert.equal((await rejected(async () => failure('LAST_PROJECT_SAVE_UNCERTAIN', 503))).kind, 'unknown');
  for (const extra of [{ details: { secret: 'value' } }, { retryable: true }, { message: 'x'.repeat(1001) }, { code: '../LAST_PROJECT_CONFLICT' }, { surplus: true }]) {
    assert.equal((await rejected(async () => failure('LAST_PROJECT_CONFLICT', 409, extra))).code, 'LAST_PROJECT_PROTOCOL_UNKNOWN');
  }
  assert.equal((await rejected(async () => { throw new Error('LAST_PROJECT_CONFLICT'); })).kind, 'unknown');
});

test('discovery is read-only and only a matching remembered project is a boot candidate', async t => {
  const h = harness(t, { initial: record(id(1), 4) });
  const found = await h.controller.discover();
  assert.equal(found.candidateProjectId, id(1)); assert.equal(found.workspaceScope, scope);
  assert.equal(h.controller.getVerifiedScope(), scope); assert.equal(h.controller.getState().phase, 'idle'); assert.equal(puts(h).length, 0);
  const missing = harness(t, { initial: record(id(1), 4, { targetStatus: 'missing' }) });
  assert.equal((await missing.controller.discover()).candidateProjectId, null); assert.equal(puts(missing).length, 0);
});

test('older boot read cannot nominate a project after newer navigation, but can safely identify the selected workspace', async t => {
  const gate = deferred(), h = harness(t, { get: () => gate.promise });
  const discovering = h.controller.discover(); h.navigate(1); h.open(id(2));
  gate.resolve(record(id(1), 3)); const found = await discovering;
  assert.equal(found.candidateProjectId, null); assert.equal(found.workspaceScope, scope);
  await tick(); assert.equal(puts(h).length, 1); assert.deepEqual(puts(h)[0].body, { ...input(id(2)), expectedRevision: 3 });
  assert.equal(h.controller.getState().currentProjectId, id(2));
});

test('stale or invalid explicit-open epochs are ignored and never generate writes', async t => {
  const h = harness(t); await h.controller.discover(); h.navigate(2);
  h.open(id(1), 1); h.open('../bad', 2); h.open(id(1), NaN); await tick();
  assert.equal(puts(h).length, 0); assert.equal(h.controller.getState().currentProjectId, null);
});

test('newer selected project queues behind exact older ACK without receiving an old saved status', async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = harness(t, { put: () => ++count === 1 ? first.promise : second.promise }); await h.controller.discover();
  h.navigate(1); h.open(id(1)); await tick(); h.navigate(2); h.open(id(2)); await tick();
  assert.equal(puts(h).length, 1); first.resolve(record(id(1), 1)); await tick();
  assert.equal(puts(h).length, 2); assert.deepEqual(puts(h)[1].body, { ...input(id(2)), expectedRevision: 1 });
  assert.equal(h.controller.getState().phase, 'pending'); assert.equal(h.controller.getState().currentProjectId, id(2));
  assert.equal(h.changes.some(value => value.phase === 'saved' && value.currentProjectId === id(2) && value.rememberedProjectId === id(1)), false);
  second.resolve(record(id(2), 2)); await tick(); assert.equal(h.controller.getState().phase, 'saved');
});

test('queue coalesces only authorized successful selections and invalidation drops stale queued work', async t => {
  const gate = deferred(), h = harness(t, { put: body => body.projectId === id(1) ? gate.promise : record(body.projectId, body.expectedRevision + 1) });
  await h.controller.discover(); h.navigate(1); h.open(id(1)); await tick();
  h.navigate(2); h.open(id(2)); h.navigate(3); h.open(id(3));
  gate.resolve(record(id(1), 1)); await tick();
  assert.deepEqual(puts(h).map(call => call.body.projectId), [id(1), id(3)]);
  const other = deferred(), g = harness(t, { put: () => other.promise }); await g.controller.discover();
  g.navigate(1); g.open(id(1)); await tick(); g.navigate(2); g.open(id(2)); g.navigate(3);
  other.resolve(record(id(1), 1)); await tick(); assert.equal(puts(g).length, 1);
});

test('two-window CAS conflict never overwrites or silently rebases after read-only recheck', async t => {
  const h = harness(t); await h.controller.discover(); h.replace(record(id(99), 1));
  h.navigate(1); h.open(id(1)); await tick();
  assert.equal(h.controller.getState().phase, 'conflict'); assert.equal(h.controller.getState().canRetry, false);
  await h.controller.recheck(); h.navigate(2); h.open(id(2)); await h.controller.flush();
  assert.equal(puts(h).length, 1); assert.equal(h.current().projectId, id(99)); assert.equal(h.controller.getState().rechecked.projectId, id(99));
});

test('wrong scope or stale instance in a strict ACK blocks all further writes and invalidates verified scope', async t => {
  for (const changed of [{ workspaceScope: 'b'.repeat(64) }, { instanceId: id(91) }]) {
    const h = harness(t, { put: () => record(id(1), 1, changed) }); await h.controller.discover(); h.open(id(1)); await tick();
    assert.equal(h.controller.getState().phase, 'conflict'); assert.equal(h.controller.getVerifiedScope(), null);
    assert.equal(h.controller.getState().canRetry, false); h.navigate(1); h.open(id(2)); await h.controller.retry(); await h.controller.flush();
    assert.equal(puts(h).length, 1);
  }
});

test('server identity change during a pending PUT cannot be undone by its older valid ACK', async t => {
  const gate = deferred(), h = harness(t, { put: () => gate.promise }); await h.controller.discover(); h.open(id(1)); await tick();
  h.replace(record(null, 0, { instanceId: id(91) })); await h.controller.recheck(); gate.resolve(record(id(1), 1)); await tick();
  assert.equal(h.controller.getVerifiedScope(), null); assert.notEqual(h.controller.getState().phase, 'saved'); assert.equal(puts(h).length, 1);
});

test('lost ACK plus empty recheck retains immutable original and never writes the newer selection', async t => {
  const h = harness(t, { put: async () => { throw new Error('lost ACK'); } }); await h.controller.discover();
  h.navigate(1); h.open(id(1)); await tick(); const submitted = structuredClone(puts(h)[0].body);
  assert.equal(h.controller.getState().uncertain, true); assert.equal(h.controller.getState().canRetry, true);
  h.navigate(2); h.open(id(2)); assert.equal(h.controller.getState().canRetry, false);
  await h.controller.recheck(); await h.controller.retry(); assert.equal(await h.controller.flush(), false);
  assert.equal(puts(h).length, 1); assert.deepEqual(h.controller.getState().pendingInput, submitted);
  assert.equal(h.controller.getState().queuedProjectId, id(2)); assert.equal(h.controller.getState().uncertain, true);
});

test('even exact matching read does not cancel an unknown PUT or automatically release its queue', async t => {
  const h = harness(t, { put: async () => { throw new Error('lost ACK'); } }); await h.controller.discover(); h.open(id(1)); await tick();
  h.replace(record(id(1), 1)); await h.controller.recheck();
  assert.equal(puts(h).length, 1); assert.equal(h.controller.getState().uncertain, true); assert.deepEqual(h.controller.getState().pendingInput, input());
});

test('explicit retry sends precisely the original CAS body and only a strict matching ACK releases it', async t => {
  let count = 0;
  const h = harness(t, { put: async body => { if (++count === 1) throw new Error('network'); return record(body.projectId, body.expectedRevision + 1); } });
  await h.controller.discover(); h.open(id(1)); await tick(); await h.controller.retry();
  assert.equal(puts(h).length, 2); assert.deepEqual(puts(h)[1].body, puts(h)[0].body);
  assert.equal(h.controller.getState().phase, 'saved'); assert.equal(h.controller.getState().uncertain, false); assert.equal(h.controller.getState().pendingInput, null);
});

test('a definite retry conflict cannot retroactively turn an unknown original into a rejected write', async t => {
  let count = 0;
  const h = harness(t, { put: async () => { if (++count === 1) throw new Error('network'); return failure('LAST_PROJECT_CONFLICT', 409); } });
  await h.controller.discover(); h.open(id(1)); await tick(); await h.controller.retry();
  assert.equal(h.controller.getState().uncertain, true); assert.deepEqual(h.controller.getState().pendingInput, input());
  assert.equal(h.controller.getState().phase, 'error'); assert.equal(h.controller.getState().failure.kind, 'unknown');
});

test('malformed or mismatched successful write response never produces saved state', async t => {
  for (const result of [record(id(2), 1), record(id(1), 2), record(id(1), 1, { targetStatus: 'missing' }), { ...record(id(1)), extra: true }]) {
    const h = harness(t, { put: () => result }); await h.controller.discover(); h.open(id(1)); await tick();
    assert.equal(h.controller.getState().phase, 'error'); assert.equal(h.controller.getState().uncertain, true); assert.equal(h.controller.getState().rememberedProjectId, null);
  }
});

test('restored profile is explicitly unsupported and no selection or flush can write', async t => {
  const h = harness(t, { initial: unsupported }); const found = await h.controller.discover(); h.open(id(1)); await h.controller.flush();
  assert.equal(found.workspaceScope, null); assert.equal(found.candidateProjectId, null);
  assert.equal(h.controller.getState().phase, 'unavailable'); assert.equal(h.controller.getState().canRetry, false); assert.equal(h.controller.getState().canRecheck, false);
  assert.equal(puts(h).length, 0);
});

test('dispose suppresses callbacks, fences old reads across activation, and does not create writes', async t => {
  const old = deferred(), fresh = deferred(); let count = 0;
  const h = harness(t, { get: () => ++count === 1 ? old.promise : fresh.promise });
  const first = h.controller.discover(); h.controller.dispose(); const length = h.changes.length;
  h.open(id(1)); old.resolve(record(id(1), 1)); assert.equal(await first, null); await tick(); assert.equal(h.changes.length, length);
  h.controller.activate(); const second = h.controller.discover(); fresh.resolve(record(id(2), 2));
  assert.equal((await second).candidateProjectId, id(2)); assert.equal(puts(h).length, 0);
});

test('old close flush and late old write cannot publish after disposal/reactivation', async t => {
  const gate = deferred(), h = harness(t, { put: () => gate.promise }); await h.controller.discover(); h.open(id(1)); await tick();
  const closing = h.controller.flush(500); h.controller.dispose(); h.controller.activate(); const changes = h.changes.length;
  gate.resolve(record(id(1), 1)); assert.equal(await closing, false); await tick();
  assert.equal(h.changes.length, changes); assert.notEqual(h.controller.getState().phase, 'saved'); assert.equal(puts(h).length, 1);
});

test('bounded flush does not cancel an in-flight authorized write or invent work', async t => {
  const gate = deferred(), h = harness(t, { put: () => gate.promise }); await h.controller.discover();
  assert.equal(await h.controller.flush(1), true); h.open(id(1)); await tick(); assert.equal(await h.controller.flush(1), false);
  assert.equal(puts(h).length, 1); assert.deepEqual(h.controller.getState().pendingInput, input());
  gate.resolve(record(id(1), 1)); await tick(); assert.equal(h.controller.getState().phase, 'saved'); assert.equal(await h.controller.flush(), true);
});

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
function view(state, controller, restored = false) {
  const source = readFileSync(new URL('../apps/web/src/LastProjectStatus.tsx', import.meta.url), 'utf8');
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  const module = { exports: {} };
  Function('require', 'module', 'exports', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(name => {
    if (name === 'react') return react;
    if (name === '@mioon/ui/components/button') return { Button: 'Button' };
    throw new Error(`Unexpected UI dependency: ${name}`);
  }, module, module.exports);
  return module.exports.default({ state, controller, restored });
}

test('status component uses accessible shared controls, scopes its copy, and exposes only state-approved actions', async t => {
  const h = harness(t, { put: async () => { throw new Error('network'); } }); await h.controller.discover(); h.open(id(1)); await tick();
  const tree = view(h.controller.getState(), h.controller), all = nodes(tree);
  assert.ok(all.some(node => node.props.role === 'status')); assert.ok(all.some(node => node.props.role === 'alert'));
  assert.ok(all.some(node => node.type === 'Button' && node.props['data-testid'] === 'last-project-retry'));
  assert.ok(all.some(node => node.type === 'Button' && node.props['data-testid'] === 'last-project-recheck'));
  assert.match(JSON.stringify(tree), /项目内容和片段草稿分别保存/);
  h.navigate(1); h.open(id(2)); assert.equal(nodes(view(h.controller.getState(), h.controller)).some(node => node.props['data-testid'] === 'last-project-retry'), false);
  const restored = view(h.controller.getState(), h.controller, true);
  assert.match(JSON.stringify(restored), /恢复分支暂不记住最近项目/); assert.equal(nodes(restored).some(node => node.type === 'Button'), false);
});

test('request deadlines bound hanging GET and body reads, and tiny PUT permits keepalive', async () => {
  let signal;
  const hanging = createLastProjectClient(async (_url, init) => { signal = init.signal; return new Promise(() => {}); }, { timeoutMs: 5 });
  await assert.rejects(hanging.get(), error => lastProjectFailure(error).code === 'LAST_PROJECT_TIMEOUT_UNKNOWN'); assert.equal(signal.aborted, true);
  const body = createLastProjectClient(async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 5 });
  await assert.rejects(body.get(), error => lastProjectFailure(error).kind === 'unknown');
  let request;
  await createLastProjectClient(async (_url, init) => { request = init; return response(record(id(1), 1)); }).put(input());
  assert.equal(request.keepalive, true); assert.ok(request.signal instanceof AbortSignal);
});

test('unknown PUT plus scope mismatch reread retains original uncertainty and exposes authoritative identity block', async t => {
  const h = harness(t, { put: async () => { throw new Error('lost ACK'); } }); await h.controller.discover(); h.open(id(1)); await tick();
  h.replace(record(null, 0, { workspaceScope: 'b'.repeat(64) })); await h.controller.recheck();
  const state = h.controller.getState(); assert.equal(state.uncertain, true); assert.deepEqual(state.pendingInput, input());
  assert.equal(state.identityBlocked, true); assert.equal(state.workspaceScope, null); assert.equal(h.controller.getVerifiedScope(), null);
  assert.equal(state.canRetry, false); assert.equal(puts(h).length, 1);
});

test('a read started during PUT cannot regress a newer ACK with stale data or a stale failure', async t => {
  for (const rejectRead of [false, true]) {
    const write = deferred(), read = deferred(); let reads = 0;
    const h = harness(t, { get: stored => ++reads === 1 ? stored : read.promise, put: () => write.promise });
    await h.controller.discover(); h.open(id(1)); await tick(); const rechecking = h.controller.recheck();
    write.resolve(record(id(1), 1)); await tick(); assert.equal(h.controller.getState().phase, 'saved');
    if (rejectRead) read.reject(new Error('old GET failed')); else read.resolve(record());
    await rechecking; assert.equal(h.controller.getState().phase, 'saved'); assert.equal(h.controller.getState().failure, null);
    assert.equal(h.controller.getState().rememberedProjectId, id(1)); assert.equal(h.controller.getState().revision, 1);
  }
});

test('a timed-out PUT late response never acknowledges the current renderer state', async t => {
  const gate = deferred(); let putSignal;
  const client = createLastProjectClient(async (_url, init) => {
    if (init.method === 'GET') return response(record());
    putSignal = init.signal; return gate.promise;
  }, { timeoutMs: 5 });
  const changes = [], controller = createLastProjectController({ client, onChange: state => changes.push(state) });
  t.after(() => controller.dispose()); await controller.discover(); controller.rememberOpened(id(1), 0);
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(controller.getState().uncertain, true); assert.equal(putSignal.aborted, true);
  const count = changes.length; gate.resolve(response(record(id(1), 1))); await tick();
  assert.equal(changes.length, count); assert.notEqual(controller.getState().phase, 'saved'); assert.deepEqual(controller.getState().pendingInput, input());
});
