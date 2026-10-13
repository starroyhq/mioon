import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { transformSync } from 'esbuild';
import * as contracts from '@mioon/contracts';
import * as workspaceOrigin from '../apps/web/src/workspace-origin.js';
import * as restoredWorkspace from '../apps/web/src/restored-workspace.js';
import * as projectOpening from '../apps/web/src/project-open-state.ts';
import { rpc as realRpc } from '../apps/web/src/api.js';
import * as feedback from '../apps/web/src/import-feedback.js';
import { createEditorWindowInputs } from '../apps/web/src/editor-window-inputs.ts';

const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../apps/web/src/api.js', import.meta.url), 'utf8');
const importSource = appSource.slice(appSource.indexOf('  async function importFiles(files) {'), appSource.indexOf('  async function saveShot('));
const errorSource = appSource.slice(appSource.indexOf('function readableError(error) {'), appSource.indexOf('function Login('));
assert.ok(importSource.startsWith('  async function importFiles(files) {'), 'Exercise the actual App importFiles function');
const projectId = '00000000-0000-4000-8000-000000000001';
const file = (name, patch = {}) => ({ name, type: 'image/png', size: 4, ...patch });
const ack = input => ({ id: '00000000-0000-4000-8000-000000000010', projectId: input.projectId, name: input.name, mimeType: input.mimeType });
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const lifecycleSource = appSource.slice(appSource.indexOf('  const importSession ='), appSource.indexOf('  const currentProject ='));
const refreshSource = appSource.slice(appSource.indexOf('  const refresh = useCallback('), appSource.indexOf('  async function revealImageAsset('));
function harness({ fetchImpl, readerImpl, refreshImpl, rpcImpl, actualRefresh = false, workspace = { restored: false }, projectReady = true } = {}) {
  const notifications = [], requests = [], refreshes = [], busyWrites = [], stateWrites = [], busy = new Set(), input = { value: 'selected-files' };
  const currentProject = { current: projectId }, navigationEpoch = { current: 0 }, projectEpoch = { current: 0 }, requestCounter = { current: 0 };
  const data = { project: { id: projectId }, assets: [] }, dataRef = { current: data };
  const apiModule = { exports: {} }, workspaceRef = { current: workspace };
  Function('module', 'exports', 'require', 'fetch', transformSync(apiSource, { format: 'cjs' }).code)(apiModule, apiModule.exports, name => {
    if (name === '@mioon/contracts') return contracts;
    if (name === './workspace-origin.js') return workspaceOrigin;
    throw new Error(`Unexpected API dependency ${name}`);
  }, async (url, options) => {
    const body = JSON.parse(options.body);
    return fetchImpl ? fetchImpl(url, options, body, requests.length) : Response.json({ ok: true, data: ack(body.input) });
  });
  const api = apiModule.exports;
  class FileReader {
    readAsDataURL(selected) {
      if (readerImpl) return readerImpl(this, selected);
      this.result = 'data:image/png;base64,YWJjZA=='; queueMicrotask(() => this.onload());
    }
  }
  let effect, cleanup;
  const importSession = Function('useRef', 'useEffect', 'requestCounter', `${lifecycleSource}\nreturn importSession;`)(
    value => ({ current: value }), fn => { effect = fn; cleanup = fn(); }, requestCounter);
  const scope = { nativeWindow: null, editorInputs: { current: createEditorWindowInputs() }, ...workspaceOrigin, ...restoredWorkspace, ...projectOpening, projectSessionReady: () => projectReady, workspaceRef, data, dataRef, currentProject, navigationEpoch, projectEpoch, requestCounter, importSession, busyRef: { current: busy }, ...feedback,
    setShowCreate: value => stateWrites.push(['create', value]), context: () => ({ projectId: currentProject.current, epoch: navigationEpoch.current, workspace: workspaceRef.current }),
    isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === navigationEpoch.current && workspaceOrigin.workspaceOriginScope(captured.workspace) === workspaceOrigin.workspaceOriginScope(workspaceRef.current),
    isBusy: key => busy.has(`${currentProject.current}:${key}`), markBusy: (owner, key, value) => { busyWrites.push({ owner, key, value }); if (value) busy.add(`${owner}:${key}`); else busy.delete(`${owner}:${key}`); },
    notify: (message, type = 'success') => notifications.push({ message, type }),
    fileInput: { current: input }, FileReader, rpc: (operation, input, options) => { requests.push({ operation, input }); return (rpcImpl || api.rpc)(operation, input, options); },
    useCallback: fn => fn, reconcilePending() {}, emptyData: {}, setData: value => stateWrites.push(['data', value]), setProviders: value => stateWrites.push(['providers', value]),
    setLastSync: value => stateWrites.push(['sync', value]), setOnline: value => stateWrites.push(['online', value]), setPending() {}, pendingForProject: () => [],
    reconcileWorkspaceState: value => value, viewRef: { current: {} }, viewReady: { current: false }, preferencesRef: { current: { update() {} } }, setView() {}, setAuth: value => stateWrites.push(['auth', value]),
  };
  const refreshing = actualRefresh ? Function(...Object.keys(scope), `${errorSource}\n${refreshSource}\nreturn refresh;`)(...Object.values(scope)) : refreshImpl || (async () => {});
  scope.refresh = async owner => { refreshes.push(owner); return refreshing(owner); };
  const importFiles = Function(...Object.keys(scope), `${errorSource}\n${importSource}\nreturn importFiles;`)(...Object.values(scope));
  return { importFiles, notifications, requests, refreshes, busy, busyWrites, stateWrites, input, scope, api,
    unmount: () => cleanup(), remount: () => { cleanup = effect(); },
    switchProject(id) { currentProject.current = id; navigationEpoch.current++; projectEpoch.current++; requestCounter.current++; data.project = { id }; dataRef.current = { project: { id }, assets: [] }; },
  };
}
const imports = h => h.requests.filter(item => item.operation === 'asset.import');
const notice = h => h.notifications.at(-1)?.message || '';
const rejected = (message = '无法解码素材或媒体类型不符，请检查文件', status = 400) => Response.json({ ok: false, error: { code: 'INVALID_MEDIA', message } }, { status });
const assertUnknown = h => {
  assert.match(notice(h), /结果未知 1 个/); assert.match(notice(h), /素材可能已保存/); assert.match(notice(h), /先核对素材列表/); assert.match(notice(h), /不要整批重选/);
  assert.doesNotMatch(notice(h), /服务端已拒绝|本地处理失败|检查.*后重试/);
};

