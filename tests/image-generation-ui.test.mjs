import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createHash } from 'node:crypto';
import { canonicalImageInput } from '../packages/contracts/src/images.mjs';
import { ApiError } from '../apps/web/src/api.js';
import * as imageLogic from '../apps/web/src/image-generation.js';
import { IMAGE_LIMITS } from '../packages/contracts/src/images.mjs';
import { DEFAULT_IMAGE_CONFIGURATION } from '../packages/contracts/src/image-settings.mjs';
import { IMAGE_REVIEW_DESTINATION, IMAGE_REVIEW_POLICY } from '../packages/contracts/src/image-reviews.mjs';
import { IMAGE_FIXED_OPTIONS, IMAGE_MODELS, createImageGenerationSession, imageCanGenerate, imageDraftDirty, imageInputIssue, imageTaskLabel } from '../apps/web/src/image-generation.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), groupId = id(2), taskId = id(3), requestId = id(4), versionId = id(5), assetId = id(6);
const at = '2026-10-10T10:00:00.000Z';
const settings = (patch = {}) => ({ revision: 1, configuration: { ...DEFAULT_IMAGE_CONFIGURATION, enabled: true }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, ...patch });
const paidInput = (patch = {}) => ({ projectId, name: '原始图像', prompt: '  原始描述\n不要改写。  ', providerId: 'openai', model: IMAGE_MODELS.openai, options: { ...IMAGE_FIXED_OPTIONS }, requestId: id(60), ...patch });
const review = (input = paidInput(), patch = {}) => ({ id: id(70), projectId: input.projectId, requestId: input.requestId, input, inputHash: createHash('sha256').update(canonicalImageInput(input)).digest('hex'), settingsRevision: 1, destination: IMAGE_REVIEW_DESTINATION, policy: { ...IMAGE_REVIEW_POLICY }, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null, ...patch });
const task = (patch = {}) => ({ id: taskId, projectId, groupId, requestId, name: '测试图像', prompt: '清晨的山间小屋', providerId: 'mock', model: IMAGE_MODELS.mock, options: { ...IMAGE_FIXED_OPTIONS }, state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const group = (patch = {}) => ({ id: groupId, projectId, name: '测试图像', revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at, ...patch });
const version = (patch = {}) => ({ id: versionId, projectId, groupId, taskId, number: 1, assetId, sha256: 'a'.repeat(64), mimeType: 'image/png', width: 1024, height: 1024, byteLength: 3400, isMock: true, providerId: 'mock', model: IMAGE_MODELS.mock, options: { ...IMAGE_FIXED_OPTIONS }, createdAt: at, ...patch });
const page = (items, nextCursor = null) => ({ projectId, items, nextCursor });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 120; n++) await Promise.resolve(); };
const error = (code = 'NETWORK', details) => new ApiError('NEVER SHOW private provider text', code, details, Boolean(details));
function memoryStorage() { const data = new Map(); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }; }
function fixture(options = {}) {
  const calls = [], privateCalls = [], changes = [], notifications = [], timers = new Map(), storage = options.storage || memoryStorage(); let sequence = 0, keys = 0;
  const data = { groups: options.groups || [], tasks: options.tasks || [], versions: options.versions || [], reviews: options.reviews || [], receipts: new Map() };
  function accept(input) {
    const result = task({ ...input, id: data.tasks.length ? id(30 + data.tasks.length) : taskId, groupId: input.groupId || groupId }); delete result.expectedRevision;
    data.tasks = [result, ...data.tasks]; data.groups = [group({ id: result.groupId, name: result.name, revision: input.expectedRevision ? input.expectedRevision + 1 : 1, activeTaskId: result.id })];
    data.receipts.set(input.requestId, { projectId, requestId: input.requestId, operation: 'image.generate', response: structuredClone(result) }); return result;
  }
  const api = async (operation, input) => {
    calls.push({ operation, input: structuredClone(input) });
    if (options.api) { const response = await options.api(operation, input, data); if (response !== undefined) return response; }
    if (operation === 'image.group.list') return page(data.groups.slice(0, input.limit));
    if (operation === 'image.group.get') return data.groups.find(item => item.id === input.groupId);
    if (operation === 'image.task.list') return page(data.tasks.filter(item => !input.groupId || item.groupId === input.groupId).slice(0, input.limit));
    if (operation === 'image.version.list') return page(data.versions.filter(item => item.groupId === input.groupId).slice(0, input.limit));
    if (operation === 'image.request.get') return data.receipts.get(input.requestId) || null;
    if (operation === 'image.task.get') return data.tasks.find(item => item.id === input.taskId);
    if (operation === 'image.review.prepare') { const result = review(input.input, { settingsRevision: input.settingsRevision }); data.reviews.unshift(result); return result; }
    if (operation === 'image.review.get') return data.reviews.find(item => item.id === input.reviewId);
    if (operation === 'image.review.list') return page(data.reviews.slice(0, input.limit));
    if (operation === 'image.generate') {
      return accept(input);
    }
    if (['image.task.cancelQueued', 'image.task.recoverResult'].includes(operation)) {
      const original = data.tasks.find(item => item.id === input.taskId), result = { ...original, state: operation.endsWith('cancelQueued') ? 'cancelled_before_dispatch' : 'persisting', revision: original.revision + 1 };
      data.tasks = [result]; data.groups = [group({ activeTaskId: operation.endsWith('cancelQueued') ? null : taskId })];
      data.receipts.set(input.requestId, { projectId, requestId: input.requestId, operation, response: structuredClone(result) }); return result;
    }
    throw error('UNSUPPORTED');
  };
  const reviewClient = { async approve(value) { privateCalls.push({ action: 'approve', review: structuredClone(value) }); if (options.approve) return options.approve(value, data, accept); const result = accept(value.input); data.reviews = data.reviews.map(item => item.id === value.id ? { ...item, state: 'approved', revision: 2, taskId: result.id, approvedAt: at } : item); return result; }, async reject(value) { privateCalls.push({ action: 'reject', review: structuredClone(value) }); if (options.reject) return options.reject(value, data); const result = { ...value, state: 'rejected', revision: 2, rejectedAt: at }; data.reviews = data.reviews.map(item => item.id === value.id ? result : item); return result; } };
  const settingsClient = { read: async () => options.settings || settings({ configuration: { ...DEFAULT_IMAGE_CONFIGURATION } }) };
  const session = createImageGenerationSession({ projectId, api, storage, reviewClient, settings: options.settings, requestId: () => { keys++; return keys === 1 && !data.tasks.some(item => item.requestId === requestId) ? requestId : id(40 + keys); }, onChange: next => changes.push(next), onGenerated: (...args) => notifications.push(args), setTimer: fn => { const key = ++sequence; timers.set(key, fn); return key; }, clearTimer: key => timers.delete(key), ...options.session });
  return { session, api, reviewClient, settingsClient, privateCalls, calls, data, storage, changes, notifications, timers, keyCount: () => keys, async tick() { const [key, fn] = timers.entries().next().value || []; if (!fn) return false; timers.delete(key); fn(); await flush(); return true; } };
}
async function ready(f) { await f.session.load(); f.session.edit('name', '测试图像'); f.session.edit('prompt', '清晨的山间小屋'); }
const mutations = f => f.calls.filter(call => ['image.generate', 'image.task.cancelQueued', 'image.task.recoverResult'].includes(call.operation));

