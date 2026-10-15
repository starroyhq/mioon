import { i18nTestModule, message, renderMessage, translate } from './helpers/i18n.ts';
import * as i18n from '../packages/i18n/src/index.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ApiError } from '../apps/web/src/api.js';
import { canonicalFrameInput } from '@mioon/contracts';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as frame from '../apps/web/src/frame-extraction.js';

const project = '00000000-0000-4000-8000-000000000001', otherProject = '00000000-0000-4000-8000-000000000002';
const sourceId = '00000000-0000-4000-8000-000000000003', taskId = '00000000-0000-4000-8000-000000000004', resultId = '00000000-0000-4000-8000-000000000005';
const hash = 'a'.repeat(64), outputHash = 'b'.repeat(64), date = '2026-10-11T00:00:00.000Z';
const asset = { id: sourceId, projectId: project, sha256: hash, name: 'Source clip', duration: 10, mimeType: 'video/mp4' };
const intent = { sourceScope: 'source-a:1', sourceAssetId: sourceId, sourceHash: hash, sourceFrame: 56 };
const task = (patch = {}) => ({ id: taskId, projectId: project, requestId: 'request-0001', sourceAssetId: sourceId, sourceHash: hash, sourceFrame: 56, fps: 30, profileId: 'local-png-1024-v1', state: 'queued', revision: 1, started: false, result: null, errorCode: null, createdAt: date, updatedAt: date, ...patch });
const succeeded = (patch = {}) => task({ state: 'succeeded', revision: 4, started: true, result: { assetId: resultId, sha256: outputHash, mimeType: 'image/png', width: 1024, height: 576, byteLength: 1024 }, ...patch });
const page = (items = [], nextCursor = null, projectId = project) => ({ projectId, items, nextCursor });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function setup(handler = () => page(), options = {}) {
  const calls = []; let serial = 0;
  const controller = frame.createFrameExtractionController({ rpc: async (operation, input) => { calls.push({ operation, input }); return handler(operation, input); }, createRequestId: () => `request-${String(++serial).padStart(4, '0')}`, ...options });
  const configure = (patch = {}) => controller.configure({ projectId: project, sourceScope: intent.sourceScope, sourceAsset: asset, visible: true, assets: [], ...patch });
  configure(); return { controller, calls, configure };
}

test('construction/configure/reopen are inert and initial unread or failed history blocks capture', async () => {
  const h = setup(() => { throw new Error('offline'); });
  assert.deepEqual(h.calls, []); await h.controller.capture(intent); assert.deepEqual(h.calls, []);
  await h.controller.refreshTasks(); assert.equal(h.controller.getState().historyError, true);
  await h.controller.capture(intent); assert.equal(h.calls.length, 1);
  h.configure({ visible: false }); h.configure(); assert.equal(h.calls.length, 1);
});

test('capture freezes actual intent, rejects double clicks, validates ACK and reads current task instead of showing historical queued state', async () => {
  const submit = deferred();
  const h = setup(operation => operation === 'frame.task.list' ? page() : operation === 'frame.extract' ? submit.promise : succeeded());
  await h.controller.refreshTasks(); const clicked = { ...intent }; const first = h.controller.capture(clicked);
  clicked.sourceFrame = 100; await h.controller.capture(intent);
  assert.equal(h.calls.filter(call => call.operation === 'frame.extract').length, 1);
  assert.equal(h.controller.getState().pending.input.sourceFrame, 56);
  assert.equal(Object.isFrozen(h.controller.getState().pending.input), true);
  submit.resolve(task()); await first;
  assert.equal(h.controller.getState().acknowledged.state, 'queued');
  assert.equal(h.controller.getState().tasks[0].state, 'succeeded');
  assert.deepEqual(h.calls[1].input, { projectId: project, sourceAssetId: sourceId, sourceHash: hash, sourceFrame: 56, requestId: 'request-0001' });
});

test('lost or malformed ACK retains exact input; null receipt never invents a key, explicit retry repeats exact input', async () => {
  let extracts = 0;
  const h = setup(operation => operation === 'frame.task.list' ? page() : operation === 'frame.request.get' ? null : operation === 'frame.extract' ? (++extracts === 1 ? { ...task(), extra: '/private/path' } : task()) : task());
  await h.controller.refreshTasks(); await h.controller.capture(intent);
  assert.equal(h.controller.getState().phase, 'unknown'); const frozen = h.controller.getState().pending.input;
  await h.controller.reconcileUnknown(); assert.deepEqual(h.controller.getState().pending.input, frozen);
  await h.controller.capture(intent); assert.equal(extracts, 1);
  await h.controller.retryUnknown(); assert.equal(extracts, 2);
  assert.deepEqual(h.calls.filter(call => call.operation === 'frame.extract').map(call => call.input), [frozen, frozen]);
  assert.equal(h.controller.getState().pending, null);
});

