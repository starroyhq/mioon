import * as i18n from '../packages/i18n/src/index.ts';
import * as creationI18n from '../apps/web/src/creation-i18n.ts';
import * as comfySettings from '../apps/web/src/comfy-image-settings.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { transformSync } from 'esbuild';
import * as sources from '../apps/web/src/native-close-sources.ts';
import * as imageEditIntent from '../apps/web/src/image-edit-intent.ts';
import { createNativeCloseRegistry } from '../apps/web/src/native-close-state.ts';
import * as chat from '../apps/web/src/agent-chat.ts';
import * as edits from '../apps/web/src/agent-edits.ts';
import * as image from '../apps/web/src/image-generation.ts';
import * as toolState from '../apps/web/src/agent-tool-state.ts';
import * as timing from '../apps/web/src/agent-timeline-context.ts';
import * as contracts from '@mioon/contracts';
import { createAgentAuthorizationUiMock } from './helpers/agent-authorization-ui.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), instanceId = id(2), threadId = id(3), requestId = id(4), runId = id(5), groupId = id(6), taskId = id(7), reviewId = id(8), shotId = id(9), proposalId = id(10);
const at = '2026-10-10T10:00:00.000Z';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
// Completion is an actual publication event, not an assumed number of event-loop
// turns. This deadline only rejects a hung test; it never proves completion.
function stateNotifications() {
  const listeners = new Set();
  return {
    notify() { for (const check of [...listeners]) check(); },
    until(condition) {
      if (condition()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { listeners.delete(check); reject(Error('Expected close publication event within 5s')); }, 5000);
        const check = () => { if (condition()) { clearTimeout(timeout); listeners.delete(check); resolve(); } };
        listeners.add(check); check();
      });
    },
  };
}
const memory = () => { const map = new Map(); return { map, getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };
const config = { presetId: 'openai', platformId: 'global', baseUrl: 'https://private.example.com/v1', model: 'synthetic-model', protocol: 'chat_completions' };
const chatSettings = { revision: 0, configuration: config, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions'], ...config }] }], scope: 'settings_only', verification: 'not_tested' };
const chatSnapshot = patch => ({ instanceId, threadId, projectId, revision: 0, historyCursor: null, scope: 'chat_only', persistence: 'local_database', mode: 'simulated', settings: chatSettings, runs: [], ...patch });
const chatRun = patch => ({ id: runId, requestId, threadId, projectId, status: 'running', userText: 'PRIVATE_DRAFT', assistantText: '', configuration: config, createdAt: at, updatedAt: at, lastEventId: 1, ...patch });
const envelope = (run = chatRun(), revision = 1) => ({ instanceId, threadId, projectId, revision, run });
const paidInput = patch => ({ projectId, name: 'PRIVATE_NAME', prompt: 'PRIVATE_PROMPT', providerId: 'openai', model: image.IMAGE_MODELS.openai, options: image.IMAGE_FIXED_OPTIONS, requestId, ...patch });
const review = patch => { const input = paidInput(); return { id: reviewId, projectId, requestId, input, inputHash: createHash('sha256').update(contracts.canonicalImageInput(input)).digest('hex'), settingsRevision: 1, destination: contracts.IMAGE_REVIEW_DESTINATION, policy: contracts.IMAGE_REVIEW_POLICY, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: at, updatedAt: at, approvedAt: null, rejectedAt: null, dispatchedAt: null, ...patch }; };
const task = patch => ({ id: taskId, projectId, groupId, requestId, name: 'PRIVATE_NAME', prompt: 'PRIVATE_PROMPT', providerId: 'mock', model: image.IMAGE_MODELS.mock, options: image.IMAGE_FIXED_OPTIONS, state: 'queued', revision: 1, dispatched: false, versionId: null, errorCode: null, createdAt: at, updatedAt: at, ...patch });
const page = items => ({ projectId, items, nextCursor: null });
const imageSettings = { revision: 1, configuration: { ...contracts.DEFAULT_IMAGE_CONFIGURATION, enabled: true }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' } };
function imageFixture(options = {}) {
  const data = { reviews: options.reviews || [], tasks: [], groups: [], receipt: null }, calls = [], storage = options.storage || memory();
  const api = async (operation, input) => {
    calls.push(operation);
    if (options.api) { const value = await options.api(operation, input, data); if (value !== undefined) return value; }
    if (operation === 'image.group.list') return page(data.groups);
    if (operation === 'image.group.get') return data.groups.find(value => value.id === input.groupId);
    if (operation === 'image.task.list') return page(data.tasks);
    if (operation === 'image.task.get') return data.tasks.find(value => value.id === input.taskId);
    if (operation === 'image.version.list') return page([]);
    if (operation === 'image.review.list') return page(data.reviews);
    if (operation === 'image.request.get') return data.receipt;
    if (operation === 'image.generate') {
      const result = task(input); data.tasks = [result]; data.groups = [{ id: groupId, projectId, name: input.name, revision: 1, headVersionId: null, activeTaskId: taskId, createdAt: at, updatedAt: at }];
      data.receipt = { projectId, requestId: input.requestId, operation, response: result }; return result;
    }
    throw Error(operation);
  };
  const client = { read: async () => imageSettings }, rejects = [];
  const reviewClient = { approve: async () => { throw Error('No implicit approval'); }, reject: value => { rejects.push(value.id); return options.reject ? options.reject(value, data) : Promise.reject(Error('Unknown reject')); } };
  return { data, api, storage, reviewClient, rejects, calls, settingsClient: client, customSettingsClient: { read: async () => null }, comfySettingsClient: { read: async () => null } };
}
function chatFixture(options = {}) {
  const calls = [], streams = [], receiptMap = new Map(), receipts = { get: id => receiptMap.get(id), set: (id, value) => receiptMap.set(id, value) };
  const authorization = createAgentAuthorizationUiMock(async () => { calls.push('read'); return options.read ? options.read() : chatSnapshot(); });
  const client = {
    ...authorization,
    authorize: (...args) => { calls.push('authorize'); return authorization.authorize(...args); },
    start: async (_, input) => { calls.push('start'); return options.start ? options.start(input) : envelope(chatRun({ userText: input.message })); },
    stop: async () => { calls.push('stop'); return options.stop ? options.stop() : envelope(chatRun({ status: 'stopped' }), 2); },
    lookup: async () => { calls.push('lookup'); throw Object.assign(Error('Unknown'), { code: 'AGENT_CHAT_NOT_FOUND' }); },
    run: async () => { calls.push('run'); return envelope(); },
    stream: (...args) => { streams.push(args[4]); return new Promise(resolve => args[4].signal.addEventListener('abort', resolve, { once: true })); },
  };
  return { client, calls, streams, receipts, receiptMap };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
function renderer(filename, fixture, options = {}) {
  const path = process.env.MIOON_NATIVE_CLOSE_COMPONENT_ROOT ? resolve(process.env.MIOON_NATIVE_CLOSE_COMPONENT_ROOT, filename) : new URL(`../apps/web/src/${filename}`, import.meta.url);
  const source = readFileSync(path, 'utf8'), hooks = [], registry = options.registry || createNativeCloseRegistry();
  let cursor = 0, effects = [], tree, visible = options.visible ?? true, session;
  const publications = stateNotifications();
  const observedRegistry = { ...registry, register(slot) {
    const registration = registry.register(slot);
    return { ...registration, update(value) { registration.update(value); publications.notify(); } };
  } };
  const react = {
    createElement: (type, props = {}, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }]; },
    useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
    useMemo(fn, deps) { const index = cursor++; if (!hooks[index] || !same(hooks[index].deps, deps)) hooks[index] = { value: fn(), deps }; return hooks[index].value; },
    useLayoutEffect(fn, deps) { const index = cursor++, before = hooks[index]; if (before && same(before.deps, deps)) return; hooks[index] = { fn, deps, cleanup: before?.cleanup }; effects.push(index); },
  }; react.default = react;
  const module = { exports: {} }, primitives = new Proxy({}, { get: (_, name) => String(name) });
  const require = name => {
    if (name === 'react') return react;
    if (name === './i18n/I18nProvider.tsx') return { useI18n: () => ({ t: (key, params) => i18n.translate('zh-Hans', key, params), renderMessage: value => i18n.renderMessage('zh-Hans', value), formatDate: (value, options) => i18n.formatDate('zh-Hans', value, options), formatNumber: (value, options) => i18n.formatNumber('zh-Hans', value, options) }) };
    if (name === './creation-i18n.ts') return creationI18n;
    if (name === './editor-settings-scope.ts') {
      // Run the real optional native-activity hook against this renderer's hook
      // scheduler. No native scope is passed by the existing Web close cases.
      const activity = { exports: {} };
      const code = transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
      Function('module', 'exports', 'require', code)(activity, activity.exports, dependency => {
        assert.equal(dependency, 'react', 'Native activity may depend only on this exact React fixture');
        return react;
      });
      return activity.exports;
    }
    if (name === './native-close-sources.ts') return sources;
    if (name === './image-edit-intent.ts') return imageEditIntent;
    if (name === '@mioon/contracts') return contracts;
    if (name === './agent-chat.ts') return { ...chat, createAgentChatSession: input => session = chat.createAgentChatSession({ ...input, client: fixture.client, receipts: fixture.receipts, requestId: () => requestId }) };
    if (name === './agent-edits.ts') return { ...edits, createAgentEditsSession: input => session = edits.createAgentEditsSession({ ...input, client: fixture.client }) };
    if (name === './image-generation.ts') return { ...image, createImageGenerationSession: input => session = image.createImageGenerationSession({ ...input, requestId: () => requestId, setTimer: () => 1, clearTimer() {} }) };
    if (name === './agent-tool-state.ts') return toolState;
    if (name === './agent-timeline-context.ts') return timing;
    if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => visible };
    if (name === './image-settings.ts') return { createImageSettingsClient: () => fixture.settingsClient };
    if (name === './comfy-image-settings.ts') return { ...comfySettings, createComfyImageSettingsClient: () => fixture.comfySettingsClient };
    if (name === './AgentTimelineGain.tsx' || name === './ComfyImageDetails.tsx') return primitives;
    if (['./AgentEditProposal.tsx', './AgentRunActivity.tsx', './ImageSettings.tsx', './ComfyImageSettings.tsx', './SettingsNavigationSlot.tsx', './icons.tsx'].includes(name)) return { __esModule: true, default: name };
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return primitives;
    if (name.endsWith('.css')) return {};
    throw Error(`Unexpected close test import: ${name}`);
  };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, require);
  const ui = {
    render() {
      cursor = 0; effects = [];
      tree = module.exports.default({ nativeCloseRegistry: observedRegistry, projectId, projectName: 'Project', onClose() {}, onSettings() {}, ...fixture });
      for (const node of nodes(tree)) if (node.props.ref) node.props.ref.current ||= { value: '', scrollTop: 0, scrollHeight: 0 };
      for (const index of effects) { hooks[index].cleanup?.(); hooks[index].cleanup = hooks[index].fn(); }
      return tree;
    },
    find: id => nodes(tree).find(node => node.props['data-testid'] === id),
    edit(id, value) { ui.find(id).props.onChange({ target: { value, checked: value } }); },
    click(id) { ui.find(id).props.onClick(); },
    form() { return nodes(tree).find(node => node.type === 'form'); },
    hide() { visible = false; ui.render(); },
    unmount() { for (const hook of hooks) hook.cleanup?.(); },
    get session() { return session; }, registry,
    state: () => registry.capture()[0],
    waitForState: condition => publications.until(condition),
  };
  return ui;
}
const safeMetadata = state => {
  assert.ok(state, 'Actual mounted component must register a native close source');
  assert.deepEqual(Object.keys(state).sort(), ['blocked', 'busy', 'dirty', 'owner', 'slot', 'version']);
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|private\.example|prompt|requestId|configuration|secret/);
};