test('actual App importFiles identifies confirmed, rejected, and unattempted files after partial success', async () => {
  const h = harness({ fetchImpl: async (_url, _options, body, index) => index === 2
    ? Response.json({ ok: false, error: { code: 'INVALID_MEDIA', message: '无法解码素材或媒体类型不符，请检查文件' } }, { status: 400 })
    : Response.json({ ok: true, data: ack(body.input) }) });
  await h.importFiles([file('valid-a.png'), file('broken.png'), file('valid-c.png')]);
  assert.deepEqual(h.requests.map(item => item.input.name), ['valid-a.png', 'broken.png']);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].message, /valid-a\.png/, 'Keep the confirmed filename so selecting the whole batch again does not duplicate it');
  assert.match(h.notifications[0].message, /broken\.png/);
  assert.match(h.notifications[0].message, /valid-c\.png/);
  assert.match(h.notifications[0].message, /未尝试\s*1/);
  assert.equal(h.input.value, ''); assert.equal(h.busy.size, 0);
});

test('first explicit rejection confirms zero and identifies every unattempted remainder', async () => {
  const h = harness({ fetchImpl: async () => rejected() });
  await h.importFiles([file('broken.png'), file('b.png'), file('c.png')]);
  assert.equal(imports(h).length, 1); assert.match(notice(h), /已确认导入 0 个/); assert.match(notice(h), /服务端已拒绝 1 个：「broken.png」/);
  assert.match(notice(h), /未尝试 2 个：「b.png」、「c.png」/); assert.deepEqual(h.refreshes, [projectId]);
});