test('fixed Mock intent is persisted and verified before one explicit dispatch', async () => {
  const storage = memoryStorage(); let savedBeforeDispatch = false;
  const f = fixture({ storage, api: (operation, input) => { if (operation === 'image.generate') savedBeforeDispatch = [...storage.data.values()].some(value => JSON.parse(value).input.requestId === input.requestId); } });
  await ready(f); assert.equal(imageCanGenerate(f.session.getState()), true); assert.equal(await f.session.generate(), true);
  assert.equal(savedBeforeDispatch, true); assert.equal(mutations(f).length, 1);
  assert.deepEqual(mutations(f)[0].input, { projectId, name: '测试图像', prompt: '清晨的山间小屋', providerId: 'mock', model: IMAGE_MODELS.mock, options: IMAGE_FIXED_OPTIONS, requestId });
  assert.equal(f.storage.data.size, 0); assert.equal(imageDraftDirty(f.session.getState()), false); f.session.dispose();
});

test('storage failure and silent storage discard fail before dispatch', async () => {
  for (const setItem of [() => { throw error(); }, () => {}]) {
    const f = fixture({ storage: { getItem: () => null, setItem, removeItem() {} } }); await ready(f);
    assert.equal(await f.session.generate(), false); assert.equal(mutations(f).length, 0); assert.match(f.session.getState().message, /尚未发送/); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); f.session.dispose();
  }
});