// This test intentionally exercises the real old component/session path. Setting
// MIOON_NATIVE_CLOSE_COMPONENT_ROOT to baseline JSX makes it red, with no mocked
// clean/dirty controller replacing the omission under test.
test('actual Agent draft and held send report before React rerender; accepted stream is close-neutral', async () => {
  const held = deferred(), f = chatFixture({ start: () => held.promise }), ui = renderer('AgentPanel.tsx', f);
  ui.render(); await flush(); ui.render(); safeMetadata(ui.state()); assert.equal(ui.state().busy, false);
  ui.edit('agent-chat-prompt', 'PRIVATE_DRAFT'); assert.equal(ui.state().dirty, true);
  const first = ui.state().version; ui.edit('agent-chat-prompt', 'PRIVATE_DRAFT_2'); assert.ok(ui.state().version > first);
  ui.render(); ui.click('agent-chat-authorization-open'); ui.render(); ui.edit('agent-chat-consent', true); ui.render(); ui.click('agent-chat-authorization-confirm'); await flush();
  assert.equal(f.calls.filter(value => value === 'authorize').length, 1);
  assert.equal(f.calls.includes('start'), false, 'explicitly saving a grant never sends the draft');
  ui.render(); ui.form().props.onSubmit({ preventDefault() {} });
  assert.equal(ui.state().busy, true); assert.equal(ui.state().blocked, true); assert.equal(f.calls.filter(value => value === 'start').length, 1);
  held.resolve(envelope(chatRun({ userText: 'PRIVATE_DRAFT_2' }))); await flush();
  assert.equal(ui.state().dirty, false); assert.equal(ui.state().busy, false); assert.equal(ui.state().blocked, false);
  const accepted = ui.state().version; f.streams.at(-1).onEvent({ id: 2, type: 'delta', instanceId, threadId, projectId, runId, revision: 1, text: 'PRIVATE_RESPONSE' });
  assert.equal(ui.state().version, accepted); ui.hide(); assert.equal(ui.state().version, accepted);
  assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.filter(value => value === 'authorize').length, 1); safeMetadata(ui.state()); ui.unmount();
});