test('request reconciliation requires matching operation/identity and treats original receipt separately from task current state', async () => {
  let valid = false;
  const h = setup(operation => operation === 'frame.task.list' ? page() : operation === 'frame.extract' ? Promise.reject(new Error('lost')) : operation === 'frame.request.get' ? { projectId: valid ? project : otherProject, requestId: 'request-0001', operation: 'frame.extract', response: task() } : succeeded());
  await h.controller.refreshTasks(); await h.controller.capture(intent); await h.controller.reconcileUnknown();
  assert.ok(h.controller.getState().pending); valid = true; await h.controller.reconcileUnknown();
  assert.equal(h.controller.getState().tasks[0].state, 'succeeded'); assert.equal(h.controller.getState().pending, null);
});

test('late project/source responses do not overwrite current selection; exact unknown input survives navigation', async () => {
  const submit = deferred();
  const h = setup(operation => operation === 'frame.task.list' ? page() : submit.promise);
  await h.controller.refreshTasks(); const pending = h.controller.capture(intent);
  h.configure({ sourceScope: 'source-a:2' }); submit.resolve(task()); await pending;
  assert.equal(h.controller.getState().sourceScope, 'source-a:2'); assert.equal(h.controller.getState().tasks.length, 0);
  assert.equal(h.controller.getState().pending.input.sourceFrame, 56);
  h.configure({ projectId: otherProject, sourceScope: 'project-b:1', sourceAsset: { ...asset, projectId: otherProject } });
  assert.equal(h.controller.getState().pending, null); h.configure(); assert.equal(h.controller.getState().pending.input.requestId, 'request-0001');
});

test('late and decreasing task revisions cannot regress the current task or leak foreign-project DTOs', async () => {
  const old = deferred(); let reads = 0;
  const h = setup(operation => operation === 'frame.task.list' ? page([task()]) : ++reads === 1 ? old.promise : succeeded());
  await h.controller.refreshTasks(); const pending = h.controller.readTask(taskId); await h.controller.readTask(taskId); old.resolve(task()); await pending;
  assert.equal(h.controller.getState().tasks[0].state, 'succeeded');
  h.configure({ projectId: otherProject, sourceScope: 'b', sourceAsset: { ...asset, projectId: otherProject } });
  await h.controller.readTask(taskId); assert.equal(h.controller.getState().tasks.length, 0); assert.ok(h.controller.getState().error);
});

test('history replaces page-20 while retaining at most 50 active rows and blocks duplicate active source marks', async () => {
  let pages = 0;
  const h = setup(operation => operation === 'frame.task.list' ? page(Array.from({ length: 20 }, (_, i) => task({ id: `00000000-0000-4000-8000-${String(pages * 20 + i + 100).padStart(12, '0')}`, requestId: `existing-${pages}-${i}` })), `cursor-${++pages}`) : assert.fail('no mutation'));
  await h.controller.refreshTasks(); await h.controller.capture(intent); assert.match(h.controller.getState().message, /已有未完成/);
  await h.controller.loadMoreTasks(); await h.controller.loadMoreTasks(); await h.controller.loadMoreTasks();
  assert.equal(h.controller.getState().tasks.length, 50); assert.equal(h.calls.length, 4); assert.equal(h.controller.getState().pageTrail.length, 3); assert.ok(h.controller.getState().nextCursor); assert.ok(h.calls.every(call => call.input.limit === 20));
});

