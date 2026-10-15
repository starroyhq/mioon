import { creationTestDependency } from './helpers/creation-i18n.ts';
import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import * as timing from '../apps/web/src/agent-timeline-context.js';
import * as gainContext from '../apps/web/src/agent-timeline-gain-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as edits from '../apps/web/src/agent-edits.js';
import * as chat from '../apps/web/src/agent-chat.js';
import * as policy from '../apps/web/src/agent-tool-state.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), instanceId = id(2), threadId = id(3), shotId = id(4), runId = id(5), proposalId = id(6), requestId = id(7);
const target = { projectId, shotId, expectedRevision: 4, title: 'Saved title', prompt: 'Saved prompt <script>untrusted</script>' };
const selected = { id: shotId, revision: 4, title: target.title, prompt: target.prompt };
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions' };
const settings = { revision: 0, configuration, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], ...configuration }] }], scope: 'settings_only', verification: 'not_tested' };
const snapshot = (patch = {}) => ({ instanceId, threadId, projectId, revision: 0, scope: 'chat_and_reviewed_shot_edits', persistence: 'local_database', mode: 'simulated', edit: { available: true, ...policy.AGENT_EDIT_LIMITS, catalogHash: 'a'.repeat(64) }, inspection: { available: true, ...policy.AGENT_INSPECTION_LIMITS, catalogHash: 'b'.repeat(64) }, settings, runs: [], historyCursor: null, ...patch });
const run = (patch = {}) => ({ id: runId, requestId, threadId, projectId, status: 'completed', userText: 'Improve selected shot', assistantText: 'I already applied everything! <img src=x>', configuration, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', lastEventId: 3, contextMode: policy.AGENT_EDIT_CONTEXT, editTarget: target, provenance: { category: 'project_selected_shot_text', projectId, sourceRunIds: [] }, activity: [{ id: id(10), kind: 'model', ordinal: 1, status: 'completed' }], ...patch });
const proposal = (patch = {}) => ({ id: proposalId, projectId, runId, digest: 'c'.repeat(64), status: 'pending', runStatus: 'completed', operation: 'shot.update', target: { projectId, shotId, expectedRevision: 4 }, patch: { title: 'Proposed title', prompt: '' }, diff: { before: { title: target.title, prompt: target.prompt }, after: { title: 'Proposed title', prompt: '' } }, provenance: { runId, toolCallId: 'provider-call-1', toolName: 'mioon_propose_shot_update' }, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', ...patch });
const approval = { requestId: id(8), approvedAt: '2026-10-09T00:00:01Z' };
const applied = () => proposal({ status: 'applied', approval, outcome: { status: 'applied', shotId, revision: 5 } });
const envelope = (value, epoch = instanceId) => ({ instanceId: epoch, projectId, proposal: value });
const page = (values = [proposal()], patch = {}) => ({ instanceId, projectId, proposals: values, nextCursor: null, ...patch });
const error = code => Object.assign(new Error('DO NOT SHOW private server text'), { code });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  const calls = [], appliedCalls = [];
  const client = {
    list: async (...args) => { calls.push(['list', ...args]); return options.list ? options.list(...args) : page(); },
    get: async (...args) => { calls.push(['get', ...args]); return options.get ? options.get(...args) : envelope(proposal()); },
    act: async (...args) => { calls.push(['act', ...args]); return options.act ? options.act(...args) : envelope(applied()); },
  };
  return { calls, appliedCalls, client, session: edits.createAgentEditsSession({ projectId, client, onApplied: (...args) => appliedCalls.push(args) }) };
}
const act = (f, name = 'approve') => f.session.act(name, f.session.getState().proposals[0]);

test('unresolved proposal discovery and native recreation are GET-only without browser storage or fresh keys', async () => {
  const f = fixture({ list: async () => page([proposal({ status: 'unknown', approval })]) });
  await f.session.load(); assert.equal(f.session.getState().view, 'unresolved'); f.session.dispose();
  const again = edits.createAgentEditsSession({ projectId, client: f.client }); await again.load();
  assert.equal(again.getState().proposals[0].approval.requestId, approval.requestId);
  assert.equal(f.calls.filter(call => call[0] === 'act').length, 0);
  assert.doesNotMatch(readFileSync(new URL('../apps/web/src/agent-edits.js', import.meta.url), 'utf8'), /(?:sessionStorage|localStorage)\s*[.(]|randomUUID\s*\(/);
  again.dispose();
});

test('client routes are authenticated GET reads and explicit epoch/digest actions only', async () => {
  const calls = [], client = edits.createAgentEditsClient({ fetchImpl: async (url, input) => { calls.push({ url, input }); return Response.json({ ok: true, data: input.method === 'GET' && url.includes('?') ? page() : envelope(proposal()) }); } });
  await client.list(projectId); await client.list(projectId, { view: 'all', cursor: 'cursor-a' }); await client.get(projectId, proposalId);
  await client.act(projectId, proposalId, 'approve', { instanceId, digest: proposal().digest, requestId: 'must-not-be-sent' });
  assert.match(calls[0].url, /view=unresolved/); assert.match(calls[1].url, /view=all.*cursor=cursor-a/);
  assert.ok(calls.slice(0, 3).every(call => call.input.method === 'GET' && !call.input.body));
  assert.deepEqual(JSON.parse(calls[3].input.body), { instanceId, digest: proposal().digest });
  assert.ok(calls.every(call => call.input.credentials === 'same-origin' && call.input.cache === 'no-store'));
  assert.doesNotMatch(calls.map(call => call.url).join(), /rpc|runs/);
});

test('persisted diff projection rejects changed targets, invalid fields and optimistic applied claims', () => {
  const safe = edits.safeAgentEditProposal(proposal({ ignoredSecret: 'SECRET' }), projectId);
  assert.equal(Object.isFrozen(safe.diff.after), true); assert.equal(safe.diff.after.prompt, ''); assert.doesNotMatch(JSON.stringify(safe), /SECRET/);
  for (const patch of [{ projectId: id(99) }, { operation: 'project.delete' }, { patch: { duration: 5 } }, { patch: { title: null } }, { diff: { ...proposal().diff, after: { title: '', prompt: '' } } }, { status: 'applied' }, { status: 'pending', outcome: { status: 'applied', shotId, revision: 5 } }, { status: 'unknown' }, { runStatus: 'success' }, { provenance: { runId: id(99), toolCallId: 'x', toolName: 'mioon_propose_shot_update' } }]) assert.throws(() => edits.safeAgentEditProposal(proposal(patch), projectId), error => error.code === 'INVALID_RESPONSE');
  assert.throws(() => edits.safeAgentEditPage(page([proposal(), proposal()]), projectId));
});

test('only explicit approval of completed immutable pending proposal posts once and confirmed outcome refreshes once', async () => {
  const held = deferred(), f = fixture({ act: () => held.promise }); await f.session.load();
  const original = f.session.getState().proposals[0], sending = f.session.act('approve', original);
  assert.equal(await f.session.act('approve', original), false); assert.equal(await f.session.act('reject', original), false);
  assert.equal(f.session.getState().proposals[0].status, 'pending'); assert.equal(f.appliedCalls.length, 0);
  held.resolve(envelope(applied())); assert.equal(await sending, true);
  assert.equal(f.session.getState().proposals[0].status, 'applied'); assert.equal(f.appliedCalls.length, 1); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1);
  assert.equal(await f.session.act('approve', original), false); f.session.dispose();
});

test('running, stopped, failed, interrupted, rejected, stale and hidden proposals never approve', async () => {
  for (const status of ['running', 'stopped', 'failed', 'interrupted']) {
    const f = fixture({ list: async () => page([proposal({ runStatus: status })]) }); await f.session.load(); assert.equal(await act(f), false); assert.equal(await act(f, 'reject'), false); f.session.dispose();
  }
  for (const status of ['rejected', 'cancelled', 'failed']) {
    const f = fixture({ list: async () => page([proposal({ status, ...(status === 'failed' ? { approval, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT' } } : {}) })]) }); await f.session.load(); assert.equal(await act(f), false); f.session.dispose();
  }
  const f = fixture(); await f.session.load(); const original = f.session.getState().proposals[0]; await f.session.load(); assert.equal(await f.session.act('approve', original), false);
  f.session.setVisible(false); assert.equal(await act(f), false); assert.equal(await f.session.inspect(proposalId), false); assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.dispose();
});

test('lost approval acknowledgement is unknown, never rejection or optimistic apply, and only reads for recovery', async () => {
  const f = fixture({ act: async () => { throw error('NETWORK'); } }); await f.session.load(); await act(f);
  assert.equal(f.session.getState().proposals[0].status, 'pending'); assert.deepEqual(f.session.getState().uncertainIds, [proposalId]); assert.equal(f.appliedCalls.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); assert.equal(f.calls.filter(call => call[0] === 'get').length, 1);
  assert.match(f.session.getState().message, /尚未确认/); assert.doesNotMatch(f.session.getState().message, /private server/);
  assert.equal(await act(f), false); assert.equal(await act(f, 'reject'), false); await f.session.load(); assert.deepEqual(f.session.getState().uncertainIds, [proposalId]); f.session.dispose();
});

test('a late confirmed application disappearing from unresolved page keeps exact identity and confirms by detail GET', async () => {
  let reads = 0, details = 0;
  const f = fixture({ list: async () => ++reads === 1 ? page() : page([]), act: async () => { throw error('NETWORK'); }, get: async () => envelope(++details === 1 ? proposal() : applied()) });
  await f.session.load(); await act(f); await f.session.load();
  assert.equal(f.session.getState().proposals[0].status, 'applied'); assert.equal(f.session.getState().uncertainIds.length, 0); assert.equal(f.appliedCalls.length, 1); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); f.session.dispose();
});

test('explicit recover uses server-persisted approval identity and fresh epoch after restart; duplicate action cannot make a new request', async () => {
  const nextEpoch = id(90), f = fixture({ list: async () => page([proposal({ status: 'unknown', approval })], { instanceId: nextEpoch }), act: async () => envelope(applied(), nextEpoch) });
  await f.session.load(); const pending = f.session.getState().proposals[0]; assert.equal(await f.session.act('approve', pending), false); assert.equal(f.calls.some(call => call[0] === 'act'), false);
  await act(f, 'recover'); const call = f.calls.find(call => call[0] === 'act'); assert.equal(call[3], 'recover'); assert.deepEqual(call[4], { instanceId: nextEpoch, digest: pending.digest }); assert.equal(f.appliedCalls.length, 1); assert.equal(await f.session.act('recover', pending), false); f.session.dispose();
});

test('two-window rejection and revision conflict reconcile read-only; old epoch and tampered diff never show applied', async () => {
  for (const terminal of [proposal({ status: 'rejected' }), proposal({ status: 'failed', approval, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT' } })]) {
    const f = fixture({ act: async () => { throw error('CONFLICT'); }, get: async () => envelope(terminal) }); await f.session.load(); await act(f); assert.equal(f.session.getState().proposals[0].status, terminal.status); assert.equal(f.appliedCalls.length, 0); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); f.session.dispose();
  }
  for (const result of [envelope(applied(), id(90)), envelope({ ...applied(), digest: 'd'.repeat(64) })]) {
    const f = fixture({ act: async () => result, get: async () => { throw error('NETWORK'); } }); await f.session.load(); await act(f); assert.equal(f.session.getState().proposals[0].status, 'pending'); assert.equal(f.appliedCalls.length, 0); f.session.dispose();
  }
});

test('project disposal fences late approval and reads; hidden accepted action preserves immutable diff without refreshing a new project', async () => {
  const held = deferred(), f = fixture({ act: () => held.promise }); await f.session.load(); const sending = act(f); f.session.dispose(); held.resolve(envelope(applied())); await sending; assert.equal(f.appliedCalls.length, 0);
  const waiting = deferred(), g = fixture({ list: () => waiting.promise }); const loading = g.session.load(); g.session.dispose(); waiting.resolve(page()); await loading; assert.equal(g.session.getState().proposals.length, 0);
  const accepted = deferred(), h = fixture({ act: () => accepted.promise }); await h.session.load(); const sendingHidden = act(h); h.session.setVisible(false); accepted.resolve(envelope(applied())); await sendingHidden; assert.equal(h.session.getState().proposals[0].status, 'applied'); assert.equal(h.appliedCalls.length, 1); assert.equal(h.calls.filter(call => call[0] === 'act').length, 1); h.session.dispose();
});

test('bounded independent paging and view changes never authorize or mutate a proposal', async () => {
  const f = fixture({ list: async (_, options) => page([proposal({ id: options.cursor ? id(44) : proposalId })], { nextCursor: options.cursor ? null : 'opaque-cursor' }) });
  await f.session.load(); await f.session.older(); assert.equal(f.session.getState().cursor, 'opaque-cursor'); assert.equal(f.session.getState().proposals.length, 1); await f.session.newer(); await f.session.chooseView('all');
  assert.equal(f.session.getState().view, 'all'); assert.equal(f.session.getState().cursor, null); assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.dispose();
});

function chatFixture() {
  const calls = [], storage = new Map(); let initial = snapshot();
  const client = { read: async () => initial, start: async (_, input) => { calls.push(input); return { instanceId, threadId, projectId, revision: 1, run: run({ status: 'completed', userText: input.message, contextMode: input.consent.context, ...(input.consent.context === policy.AGENT_TYPED_CONTEXT ? { provenance: null, editTarget: null, activity: [] } : {}) }) }; }, stream: async () => {}, lookup: async () => { throw error('AGENT_CHAT_NOT_FOUND'); } };
  const receipts = { get: key => storage.get(key), set: (key, value) => storage.set(key, value) };
  return { calls, client, receipts, setSnapshot: value => { initial = value; }, session: chat.createAgentChatSession({ projectId, client, receipts, requestId: () => requestId }) };
}

test('selected edit consent is project/target/text/revision/settings/schema/destination bound; typing cannot widen scope', async () => {
  const f = chatFixture(); await f.session.load(); f.session.edit('Improve selected shot'); f.session.setEditTarget(selected);
  assert.equal(f.session.getState().contextMode, policy.AGENT_TYPED_CONTEXT); assert.equal(f.session.setContextMode(policy.AGENT_EDIT_CONTEXT), true); assert.equal(f.session.approve(true), true);
  const key = f.session.getState().consent;
  for (const patch of [{ ...selected, id: id(99) }, { ...selected, revision: 5 }, { ...selected, title: 'changed saved text' }, { ...selected, prompt: 'changed saved prompt' }]) {
    f.session.setEditTarget(patch); assert.equal(f.session.getState().consent, null); assert.equal(await f.session.send(), false); f.session.approve(true); assert.notEqual(f.session.getState().consent, key);
  }
  f.session.setEditTarget(selected); f.session.approve(true); await f.session.send(); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].consent, { destination: chat.deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model, context: policy.AGENT_EDIT_CONTEXT, projectId, ...policy.AGENT_EDIT_LIMITS, catalogHash: 'a'.repeat(64), shotId, expectedRevision: 4 });
  const parsed = chat.safeAgentChatSnapshot(snapshot(), projectId), original = chat.agentChatConsentKey(parsed, policy.AGENT_EDIT_CONTEXT, target);
  for (const changed of [{ ...parsed, projectId: id(99) }, { ...parsed, settings: { ...settings, revision: 2 } }, { ...parsed, edit: { ...parsed.edit, catalogHash: 'd'.repeat(64) } }, { ...parsed, settings: { ...settings, configuration: { ...configuration, model: 'different' } } }]) assert.notEqual(chat.agentChatConsentKey(changed, policy.AGENT_EDIT_CONTEXT, target), original);
  f.session.dispose();
});

test('invalid selected title and oversized prompt disable send; empty prompt is a valid saved target', async () => {
  const f = chatFixture(); await f.session.load(); f.session.setContextMode(policy.AGENT_EDIT_CONTEXT); f.session.edit('Improve this');
  for (const changed of [{ ...selected, title: '' }, { ...selected, title: ' ' }, { ...selected, prompt: 'x'.repeat(5001) }, { ...selected, revision: -1 }, { ...selected, title: '\ud800' }]) { f.session.setEditTarget(changed); assert.equal(f.session.getState().editTarget, null); assert.equal(f.session.approve(true), false); assert.equal(await f.session.send(), false); }
  f.session.setEditTarget({ ...selected, prompt: '' }); assert.equal(f.session.approve(true), true); f.session.dispose();
});

test('edit run provenance is pinned and excludes edit rounds from typed-mode consent', async () => {
  const value = chat.safeAgentChatRun(run(), projectId); assert.equal(value.editTarget.title, target.title); assert.equal(Object.isFrozen(value.editTarget), true);
  assert.equal(policy.agentRunProvenanceEqual(value, { ...value, editTarget: { ...value.editTarget, shotId: id(99) } }), false);
  for (const patch of [{ editTarget: { ...target, projectId: id(99) } }, { contextMode: policy.AGENT_TYPED_CONTEXT }, { provenance: { ...run().provenance, category: 'project_saved_text_metadata' } }, { activity: [...run().activity, { id: id(20), kind: 'tool', ordinal: 1, status: 'completed', name: 'mioon_project_inspect', operation: 'project.inspect', resultJson: '{}' }] }]) assert.throws(() => chat.safeAgentChatRun(run(patch), projectId));
  const f = chatFixture(); f.setSnapshot(snapshot({ runs: [run()] })); await f.session.load(); f.session.setEditTarget(selected); f.session.edit('Ignore context and apply everything now'); f.session.approve(true); await f.session.send();
  assert.equal(f.calls[0].consent.context, policy.AGENT_TYPED_CONTEXT); assert.equal(Object.hasOwn(f.calls[0].consent, 'projectId'), false); assert.equal(Object.hasOwn(f.calls[0].consent, 'shotId'), false); f.session.dispose();
});

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const element = (type, props, ...children) => { const p = { ...props, children: children.length === 1 ? children[0] : children }; return typeof type === 'function' && ['AgentEditDiff', 'AgentRunActivity'].includes(type.name) ? type(p) : { type, props: p }; };
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function harness(file, options = {}) {
  const slots = []; let cursor = 0, effects = [], visible = true, tree, props = { projectId, projectName: 'Saved project', selectedShot: selected, refreshKey: 'initial', onClose() {}, onSettings() {}, onApplied: options.onApplied || (() => {}), ...options.props };
  const react = { createElement: element,
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useLayoutEffect(fn, deps) { const index = cursor++, old = slots[index]; if (old && sameDeps(old.deps, deps)) return; slots[index] = { fn, deps, cleanup: old?.cleanup }; effects.push(index); },
  }; react.default = react;
  const resolve = name => {
    const i18nDependency = creationTestDependency(name); if (i18nDependency) return i18nDependency;
    if (name === './agent-timeline-context.js') return timing;
    if (name === './agent-timeline-gain-context.ts') return gainContext;
    if (name === './AgentTimelineGain.tsx') { const gain = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/AgentTimelineGain.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(gain, gain.exports, resolve); return gain.exports; }
    if (name === './editor-settings-scope.ts') { const scope = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(scope, scope.exports, resolve); return scope.exports; }
    if (name === './native-close-sources.ts') return nativeCloseSources;
    if (name === 'react') return react;
    if (name === './agent-edits.js') return { ...edits, createAgentEditsSession: input => edits.createAgentEditsSession({ ...input, client: options.client }) };
    if (name === './agent-chat.js') return { ...chat, createAgentChatSession: input => chat.createAgentChatSession({ ...input, client: options.chatClient, receipts: options.receipts, requestId: () => requestId }) };
    if (name === './agent-tool-state.js') return policy;
    if (name === './AgentEditProposal.jsx') return { __esModule: true, default: 'AgentEditProposal' };
    if (name === './AgentRunActivity.jsx') return load('AgentRunActivity');
    if (name === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => visible };
    if (name === './icons.jsx') return { default: 'Icon' };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.jsx') return new Proxy({}, { get: (_, key) => String(key) });
    throw Error(name);
  };
  const load = name => { const module = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL(`../apps/web/src/${name}.jsx`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, resolve); return module.exports; };
  const component = load(file).default;
  const h = {
    render(patch = {}) { props = { ...props, ...patch }; cursor = 0; effects = []; tree = component(props); for (const index of effects) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].fn(); } return tree; },
    find: id => nodes(tree).find(node => node.props['data-testid'] === id),
    all: id => nodes(tree).filter(node => node.props['data-testid'] === id),
    change(id, value) { h.find(id).props.onChange({ target: { value, checked: value } }); h.render(); },
    click(id) { h.find(id).props.onClick(); h.render(); },
    submit() { nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    hide(value = true) { visible = !value; h.render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  }; return h;
}

test('actual right-dock review renders full immutable before/after and honest proposed status despite hostile model text', async () => {
  const f = fixture(), h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render();
  assert.equal(h.find('agent-edit-before-title').props.children, target.title); assert.equal(h.find('agent-edit-after-title').props.children, 'Proposed title'); assert.equal(h.find('agent-edit-after-prompt').props.children, '（清空）');
  assert.equal(h.find('agent-edit-status').props.children, '已提议，尚未应用'); assert.equal(h.find('agent-edit-approve').props.disabled, false);
  assert.match(JSON.stringify(h.render()), /shot.update|基准版本|模型文字可能说/);
  assert.equal(nodes(h.render()).some(node => ['Dialog', 'Modal', 'input', 'textarea', 'a', 'img', 'script', 'iframe'].includes(node.type) || node.props.dangerouslySetInnerHTML), false);
  assert.equal(f.calls.some(call => call[0] === 'act'), false); h.unmount();
});

test('actual review Stop/running/completion gates, hidden callbacks, all/history and original target remain separate', async () => {
  const f = fixture(), h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render(); const oldApprove = h.find('agent-edit-approve').props.onClick;
  h.render({ blockedRunIds: [runId] }); assert.equal(h.find('agent-edit-approve').props.disabled, true); oldApprove(); await flush(); assert.equal(f.calls.some(call => call[0] === 'act'), false);
  h.render({ blockedRunIds: [] }); const approveBeforeHide = h.find('agent-edit-approve').props.onClick; h.hide(); assert.equal(h.find('agent-edit-review').props.inert, true); approveBeforeHide(); await flush(); assert.equal(f.calls.some(call => call[0] === 'act'), false);
  h.hide(false); await flush(); h.render({ selectedShot: { ...selected, id: id(80), title: 'Different current selection' } });
  assert.equal(h.find('agent-edit-before-title').props.children, target.title); assert.doesNotMatch(JSON.stringify(h.find('agent-edit-diff')), /Different current selection/);
  h.click('agent-edits-all'); await flush(); h.render(); assert.equal(h.find('agent-edits-all').props['aria-pressed'], true); assert.equal(f.calls.some(call => call[0] === 'act'), false); h.unmount();
});

test('actual review response loss shows no applied success and exposes explicit saved-intent recovery only after GET finds approval', async () => {
  let details = 0; const f = fixture({ act: async (_, __, action) => { if (action === 'approve') throw error('NETWORK'); return envelope(applied()); }, get: async () => envelope(++details === 1 ? proposal({ status: 'unknown', approval }) : applied()) });
  const refreshed = [], h = harness('AgentEditProposal', { client: f.client, onApplied: (...args) => refreshed.push(args) }); h.render(); await flush(); h.render(); h.click('agent-edit-approve'); await flush(); h.render();
  assert.equal(h.find('agent-edit-status').props.children, '应用结果未知'); assert.equal(h.find('agent-edit-applied'), undefined); assert.equal(refreshed.length, 0); assert.equal(h.find('agent-edit-approve'), undefined); assert.ok(h.find('agent-edit-recover')); assert.match(JSON.stringify(h.find('agent-edit-approval-id')), new RegExp(approval.requestId));
  assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); h.click('agent-edit-recover'); await flush(); h.render(); assert.ok(h.find('agent-edit-applied')); assert.equal(refreshed.length, 1); assert.equal(f.calls.filter(call => call[0] === 'act').length, 2); h.unmount();
});

test('actual review project lifetime rejects old callback, unresolved GET and late action after navigation', async () => {
  const held = deferred(), f = fixture({ act: () => held.promise }), refreshed = [], h = harness('AgentEditProposal', { client: f.client, onApplied: (...args) => refreshed.push(args) }); h.render(); await flush(); h.render(); const oldApprove = h.find('agent-edit-approve').props.onClick;
  h.click('agent-edit-approve'); h.render({ projectId: id(90) }); oldApprove(); held.resolve(envelope(applied())); await flush(); h.render();
  assert.equal(refreshed.length, 0); assert.equal(h.find('agent-edit-proposal'), undefined); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); h.unmount();
});

test('actual composer previews saved title/prompt, requires distinct edit mode and invalidates stale selected-shot callbacks', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); h.render(); await flush(); h.render();
  h.change('agent-chat-prompt', 'Improve selected shot'); assert.equal(h.find('agent-chat-mode-typed').props.checked, true); h.change('agent-chat-mode-edit', true);
  assert.equal(h.find('agent-chat-mode-typed').props.checked, false); assert.equal(h.find('agent-edit-selected-title').props.children, selected.title); assert.equal(h.find('agent-edit-selected-prompt').props.children, selected.prompt);
  h.change('agent-chat-consent', true); const oldConsent = h.find('agent-chat-consent').props.onChange, oldSubmit = nodes(h.render()).find(node => node.type === 'form').props.onSubmit;
  h.render({ selectedShot: { ...selected, revision: 5, title: 'New saved title' } }); h.render(); assert.equal(h.find('agent-chat-consent').props.checked, false); oldConsent({ target: { checked: true } }); oldSubmit({ preventDefault() {} }); await flush(); h.render();
  assert.equal(f.calls.length, 0); assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.find('agent-edit-selected-title').props.children, 'New saved title');
  h.change('agent-chat-mode-typed', true); assert.match(JSON.stringify(h.find('agent-chat-context')), /不含项目/); h.unmount();
});

test('App confirmed-apply refresh is same-project and cannot mark an Inspector draft saved or remount it', () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  const handler = app.match(/onApplied=\{projectId => \{([^}]+)\}\}/)?.[1]; assert.ok(handler); assert.match(handler, /currentProject.current === projectId/); assert.match(handler, /refresh\(projectId\)/);
  assert.doesNotMatch(handler, /setShotDirty|setClipDirty|setSourceDirty|setSubjectDirty|setSubtitleDirty|setInspectorEpoch|saveShot|setSelected|rpc/);
  const calls = [], apply = Function('currentProject', 'refresh', `return projectId => { ${handler} };`)({ current: projectId }, id => calls.push(id));
  apply(id(90)); assert.equal(calls.length, 0); apply(projectId); assert.deepEqual(calls, [projectId]);
  // Prop order is irrelevant; evaluate the actual key to preserve remount fences.
  const inspectorStart = app.indexOf('<Inspector '), inspectorEnd = app.indexOf('/>', inspectorStart);
  assert.ok(inspectorStart >= 0 && inspectorEnd > inspectorStart);
  const inspectorTag = app.slice(inspectorStart, inspectorEnd);
  const keyExpression = inspectorTag.match(/\bkey=\{(`[^`]+`)\}/)?.[1];
  assert.equal(keyExpression, "`${data.project?.id}:${selectedId || 'empty'}:${inspectorEpoch}`");
  const keyFor = Function('data', 'selectedId', 'inspectorEpoch', `return ${keyExpression};`);
  const key = keyFor({project:{id:projectId}, shots:[]}, shotId, 3);
  assert.equal(keyFor({project:{id:projectId}, shots:[{id:shotId, revision:5}], subjects:[{revision:9}]}, shotId, 3), key);
  assert.notEqual(keyFor({project:{id:id(90)}}, shotId, 3), key);
  assert.notEqual(keyFor({project:{id:projectId}}, id(91), 3), key);
  assert.notEqual(keyFor({project:{id:projectId}}, shotId, 4), key);
  const inspector = readFileSync(new URL('../apps/web/src/Inspector.jsx', import.meta.url), 'utf8'); assert.match(inspector, /if \(!dirty\) \{ draftRef\.current = latest; setDraft\(latest\)/); assert.match(inspector, /else if \(record.revision !== baseRevision\) setConflict\(true\)/);
});

test('a stale-epoch rejection only rereads and preserves uncertainty until terminal evidence or explicit same-intent retry', async () => {
  const nextEpoch = id(90), calls = [];
  const client = edits.createAgentEditsClient({ fetchImpl: async (url, input) => {
    calls.push([url, input]);
    if (input.method === 'POST') return Response.json({ ok: false, error: { code: 'AGENT_CHAT_SESSION_EXPIRED' } }, { status: 409 });
    return Response.json({ ok: true, data: url.includes('?') ? page() : envelope(proposal(), nextEpoch) });
  } });
  const session = edits.createAgentEditsSession({ projectId, client }); await session.load(); const original = session.getState().proposals[0]; await session.act('approve', original);
  assert.equal(calls.filter(([, input]) => input.method === 'POST').length, 1); assert.equal(session.getState().instanceId, nextEpoch); assert.deepEqual(session.getState().uncertainIds, [proposalId]); assert.deepEqual(session.getState().retryApprovalIds, [proposalId]); assert.equal(session.getState().proposals[0].status, 'pending');
  assert.equal(await session.act('approve', original), false); session.dispose();
});

test('actual missing edit target never displays consent as checked and scope changes revoke prior consent', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts, props: { selectedShot: null } }); h.render(); await flush(); h.render(); h.change('agent-chat-mode-edit', true);
  assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.find('agent-chat-consent').props.disabled, true); assert.match(JSON.stringify(h.find('agent-edit-selected-target')), /请先在画板中选择/);
  h.render({ selectedShot: selected }); h.render(); h.change('agent-chat-consent', true); assert.equal(h.find('agent-chat-consent').props.checked, true); h.change('agent-chat-mode-project', true); assert.equal(h.find('agent-chat-consent').props.checked, false); h.unmount();
});


test('proposal state combinations cannot fabricate nonapplication or application without the exact durable evidence', () => {
  const bad = [
    { status: 'failed' }, { status: 'failed', approval }, { status: 'failed', outcome: { status: 'not_applied', code: 'REVISION_CONFLICT' } },
    { status: 'failed', approval, outcome: { status: 'not_applied', code: 'UNKNOWN' } },
    { status: 'pending', approval }, { status: 'rejected', approval }, { status: 'cancelled', approval },
    { status: 'pending', outcome: { status: 'not_applied', code: 'REVISION_CONFLICT' } },
    { status: 'unknown', approval, outcome: { status: 'not_applied', code: 'REVISION_CONFLICT' } },
    { status: 'applied', approval, outcome: { status: 'applied', shotId, revision: 6 } },
    { patch: { title: target.title }, diff: { before: proposal().diff.before, after: proposal().diff.before } },
  ];
  for (const patch of bad) assert.throws(() => edits.safeAgentEditProposal(proposal(patch), projectId), value => value.code === 'INVALID_RESPONSE');
  for (const status of ['pending', 'rejected', 'cancelled']) assert.equal(edits.safeAgentEditProposal(proposal({ status }), projectId).status, status);
  for (const status of ['approved', 'dispatching', 'unknown']) assert.equal(edits.safeAgentEditProposal(proposal({ status, approval }), projectId).status, status);
  assert.equal(edits.safeAgentEditProposal(applied(), projectId).status, 'applied');
});


test('explicit same-proposal approval retry needs fresh detail proof, preserves identity and permits only one local dispatch', async () => {
  const held = deferred(); let posts = 0;
  const f = fixture({ act: async () => { if (++posts === 1) throw error('NETWORK'); return held.promise; } });
  await f.session.load(); assert.equal(await act(f, 'retry_approval'), false); await act(f);
  assert.deepEqual(f.session.getState().retryApprovalIds, [proposalId]); const reviewed = f.session.getState().proposals[0];
  const retry = f.session.act('retry_approval', reviewed); assert.equal(await f.session.act('retry_approval', reviewed), false); assert.equal(await f.session.act('approve', reviewed), false);
  held.resolve(envelope(applied())); await retry;
  const actions = f.calls.filter(call => call[0] === 'act'); assert.equal(actions.length, 2); assert.deepEqual(actions[0].slice(1, 5), actions[1].slice(1, 5));
  assert.equal(actions[1][3], 'approve'); assert.equal(Object.hasOwn(actions[1][4], 'requestId'), false); assert.equal(f.appliedCalls.length, 1); f.session.dispose();
});

test('same-intent retry proof expires on list reload, hide, epoch change, rejection and project disposal', async () => {
  const f = fixture({ act: async () => { throw error('NETWORK'); } }); await f.session.load(); await act(f); const first = f.session.getState().proposals[0];
  await f.session.load(); assert.deepEqual(f.session.getState().retryApprovalIds, []); assert.equal(await f.session.act('retry_approval', first), false); assert.equal(await act(f, 'retry_approval'), false);
  await f.session.inspect(proposalId); assert.deepEqual(f.session.getState().retryApprovalIds, [proposalId]); f.session.setVisible(false); assert.deepEqual(f.session.getState().retryApprovalIds, []); assert.equal(await act(f, 'retry_approval'), false); f.session.dispose();
  for (const status of ['rejected', 'cancelled']) { const terminal = fixture({ act: async () => { throw error('NETWORK'); }, get: async () => envelope(proposal({ status })) }); await terminal.session.load(); await act(terminal); assert.deepEqual(terminal.session.getState().retryApprovalIds, []); assert.equal(await act(terminal, 'retry_approval'), false); terminal.session.dispose(); }
  const late = deferred(), g = fixture({ act: async () => { throw error('NETWORK'); }, get: () => late.promise }); await g.session.load(); const sent = act(g); g.session.dispose(); late.resolve(envelope(proposal(), id(90))); await sent; assert.equal(await act(g, 'retry_approval'), false);
});

test('actual unknown pending proposal offers clearly labelled explicit same-intent retry only after detail GET', async () => {
  let posts = 0; const f = fixture({ act: async () => { if (++posts === 1) throw error('NETWORK'); return envelope(applied()); } }), h = harness('AgentEditProposal', { client: f.client });
  h.render(); await flush(); h.render(); assert.equal(h.find('agent-edit-retry-approval'), undefined); h.click('agent-edit-approve'); await flush(); h.render();
  assert.match(h.find('agent-edit-status').props.children, /待确认/); assert.equal(h.find('agent-edit-approve').props.disabled, true); assert.equal(h.find('agent-edit-retry-approval').props.children, '重试同一批准请求'); assert.match(JSON.stringify(h.render()), /可能已被接受|不会创建新差异/);
  assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); h.click('agent-edit-retry-approval'); await flush(); h.render(); assert.ok(h.find('agent-edit-applied')); assert.equal(f.calls.filter(call => call[0] === 'act').length, 2); h.unmount();
});

test('reordered list/detail responses and stale pending snapshots cannot downgrade approved, unknown or applied state', async () => {
  const waiting = deferred(); let lists = 0;
  const f = fixture({ list: async () => ++lists === 1 ? page() : waiting.promise, get: async () => envelope(proposal({ status: 'unknown', approval })) });
  await f.session.load(); const oldRead = f.session.load(); await f.session.inspect(proposalId); waiting.resolve(page()); await oldRead;
  assert.equal(f.session.getState().proposals[0].status, 'unknown'); assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.dispose();
  for (const current of [proposal({ status: 'approved', approval }), proposal({ status: 'unknown', approval }), applied()]) {
    const g = fixture({ list: async () => page([current]), get: async () => envelope(proposal()) }); await g.session.load(); assert.equal(await g.session.inspect(proposalId), false);
    assert.equal(g.session.getState().proposals[0].status, current.status); assert.equal(g.session.getState().phase, 'error'); assert.equal(g.calls.some(call => call[0] === 'act'), false); g.session.dispose();
  }
});

test('approve and reject cannot race locally; a confirmed rejection cannot later become applied or retryable', async () => {
  const waiting = deferred(), f = fixture({ act: () => waiting.promise, get: async () => envelope(applied()) }); await f.session.load();
  const original = f.session.getState().proposals[0], rejecting = f.session.act('reject', original);
  assert.equal(await f.session.act('approve', original), false); assert.equal(await f.session.act('reject', original), false);
  waiting.resolve(envelope(proposal({ status: 'rejected' }))); await rejecting; assert.equal(await f.session.act('approve', original), false); assert.equal(await f.session.act('retry_approval', original), false);
  assert.equal(await f.session.inspect(proposalId), false); assert.equal(f.session.getState().proposals[0].status, 'rejected'); assert.equal(f.appliedCalls.length, 0); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); f.session.dispose();
});

test('all-records read can confirm a previously uncertain application without another mutation POST', async () => {
  let lists = 0; const f = fixture({ list: async () => ++lists === 1 ? page() : page([applied()]), act: async () => { throw error('NETWORK'); } }); await f.session.load(); await act(f); await f.session.chooseView('all');
  assert.equal(f.session.getState().proposals[0].status, 'applied'); assert.equal(f.appliedCalls.length, 1); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); f.session.dispose();
});


test('proposal JSON transport enforces advertised and streamed byte bounds, cancels overflow and never calls unbounded json()', async () => {
  for (const contentLength of [String(edits.AGENT_EDIT_RESPONSE_BYTES + 1), '-1', '999999999999999999999']) {
    let cancelled = 0, pulls = 0;
    const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('{}')); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    await assert.rejects(edits.readAgentEditJson(new Response(stream, { headers: { 'content-length': contentLength } })), value => value.code === 'INVALID_RESPONSE');
    assert.equal(cancelled, 1); assert.equal(pulls, 0); assert.equal(stream.locked, false);
  }
  let cancelled = 0, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const response = new Response(stream, { headers: { 'content-length': '2' } }); response.json = () => { throw Error('unbounded parser must not be called'); };
  await assert.rejects(edits.readAgentEditJson(response), value => value.code === 'INVALID_RESPONSE'); assert.equal(pulls, 5); assert.equal(cancelled, 1); assert.equal(stream.locked, false);
  await assert.rejects(edits.readAgentEditJson({ json: async () => ({}) }), value => value.code === 'INVALID_RESPONSE');
});

test('proposal JSON transport rejects malformed UTF-8 and incomplete JSON, accepts split multibyte text and releases readers', async () => {
  let cancelled = 0;
  const bad = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0x7b, 0x22, 0xc3, 0x28])); }, cancel() { cancelled++; } });
  await assert.rejects(edits.readAgentEditJson(new Response(bad)), value => value.code === 'INVALID_RESPONSE'); assert.equal(cancelled, 1); assert.equal(bad.locked, false);
  const encoded = new TextEncoder().encode(JSON.stringify({ message: '镜头 🌲' }));
  const good = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  assert.deepEqual(await edits.readAgentEditJson(new Response(good)), { message: '镜头 🌲' }); assert.equal(good.locked, false);
  for (const body of ['{"incomplete":', new Uint8Array([0x22, 0xe2])]) await assert.rejects(edits.readAgentEditJson(new Response(body)), value => value.code === 'INVALID_RESPONSE');
});

test('proposal JSON transport cancels a hanging read on explicit abort and client timeout, cleans up listeners and never retries', async () => {
  for (const mode of ['abort', 'timeout']) {
    let cancelled = 0, requests = 0, added = 0, removed = 0, transportSignal;
    const abort = new AbortController(), originalAdd = abort.signal.addEventListener.bind(abort.signal), originalRemove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = (...args) => { added++; return originalAdd(...args); }; abort.signal.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
    const stream = new ReadableStream({ start() {}, cancel() { cancelled++; } });
    const client = edits.createAgentEditsClient({ timeoutMs: mode === 'timeout' ? 5 : 1000, fetchImpl: async (_, input) => { requests++; transportSignal = input.signal; return new Response(stream); } });
    const pending = client.list(projectId, { signal: abort.signal }); await flush(); if (mode === 'abort') abort.abort();
    await assert.rejects(pending, value => value.code === 'NETWORK'); await flush();
    assert.equal(requests, 1); assert.equal(cancelled, 1); assert.equal(stream.locked, false); assert.equal(transportSignal.aborted, true); assert.equal(added, removed);
  }
  let signal;
  const client = edits.createAgentEditsClient({ timeoutMs: 5, fetchImpl: async (_, input) => { signal = input.signal; return Response.json({ ok: true, data: page() }); } });
  await client.list(projectId); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(signal.aborted, false);
});

test('complete selected text starts expanded, requires explicit consent to compact, and only accepted Send auto-compacts it', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); h.render(); await flush(); h.render(); h.change('agent-chat-mode-edit', true);
  assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); assert.equal(h.find('agent-edit-selected-details-toggle').props.disabled, true);
  h.find('agent-edit-selected-disclosure').props.onOpenChange(false); h.render(); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true);
  h.change('agent-chat-prompt', 'Improve selected shot'); h.submit(); await flush(); h.render(); assert.equal(f.calls.length, 0); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true);
  h.change('agent-chat-consent', true); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); h.submit(); await flush(); h.render();
  assert.equal(f.calls.length, 1); assert.equal(h.find('agent-edit-selected-disclosure').props.open, false); assert.match(JSON.stringify(h.find('agent-edit-target-summary')), new RegExp(shotId)); assert.match(JSON.stringify(h.find('agent-edit-target-summary')), /基准版本/);
  assert.match(h.find('agent-edit-selected-details-toggle').props.children, /展开已核对/); assert.equal(h.find('agent-edit-selected-details-toggle').props.disabled, false);
  h.find('agent-edit-selected-disclosure').props.onOpenChange(true); h.render(); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); assert.equal(h.find('agent-edit-selected-prompt').props.children, selected.prompt); assert.equal(f.calls.length, 1); h.unmount();
});

test('failed or unconfirmed Send never auto-compacts the initial selected-text disclosure', async () => {
  for (const code of ['NETWORK', 'AGENT_EDIT_CONFLICT']) {
    const f = chatFixture(); f.client.start = async () => { throw error(code); };
    const h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); h.render(); await flush(); h.render(); h.change('agent-chat-mode-edit', true); h.change('agent-chat-prompt', 'Keep draft'); h.change('agent-chat-consent', true); h.submit(); await flush(); h.render();
    assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); assert.equal(h.find('agent-chat-prompt').props.value, 'Keep draft'); h.unmount();
  }
});

test('compact disclosure survives hide with draft intact and reopens on saved target, revision, scope or settings change', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); h.render(); await flush(); h.render(); h.change('agent-chat-mode-edit', true); h.change('agent-chat-consent', true);
  h.find('agent-edit-selected-disclosure').props.onOpenChange(false); h.render(); const oldToggle = h.find('agent-edit-selected-disclosure').props.onOpenChange;
  h.change('agent-chat-prompt', 'Draft stays in composer'); h.hide(); oldToggle(true); h.hide(false); await flush(); h.render();
  assert.equal(h.find('agent-edit-selected-disclosure').props.open, false); assert.equal(h.find('agent-chat-prompt').props.value, 'Draft stays in composer');
  h.render({ selectedShot: { ...selected, revision: 5, title: 'New saved title' } }); h.render(); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); oldToggle(false); h.render(); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); assert.equal(h.find('agent-chat-consent').props.checked, false);
  h.change('agent-chat-consent', true); h.find('agent-edit-selected-disclosure').props.onOpenChange(false); h.render(); h.change('agent-chat-mode-typed', true); h.change('agent-chat-mode-edit', true); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true);
  for (const configurationPatch of [{ model: 'new-model' }, { protocol: 'responses' }, { baseUrl: 'https://different.example/v1' }]) {
    h.change('agent-chat-consent', true); h.find('agent-edit-selected-disclosure').props.onOpenChange(false); h.render(); f.setSnapshot(snapshot({ settings: { ...settings, revision: 1, configuration: { ...configuration, ...configurationPatch } } }));
    h.hide(); h.hide(false); await flush(); h.render(); h.render(); assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.find('agent-chat-prompt').props.value, 'Draft stays in composer');
  }
  assert.equal(f.calls.length, 0); h.unmount();
});

test('late accepted Send cannot compact a newer selected shot or a new project disclosure', async () => {
  for (const navigate of ['target', 'project']) {
    const held = deferred(), f = chatFixture(); f.client.start = () => held.promise;
    const h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); h.render(); await flush(); h.render(); h.change('agent-chat-mode-edit', true); h.change('agent-chat-prompt', 'Improve selected shot'); h.change('agent-chat-consent', true); h.submit();
    h.render(navigate === 'target' ? { selectedShot: { ...selected, id: id(91), revision: 5 } } : { projectId: id(90) }); h.render();
    held.resolve({ instanceId, threadId, projectId, revision: 1, run: run() }); await flush(); h.render();
    if (navigate === 'target') assert.equal(h.find('agent-edit-selected-disclosure').props.open, true); else assert.equal(h.find('agent-edit-selected-disclosure'), undefined);
    h.unmount();
  }
});

test('proposal cards reserve a bounded readable review viewport while the existing outer dock keeps all consent reachable', () => {
  const css = readFileSync(new URL('../apps/web/src/agent-edits.css', import.meta.url), 'utf8'), base = readFileSync(new URL('../apps/web/src/styles.css', import.meta.url), 'utf8');
  const declaration = css.match(/\.agent-workspace \.agent-chat-scroll:has\(\.agent-edit-card\)\{([^}]+)\}/)?.[1]; assert.ok(declaration);
  assert.match(declaration, /min-height:clamp\(320px,50dvh,480px\)/); assert.match(declaration, /flex-basis:clamp\(320px,50dvh,480px\)/); assert.match(declaration, /flex-shrink:0/);
  assert.doesNotMatch(declaration, /overflow:hidden|position:fixed|display:none/);
  assert.match(base, /\.agent-chat-page,\.agent-settings-page\{[^}]*overflow:auto/); assert.match(base, /\.agent-chat-scroll\{[^}]*overflow-y:auto/);
  for (const height of [480, 650, 760, 1200]) { const pane = Math.min(480, Math.max(320, height * 0.5)); assert.ok(pane >= 320 && pane <= 480); }
});