test('Agent unrecovered receipt stays blocked on initial failed read, and stopping blocks synchronously', async () => {
  const broken = chatFixture({ read: () => { throw Error('Offline'); } }); broken.receiptMap.set(projectId, { instanceId, requestId });
  const ui = renderer('AgentPanel.tsx', broken); ui.render(); await flush(); assert.equal(ui.session.getState().pending, null); assert.equal(ui.state().blocked, true); ui.unmount();
  const stop = deferred(), f = chatFixture({ read: () => chatSnapshot({ revision: 1, runs: [chatRun()] }), stop: () => stop.promise }), running = renderer('AgentPanel.tsx', f);
  running.render(); await flush(); running.render(); assert.equal(running.state().blocked, false); running.click('agent-chat-stop'); assert.equal(running.state().busy, true);
  stop.resolve(envelope(chatRun({ status: 'stopped' }), 2)); await flush(); assert.equal(running.state().busy, false); running.unmount();
});

test('hidden Image constructor immediately reports restored generation/remote intents and corrupt storage', () => {
  const generation = { version: 1, operation: 'image.generate', input: paidInput({ providerId: 'mock', model: image.IMAGE_MODELS.mock }) };
  const observation = { version: 1, operation: 'image.task.observeRemote', input: { projectId, taskId, expectedRevision: 1, requestId } };
  for (const [key, value] of [[`mioon.image-intent.v1:${projectId}`, generation], [`mioon.comfy-observation.v1:${projectId}`, observation], [`mioon.image-intent.v1:${projectId}`, 'corrupt']]) {
    const storage = memory(); storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    const f = imageFixture({ storage }), ui = renderer('ImageGeneration.tsx', f, { visible: false }); ui.render();
    safeMetadata(ui.state()); assert.equal(ui.state().blocked, true); assert.equal(f.calls.length, 0); assert.equal(storage.map.has(key), true); ui.unmount();
  }
});