test('full success is sequential, names every confirmed file and normalizes existing audio aliases', async () => {
  let active = 0, maximum = 0;
  const h = harness({ fetchImpl: async (_url, _options, body) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return Response.json({ ok: true, data: ack(body.input) }); } });
  await h.importFiles([file('a.png'), file('b.wav', { type: 'audio/x-wav' }), file('c.m4a', { type: 'audio/x-m4a' })]);
  assert.equal(maximum, 1); assert.deepEqual(imports(h).map(call => call.input.mimeType), ['image/png', 'audio/wav', 'audio/mp4']);
  assert.match(notice(h), /已确认导入 3 个：「a.png」、「b.wav」、「c.m4a」/); assert.match(notice(h), /未尝试 0 个/);
  assert.equal(h.notifications[0].type, 'success'); assert.equal(h.busy.size, 0); assert.equal(h.input.value, ''); assert.deepEqual(h.refreshes, [projectId]);
});

test('unsupported type after success is a local pre-POST failure with the skipped remainder', async () => {
  const h = harness(); await h.importFiles([file('a.png'), file('bad.txt', { type: 'text/plain' }), file('c.png')]);
  assert.equal(imports(h).length, 1); assert.match(notice(h), /已确认导入 1 个：「a.png」/); assert.match(notice(h), /本地处理失败，未提交 1 个：「bad.txt」/);
  assert.match(notice(h), /未尝试 1 个：「c.png」/); assert.doesNotMatch(notice(h), /结果未知|服务端已拒绝/);
});

test('oversize validation happens before FileReader and before POST', async () => {
  const h = harness({ readerImpl: () => assert.fail('Must not read an oversize file') });
  await h.importFiles([file('huge.png', { size: 30 * 1024 * 1024 + 1 }), file('c.png')]);
  assert.equal(imports(h).length, 0); assert.match(notice(h), /本地处理失败，未提交 1 个：「huge.png」/); assert.match(notice(h), /30 MiB/); assert.equal(h.busy.size, 0);
});

for (const event of ['onerror', 'onabort']) test(`FileReader ${event} is a local failure, stops before POST and retains filenames`, async () => {
  const h = harness({ readerImpl: (reader, selected) => {
    if (selected.name === 'broken.png') return queueMicrotask(() => reader[event]({ type: event }));
    reader.result = 'data:image/png;base64,YWJjZA=='; queueMicrotask(() => reader.onload());
  } });
  await h.importFiles([file('a.png'), file('broken.png'), file('c.png')]);
  assert.equal(imports(h).length, 1); assert.match(notice(h), /本地处理失败，未提交 1 个：「broken.png」/); assert.match(notice(h), /未尝试 1 个：「c.png」/);
  assert.doesNotMatch(notice(h), /结果未知|服务端已拒绝/); assert.equal(h.input.value, ''); assert.equal(h.busy.size, 0);
});

test('synchronous FileReader throw and invalid read result are both local pre-POST failures', async () => {
  for (const readerImpl of [() => { throw new Error('Local read failure'); }, reader => { reader.result = null; queueMicrotask(() => reader.onload()); }]) {
    const h = harness({ readerImpl }); await h.importFiles([file('bad.png'), file('c.png')]);
    assert.equal(imports(h).length, 0); assert.match(notice(h), /本地处理失败，未提交 1 个：「bad.png」/); assert.equal(h.busy.size, 0);
  }
});

test('fetch failure after a confirmed import is unknown and never retries or advances', async () => {
  const h = harness({ fetchImpl: async (_url, _options, body, index) => { if (index === 2) throw new TypeError('Failed to fetch; retry now'); return Response.json({ ok: true, data: ack(body.input) }); } });
  await h.importFiles([file('a.png'), file('uncertain.png'), file('c.png')]);
  assert.equal(imports(h).length, 2); assertUnknown(h); assert.match(notice(h), /已确认导入 1 个：「a.png」/); assert.match(notice(h), /结果未知 1 个：「uncertain.png」/); assert.match(notice(h), /未尝试 1 个：「c.png」/);
});

test('malformed JSON and invalid success envelopes from real rpc remain unknown', async () => {
  for (const response of [new Response('<html>bad response</html>', { status: 200 }), Response.json({ ok: true }), Response.json({ result: 'done' }), Response.json({ ok: false, error: { message: 'failed' } }, { status: 400 })]) {
    const h = harness({ fetchImpl: async () => response }); await h.importFiles([file('unknown.png'), file('c.png')]);
    assert.equal(imports(h).length, 1); assertUnknown(h); assert.equal(h.busy.size, 0);
  }
});