test('lost acknowledgement remains unknown across renderer recreation and null lookup never resends', async () => {
  const storage = memoryStorage(), f = fixture({ storage, api: operation => { if (operation === 'image.generate') throw error(); } });
  await ready(f); await f.session.generate(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(await f.session.generate(), false); f.session.dispose();
  const g = fixture({ storage }); await g.session.load(); assert.equal(g.session.getState().pending.input.requestId, requestId); assert.equal(await g.session.generate(), false); assert.equal(g.keyCount(), 0); assert.equal(mutations(g).length, 0); assert.match(g.session.getState().message, /不能证明/); g.session.dispose();
});

test('historical receipt is followed by authoritative task get and never downgrades current success', async () => {
  const f = fixture({ api: (operation, input, data) => { if (operation === 'image.generate') { data.groups = [group({ activeTaskId: null, headVersionId: versionId })]; data.tasks = [task({ state: 'succeeded', dispatched: true, revision: 4, versionId })]; data.versions = [version()]; data.receipts.set(input.requestId, { projectId, requestId, operation, response: task() }); throw error(); } } });
  await ready(f); await f.session.generate(); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().tasks[0].revision, 4); assert.equal(f.session.getState().versions[0].assetId, assetId); assert.equal(f.notifications.length, 1); assert.equal(mutations(f).length, 1);
  const requestIndex = f.calls.findIndex(call => call.operation === 'image.request.get'); assert.equal(f.calls[requestIndex + 1].operation, 'image.task.get'); await f.session.load(); assert.equal(f.notifications.length, 1); f.session.dispose();
});

test('forged receipt operation, scope, payload or regressed task cannot clear pending', async () => {
  for (const mismatch of ['operation', 'scope', 'payload', 'task']) {
    const f = fixture({ api: (operation, input, data) => {
      if (operation === 'image.generate') { data.tasks = [task()]; throw error(); }
      if (operation === 'image.request.get') return { projectId: mismatch === 'scope' ? id(99) : projectId, requestId, operation: mismatch === 'operation' ? 'image.task.cancelQueued' : 'image.generate', response: task({ ...(mismatch === 'payload' ? { prompt: 'Changed input' } : {}) }) };
      if (operation === 'image.task.get' && mismatch === 'task') return task({ id: id(99) });
    } }); await ready(f); await f.session.generate(); assert.notEqual(f.session.getState().pending, null, mismatch); assert.equal(f.storage.data.size, 1); assert.equal(mutations(f).length, 1); f.session.dispose();
  }
});

test('only an exact operation, project, request and input-hash rejection proof releases the intent', async () => {
  for (const mismatch of [null, 'operation', 'projectId', 'requestId', 'inputHash']) {
    const f = fixture({ api: (operation, input) => {
      if (operation !== 'image.generate') return;
      const proof = { status: 'not_accepted', projectId, operation, requestId: input.requestId, inputHash: createHash('sha256').update(canonicalImageInput(input)).digest('hex') };
      if (mismatch) proof[mismatch] = mismatch === 'inputHash' ? '0'.repeat(64) : 'wrong-owner';
      throw error('IMAGE_GROUP_BUSY', { imageOutcome: proof });
    } }); await ready(f); await f.session.generate(); assert.equal(Boolean(f.session.getState().pending), Boolean(mismatch), String(mismatch)); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(mutations(f).length, 1); assert.doesNotMatch(f.session.getState().message, /private provider/); f.session.dispose();
  }
});

test('timed out submission retains exact request and never automatically retries', async () => {
  const held = deferred(), f = fixture({ api: operation => operation === 'image.generate' ? held.promise : undefined, session: { timeoutMs: 10 } }); await ready(f); await f.session.generate();
  assert.equal(f.session.getState().pending.input.requestId, requestId); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(mutations(f).length, 1); held.resolve(task()); await flush(); assert.equal(f.session.getState().phase, 'unknown'); f.session.dispose();
});

test('507 capacity proof clears a rejected intent while arbitrary server errors stay unknown', async () => {
  for (const code of ['IMAGE_CAPACITY', 'UNKNOWN_SERVER_FAILURE']) {
    const f = fixture({ api: (operation, input) => {
      if (operation !== 'image.generate') return;
      throw new ApiError('private server error', code, { imageOutcome: { status: 'not_accepted', projectId, operation, requestId, inputHash: createHash('sha256').update(canonicalImageInput(input)).digest('hex') } }, false);
    } }); await ready(f); await f.session.generate(); assert.equal(Boolean(f.session.getState().pending), code !== 'IMAGE_CAPACITY'); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(mutations(f).length, 1); f.session.dispose();
  }
});