test('actual Image edits report synchronously and accepted durable generation never requires cancellation', async () => {
  const held = deferred(), f = imageFixture({ api: operation => operation === 'image.generate' ? held.promise : undefined }), ui = renderer('ImageGeneration.tsx', f);
  ui.render(); await flush(); ui.render(); ui.edit('image-generation-name', 'PRIVATE_NAME'); ui.edit('image-generation-prompt', 'PRIVATE_PROMPT'); assert.equal(ui.state().dirty, true);
  const before = ui.state().version; ui.edit('image-generation-prompt', 'PRIVATE_PROMPT_2'); assert.ok(ui.state().version > before); ui.render();
  ui.form().props.onSubmit({ preventDefault() {} }); assert.equal(ui.state().busy, true); assert.equal(ui.state().blocked, true);
  const saved = task({ prompt: 'PRIVATE_PROMPT_2' }); held.resolve(saved); await flush();
  assert.equal(ui.state().dirty, false); assert.equal(ui.state().blocked, false); assert.equal(ui.state().busy, false);
  const accepted = ui.state().version; await ui.session.load(); assert.equal(ui.state().version, accepted);
  assert.equal(f.calls.some(value => /cancel|recover|observeRemote/.test(value)), false); safeMetadata(ui.state()); ui.unmount();
});