test('invalid success asset identity, project, filename or MIME never counts as acknowledged', async () => {
  for (const change of [() => null, () => ({}), () => [], item => ({ ...item, id: '' }), item => ({ ...item, id: 'not-an-asset-id' }), item => ({ ...item, projectId: 'another-project' }), item => ({ ...item, name: 'another.png' }), item => ({ ...item, mimeType: 'video/mp4' })]) {
    const h = harness({ fetchImpl: async (_url, _options, body) => Response.json({ ok: true, data: change(ack(body.input)) }) });
    await h.importFiles([file('unknown.png'), file('c.png')]); assertUnknown(h); assert.match(notice(h), /已确认导入 0 个/); assert.equal(imports(h).length, 1);
  }
});

test('a structured server 5xx is uncertain even when its code and message resemble a rejection', async () => {
  const h = harness({ fetchImpl: async () => rejected('INVALID_MEDIA: failed, please retry', 500) });
  await h.importFiles([file('unknown.png'), file('c.png')]); assertUnknown(h); assert.equal(imports(h).length, 1);
});

test('large batches and hostile Unicode/HTML labels stay bounded plain text with exact counts', async () => {
  const hostile = '<img src=x onerror=alert(1)>\n\u202E' + '🚀'.repeat(4000);
  const h = harness({ fetchImpl: async (_url, _options, body, index) => index === 6 ? rejected(hostile) : Response.json({ ok: true, data: ack(body.input) }) });
  const batch = Array.from({ length: 1000 }, (_, i) => file(`${i}-${hostile}.png`)); await h.importFiles(batch);
  assert.equal(imports(h).length, 6); assert.match(notice(h), /已确认导入 5 个/); assert.match(notice(h), /另 2 个未列出/); assert.match(notice(h), /未尝试 994 个/); assert.match(notice(h), /另 991 个未列出/);
  assert.ok(notice(h).length < 1800); assert.doesNotMatch(notice(h), /[\u0000-\u001f\u007f-\u009f\u2028-\u202e]/);
  assert.equal(notice(h).isWellFormed(), true); assert.match(notice(h), /<img src=x/);
  assert.match(appSource, /<span>\{toast\.message\}<\/span>/, 'The bounded labels remain a React text child, not injected HTML');
  assert.doesNotMatch(appSource, /dangerouslySetInnerHTML/);
});

test('project switch during FileReader stops before POST and does not clear a new input', async () => {
  let reader; const h = harness({ readerImpl: value => { reader = value; } });
  const running = h.importFiles([file('a.png'), file('b.png')]); h.switchProject('00000000-0000-4000-8000-000000000002'); h.input.value = 'project-b-selection';
  reader.result = 'data:image/png;base64,YWJjZA=='; reader.onload(); await running;
  assert.equal(imports(h).length, 0); assert.equal(h.notifications.length, 0); assert.equal(h.refreshes.length, 0); assert.equal(h.input.value, 'project-b-selection'); assert.equal(h.busy.size, 0);
});

test('project switch during POST cannot continue the old batch or overwrite the new project', async () => {
  const held = defer(), h = harness({ fetchImpl: async () => held.promise });
  const running = h.importFiles([file('a.png'), file('b.png')]); await flush(); h.switchProject('00000000-0000-4000-8000-000000000002'); h.scope.notify('new project'); h.input.value = 'new selection';
  held.resolve(Response.json({ ok: true, data: ack(imports(h)[0].input) })); await running;
  assert.equal(imports(h).length, 1); assert.equal(notice(h), 'new project'); assert.equal(h.refreshes.length, 0); assert.equal(h.input.value, 'new selection'); assert.equal(h.busy.size, 0);
});

test('A to B to A and mode navigation each invalidate old responses despite matching project ID', async () => {
  for (const change of [h => { h.switchProject('00000000-0000-4000-8000-000000000002'); h.switchProject(projectId); }, h => { h.scope.navigationEpoch.current++; }]) {
    const held = defer(), h = harness({ fetchImpl: async () => held.promise }); const running = h.importFiles([file('a.png'), file('b.png')]); await flush(); change(h);
    h.scope.notify('new view'); held.resolve(rejected()); await running;
    assert.equal(notice(h), 'new view'); assert.equal(imports(h).length, 1); assert.equal(h.refreshes.length, 0); assert.equal(h.input.value, 'selected-files'); assert.equal(h.busy.size, 0);
  }
});