test('late read and acknowledgement from disposed project cannot change state, receipt or callbacks', async () => {
  const held = deferred(), f = fixture({ api: operation => operation === 'image.generate' ? held.promise : undefined }); await ready(f); const sending = f.session.generate(); await flush(); const count = f.changes.length;
  f.session.dispose(); const stored = [...f.storage.data.values()][0]; held.resolve(task()); await sending;
  assert.equal(f.changes.length, count); assert.equal([...f.storage.data.values()][0], stored); assert.equal(f.notifications.length, 0);
  const reading = deferred(), g = fixture({ api: operation => operation === 'image.group.list' ? reading.promise : undefined }); const loading = g.session.load(); g.session.dispose(); reading.resolve(page([group()])); await loading; assert.equal(g.session.getState().groups.length, 0);
});

test('double click dispatches once, hidden panels keep draft and only visible reads poll with bounded budget', async () => {
  const held = deferred(), f = fixture({ api: operation => operation === 'image.generate' ? held.promise : undefined }); await ready(f); const sending = f.session.generate(); assert.equal(await f.session.generate(), false); await flush(); assert.equal(mutations(f).length, 1); f.session.setVisible(false); held.resolve(task()); await sending; assert.equal(f.timers.size, 0); f.session.dispose();
  const g = fixture({ groups: [group()], tasks: [task()], session: { pollLimit: 2 } }); await ready(g); g.session.setVisible(false); assert.equal(g.session.getState().draft.prompt, '清晨的山间小屋'); assert.equal(await g.session.generate(), false); assert.equal(g.timers.size, 0);
  g.session.setVisible(true); await flush(); assert.equal(await g.tick(), true); assert.equal(await g.tick(), true); assert.equal(g.timers.size, 0); assert.equal(g.session.getState().pollPaused, true); assert.equal(mutations(g).length, 0); g.session.dispose();
});

test('interrupted and queued tasks cancel explicitly; local-result recovery never calls generate', async () => {
  for (const state of ['queued', 'interrupted_before_dispatch']) {
    const f = fixture({ groups: [group()], tasks: [task({ state })] }); await f.session.load(); const saved = f.session.getState().tasks[0]; await f.session.act('cancelQueued', saved); assert.equal(f.session.getState().tasks[0].state, 'cancelled_before_dispatch'); assert.equal(mutations(f)[0].operation, 'image.task.cancelQueued'); assert.equal(await f.session.act('cancelQueued', saved), false); f.session.dispose();
  }
  const g = fixture({ groups: [group()], tasks: [task({ state: 'local_result_error', dispatched: true, revision: 3 })] }); await g.session.load(); await g.session.act('recoverResult', g.session.getState().tasks[0]); assert.equal(mutations(g)[0].operation, 'image.task.recoverResult'); assert.equal(g.session.getState().tasks[0].state, 'persisting'); assert.equal(mutations(g).length, 1); g.session.dispose();
  const h = fixture({ groups: [group()], tasks: [task({ state: 'outcome_unknown', dispatched: true })] }); await h.session.load(); assert.equal(await h.session.act('cancelQueued', h.session.getState().tasks[0]), false); assert.equal(mutations(h).length, 0); await h.session.act('recoverResult', h.session.getState().tasks[0]); assert.equal(mutations(h).length, 1); assert.equal(mutations(h)[0].operation, 'image.task.recoverResult'); h.session.dispose();
});

test('new-version target requires explicit draft discard, preserves immutable name and binds base revision', async () => {
  const f = fixture({ groups: [group({ activeTaskId: null, revision: 7, headVersionId: versionId })], tasks: [task({ state: 'succeeded', dispatched: true, revision: 4, versionId })], versions: [version()] }); await ready(f);
  await f.session.requestTarget(groupId); assert.equal(f.session.getState().target, null); assert.deepEqual(f.session.getState().targetRequest, { groupId }); f.session.keepDraft(); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋');
  await f.session.requestTarget(groupId); await f.session.confirmTarget(); assert.deepEqual(f.session.getState().target, { groupId, expectedRevision: 7 }); assert.equal(f.session.edit('name', 'Renamed'), false); assert.equal(f.session.edit('prompt', '第二张图像'), true); assert.equal(mutations(f).length, 0);
  await f.session.generate(); const input = mutations(f)[0].input; assert.equal(input.groupId, groupId); assert.equal(input.expectedRevision, 7); assert.equal(input.name, '测试图像'); assert.equal(input.prompt, '第二张图像'); f.session.dispose();
});

test('accepted group omitted from first page is resolved by identity and remains selected with its task', async () => {
  const unrelated = group({ id: id(80), name: 'Unrelated', activeTaskId: null });
  const f = fixture({ api: (operation, input, data) => { if (operation === 'image.group.list' && data.tasks.length) return page([unrelated]); } }); await ready(f); await f.session.generate();
  assert.equal(f.session.getState().selectedGroupId, groupId); assert.equal(f.session.getState().tasks[0].id, taskId); assert.ok(f.calls.some(call => call.operation === 'image.group.get' && call.input.groupId === groupId)); assert.equal(f.timers.size, 1); f.session.dispose();
});