test('actual Image lost rejection ACK remains blocked until an exact readonly rejected review is read', async () => {
  const saved = review(), f = imageFixture({ reviews: [saved] }), ui = renderer('ImageGeneration.tsx', f);
  ui.render(); await flush(); ui.render(); ui.click('image-review-reject'); assert.equal(ui.state().busy, true); assert.equal(ui.state().blocked, true);
  await flush(); await turn(); assert.equal(ui.state().busy, false); assert.equal(ui.state().blocked, true); assert.equal(ui.session.getState().pending, null);
  f.data.reviews = []; await ui.session.load(); assert.equal(ui.state().blocked, true);
  f.data.reviews = [saved]; await ui.session.load(); await turn(); assert.equal(ui.state().blocked, true);
  f.data.reviews = [review({ state: 'rejected', revision: 2, rejectedAt: at })]; await ui.session.load(); await ui.waitForState(() => !ui.state().blocked);
  assert.deepEqual(f.rejects, [reviewId]); safeMetadata(ui.state()); ui.unmount();
});

test('actual Agent proposal mutation and uncertainty are independent of chat source', async () => {
  const held = deferred(), proposal = { id: proposalId, projectId, runId, digest: 'c'.repeat(64), status: 'pending', runStatus: 'completed', operation: 'shot.update', target: { projectId, shotId, expectedRevision: 1 }, patch: { title: 'After' }, diff: { before: { title: 'Before', prompt: '' }, after: { title: 'After', prompt: '' } }, provenance: { runId, toolCallId: 'call', toolName: 'mioon_propose_shot_update' }, createdAt: at, updatedAt: at };
  let current = proposal, writes = 0;
  const client = { list: async () => ({ instanceId, projectId, proposals: [current], nextCursor: null }), get: async () => ({ instanceId, projectId, proposal: current }), act: () => { writes++; return held.promise; } };
  const ui = renderer('AgentEditProposal.tsx', { client }); ui.render(); await flush(); ui.render(); assert.equal(ui.state().slot, 'agent-edits'); assert.equal(ui.state().blocked, false);
  ui.click('agent-edit-approve'); assert.equal(ui.state().busy, true); assert.equal(ui.state().blocked, true);
  held.reject(Error('Unknown')); await flush(); assert.equal(ui.state().busy, false); assert.equal(ui.state().blocked, true);
  current = { ...proposal, status: 'applied', approval: { requestId, approvedAt: at }, outcome: { status: 'applied', shotId, revision: 2 } };
  await ui.session.inspect(proposalId); assert.equal(ui.state().blocked, false); assert.equal(writes, 1); safeMetadata(ui.state()); ui.unmount();
});