test('cancel is CAS-bound only while never started; recovery explicitly checks existing bytes for interrupted or local-result tasks', async () => {
  let current = task();
  const h = setup((operation, input) => operation === 'frame.task.list' ? page([current]) : operation === 'frame.task.get' ? current : operation === 'frame.task.cancelQueued' ? (current = task({ state: 'cancelled_before_start', revision: input.expectedRevision + 1 })) : operation === 'frame.task.recoverResult' ? (current = task({ state: 'persisting', revision: input.expectedRevision + 1, started: true })) : assert.fail(operation));
  await h.controller.refreshTasks(); await h.controller.cancelQueued(task({ state: 'running', started: true, revision: 2 })); assert.equal(h.calls.length, 1);
  await h.controller.cancelQueued(h.controller.getState().tasks[0]); assert.equal(h.calls[1].input.expectedRevision, 1);
  for (const state of ['local_result_error', 'interrupted']) {
    const recover = setup((operation, input) => operation === 'frame.task.list' ? page([task({ state, revision: 3, started: true, errorCode: 'FRAME_INTERRUPTED' })]) : task({ state: 'persisting', revision: 4, started: true }));
    await recover.controller.refreshTasks(); assert.equal(recover.calls.length, 1); await recover.controller.recoverResult(recover.controller.getState().tasks[0]);
    assert.equal(recover.calls[1].operation, 'frame.task.recoverResult'); assert.equal(recover.calls[1].input.expectedRevision, 3);
    assert.ok(recover.calls.every(call => call.operation !== 'frame.extract'));
  }
  assert.equal(frame.frameCanCancel(task({ state: 'interrupted', revision: 2 })), true);
  assert.equal(frame.frameCanCancel(task({ state: 'interrupted', revision: 3, started: true })), false);
  assert.equal(frame.frameCanRecover(task({ state: 'failed', revision: 3, started: true })), false);
  assert.equal(frame.frameCanRecover(task({ state: 'interrupted', revision: 2, started: false })), false);
  assert.equal(frame.frameCanRecover(task({ state: 'interrupted', revision: 3, started: true })), true);
});

test('result reveal re-reads current task, preserves draft refusal, and rejects navigation while awaiting verification', async () => {
  const gate = deferred(); let reads = 0, reveals = 0;
  const h = setup(operation => operation === 'frame.task.list' ? page([succeeded()]) : ++reads === 1 ? succeeded() : gate.promise, { revealAsset: (id, pid, guard) => { assert.equal(id, resultId); assert.equal(pid, project); assert.equal(guard(), true); reveals++; return false; } });
  await h.controller.refreshTasks(); assert.equal(await h.controller.revealResult(h.controller.getState().tasks[0]), false); assert.equal(reveals, 1);
  const pending = h.controller.revealResult(h.controller.getState().tasks[0]); h.configure({ sourceScope: 'source-b:2' }); gate.resolve(succeeded());
  assert.equal(await pending, false); assert.equal(reveals, 1);
});

const code = transformSync(readFileSync(new URL('../apps/web/src/FrameExtractionPanel.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function panelHarness(controller) {
  let cursor = 0, tree, visible = true, effects = [], layouts = []; const slots = [];
  const effect = (queue, fn, deps) => { const index = cursor++, previous = slots[index]; if (previous && deps.every((item, i) => Object.is(item, previous.deps[i]))) return; slots[index] = { deps, cleanup: previous?.cleanup, fn }; queue.push(index); };
  const react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), useRef: value => slots[cursor++] ||= { current: value }, useState: value => { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof value === 'function' ? value() : value }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; }, useLayoutEffect: (fn, deps) => effect(layouts, fn, deps), useEffect: (fn, deps) => effect(effects, fn, deps) }; react.default = react;
  const module = { exports: {} };
  Function('require', 'module', 'exports', code)(id => id === './i18n/I18nProvider.tsx' ? i18nTestModule() : id.endsWith('packages/i18n/src/index.ts') ? i18n : id === 'react' ? react : id === './frame-extraction.js' ? frame : id === './workspace-visibility.jsx' ? { useWorkspaceVisibility: () => visible } : new Proxy({}, { get: (_, key) => String(key) }), module, module.exports);
  const flush = queue => { for (const index of queue) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].fn(); } };
  return { render() { cursor = 0; effects = []; layouts = []; tree = module.exports.default({ controller }); flush(layouts); return tree; }, handlers: () => nodes(tree).filter(node => node.props?.onClick).map(node => node.props.onClick), hide() { visible = false; }, unmount() { slots.forEach(slot => slot.cleanup?.()); }, nodes: () => nodes(tree) };
}