test('same-project stale list cannot downgrade a newer mutation acknowledgement', async () => {
  const held = deferred(); let hold = false;
  const f = fixture({ api: operation => operation === 'image.group.list' && hold ? held.promise : undefined }); await ready(f); hold = true; const reading = f.session.load(); await flush(); const generating = f.session.generate(); await flush(); hold = false; held.resolve(page([])); await reading; await generating;
  assert.equal(mutations(f).length, 1); assert.equal(f.session.getState().tasks[0].id, taskId); f.session.dispose();
});

test('completion is observed before rereading current group and immutable result page', async () => {
  const f = fixture({ groups: [group({ activeTaskId: null, headVersionId: versionId, revision: 2 })], tasks: [task({ state: 'succeeded', dispatched: true, revision: 4, versionId })], versions: [version()], api: operation => operation === 'image.group.list' ? page([group()]) : undefined });
  await f.session.load(); assert.equal(f.session.getState().groups[0].activeTaskId, null); assert.equal(f.session.getState().groups[0].revision, 2); assert.equal(f.session.getState().versions[0].id, versionId);
  const names = f.calls.map(call => call.operation); assert.ok(names.indexOf('image.task.list') < names.indexOf('image.group.get')); assert.ok(names.indexOf('image.group.get') < names.indexOf('image.version.list')); f.session.dispose();
});

test('actual library reveal respects newer project, navigation and panel choices while refresh is pending', async () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('  async function revealImageAsset('), end = app.indexOf('  async function selectProject(', start);
  assert.ok(start > 0 && end > start); const source = app.slice(start, end).trim();
  for (const changed of [null, 'projectEpoch', 'navigationEpoch', 'panelIntent', 'currentProject']) {
    const held = deferred(), calls = [];
    const env = { currentProject: { current: projectId }, projectEpoch: { current: 1 }, navigationEpoch: { current: 1 }, panelIntent: { current: 1 }, dataRef: { current: { assets: [] } }, refresh: () => held.promise, updateView: (...args) => calls.push(['view', ...args]), setPanelOpen: (...args) => calls.push(['panel', ...args]), setMobilePanel: value => calls.push(['mobile', value]) };
    const reveal = Function(...Object.keys(env), `return (${source});`)(...Object.values(env));
    const reading = reveal(assetId, projectId); if (changed) env[changed].current = changed === 'currentProject' ? id(90) : 2;
    held.resolve({ assets: [{ id: assetId, name: 'Saved image' }] }); await reading;
    assert.equal(calls.length, changed ? 0 : 3, String(changed));
    if (!changed) assert.deepEqual(calls[0], ['view', 'shared', { assetSearch: 'Saved image', assetFilter: 'all' }]);
  }
  assert.match(app, /\['properties', 'agent', 'image', 'delivery'\]\.includes\(value\)\) \{ markPanelIntent\(\); setRightDockTab\(value\); \}/);
  assert.doesNotMatch(source, /node\.create|setPreviewAsset|image\.generate/);
  assert.doesNotThrow(() => transformSync(app, { loader: 'jsx', format: 'esm' }));
});

test('input limits match contract and state copy distinguishes unknown, failure, cancellation and local failure', () => {
  assert.equal(imageInputIssue({ name: '有效', prompt: '正常\n\t内容' }), '');
  for (const prompt of [' ', 'x'.repeat(2001), 'x\u0000y']) assert.notEqual(imageInputIssue({ name: '有效', prompt }), '');
  assert.equal(new Set(['outcome_unknown', 'failed', 'cancelled_before_dispatch', 'local_result_error', 'interrupted_before_dispatch'].map(imageTaskLabel)).size, 5);
});

test('renderer remains an extracted dock with explicit providers, fixed paid disclosure and local previews', () => {
  const source = readFileSync(new URL('../apps/web/src/ImageGeneration.jsx', import.meta.url), 'utf8');
  assert.doesNotThrow(() => transformSync(source, { loader: 'jsx', format: 'esm' }));
  for (const text of ['useWorkspaceVisibility', 'image-provider-openai', '真实调用尚未验证', '确定性测试图案', '未加密', 'image-paid-warning', 'image-review-approve', 'image-review-reject', 'image-draft-guard', 'image-edit-version', 'image-version-preview', 'image-reveal-asset', 'image-cancel-queued', 'image-recover-result']) assert.ok(source.includes(text), text);
  assert.match(source, /composerVisible \? `\/media\/\$\{encodeURIComponent\(version.assetId\)\}` : undefined/);
  assert.doesNotMatch(source, /type="password"|Dialog|dangerouslySetInnerHTML|node\.create|shot\.attach/);
  assert.match(source, /disabled=\{busy \|\| Boolean\(state.target\)\}/);
});