test('replaced source owner cannot be released or updated by stale callback', async () => {
  const registry = createNativeCloseRegistry(), held = deferred(), old = renderer('AgentPanel.tsx', chatFixture({ read: () => held.promise }), { registry }); old.render();
  const fresh = renderer('AgentPanel.tsx', chatFixture(), { registry }); fresh.render(); await flush(); fresh.render(); fresh.edit('agent-chat-prompt', 'PRIVATE_FRESH');
  const capture = registry.capture(); old.unmount(); held.resolve(chatSnapshot()); await flush(); assert.equal(registry.isCurrent(capture), true); assert.equal(fresh.state().dirty, true); fresh.unmount();
});

test('metadata versions follow draft identity, not saved Image task polling or chat stream deltas', () => {
  const registry = createNativeCloseRegistry(), report = sources.createImageGenerationCloseReporter(registry), state = image.initialImageGenerationState();
  const first = report.publish({ state, dirty: false, rejectionBlocked: false });
  const second = report.publish({ state: { ...state, tasks: [task()], historyPhase: 'loading' }, dirty: false, rejectionBlocked: false }); assert.equal(second, first);
  for (const savedState of ['queued', 'dispatching', 'receiving', 'persisting', 'outcome_unknown', 'local_result_error']) {
    assert.equal(report.publish({ state: { ...state, tasks: [task({ state: savedState })] }, dirty: false, rejectionBlocked: false }).blocked, false);
  }
  const changed = report.publish({ state: { ...state, mode: 'edit' }, dirty: true, rejectionBlocked: false }); assert.equal(changed.dirty, true); assert.ok(changed.version > first.version);
  report.release(); report.publish({ state, dirty: false, rejectionBlocked: false }); assert.deepEqual(registry.capture(), []);
});

const latchOptions = { limit: contracts.IMAGE_REVIEW_LIMITS.reviewsPerProject, identityBytes: contracts.IMAGE_REVIEW_LIMITS.rowBytes };
test('rejection proof retains multiple exact identities; pending/unrelated/older evidence never clears', async () => {
  const publications = stateNotifications(), hashes = [];
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => publications.notify(), identity => {
    const done = deferred(); hashes.push({ identity, ...done }); return done.promise;
  });
  const finishHashes = async () => { await flush(); for (const row of hashes.splice(0)) row.resolve(`digest:${row.identity}`); await flush(); };
  latch.begin('one', 1, 'identity-one'); latch.begin('two', 1, 'identity-two'); assert.equal(latch.getState().rejectionBlocked, true);
  await finishHashes();
  latch.reconcile('one', 1, 'pending', 'identity-one'); latch.reconcile('foreign', 2, 'rejected', 'identity-one');
  latch.reconcile('one', 1, 'rejected', 'identity-one'); await finishHashes(); assert.equal(latch.getState().rejectionBlocked, true);
  latch.reconcile('one', 2, 'rejected', 'identity-one'); await finishHashes(); assert.equal(latch.getState().rejectionBlocked, true);
  latch.reconcile('two', 2, 'rejected', 'identity-two'); await flush(); assert.equal(latch.getState().rejectionBlocked, true, 'uncompleted identity hash cannot authorize leaving');
  const completed = publications.until(() => !latch.getState().rejectionBlocked); await finishHashes(); await completed;
  assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});

test('one hundred loop turns cannot certify completion; actual hash publication alone settles the observer', async () => {
  const publications = stateNotifications(), held = deferred(); let digestCalls = 0;
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => publications.notify(), () => { digestCalls++; return held.promise; });
  latch.begin('one', 1, 'identity'); latch.reconcile('one', 2, 'rejected', 'identity'); await flush(); assert.equal(digestCalls, 2);
  // Exact previous helper is a negative control. Both digests deliberately stay
  // pending across all its turns, a valid scheduling outcome for WebCrypto.
  const oldTurnBudget = async condition => { for (let n = 0; n < 100; n++) { if (condition()) return; await turn(); } assert.ok(condition(), 'Expected close proof to settle'); };
  await assert.rejects(oldTurnBudget(() => !latch.getState().rejectionBlocked), /Expected close proof to settle/);
  assert.equal(latch.getState().rejectionBlocked, true);
  const completed = publications.until(() => !latch.getState().rejectionBlocked);
  held.resolve('exact-digest'); await completed; assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});

