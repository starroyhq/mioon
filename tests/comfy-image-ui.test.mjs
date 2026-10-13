import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as navigation from '../apps/web/src/settings-navigation-state.ts';
import { COMFY_IMAGE_OPTIONS, COMFY_IMAGE_POLICY, DEFAULT_COMFY_IMAGE_CONFIGURATION, canonicalImageInput, isImageReviewResponse } from '@mioon/contracts';
import { buildComfyWorkflow, hashComfyWorkflow } from '../packages/business/src/comfy/workflow.mjs';
import { createComfyImageSettingsSession, createComfyImageSettingsClient, comfyImageSettingsCanSave } from '../apps/web/src/comfy-image-settings.js';
import { ApiError, rpc } from '../apps/web/src/api.js';
import { createComfyObservationSession, comfyCanObserve } from '../apps/web/src/comfy-image-observation.js';
import { createImageGenerationSession, imageCanGenerate, imageReviewCanApprove } from '../apps/web/src/image-generation.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), groupId = id(2), taskId = id(3), at = '2026-10-10T14:00:00.000Z';
const config = () => ({ ...structuredClone(DEFAULT_COMFY_IMAGE_CONFIGURATION), enabled: true, baseUrl: 'http://127.0.0.1:8188', model: 'installed.safetensors' });
const settings = (patch = {}) => ({ revision: 1, configuration: config(), readiness: { checked: true, checkedAt: at }, ...patch });
const check = (patch = {}) => ({ ok: true, baseUrl: 'http://127.0.0.1:8188', comfyVersion: '0.39.0', checkpoints: ['installed.safetensors', 'other.safetensors'], selectedCheckpointAvailable: true, nodeClasses: ['CheckpointLoaderSimple', 'EmptyLatentImage', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage'], ...patch });
const memory = () => { const values = new Map(); return { values, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }; };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };
const fail = code => Object.assign(new Error('DO_NOT_REFLECT_REMOTE_MESSAGE'), { code });
const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const input = () => ({ projectId, name: '本地图像', prompt: '  原始描述\n不改写  ', providerId: 'comfy-local', model: config().model, options: { ...COMFY_IMAGE_OPTIONS }, requestId: id(4) });
function execution(value = input()) { const seed = 87654, outputNonce = id(6), graph = buildComfyWorkflow({ prompt: value.prompt, checkpoint: value.model, seed, outputNonce }); return { workflowId: config().profileId, workflowVersion: 1, comfyVersion: '0.39.0', seed, promptId: id(7), clientId: id(8), outputNonce, filenamePrefix: `mioon_${outputNonce}`, graph, graphHash: hashComfyWorkflow(graph) }; }
function review(value = input()) { return { id: id(5), projectId, requestId: value.requestId, input: value, inputHash: createHash('sha256').update(canonicalImageInput(value)).digest('hex'), settingsRevision: 1, destination: `${config().baseUrl}/prompt`, configuration: config(), execution: execution(value), policy: { ...COMFY_IMAGE_POLICY }, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null }; }
const task = (patch = {}) => ({ ...input(), id: taskId, groupId, state: 'outcome_unknown', revision: 4, dispatched: true, versionId: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const remote = (patch = {}) => { const { graph, ...identity } = execution(); return { ...identity, projectId, taskId, reviewId: id(5), baseUrl: config().baseUrl, state: 'submission_unknown', revision: 2, contentVerified: false, outputDescriptor: null, resultSha256: null, resultBytes: null, errorCode: null, createdAt: at, updatedAt: at, lastObservedAt: null, ...patch }; };
const remoteResponse = (patch = {}) => ({ projectId, taskId, remote: remote(), observation: null, ...patch });
const acknowledgement = value => ({ id: id(20), projectId, taskId, requestId: value.requestId, state: 'queued', revision: 1, remoteRevision: value.expectedRevision + 1, createdAt: at });

function settingsFixture(options = {}) {
  let current = options.current || settings(); const calls = [], changes = [];
  const client = { read: async () => { calls.push(['read']); return options.read ? options.read() : structuredClone(current); }, write: async value => { calls.push(['write', value]); if (options.write) return options.write(value); current = { ...current, revision: current.revision + 1, configuration: value.configuration }; return structuredClone(current); }, check: async value => { calls.push(['check', value]); return options.check ? options.check(value) : check({ baseUrl: value.baseUrl }); } };
  const session = createComfyImageSettingsSession({ client, onChange: state => changes.push(state) });
  return { session, client, calls, changes };
}

test('Comfy viewing/saving has no network probe or credential fields; explicit check populates bounded choices', async () => {
  const f = settingsFixture(); await f.session.load(); assert.deepEqual(f.calls.map(c => c[0]), ['read']);
  f.session.setEnabled(false); await f.session.save(); assert.deepEqual(f.calls.map(c => c[0]), ['read', 'write']); assert.deepEqual(Object.keys(f.calls[1][1]).sort(), ['configuration', 'expectedRevision']);
  f.session.setBaseUrl('http://[::1]:8188/'); assert.equal(f.session.getState().draft.model, ''); assert.equal(f.session.selectModel('invented.safetensors'), false);
  await f.session.checkConnection(); assert.deepEqual(f.calls[2], ['check', { baseUrl: 'http://[::1]:8188', model: '' }]); assert.equal(f.session.selectModel('other.safetensors'), true);
  f.session.setBaseUrl('http://127.0.0.1:8188'); assert.equal(f.session.getState().check, null); assert.equal(f.session.selectModel('other.safetensors'), false); assert.doesNotMatch(JSON.stringify(f.changes), /secret|storage|password/i); f.session.dispose();
});

test('Comfy blocks non-loopback checks and unknown check outputs, never probing on reopen', async () => {
  for (const baseUrl of ['http://localhost:8188', 'http://192.168.0.1:8188', 'https://127.0.0.1:8188', 'http://127.0.0.1:8188/api', 'http://u:p@127.0.0.1:8188', 'http://127.0.0.1']) {
    const f = settingsFixture(); await f.session.load(); f.session.setBaseUrl(baseUrl); assert.equal(await f.session.checkConnection(), false); assert.equal(f.calls.filter(c => c[0] === 'check').length, 0); f.session.dispose();
  }
  const f = settingsFixture({ check: () => check({ checkpoints: Array.from({ length: 257 }, (_, i) => `${i}.safetensors`) }) }); await f.session.load(); assert.equal(await f.session.checkConnection(), false); assert.equal(f.session.getState().check, null); await f.session.reload(); assert.equal(f.calls.filter(c => c[0] === 'check').length, 1); f.session.dispose();
});

test('Comfy CAS and unknown saves keep draft, require reconciliation, and never repeat a save/check', async () => {
  for (const code of ['COMFY_SETTINGS_CONFLICT', 'NETWORK']) {
    const f = settingsFixture({ write: () => { throw fail(code); } }); await f.session.load(); f.session.setEnabled(false); assert.equal(await f.session.save(), false); assert.equal(f.session.getState().phase, 'review'); assert.equal(f.session.getState().draft.enabled, false); assert.equal(comfyImageSettingsCanSave(f.session.getState()), false); assert.equal(await f.session.save(), false); assert.deepEqual(f.calls.map(c => c[0]), ['read', 'write', 'read']); assert.doesNotMatch(JSON.stringify(f.changes), /DO_NOT_REFLECT/); f.session.acknowledge(); assert.equal(comfyImageSettingsCanSave(f.session.getState()), true); f.session.dispose();
  }
  const f = settingsFixture({ write: () => { throw fail('COMFY_SETTINGS_VALIDATION'); } }); await f.session.load(); await f.session.save(); assert.equal(f.session.getState().phase, 'error'); assert.equal(f.session.getState().recovery, null); assert.deepEqual(f.calls.map(c => c[0]), ['read', 'write']); f.session.dispose();
});

test('Comfy double check, hidden controls and disposed response cannot trigger another action', async () => {
  const held = deferred(), f = settingsFixture({ check: () => held.promise }); await f.session.load(); const checking = f.session.checkConnection(); assert.equal(await f.session.checkConnection(), false); assert.equal(await f.session.save(), false); f.session.setVisible(false); assert.equal(f.session.setEnabled(false), false); const count = f.changes.length; f.session.dispose(); held.resolve(check()); await checking; assert.equal(f.changes.length, count); assert.equal(f.calls.filter(c => c[0] === 'check').length, 1);
});

test('Comfy settings transport uses dedicated local routes, preserves definite validation and strips server text', async () => {
  const calls = [], client = createComfyImageSettingsClient({ timeoutMs: 0, checkTimeoutMs: 0, fetchImpl: async (route, options) => { calls.push([route, options]); return { ok: route !== '/api/images/comfy-settings' || options.method === 'GET', status: 400, json: async () => options.method === 'PUT' ? { ok: false, error: { code: 'COMFY_SETTINGS_VALIDATION', message: 'DO_NOT_REFLECT' } } : { ok: true, data: route.endsWith('comfy-check') ? check() : settings() } }; } });
  await client.read(); await client.check({ baseUrl: config().baseUrl, model: config().model }); await assert.rejects(client.write({ expectedRevision: 1, configuration: config() }), error => error.code === 'COMFY_SETTINGS_VALIDATION' && !error.message.includes('DO_NOT_REFLECT'));
  assert.deepEqual(calls.map(([route, options]) => [route, options.method]), [['/api/images/comfy-settings', 'GET'], ['/api/images/comfy-check', 'POST'], ['/api/images/comfy-settings', 'PUT']]); assert.equal(calls[1][1].credentials, 'same-origin');
});

function generationFixture(options = {}) {
  const calls = [], approvals = [], storage = options.storage || memory(), timers = new Map(); let snapshot = settings(), key = 40, timer = 0;
  const data = { reviews: [], tasks: [], groups: [] };
  const page = items => ({ projectId, items, nextCursor: null });
  const api = async (operation, value) => { calls.push([operation, structuredClone(value)]); if (options.api) { const result = await options.api(operation, value, data); if (result !== undefined) return result; }
    if (operation === 'image.review.prepare') { const next = review(value.input); assert.equal(isImageReviewResponse(next), true); data.reviews = [next]; return next; }
    if (operation === 'image.review.list') return page(data.reviews);
    if (operation === 'image.review.get') return data.reviews.find(v => v.id === value.reviewId);
    if (operation === 'image.group.list') return page(data.groups);
    if (operation === 'image.group.get') return data.groups.find(v => v.id === value.groupId);
    if (operation === 'image.task.list') return page(data.tasks);
    if (operation === 'image.task.get') return data.tasks.find(v => v.id === value.taskId);
    if (operation === 'image.version.list') return page([]);
    if (operation === 'image.request.get') return null;
    if (operation === 'image.task.remote.get') return remoteResponse();
    throw fail('UNSUPPORTED');
  };
  const reviewClient = { approve: async value => { approvals.push(structuredClone(value)); const next = task({ ...value.input, state: 'queued', revision: 1, dispatched: false }); data.tasks = [next]; data.groups = [{ id: groupId, projectId, name: value.input.name, revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at }]; data.reviews = [{ ...value, state: 'approved', revision: 2, taskId, approvedAt: at }]; return next; } };
  const session = createImageGenerationSession({ projectId, api, storage, reviewClient, comfySettings: snapshot, comfySettingsReader: async () => snapshot, requestId: () => id(++key), setTimer: callback => { timers.set(++timer, callback); return timer; }, clearTimer: key => timers.delete(key) });
  return { session, api, reviewClient, calls, approvals, data, storage, timers, setSettings(next) { snapshot = next; session.setComfySettings(next); } };
}
async function prepare(f) { await f.session.load(); f.session.selectProvider('comfy-local'); f.session.edit('name', input().name); f.session.edit('prompt', input().prompt); return f.session.prepareComfy(); }

test('Comfy prepare freezes exact prompt, server seed and full graph but cannot automatically approve', async () => {
  const f = generationFixture(); assert.equal(await prepare(f), true); const state = f.session.getState(), saved = state.reviews[0];
  assert.equal(saved.input.prompt, input().prompt); assert.equal(saved.execution.graph['3'].inputs.text, input().prompt); assert.equal(state.pending.execution.seed, 87654); assert.deepEqual(state.pending.execution.graph, saved.execution.graph); assert.equal(f.approvals.length, 0);
  assert.equal(await f.session.generatePaid(), false); assert.equal(await f.session.generate(), false); await f.session.load(); assert.equal(f.approvals.length, 0); assert.equal(f.calls.filter(([op]) => op === 'image.review.prepare').length, 1);
  assert.equal(await f.session.approveReview(saved), true); assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].execution.graphHash, saved.execution.graphHash); assert.equal(f.calls.some(([op]) => op === 'image.generate' || op === 'image.task.observeRemote'), false); f.session.dispose();
});

test('Comfy readiness and saved configuration fence generation and stale review approval', async () => {
  const f = generationFixture(); await prepare(f); const saved = f.session.getState().reviews[0]; f.setSettings(settings({ readiness: { checked: false, checkedAt: null } })); assert.equal(imageReviewCanApprove(f.session.getState(), saved), false); assert.equal(await f.session.approveReview(saved), false);
  f.setSettings(settings({ revision: 2, configuration: { ...config(), baseUrl: 'http://[::1]:8188' } })); assert.equal(await f.session.approveReview(saved), false); assert.equal(f.approvals.length, 0); f.session.dispose();
  const g = generationFixture(); await g.session.load(); g.session.selectProvider('comfy-local'); g.session.edit('name', '名字'); g.session.edit('prompt', '描述'); g.setSettings(settings({ readiness: { checked: false, checkedAt: null } })); assert.equal(imageCanGenerate(g.session.getState()), false); assert.equal(await g.session.prepareComfy(), false); g.session.dispose();
});

test('Comfy hidden prepare completion stays review-only; saved workflow tampering cannot approve', async () => {
  const held = deferred(), f = generationFixture({ api: (operation, value, data) => { if (operation === 'image.review.prepare') { data.reviews = [review(value.input)]; return held.promise; } } }); const preparing = prepare(f); await flush(); f.session.setVisible(false); held.resolve(f.data.reviews[0]); await preparing; assert.equal(f.approvals.length, 0); f.session.setVisible(true); await flush();
  const saved = f.session.getState().reviews[0], changed = structuredClone(saved); changed.execution.seed++; assert.equal(await f.session.approveReview(changed), false); assert.equal(f.approvals.length, 0); f.session.dispose();
});

test('Comfy prepared intent survives recreation with same graph and never auto-prepares or approves', async () => {
  const f = generationFixture(); await prepare(f); const saved = f.session.getState().reviews[0], storage = f.storage; f.session.dispose(); const g = generationFixture({ storage }); g.data.reviews = [saved]; await g.session.load(); assert.equal(g.session.getState().storageBlocked, false); assert.deepEqual(g.session.getState().pending.execution, saved.execution); assert.equal(g.calls.some(([op]) => op === 'image.review.prepare' || op === 'image.generate'), false); assert.equal(g.approvals.length, 0); g.session.dispose();
});

function observationFixture(options = {}) { const calls = [], changes = [], storage = options.storage || memory(); let result = options.result || remoteResponse(); const call = async (operation, value) => { calls.push([operation, structuredClone(value)]); if (options.call) return options.call(operation, value); return operation === 'image.task.remote.get' ? structuredClone(result) : acknowledgement(value); }; const session = createComfyObservationSession({ projectId, call, storage, requestId: () => id(30), onChange: value => changes.push(value) }); return { session, calls, changes, storage, setResult(value) { result = value; } }; }

test('Comfy observation is a distinct explicit remote-CAS action; loading only reads local metadata', async () => {
  const f = observationFixture(); await f.session.read(taskId); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'image.task.remote.get'); assert.equal(comfyCanObserve(f.session.snapshot(), task()), true); assert.equal(await f.session.observe(task()), true); assert.deepEqual(f.calls[1], ['image.task.observeRemote', { projectId, taskId, expectedRevision: 2, requestId: id(30) }]); assert.equal(f.storage.values.size, 0); assert.equal(f.calls.some(([op]) => op === 'image.generate' || op === 'image.task.recoverResult'), false); f.session.dispose();
});

test('lost Comfy observe ACK retains stable key across recreation; only explicit replay uses same bytes', async () => {
  const f = observationFixture({ call: (op, value) => { if (op === 'image.task.remote.get') return remoteResponse(); throw fail('NETWORK'); } }); await f.session.read(taskId); await f.session.observe(task()); const saved = f.session.snapshot().remotePending; assert.ok(saved); f.session.dispose();
  const g = observationFixture({ storage: f.storage }); await g.session.read(taskId); assert.deepEqual(g.session.snapshot().remotePending, saved); assert.deepEqual(g.calls.map(c => c[0]), ['image.task.remote.get']); await g.session.observe(task()); assert.deepEqual(g.calls[1][1], saved.input); assert.equal(g.session.snapshot().remotePending, null); g.session.dispose();
});

test('local observation receipt settles pending without external query; foreign or regressed identities fail', async () => {
  const f = observationFixture({ call: op => op === 'image.task.remote.get' ? remoteResponse() : Promise.reject(fail('NETWORK')) }); await f.session.read(taskId); await f.session.observe(task()); const saved = f.session.snapshot().remotePending; f.session.dispose();
  const latest = { ...acknowledgement(saved.input), state: 'finished', revision: 3, errorCode: null, updatedAt: at };
  const g = observationFixture({ storage: f.storage, result: remoteResponse({ remote: remote({ revision: 4, state: 'running', lastObservedAt: at }), observation: latest }) }); await g.session.read(taskId); assert.equal(g.session.snapshot().remotePending, null); assert.equal(g.calls.length, 1);
  g.setResult(remoteResponse({ remote: remote({ revision: 5, promptId: id(90) }) })); await assert.rejects(g.session.read(taskId)); assert.equal(g.session.snapshot().remotes[taskId].remote.promptId, id(7)); g.session.dispose();
});

test('observation duplicate, hide and disposal preserve exact durable key without generation retry', async () => {
  const held = deferred(), f = observationFixture({ call: op => op === 'image.task.remote.get' ? remoteResponse() : held.promise }); await f.session.read(taskId); const observing = f.session.observe(task()); assert.equal(await f.session.observe(task()), false); f.session.setVisible(false); assert.equal(await f.session.read(taskId), false); const count = f.changes.length, saved = f.session.snapshot().remotePending; f.session.dispose(); held.resolve(acknowledgement(saved.input)); await observing; assert.equal(f.changes.length, count); assert.equal(f.storage.values.size, 1); assert.equal(f.calls.filter(([op]) => op === 'image.task.observeRemote').length, 1);
});

test('Comfy UI exposes separate prepare/observe/full graph, shared controls and truthful resource disclosures', () => {
  const read = name => readFileSync(new URL(`../apps/web/src/${name}`, import.meta.url), 'utf8');
  for (const name of ['ImageGeneration.jsx', 'ComfyImageSettings.jsx', 'ComfyImageDetails.jsx']) assert.doesNotThrow(() => transformSync(read(name), { loader: 'jsx', format: 'esm' }));
  const compose = read('ImageGeneration.jsx'), details = read('ComfyImageDetails.jsx'), settings = read('ComfyImageSettings.jsx');
  for (const text of ['image-provider-comfy', 'prepareComfy()', 'image-observe-remote', 'observeRemote(task)', 'image-recover-result', 'recoverResult', 'ComfyImageReviewDetails', '批准此冻结工作流并运行']) assert.ok(compose.includes(text), text);
  for (const text of ['execution.seed', 'execution.graphHash', 'JSON.stringify(execution.graph', 'contentVerified', 'remote?.state', 'GPU 工作可能继续', '不保证免费、可信或完全离线']) assert.ok(details.includes(text), text);
  for (const text of ['<Label', '<Input', '<WorkbenchSelect', 'useWorkspaceVisibility', 'visibilitychange', 'contextKey', '检查连接与已安装模型', '不探测服务', '不会下载模型']) assert.ok(settings.includes(text), text);
  assert.doesNotMatch(settings, /type="password"|secret|install\(|download\(|<input\b|<label\b/); assert.doesNotMatch(details, /\blow\b|moderation|task\.remote/);
});

const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [];
function componentHarness(filename, resolve, props) {
  const slots = []; let index = 0, effects = [], ancestor = true, tree, currentProps = props;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  // This legacy element-tree harness expands only the slot's render prop.
  // Registry ownership and cleanup are covered by dedicated navigation tests.
  const react = { createElement(type, props, ...children) { if (type === 'SettingsNavigationSlot') return children[0](() => {}); return { type, props: { ...props, children } }; }, useState(initial) { const slot = index++; slots[slot] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[slot].value, value => { slots[slot].value = typeof value === 'function' ? value(slots[slot].value) : value; }]; }, useRef(initial) { return slots[index++] ||= { current: initial }; }, useMemo(fn, deps) { const slot = index++; if (!slots[slot] || !equal(slots[slot].deps, deps)) slots[slot] = { value: fn(), deps }; return slots[slot].value; }, useLayoutEffect(fn, deps) { const slot = index++, old = slots[slot]; if (old && equal(old.deps, deps)) return; slots[slot] = { fn, deps, cleanup: old?.cleanup }; effects.push(slot); } }; react.default = react;
  const primitive = new Proxy({}, { get: (_, key) => String(key) }), module = { exports: {} };
  const require = name => {
    if (name === './editor-settings-scope.ts') {
      const settingsModule = { exports: {} };
      const code = transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
      Function('module', 'exports', 'require', code)(settingsModule, settingsModule.exports, dependency => { assert.equal(dependency, 'react'); return react; });
      return settingsModule.exports;
    }
    if (name === './native-close-sources.ts') return nativeCloseSources; if (name === 'react') return react; if (name === './settings-navigation-state.ts') return navigation; if (name === './SettingsNavigationSlot.tsx') return { __esModule: true, default: 'SettingsNavigationSlot' }; if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => ancestor }; if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.jsx') return primitive; if (name === './icons.jsx') return { default: 'Icon' }; if (name.endsWith('.css')) return {}; return resolve(name); };
  Function('module', 'exports', 'require', transformSync(readFileSync(new URL(`../apps/web/src/${filename}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, require);
  const ui = { render(patch = {}) { currentProps = { ...currentProps, ...patch }; index = 0; effects = []; tree = module.exports.default(currentProps); for (const slot of effects) { slots[slot].cleanup?.(); slots[slot].cleanup = slots[slot].fn(); } return tree; }, find(id) { return nodes(tree).find(node => node.props['data-testid'] === id); }, form() { return nodes(tree).find(node => node.type === 'form'); }, hide(value) { ancestor = !value; return ui.render(); }, change(id, value) { ui.find(id).props.onChange({ target: { value, checked: value } }); ui.render(); }, click(id) { ui.find(id).props.onClick(); ui.render(); }, unmount() { for (const slot of slots) slot.cleanup?.(); } }; return ui;
}

test('actual Comfy settings controls use shared components and stale project/hidden callbacks cannot check or save', async () => {
  const logic = await import('../apps/web/src/comfy-image-settings.js'), f = settingsFixture();
  const ui = componentHarness('ComfyImageSettings.jsx', name => { if (name === './comfy-image-settings.js') return logic; throw Error(name); }, { active: true, contextKey: projectId, client: f.client }); ui.render(); await flush(); let tree = ui.render();
  const enable = ui.find('comfy-image-settings-enable'); assert.equal(enable.type, 'Input'); assert.equal(enable.props.type, 'checkbox'); assert.ok(nodes(tree).some(n => n.type === 'Label' && n.props.htmlFor === enable.props.id)); assert.equal(ui.find('comfy-image-settings-model').type, 'WorkbenchSelect');
  const oldCheck = ui.find('comfy-image-settings-check').props.onClick, oldSubmit = ui.form().props.onSubmit;
  ui.hide(true); oldCheck(); oldSubmit({ preventDefault() {} }); assert.equal(f.calls.filter(c => c[0] !== 'read').length, 0);
  ui.hide(false); ui.render({ contextKey: id(91) }); oldCheck(); oldSubmit({ preventDefault() {} }); assert.equal(f.calls.filter(c => c[0] !== 'read').length, 0);
  ui.click('comfy-image-settings-check'); await flush(); ui.render(); assert.equal(f.calls.filter(c => c[0] === 'check').length, 1); assert.equal(ui.find('comfy-image-settings-model').props.disabled, false);
  ui.change('comfy-image-settings-model', 'other.safetensors'); ui.render({ active: false }); assert.equal(ui.find('comfy-image-settings-model').props.value, 'other.safetensors'); assert.equal(ui.find('comfy-image-settings-page').props.inert, true); ui.unmount(); f.session.dispose();
});

test('actual Comfy review shows exact graph, seed, independent status and no OpenAI option claims', () => {
  const source = readFileSync(new URL('../apps/web/src/ComfyImageDetails.jsx', import.meta.url), 'utf8'); const module = { exports: {} }, react = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }; react.default = react;
  Function('module', 'exports', 'require', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, name => { assert.equal(name, 'react'); return react; });
  const saved = review(), tree = module.exports.ComfyImageReviewDetails({ review: saved }); const graph = nodes(tree).find(n => n.props['data-testid'] === 'image-comfy-review-graph'); assert.deepEqual(JSON.parse(graph.props.children.join('')), saved.execution.graph); assert.match(JSON.stringify(tree), /87654/); assert.doesNotMatch(JSON.stringify(tree), /quality|moderation|1024|low/);
  const status = module.exports.ComfyImageTaskDetails({ task: task(), review: saved, remoteState: remoteResponse({ remote: remote({ state: 'running' }) }) }); const text = JSON.stringify(status); assert.match(text, /已找到相同任务 ID/); assert.match(text, /尚未核验；仅任务 ID/); assert.doesNotMatch(text, /已核验与冻结工作流一致/);
});


test('only exact observation rejection proofs release stale CAS/busy intents; no automatic replacement query', async () => {
  for (const code of ['COMFY_REMOTE_REVISION_CONFLICT', 'COMFY_REMOTE_BUSY', 'COMFY_REMOTE_STATE', 'COMFY_REMOTE_CAPACITY']) {
    for (const mismatch of [null, 'operation', 'projectId', 'taskId', 'requestId', 'inputHash']) {
      const f = observationFixture({ call: (op, value) => { if (op === 'image.task.remote.get') return remoteResponse(); const proof = { outcome: 'not_accepted', operation: op, projectId, taskId, requestId: value.requestId, inputHash: createHash('sha256').update(canonicalImageInput(value)).digest('hex') }; if (mismatch) proof[mismatch] = mismatch === 'inputHash' ? '0'.repeat(64) : 'mismatched'; throw new ApiError('UNTRUSTED', code, { observation: proof }, true, code === 'COMFY_REMOTE_CAPACITY' ? 507 : 409); } });
      await f.session.read(taskId); await f.session.observe(task()); assert.equal(f.session.snapshot().remotePending === null, mismatch === null, `${code}/${mismatch}`); assert.equal(f.calls.filter(c => c[0] === 'image.task.observeRemote').length, 1); assert.equal(f.storage.values.size, mismatch ? 1 : 0); f.session.dispose();
    }
  }
});

test('reopened unknown observation reads its exact task before paginated history and retains group selection', async () => {
  const storage = memory(), pending = { version: 1, operation: 'image.task.observeRemote', input: { projectId, taskId, requestId: id(50), expectedRevision: 2 } };
  storage.setItem(`mioon.comfy-observation.v1:${projectId}`, JSON.stringify(pending));
  const target = { id: groupId, projectId, name: input().name, revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at }, unrelated = { ...target, id: id(99), activeTaskId: null };
  const f = generationFixture({ storage, api: op => op === 'image.group.list' ? { projectId, items: [unrelated], nextCursor: null } : undefined }); f.data.tasks = [task()]; f.data.groups = [target, unrelated]; await f.session.load();
  assert.equal(f.session.getState().selectedGroupId, groupId); assert.deepEqual(f.session.getState().remotePending, pending); assert.equal(f.session.selectProvider('mock'), false); assert.equal(f.session.edit('prompt', 'stale edit'), false); assert.equal(f.calls.some(([op]) => op === 'image.task.observeRemote'), false); assert.ok(f.calls.findIndex(([op]) => op === 'image.task.remote.get') < f.calls.findIndex(([op]) => op === 'image.group.list')); f.session.dispose();
});


test('an unknown older observation can replay its receipt after another observer finishes the task', async () => {
  const storage = memory(), pending = { version: 1, operation: 'image.task.observeRemote', input: { projectId, taskId, requestId: id(30), expectedRevision: 2 } };
  storage.setItem(`mioon.comfy-observation.v1:${projectId}`, JSON.stringify(pending));
  const f = observationFixture({ storage, result: remoteResponse({ remote: remote({ state: 'failed', contentVerified: true, revision: 6 }), observation: { ...acknowledgement({ requestId: id(99), expectedRevision: 4 }), state: 'finished', revision: 3, errorCode: null, updatedAt: at } }) }); await f.session.read(taskId);
  const finished = task({ state: 'failed', errorCode: 'COMFY_EXECUTION_FAILED', revision: 7 }); assert.equal(comfyCanObserve(f.session.snapshot(), task({ state: 'succeeded', versionId: id(90), revision: 7 })), true); assert.equal(comfyCanObserve(f.session.snapshot(), finished), true); await f.session.observe(finished); assert.deepEqual(f.calls[1][1], pending.input); assert.equal(f.session.snapshot().remotePending, null); f.session.dispose();
});


test('actual Comfy composer prepares first and stale hidden approval handlers never run', async () => {
  const contracts = await import('@mioon/contracts'), logic = await import('../apps/web/src/image-generation.js'), f = generationFixture();
  const localClient = { read: async () => settings() }, legacyClient = { read: async () => null };
  const ui = componentHarness('ImageGeneration.jsx', name => {
    if (name === '@mioon/contracts') return contracts;
    if (name === './image-generation.js') return { ...logic, createImageGenerationSession: options => logic.createImageGenerationSession({ ...options, requestId: () => id(4), setTimer: () => 1, clearTimer() {} }) };
    if (name === './ImageSettings.jsx') return { __esModule: true, default: 'ImageSettings' };
    if (name === './ComfyImageSettings.jsx') return { __esModule: true, default: 'ComfyImageSettings' };
    if (name === './ComfyImageDetails.jsx') return { ComfyImageReviewDetails: 'ComfyImageReviewDetails', ComfyImageTaskDetails: 'ComfyImageTaskDetails' };
    if (name === './image-settings.js') return { createImageSettingsClient: () => legacyClient };
    if (name === './comfy-image-settings.js') return { createComfyImageSettingsClient: () => localClient };
    throw Error(name);
  }, { projectId, projectName: '本地测试项目', api: f.api, storage: f.storage, reviewClient: f.reviewClient, settingsClient: legacyClient, customSettingsClient: legacyClient, comfySettingsClient: localClient });
  ui.render(); await flush(); ui.render(); ui.click('image-provider-comfy'); ui.change('image-generation-name', input().name); ui.change('image-generation-prompt', input().prompt); assert.equal(ui.find('image-generate').props.type, 'button'); assert.equal(ui.find('image-generate').props.disabled, false); assert.match(JSON.stringify(ui.find('image-fixed-options')), /512/); assert.doesNotMatch(JSON.stringify(ui.find('image-fixed-options')), /low|1024/);
  ui.click('image-generate'); await flush(); ui.render(); assert.equal(f.approvals.length, 0); assert.equal(f.data.reviews[0].input.prompt, input().prompt); assert.equal(ui.find('image-review-approve').props.disabled, false);
  const oldApprove = ui.find('image-review-approve').props.onClick; ui.click('image-settings-open'); oldApprove(); assert.equal(f.approvals.length, 0); const card = nodes(ui.render()).find(n => n.type === 'ComfyImageSettings'); assert.equal(card.props.active, true); card.props.onClose(); ui.render(); await flush(); ui.render(); oldApprove(); assert.equal(f.approvals.length, 0);
  ui.click('image-review-approve'); await flush(); ui.render(); assert.equal(f.approvals.length, 1); assert.equal(f.calls.some(([op]) => op === 'image.generate' || op === 'image.task.observeRemote'), false); ui.unmount(); f.session.dispose();
});


test('observation rejection proof with wrong or absent HTTP status stays uncertain', async () => {
  for (const status of [undefined, 400, 500, 507]) {
    const f = observationFixture({ call: (op, value) => { if (op === 'image.task.remote.get') return remoteResponse(); const proof = { outcome: 'not_accepted', operation: op, projectId, taskId, requestId: value.requestId, inputHash: createHash('sha256').update(canonicalImageInput(value)).digest('hex') }; throw new ApiError('UNTRUSTED', 'COMFY_REMOTE_REVISION_CONFLICT', { observation: proof }, true, status); } });
    await f.session.read(taskId); await f.session.observe(task()); assert.ok(f.session.snapshot().remotePending, String(status)); assert.equal(f.calls.filter(([op]) => op === 'image.task.observeRemote').length, 1); f.session.dispose();
  }
});

test('browser RPC preserves actual HTTP status without changing legacy ApiError construction', async () => {
  const original = globalThis.fetch;
  try { globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'COMFY_REMOTE_REVISION_CONFLICT', message: 'safe', details: {} } }) }); await assert.rejects(rpc('image.task.observeRemote', {}), error => error instanceof ApiError && error.status === 500 && error.definitive === false); assert.equal(Object.hasOwn(new ApiError('legacy', 'NETWORK'), 'status'), false); }
  finally { globalThis.fetch = original; }
});