const componentSource = readFileSync(new URL('../apps/web/src/ImageGeneration.jsx', import.meta.url), 'utf8');
const element = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const depsEqual = (left, right) => Boolean(left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index])));
function renderer(f) {
  const slots = []; let index = 0, effects = [], visible = true, tree, currentProject = projectId, dirty = false;
  const react = {
    createElement: element,
    useState(initial) { const slot = index++; slots[slot] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[slot].value, value => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; }]; },
    useRef(initial) { return slots[index++] ||= { current: initial }; },
    useMemo(callback, deps) { const slot = index++; if (!slots[slot] || !depsEqual(deps, slots[slot].deps)) slots[slot] = { value: callback(), deps }; return slots[slot].value; },
    useLayoutEffect(callback, deps) { const slot = index++, old = slots[slot]; if (old && depsEqual(deps, old.deps)) return; slots[slot] = { callback, deps, cleanup: old?.cleanup }; effects.push(slot); },
  }; react.default = react;
  const primitive = new Proxy({}, { get: (_, key) => String(key) }), module = { exports: {} };
  const require = name => {
    if (name === 'react') return react;
    if (name === '@mioon/contracts') return { IMAGE_LIMITS };
    if (name === './image-generation.js') return { ...imageLogic, createImageGenerationSession: options => createImageGenerationSession({ ...options, api: f.api, storage: f.storage, requestId: () => requestId, setTimer: () => 1, clearTimer() {} }) };
    if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => visible };
    if (name === './ImageSettings.jsx') return { __esModule: true, default: 'ImageSettings' };
    if (name === './image-settings.js') return { createImageSettingsClient: () => f.settingsClient };
    if (name === './icons.jsx') return { default: 'Icon' };
    if (name === './image-generation.css') return {};
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.jsx') return primitive;
    throw Error(name);
  };
  Function('module', 'exports', 'require', transformSync(componentSource, { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, require);
  const harness = {
    render(owner = currentProject) { currentProject = owner; index = 0; effects = []; tree = module.exports.default({ projectId: owner, projectName: 'Test project', reviewClient: f.reviewClient, settingsClient: f.settingsClient, onDirtyChange: value => { dirty = value; } }); for (const slot of effects) { slots[slot].cleanup?.(); slots[slot].cleanup = slots[slot].callback(); } return tree; },
    find(id) { return nodes(tree).find(node => node.props['data-testid'] === id); },
    form() { return nodes(tree).find(node => node.type === 'form'); },
    change(id, value) { harness.find(id).props.onChange({ target: { value } }); harness.render(); },
    click(id) { harness.find(id).props.onClick?.(); harness.render(); },
    settings() { return nodes(tree).find(node => node.type === 'ImageSettings'); },
    show(value) { visible = value; harness.render(); },
    get dirty() { return dirty; },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  }; return harness;
}

test('actual composer keeps draft across hidden tabs and invalidates old edit/submit handlers after reveal', async () => {
  const f = fixture(), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', '保留名称'); ui.change('image-generation-prompt', '保留描述'); assert.equal(ui.dirty, true);
  const edit = ui.find('image-generation-prompt').props.onChange, submit = ui.form().props.onSubmit;
  ui.show(false); assert.equal(ui.find('image-generation-page').props.inert, true); assert.equal(ui.find('image-generate').props.disabled, true); edit({ target: { value: '旧回调' } }); submit({ preventDefault() {} });
  ui.show(true); await flush(); ui.render(); edit({ target: { value: '仍是旧回调' } }); submit({ preventDefault() {} }); ui.render(); assert.equal(ui.find('image-generation-prompt').props.value, '保留描述'); assert.equal(mutations(f).length, 0); ui.unmount(); f.session.dispose();
});

test('actual composer fences project navigation and current submit uses only typed image fields', async () => {
  const f = fixture(), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', '测试图像'); ui.change('image-generation-prompt', '清晨的山间小屋');
  const oldEdit = ui.find('image-generation-prompt').props.onChange, oldSubmit = ui.form().props.onSubmit; oldSubmit({ preventDefault() {} }); await flush(); ui.render(); assert.equal(mutations(f).length, 1);
  ui.render(id(90)); await flush(); ui.render(); oldEdit({ target: { value: 'Wrong project' } }); oldSubmit({ preventDefault() {} }); ui.render(); assert.equal(ui.find('image-generation-prompt').props.value, ''); assert.equal(ui.find('image-generation-page').props['data-project-id'], id(90)); assert.equal(mutations(f).length, 1); ui.unmount(); f.session.dispose();
});

test('paid generation saves the exact visible prompt before preparation and sends only one private approval', async () => {
  const f = fixture({ settings: settings(), api: (operation, input) => { if (operation === 'image.review.prepare') { const saved = JSON.parse([...f.storage.data.values()][0]); assert.deepEqual(saved.input, input.input); assert.equal(saved.approvalAttempted, false); } }, approve: (value, data, accept) => { const saved = JSON.parse([...f.storage.data.values()][0]); assert.equal(saved.approvalAttempted, true); assert.equal(saved.reviewId, value.id); return accept(value.input); } });
  await ready(f); f.session.edit('prompt', '  光线\n原文，不优化。  '); f.session.selectProvider('openai');
  assert.equal(await f.session.generate(), false); assert.equal(await f.session.generatePaid(), true);
  assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.input.prompt, '  光线\n原文，不优化。  '); assert.equal(f.privateCalls[0].review.settingsRevision, 1);
  assert.equal(mutations(f).length, 0); assert.equal(f.calls.filter(call => call.operation === 'image.review.prepare').length, 1); assert.equal(f.storage.data.size, 0); f.session.dispose();
});