test('actual Properties result card keeps its readable summary visible and exact audit identities in a closed native disclosure', async () => {
  const resultName = 'Source clip - 00.01.867.png', completed = succeeded();
  const h = setup(() => page([completed]));
  h.configure({ assets: [{ id: resultId, projectId: project, sha256: outputHash, name: resultName, mimeType: 'image/png', provenance: 'extracted-frame' }] });
  await h.controller.refreshTasks(); const panel = panelHarness(h.controller); panel.render();
  const card = panel.nodes().find(node => node.props?.['data-testid'] === 'frame-extraction-task');
  const disclosure = nodes(card).find(node => node.type === 'details');
  const summary = disclosure.props.children[0];
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
  assert.equal(summary.type, 'summary'); assert.equal(text(summary), '源文件与请求记录');
  assert.equal(Boolean(disclosure.props.open), false, 'audit details are collapsed by default');
  const collapsedText = text(card.props.children.filter(node => node !== disclosure)) + text(summary);
  for (const expected of [resultName, '时间点 56', '1.867 秒', '1024 × 576', frame.frameTaskLabel('succeeded'), '在素材库查看 PNG']) assert.ok(collapsedText.includes(expected), expected);
  const auditFields = [
    ['源素材 ', sourceId], ['源 SHA-256 ', hash], ['任务 ', taskId], ['请求 ', completed.requestId], ['提取配置 ', completed.profileId],
    ['素材 ', resultId], ['SHA-256 ', outputHash],
  ];
  const disclosedFields = nodes(disclosure).filter(node => node.type === 'span').map(text);
  for (const [label, value] of auditFields) {
    assert.equal(collapsedText.includes(value), false, `${label}is hidden until the disclosure is expanded`);
    assert.ok(disclosedFields.includes(label + value), `${label}retains its complete, untruncated value`);
  }
  assert.ok(nodes(card).find(node => node.props?.['data-testid'] === 'frame-result-reveal').props.onClick);
  panel.unmount();
});

test('actual Properties component shows bounded provenance/result, and stale hidden/unmounted handlers cannot act', async () => {
  const actions = [], h = setup(operation => operation === 'frame.task.list' ? page([succeeded()]) : succeeded()); await h.controller.refreshTasks();
  const controller = new Proxy(h.controller, { get(target, key) { return ['refreshTasks', 'revealResult', 'loadMoreTasks'].includes(key) ? (...args) => actions.push([key, ...args]) : target[key]; } });
  const panel = panelHarness(controller); panel.render(); const old = panel.handlers();
  assert.ok(panel.nodes().some(node => node.props?.['data-testid'] === 'frame-extraction-result')); assert.ok(old.length >= 2);
  h.configure({ sourceScope: 'source-a:2' }); panel.render(); old.forEach(fn => fn()); assert.deepEqual(actions, []);
  const current = panel.handlers(); panel.hide(); panel.render(); current.forEach(fn => fn()); assert.deepEqual(actions, []);
  panel.unmount(); panel.handlers().forEach(fn => fn()); assert.deepEqual(actions, []);
});


test('interrupted recovery with missing local bytes never falls back to extraction or replaces the original key', async () => {
  const interrupted = task({ state: 'interrupted', revision: 3, started: true, errorCode: 'FRAME_INTERRUPTED' });
  const h = setup(operation => operation === 'frame.task.list' ? page([interrupted]) : operation === 'frame.request.get' ? null : Promise.reject(Object.assign(new Error('No local result'), { code: 'FRAME_RESULT_INVALID', status: 409 })));
  await h.controller.refreshTasks(); await h.controller.recoverResult(h.controller.getState().tasks[0]);
  assert.equal(h.controller.getState().phase, 'unknown'); const retained = h.controller.getState().pending.input;
  await h.controller.reconcileUnknown(); await h.controller.capture(intent);
  assert.deepEqual(h.controller.getState().pending.input, retained); assert.equal(h.calls.filter(call => call.operation === 'frame.task.recoverResult').length, 1); assert.equal(h.calls.filter(call => call.operation === 'frame.extract').length, 0);
});

test('actual Properties recovery control does not claim every interrupted task already has a complete PNG', async () => {
  const interrupted = task({ state: 'interrupted', revision: 3, started: true, errorCode: 'FRAME_INTERRUPTED' });
  const h = setup(() => page([interrupted])); await h.controller.refreshTasks(); const panel = panelHarness(h.controller); panel.render();
  const recover = panel.nodes().find(node => node.props?.['data-testid'] === 'frame-task-recover'); assert.ok(recover);
  assert.match(JSON.stringify(panel.nodes().map(node => node.props?.children)), /中断后可能留有本地 PNG/); assert.match(JSON.stringify(recover.props.children), /检查并恢复/); panel.unmount();
});