test('new selection while busy is explicitly not started and fences old success, remainder and input cleanup', async () => {
  const held = defer(), h = harness({ fetchImpl: async () => held.promise }); const running = h.importFiles([file('old.png'), file('old-remainder.png')]); await flush();
  h.input.value = 'new-selection'; await h.importFiles([file('new.png'), file('new-b.png')]);
  assert.match(notice(h), /本次选择未开始 2 个：「new.png」、「new-b.png」/); assert.match(notice(h), /当前文件结束后不再继续后续文件/); assert.equal(h.busy.size, 1);
  assert.equal(h.input.value, '', 'This rejected selection clears its own input so choosing those files later still fires change');
  h.input.value = 'later-picker-selection';
  const newerNotice = notice(h); held.resolve(Response.json({ ok: true, data: ack(imports(h)[0].input) })); await running;
  assert.equal(notice(h), newerNotice); assert.equal(imports(h).length, 1); assert.equal(h.input.value, 'later-picker-selection'); assert.equal(h.busy.size, 0);
  assert.doesNotMatch(notice(h), /已取消|取消成功/);
});

test('late old-project cleanup cannot release a newer project batch busy lock', async () => {
  const old = defer(), next = defer(); const h = harness({ fetchImpl: async (_url, _options, body) => body.input.projectId === projectId ? old.promise : next.promise });
  const oldRun = h.importFiles([file('old.png')]); await flush(); h.switchProject('00000000-0000-4000-8000-000000000002');
  const newRun = h.importFiles([file('new.png')]); await flush(); assert.equal(h.busy.size, 2);
  old.resolve(rejected()); await oldRun; assert.equal(h.busy.has('00000000-0000-4000-8000-000000000002:import'), true); assert.equal(h.notifications.length, 0);
  next.resolve(Response.json({ ok: true, data: ack(imports(h)[1].input) })); await newRun; assert.equal(h.busy.size, 0); assert.match(notice(h), /已确认导入 1 个：「new.png」/);
});

test('unmount during read or POST prevents continuation, refresh, notification and stateful busy cleanup', async () => {
  for (const stage of ['read', 'post']) {
    let reader; const held = defer(), h = harness(stage === 'read' ? { readerImpl: value => { reader = value; } } : { fetchImpl: async () => held.promise });
    const running = h.importFiles([file('old.png'), file('unattempted.png')]); await flush(); h.unmount(); const writes = h.busyWrites.length;
    if (stage === 'read') { reader.result = 'data:image/png;base64,YWJjZA=='; reader.onload(); } else held.resolve(rejected());
    await running; assert.equal(imports(h).length, stage === 'read' ? 0 : 1); assert.equal(h.notifications.length, 0); assert.equal(h.refreshes.length, 0);
    assert.equal(h.busyWrites.length, writes); assert.equal(h.busy.size, 0); assert.equal(h.input.value, 'selected-files');
  }
});

test('StrictMode effect reactivation does not resurrect old import ownership', async () => {
  const held = defer(), h = harness({ fetchImpl: async () => held.promise }); const running = h.importFiles([file('old.png'), file('unattempted.png')]); await flush();
  h.unmount(); h.remount(); held.resolve(Response.json({ ok: true, data: ack(imports(h)[0].input) })); await running;
  assert.equal(imports(h).length, 1); assert.equal(h.notifications.length, 0); assert.equal(h.refreshes.length, 0); assert.equal(h.busy.size, 0);
});

test('replacement input element is not cleared by completed old selection', async () => {
  const held = defer(), h = harness({ fetchImpl: async () => held.promise }); const running = h.importFiles([file('old.png')]); await flush();
  const newer = { value: 'newer-input' }; h.scope.fileInput.current = newer; held.resolve(Response.json({ ok: true, data: ack(imports(h)[0].input) })); await running;
  assert.equal(newer.value, 'newer-input'); assert.equal(h.busy.size, 0);
});

test('cleanup refresh failure still releases busy and clears only the current input', async () => {
  const h = harness({ refreshImpl: async () => { throw new Error('Refresh unavailable'); } });
  await assert.rejects(h.importFiles([file('a.png')]), /Refresh unavailable/); assert.equal(h.busy.size, 0); assert.equal(h.input.value, ''); assert.match(notice(h), /已确认导入 1 个/);
});