test('real WebCrypto identity reconciliation publishes completion without a scheduler-turn assumption', async () => {
  const publications = stateNotifications();
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => publications.notify());
  latch.begin('one', 1, 'same real SHA bytes'); latch.reconcile('one', 2, 'rejected', 'same real SHA bytes');
  assert.equal(latch.getState().rejectionBlocked, true);
  await publications.until(() => !latch.getState().rejectionBlocked); assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});

test('identity corruption, existing-domain overflow and hash failure never release close proof', async () => {
  for (const kind of ['different-identity', 'overflow', 'oversize', 'hash-failure']) {
    const latch = sources.createImageRejectionCloseLatch(latchOptions, () => {}, kind === 'hash-failure' ? () => Promise.reject(Error('Unavailable')) : undefined);
    if (kind === 'overflow') { for (let n = 0; n <= latchOptions.limit; n++) latch.begin(`id-${n}`, 1, `identity-${n}`); }
    else { latch.begin('one', 1, kind === 'oversize' ? 'x'.repeat(latchOptions.identityBytes + 1) : 'identity'); if (kind === 'different-identity') latch.reconcile('one', 2, 'rejected', 'changed'); }
    await flush(); await turn(); assert.equal(latch.getState().rejectionBlocked, true, kind); latch.dispose();
  }
});

test('disposed hash/reconciliation completions cannot publish or reset a replacement owner', async () => {
  const held = deferred(); let oldChanges = 0;
  const old = sources.createImageRejectionCloseLatch(latchOptions, () => oldChanges++, () => held.promise);
  old.begin('one', 1, 'same'); old.reconcile('one', 2, 'rejected', 'same'); old.dispose(); const before = oldChanges;
  const fresh = sources.createImageRejectionCloseLatch(latchOptions); fresh.begin('two', 1, 'new'); held.resolve('digest'); await flush();
  assert.equal(oldChanges, before); assert.equal(fresh.getState().rejectionBlocked, true); fresh.dispose();
});


test('readonly concurrent approval/dispatched proof resolves lost rejection without cancelling durable work', async () => {
  for (const status of ['approved', 'dispatched']) {
    const saved = review(), f = imageFixture({ reviews: [saved] }), ui = renderer('ImageGeneration.tsx', f);
    ui.render(); await flush(); ui.render(); ui.click('image-review-reject'); await flush(); assert.equal(ui.state().blocked, true);
    f.data.reviews = [review({ state: status, revision: status === 'approved' ? 2 : 3, taskId, approvedAt: at, ...(status === 'dispatched' ? { dispatchedAt: at, postAttempts: 1 } : {}) })];
    await ui.session.load(); await ui.waitForState(() => !ui.state().blocked);
    assert.deepEqual(f.rejects, [reviewId]); assert.equal(f.calls.some(value => /cancel|recover|generate/.test(value)), false); ui.unmount();
  }
});

test('a late failed hash for an older pending read cannot poison an already resolved review', async () => {
  const held = deferred(); let calls = 0;
  const latch = sources.createImageRejectionCloseLatch(latchOptions, () => {}, () => ++calls === 2 ? held.promise : Promise.resolve('same-digest'));
  latch.begin('one', 1, 'same'); latch.reconcile('one', 1, 'pending', 'same'); latch.reconcile('one', 2, 'rejected', 'same');
  await flush(); assert.equal(latch.getState().rejectionBlocked, false); held.reject(Error('Late unavailable hash')); await flush(); assert.equal(latch.getState().rejectionBlocked, false); latch.dispose();
});