const refusal = (operation, input, patch = {}) => new ApiError('Not accepted', 'FRAME_RESULT_INVALID', { frameOutcome: { status: 'not_accepted', projectId: input.projectId, operation, requestId: input.requestId, inputHash: createHash('sha256').update(canonicalFrameInput(input)).digest('hex'), ...patch } }, true, 409);

test('only an exact operation/input-bound authoritative rejection clears recovery intent, never retries extraction', async () => {
  const interrupted = task({ state: 'interrupted', revision: 3, started: true, errorCode: 'FRAME_INTERRUPTED' });
  const h = setup((operation, input) => operation === 'frame.task.list' ? page([interrupted]) : Promise.reject(refusal(operation, input)));
  await h.controller.refreshTasks(); await h.controller.recoverResult(h.controller.getState().tasks[0]);
  assert.equal(h.controller.getState().pending, null); assert.equal(h.controller.getState().phase, 'idle'); assert.equal(h.controller.getState().historyError, true); assert.match(h.controller.getState().message, /没有重新解码/);
  assert.equal(h.calls.length, 2); await h.controller.capture(intent); assert.equal(h.calls.length, 2, 'fresh read is required before another deliberate capture');
  await h.controller.refreshTasks(); assert.equal(frame.frameCaptureBusy(h.controller.getState()), false); assert.equal(h.calls.filter(call => call.operation === 'frame.extract').length, 0);
});

test('forged, changed-input, wrong-status or unbound refusal never clears exact unknown input', async () => {
  const input = { projectId: project, taskId, expectedRevision: 3, requestId: 'fixed-control-key' }, operation = 'frame.task.recoverResult';
  const tampered = [
    refusal(operation, input, { operation: 'frame.extract' }), refusal(operation, input, { projectId: otherProject }), refusal(operation, input, { requestId: 'different-control-key' }),
    refusal(operation, input, { inputHash: createHash('sha256').update(canonicalFrameInput({ ...input, expectedRevision: 4 })).digest('hex') }), refusal(operation, input, { extra: true }), refusal(operation, input, { status: 'not_applied' }),
    Object.assign(refusal(operation, input), { status: 503 }), Object.assign(refusal(operation, input), { code: 'FRAME_STORAGE_FAILED' }), Object.assign(new Error('claimed refusal'), { code: 'FRAME_RESULT_INVALID', status: 409, details: refusal(operation, input).details }),
  ];
  assert.equal(await frame.frameRequestNotAccepted(refusal(operation, input), operation, input), true);
  for (const error of tampered) assert.equal(await frame.frameRequestNotAccepted(error, operation, input), false);
  const h = setup((op, captured) => op === 'frame.task.list' ? page([task({ state: 'interrupted', revision: 3, started: true, errorCode: 'FRAME_INTERRUPTED' })]) : Promise.reject(refusal(op, captured, { inputHash: '0'.repeat(64) })));
  await h.controller.refreshTasks(); await h.controller.recoverResult(h.controller.getState().tasks[0]);
  assert.equal(h.controller.getState().phase, 'unknown'); assert.equal(h.controller.getState().pending.input.expectedRevision, 3);
});