test('actual App refresh cannot apply a late snapshot after newer selection, project switch or unmount', async () => {
  for (const change of [async h => { h.input.value = 'new-files'; await h.importFiles([file('new.png')]); }, async h => h.switchProject('00000000-0000-4000-8000-000000000002'), async h => h.unmount()]) {
    const held = defer(), h = harness({ actualRefresh: true, fetchImpl: async (_url, _options, body) => {
      if (body.operation === 'asset.import') return Response.json({ ok: true, data: ack(body.input) });
      if (body.operation === 'project.get') return held.promise;
      return Response.json({ ok: true, data: [] });
    } });
    const running = h.importFiles([file('old.png')]); await flush(); assert.equal(h.refreshes.length, 1); await change(h); const writes = h.stateWrites.length;
    held.resolve(Response.json({ ok: true, data: { project: { id: projectId }, assets: [ack(imports(h)[0].input)] } })); await running;
    assert.equal(h.stateWrites.length, writes); assert.equal(h.busy.size, 0);
  }
});

test('normal actual App refresh applies the confirmed import and leaves busy/input clean', async () => {
  const h = harness({ actualRefresh: true, fetchImpl: async (_url, _options, body) => Response.json({ ok: true, data: body.operation === 'asset.import' ? ack(body.input) : body.operation === 'project.get' ? { project: { id: projectId }, assets: [ack({ projectId, name: 'a.png', mimeType: 'image/png' })] } : [] }) });
  await h.importFiles([file('a.png')]); assert.equal(h.stateWrites.filter(([key]) => key === 'data').length, 1); assert.equal(h.scope.dataRef.current.assets[0].name, 'a.png'); assert.equal(h.busy.size, 0); assert.equal(h.input.value, '');
});