test('hide and reveal during preparation never auto-approves; explicit approval uses the original review', async () => {
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } } });
  await ready(f); f.session.selectProvider('openai'); const sending = f.session.generatePaid(); await flush(); f.session.setVisible(false); f.session.setVisible(true); held.resolve(original); await sending;
  assert.equal(f.privateCalls.length, 0); assert.equal(f.session.getState().pending.approvalAttempted, false); assert.equal(f.session.edit('prompt', 'changed'), false);
  await f.session.load(); assert.equal(f.privateCalls.length, 0); assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true); assert.equal(f.privateCalls.length, 1); assert.deepEqual(f.privateCalls[0].review.input, original.input); f.session.dispose();
});

test('configuration changes during preparation keep original review stale and cannot authorize a new configuration', async () => {
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } } });
  await ready(f); f.session.selectProvider('openai'); const sending = f.session.generatePaid(); await flush(); f.session.setSettings(settings({ revision: 2 })); held.resolve(original); await sending;
  assert.equal(f.privateCalls.length, 0); assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), false); assert.equal(f.session.getState().pending.settingsRevision, 1);
  await f.session.rejectReview(f.session.getState().reviews[0]); assert.equal(f.privateCalls[0].action, 'reject'); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().draft.prompt, '清晨的山间小屋'); f.session.dispose();
});

test('a changed prepared prompt, provider, destination or settings revision is never privately approved', async () => {
  for (const patch of [{ input: paidInput({ prompt: 'forged' }) }, { destination: 'https://other.example.com' }, { settingsRevision: 2 }]) {
    const f = fixture({ settings: settings(), api: (operation, input) => operation === 'image.review.prepare' ? review(input.input, patch) : undefined }); await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid(); assert.equal(f.privateCalls.length, 0); assert.ok(f.session.getState().pending); f.session.dispose();
  }
});

test('lost paid acknowledgement recovers original task receipt without another approval or generation', async () => {
  const f = fixture({ settings: settings(), approve: (value, data, accept) => { accept(value.input); throw error(); } }); await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid();
  assert.equal(f.session.getState().pending, null); assert.equal(f.privateCalls.length, 1); assert.equal(mutations(f).length, 0); assert.equal(f.session.getState().tasks[0].providerId, 'openai'); await f.session.load(); assert.equal(f.privateCalls.length, 1); f.session.dispose();
});

test('lost approval with no receipt is retained across restart and never repeated by reads', async () => {
  const f = fixture({ settings: settings(), approve: () => { throw error(); } }); await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid(); const pending = f.session.getState().pending, original = f.data.reviews[0]; assert.equal(pending.approvalAttempted, true); f.session.dispose();
  const g = fixture({ settings: settings(), storage: f.storage, reviews: [original] }); await g.session.load(); g.session.setVisible(false); g.session.setVisible(true); await flush(); await g.session.load(); assert.equal(g.privateCalls.length, 0); assert.equal(g.calls.some(call => call.operation === 'image.review.prepare'), false); assert.equal(await g.session.generatePaid(), false); assert.equal(g.keyCount(), 0); assert.deepEqual(g.session.getState().pending.input, pending.input); g.session.dispose();
});