test('more than 50 historical tasks remain navigable and an older local PNG recovery is explicit', async () => {
  const records = Array.from({ length: 61 }, (_, i) => task({ id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`, requestId: `historical-request-${i}`, sourceFrame: i, state: i === 60 ? 'local_result_error' : 'cancelled_before_start', revision: i === 60 ? 3 : 2, started: i === 60, errorCode: i === 60 ? 'FRAME_RESULT_INVALID' : null }));
  let recovered;
  const h = setup((operation, input) => {
    if (operation === 'frame.task.list') { const start = input.cursor ? Number(input.cursor.split('-')[1]) : 0; return page(records.slice(start, start + 20), start + 20 < records.length ? `page-${start + 20}` : null); }
    if (operation === 'frame.task.recoverResult') { assert.equal(input.taskId, records[60].id); return recovered = { ...records[60], state: 'persisting', revision: 4, errorCode: null }; }
    if (operation === 'frame.task.get') return recovered;
    assert.fail(`Unexpected operation ${operation}`);
  });
  await h.controller.refreshTasks(); for (let i = 0; i < 3; i++) { await h.controller.loadMoreTasks(); assert.ok(h.controller.getState().tasks.length <= 50); }
  assert.equal(h.controller.getState().pageTrail.length, 3); assert.equal(h.controller.getState().tasks[0].id, records[60].id); assert.ok(h.calls.every(call => call.operation === 'frame.task.list'));
  const panel = panelHarness(h.controller); panel.render(); const button = panel.nodes().find(node => node.props?.['data-testid'] === 'frame-task-recover'); assert.ok(button); await button.props.onClick();
  assert.equal(h.calls.filter(call => call.operation === 'frame.task.recoverResult').length, 1); assert.equal(h.calls.filter(call => call.operation === 'frame.extract').length, 0);
  await h.controller.refreshTasks(); assert.equal(h.controller.getState().pageTrail.length, 0); assert.equal(h.controller.getState().tasks.find(item => item.id === records[60].id).revision, 4, 'current accepted task survives replacing history page');
  for (let i = 0; i < 3; i++) await h.controller.loadMoreTasks(); assert.equal(h.controller.getState().tasks.find(item => item.id === records[60].id).revision, 4, 'older page snapshot cannot downgrade known recovery');
  panel.unmount();
});

test('returning to latest supersedes a late older page and retains newer observed task revisions', async () => {
  const held = deferred(), oldRow = task(), newer = task({ state: 'running', revision: 2, started: true });
  const h = setup((operation, input) => operation === 'frame.task.get' ? newer : input.cursor ? held.promise : page([oldRow], 'older-page'));
  await h.controller.refreshTasks(); const older = h.controller.loadMoreTasks(); await h.controller.readTask(taskId);
  await h.controller.refreshTasks(); assert.equal(h.controller.getState().tasks[0].revision, 2); assert.equal(h.controller.getState().pageTrail.length, 0);
  held.resolve(page([task({ id: '00000000-0000-4000-8000-000000000080', requestId: 'late-old-page-key', state: 'cancelled_before_start', revision: 2 })])); await older;
  assert.equal(h.controller.getState().tasks.length, 1); assert.equal(h.controller.getState().tasks[0].revision, 2); assert.equal(h.controller.getState().pageCursor, null);
  h.configure({ projectId: otherProject, sourceScope: 'new-project', sourceAsset: { ...asset, projectId: otherProject } }); assert.equal(h.controller.getState().tasks.length, 0); assert.deepEqual(h.controller.getState().pageTrail, []);
});

test('page trail reaches all 256 retained tasks in 13 bounded pages and supports newer-page navigation', async () => {
  const records = Array.from({ length: 256 }, (_, i) => task({ id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`, requestId: `retained-request-${i}`, state: 'cancelled_before_start', revision: 2 }));
  const h = setup((_operation, input) => { const start = input.cursor ? Number(input.cursor.split('-')[1]) : 0; return page(records.slice(start, start + 20), start + 20 < records.length ? `page-${start + 20}` : null); });
  await h.controller.refreshTasks(); for (let i = 0; i < 12; i++) { await h.controller.loadMoreTasks(); assert.ok(h.controller.getState().tasks.length <= 50); assert.ok(h.controller.getState().pageTrail.length <= 12); }
  assert.equal(h.calls.length, 13); assert.equal(h.controller.getState().tasks.length, 16); assert.equal(h.controller.getState().nextCursor, null); await h.controller.loadMoreTasks(); assert.equal(h.calls.length, 13);
  await h.controller.previousTasks(); assert.equal(h.controller.getState().pageTrail.length, 11); assert.equal(h.controller.getState().tasks[0].id, records[220].id);
});

test('interrupted and local-result errors retain old tasks but permit a new explicit capture key after review', async () => {
  for (const state of ['interrupted', 'local_result_error']) {
    const original = task({ requestId: 'older-source-capture-key', state, revision: 3, started: true, errorCode: 'FRAME_RESULT_INVALID' });
    const fresh = task({ id: '00000000-0000-4000-8000-000000000081', requestId: 'new-explicit-capture-key' });
    const h = setup(operation => operation === 'frame.task.list' ? page([original]) : fresh, { createRequestId: () => fresh.requestId });
    await h.controller.refreshTasks(); assert.equal(h.calls.length, 1); await h.controller.capture(intent);
    assert.equal(h.calls.filter(call => call.operation === 'frame.extract').length, 1); assert.equal(h.calls[1].input.requestId, fresh.requestId); assert.equal(h.calls.filter(call => call.operation === 'frame.task.recoverResult').length, 0);
    assert.ok(h.controller.getState().tasks.some(item => item.id === original.id && item.state === state)); assert.ok(h.controller.getState().tasks.some(item => item.id === fresh.id));
  }
});