async function httpFixture(handler, run) {
  const observed = [];
  const server = createServer(async (req, res) => {
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const request = JSON.parse(bytes); observed.push(request); await handler(request, res, observed.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => nativeFetch(new URL(url, origin), options);
  try { await run(observed); }
  finally { globalThis.fetch = nativeFetch; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const sendJson = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('real loopback HTTP and imported rpc: structured 4xx rejects only the current file', async () => {
  await httpFixture((request, res, index) => index === 2 ? sendJson(res, 400, { ok: false, error: { code: 'INVALID_MEDIA', message: '无法解码素材' } }) : sendJson(res, 200, { ok: true, data: ack(request.input) }), async observed => {
    const h = harness({ rpcImpl: realRpc }); await h.importFiles([file('valid-a.png'), file('broken.png'), file('valid-c.png')]);
    assert.deepEqual(observed.map(item => item.input.name), ['valid-a.png', 'broken.png']); assert.match(notice(h), /已确认导入 1 个：「valid-a.png」/);
    assert.match(notice(h), /服务端已拒绝 1 个：「broken.png」/); assert.match(notice(h), /未尝试 1 个：「valid-c.png」/);
  });
});

test('real loopback HTTP and imported rpc: malformed 200 acknowledgement remains unknown', async () => {
  await httpFixture((_request, res) => sendJson(res, 200, { ok: true, data: { success: true } }), async observed => {
    const h = harness({ rpcImpl: realRpc }); await h.importFiles([file('unknown.png'), file('not-attempted.png')]);
    assert.equal(observed.length, 1); assertUnknown(h); assert.match(notice(h), /未尝试 1 个：「not-attempted.png」/); assert.equal(h.busy.size, 0);
  });
});

test('real loopback HTTP and imported rpc: socket loss after observed POST stays unknown with no retry', async () => {
  await httpFixture((_request, res) => { res.socket.destroy(); }, async observed => {
    const h = harness({ rpcImpl: realRpc }); await h.importFiles([file('possibly-saved.png'), file('not-attempted.png')]);
    assert.equal(observed.length, 1); assert.equal(imports(h).length, 1); assertUnknown(h); assert.match(notice(h), /已确认导入 0 个/); assert.equal(h.input.value, ''); assert.equal(h.busy.size, 0);
  });
});

// Execute the actual App polling effect including the H1 loaded-project gate. Only browser scheduling/event
// plumbing is controlled; callbacks call the actual App refresh implementation.
const pollSource = appSource.slice(appSource.indexOf('  useEffect(() => {\n    if (!auth || !workbenchReady || !data.project?.id) return;'), appSource.indexOf('  async function run(key,'));
assert.ok(pollSource.startsWith('  useEffect(() => {\n    if (!auth || !workbenchReady || !data.project?.id) return;'));
function mountActualPolling(h, workbenchReady = true) {
  let timer, cleanup, cleared = false;
  const listeners = new Map(), document = { visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const dragging = { current: false };
  const environment = { ...h.scope, auth: true, workbenchReady, dragging, document,
    useEffect: fn => { cleanup = fn(); },
    setInterval: (fn, delay) => { assert.equal(delay, 2500); timer = fn; return 'poll-timer'; },
    clearInterval: id => { assert.equal(id, 'poll-timer'); cleared = true; },
  };
  Function(...Object.keys(environment), pollSource)(...Object.values(environment));
  return { dragging, document, listeners,
    async tick() { if (!cleared) timer?.(); await flush(); },
    async visibility(state) { document.visibilityState = state; listeners.get('visibilitychange')?.(); await flush(); },
    cleanup: () => cleanup?.(),
    get cleared() { return cleared; },
  };
}
async function supersededBatch(outcome, options = {}) {
  const post = defer(), saved = ack({ projectId, name: 'accepted-old.png', mimeType: 'image/png' });
  let persisted = false;
  const h = harness({ actualRefresh: true, fetchImpl: async (_url, _options, body) => {
    if (body.operation === 'asset.import') return post.promise;
    if (body.operation === 'project.get') return options.projectRead ? options.projectRead(body.input.projectId, saved) : Response.json({ ok: true, data: { project: { id: projectId }, assets: persisted ? [saved] : [] } });
    return Response.json({ ok: true, data: [] });
  } });
  const running = h.importFiles([file('accepted-old.png'), file('old-unattempted.png')]); await flush();
  await h.importFiles([file('new-not-started.png')]);
  const newerNotice = notice(h); assert.match(newerNotice, /本次选择未开始 1 个：「new-not-started.png」/);
  h.input.value = 'later-picker-selection'; persisted = true;
  if (outcome === 'success') post.resolve(Response.json({ ok: true, data: saved }));
  else post.reject(new TypeError('Connection lost after server accepted the bytes'));
  await running;
  assert.equal(imports(h).length, 1); assert.equal(h.refreshes.length, 0, 'The superseded import itself must not refresh the newer selection');
  assert.equal(notice(h), newerNotice); assert.equal(h.input.value, 'later-picker-selection'); assert.equal(h.busy.size, 0);
  return { h, saved, newerNotice };
}

for (const outcome of ['success', 'unknown']) {
  for (const route of ['interval', 'visibilitychange']) test(`actual App ${route} discovers accepted asset after superseded old POST ${outcome} without changing newer notice/input`, async () => {
    const { h, saved, newerNotice } = await supersededBatch(outcome), poll = mountActualPolling(h);
    try {
      assert.deepEqual(h.scope.dataRef.current.assets, []);
      if (route === 'interval') await poll.tick(); else { await poll.visibility('hidden'); assert.equal(h.refreshes.length, 0); await poll.visibility('visible'); }
      assert.deepEqual(h.scope.dataRef.current.assets, [saved], 'The existing asset list refresh exposes the accepted old import');
      assert.equal(h.stateWrites.filter(([key]) => key === 'data').length, 1);
      assert.equal(h.requests.filter(call => call.operation === 'project.get').length, 1);
      assert.equal(imports(h).length, 1, 'Neither polling route retries the old POST, old remainder, or rejected newer selection');
      assert.equal(notice(h), newerNotice); assert.equal(h.notifications.length, 1); assert.equal(h.input.value, 'later-picker-selection'); assert.equal(h.busy.size, 0);
    } finally { poll.cleanup(); }
    assert.equal(poll.cleared, true); assert.equal(poll.listeners.size, 0);
  });

  test(`actual App poll after superseded POST ${outcome} cannot apply an old project snapshot after newer project refresh`, async () => {
    const oldSnapshot = defer(), newAsset = { ...ack({ projectId: '00000000-0000-4000-8000-000000000002', name: 'project-b.png', mimeType: 'image/png' }), id: '00000000-0000-4000-8000-000000000011' };
    const { h, saved } = await supersededBatch(outcome, { projectRead: owner => owner === projectId ? oldSnapshot.promise : Response.json({ ok: true, data: { project: { id: '00000000-0000-4000-8000-000000000002' }, assets: [newAsset] } }) });
    const oldPoll = mountActualPolling(h); await oldPoll.tick();
    assert.equal(h.requests.filter(call => call.operation === 'project.get').length, 1); assert.equal(h.stateWrites.length, 0);
    oldPoll.cleanup(); h.switchProject('00000000-0000-4000-8000-000000000002'); h.scope.notify('new project notice'); h.input.value = 'new project input';
    const newPoll = mountActualPolling(h);
    try {
      await newPoll.tick(); assert.deepEqual(h.scope.dataRef.current.assets, [newAsset]); const writes = h.stateWrites.length;
      oldSnapshot.resolve(Response.json({ ok: true, data: { project: { id: projectId }, assets: [saved] } })); await flush();
      assert.equal(h.stateWrites.length, writes); assert.equal(h.scope.dataRef.current.project.id, '00000000-0000-4000-8000-000000000002'); assert.deepEqual(h.scope.dataRef.current.assets, [newAsset]);
      assert.equal(notice(h), 'new project notice'); assert.equal(h.input.value, 'new project input'); assert.equal(imports(h).length, 1); assert.equal(h.busy.size, 0);
    } finally { newPoll.cleanup(); }
  });
}

test('actual App polling honors hidden/dragging guards and removes its timer and visibility listener on cleanup', async () => {
  const { h, saved, newerNotice } = await supersededBatch('unknown'), poll = mountActualPolling(h);
  await poll.visibility('hidden'); await poll.tick(); assert.equal(h.refreshes.length, 0);
  poll.document.visibilityState = 'visible'; poll.dragging.current = true; await poll.tick(); assert.equal(h.refreshes.length, 0);
  poll.dragging.current = false; await poll.tick(); assert.deepEqual(h.scope.dataRef.current.assets, [saved]);
  assert.equal(h.refreshes.length, 1); assert.equal(notice(h), newerNotice); assert.equal(h.input.value, 'later-picker-selection');
  poll.cleanup(); await poll.tick(); await poll.visibility('visible'); assert.equal(h.refreshes.length, 1); assert.equal(poll.cleared, true); assert.equal(poll.listeners.size, 0);
});


test('restored import pins the first gesture and treats origin refusal as unknown without rekeying or batch replay', async () => {
  const origin = '96000000-0000-4000-8000-000000000001';
  const workspace = { restored: true, workspaceOrigin: origin, operationPolicy: [{ operation: 'asset.import', available: true }] };
  const bodies = [], h = harness({ workspace, fetchImpl: async (_url, _options, body) => {
    bodies.push(body);
    return Response.json({ ok: false, error: { code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', message: 'Workspace changed', details: { mutationOutcome: 'not_applied' } } }, { status: 409 });
  } });
  await h.importFiles([file('原始素材.png'), file('后续素材.png')]);
  assert.equal(bodies.length, 1); assert.equal(bodies[0].expectedWorkspaceOrigin, origin);
  assert.deepEqual(bodies[0].input, { projectId, name: '原始素材.png', mimeType: 'image/png', dataBase64: 'YWJjZA==' });
  assertUnknown(h); assert.equal(h.busy.size, 0);
  let reader;
  const delayed = harness({ workspace, readerImpl: current => { reader = current; } });
  const running = delayed.importFiles([file('delayed.png')]);
  delayed.scope.workspaceRef.current = { ...workspace, workspaceOrigin: '96000000-0000-4000-8000-000000000002' };
  reader.result = 'data:image/png;base64,YWJjZA=='; reader.onload(); await running;
  assert.equal(delayed.requests.length, 0, 'A changed origin after file reading cannot submit using a newly adopted pin');
});


test('home presentation never starts project polling or performs the loaded-project refresh', async () => {
  const h = harness({ actualRefresh: true, projectReady: false });
  const poll = mountActualPolling(h, false); await poll.tick(); await poll.visibility('visible');
  await h.scope.refresh(projectId);
  assert.deepEqual(h.requests, []); assert.deepEqual(h.stateWrites, []); assert.equal(poll.listeners.size, 0); poll.cleanup();
});