test('external review approval preserves separate composer draft and rejection never generates', async () => {
  const original = review(), f = fixture({ settings: settings(), reviews: [original] }); await ready(f); const draft = f.session.getState().draft;
  assert.equal(await f.session.approveReview(f.session.getState().reviews[0]), true); assert.deepEqual(f.privateCalls[0].review.input, original.input); assert.deepEqual(f.session.getState().draft, draft); assert.equal(mutations(f).length, 0); f.session.dispose();
  const g = fixture({ settings: settings(), reviews: [original] }); await g.session.load(); await g.session.rejectReview(g.session.getState().reviews[0]); assert.deepEqual(g.privateCalls.map(call => call.action), ['reject']); assert.equal(g.session.getState().reviews[0].state, 'rejected'); assert.equal(g.data.tasks.length, 0); assert.equal(g.storage.data.size, 0); g.session.dispose();
});

test('double approval, late project completion and settings-read outage remain safe', async () => {
  const held = deferred(), original = review(), f = fixture({ settings: settings(), reviews: [original], approve: () => held.promise }); await f.session.load(); const approving = f.session.approveReview(original); assert.equal(await f.session.approveReview(original), false); assert.equal(f.privateCalls.length, 1); f.session.dispose(); const stored = [...f.storage.data.values()][0]; held.resolve(task({ ...original.input })); await approving; assert.equal([...f.storage.data.values()][0], stored);
  const g = fixture({ session: { settingsReader: async () => { throw error(); } } }); await ready(g); assert.equal(imageCanGenerate(g.session.getState()), true); await g.session.generate(); assert.equal(mutations(g).length, 1); g.session.dispose();
});

test('actual paid button is the only composer action authorizing payment; settings navigation retains draft', async () => {
  const f = fixture({ settings: settings() }), ui = renderer(f); ui.render(); await flush(); ui.render(); ui.change('image-generation-name', 'Visible title'); ui.change('image-generation-prompt', '  Exact visible prompt  '); ui.click('image-provider-openai');
  assert.equal(ui.find('image-generate').props.type, 'button'); ui.form().props.onSubmit({ preventDefault() {} }); ui.find('image-generation-prompt').props.onKeyDown({ ctrlKey: true, key: 'Enter', preventDefault() {} }); await flush(); assert.equal(f.privateCalls.length, 0);
  const oldPaid = ui.find('image-generate').props.onClick; ui.click('image-settings-open'); oldPaid(); assert.equal(ui.settings().props.active, true); ui.settings().props.onClose(); ui.render(); await flush(); ui.render(); oldPaid(); assert.equal(f.privateCalls.length, 0); assert.equal(ui.find('image-generation-prompt').props.value, '  Exact visible prompt  ');
  ui.click('image-generate'); await flush(); ui.render(); assert.equal(f.privateCalls.length, 1); assert.equal(f.privateCalls[0].review.input.prompt, '  Exact visible prompt  '); ui.unmount(); f.session.dispose();
});

test('exact pending review stays visible when omitted from the current review page', async () => {
  const held = deferred(); let original;
  const f = fixture({ settings: settings(), api: (operation, input, data) => { if (operation === 'image.review.prepare') { original = review(input.input); data.reviews = [original]; return held.promise; } if (operation === 'image.review.list') return page([]); } });
  await ready(f); f.session.selectProvider('openai'); const preparing = f.session.generatePaid(); await flush(); f.session.setVisible(false); held.resolve(original); await preparing; f.session.setVisible(true); await flush(); await f.session.load();
  assert.equal(f.session.getState().reviews.length, 1); assert.equal(f.session.getState().reviews[0].id, original.id); assert.equal(f.privateCalls.length, 0); f.session.dispose();
});

test('valid-shaped altered rejection acknowledgement cannot release an uncertain original request', async () => {
  const f = fixture({ settings: settings(), approve: () => { throw error(); }, reject: value => review({ ...value.input, prompt: 'Changed' }, { id: value.id, state: 'rejected', revision: 2, rejectedAt: at }) });
  await ready(f); f.session.selectProvider('openai'); await f.session.generatePaid(); const pending = f.session.getState().pending;
  assert.equal(await f.session.rejectReview(f.session.getState().reviews[0]), false); assert.deepEqual(f.session.getState().pending, pending); assert.equal(f.storage.data.size, 1); assert.equal(f.session.getState().reviews[0].state, 'pending'); f.session.dispose();
});
