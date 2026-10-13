import * as timing from '../apps/web/src/agent-timeline-context.js';
import * as gainContext from '../apps/web/src/agent-timeline-gain-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.js';
import { projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind } from '../apps/web/src/project-open-state.ts';
import { createSettingsNavigationRegistry } from '../apps/web/src/settings-navigation-state.ts';
import * as logic from '../apps/web/src/agent-chat.js';
import * as toolLogic from '../apps/web/src/agent-tool-state.js';

const { createAgentChatClient, createAgentChatSession, createAgentChatReceipts, safeAgentChatSnapshot, safeAgentChatRun, readAgentChatSSE, agentChatCanSend, agentChatPromptIssue, agentChatErrorText } = logic;
const projectId = 'project-one', instanceId = '11111111-1111-4111-8111-111111111111', nextInstance = '99999999-9999-4999-8999-999999999999';
const threadId = '44444444-4444-4444-8444-444444444444';
const runId = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333';
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://api.example.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions' };
const settings = (patch = {}) => ({ revision: 0, configuration: { ...configuration }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], ...configuration }] }], scope: 'settings_only', verification: 'not_tested', ...patch });
const run = (patch = {}) => ({ id: runId, requestId, threadId, projectId, status: 'running', userText: 'A typed question', assistantText: '', configuration: { ...configuration }, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', lastEventId: 1, ...patch });
const snapshot = (patch = {}) => ({ instanceId, threadId, projectId, revision: 0, historyCursor: null, scope: 'chat_only', persistence: 'local_database', mode: 'simulated', settings: settings(), runs: [], ...patch });
const envelope = (value = run(), revision = 1) => ({ instanceId, threadId, projectId, revision, run: value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const error = code => Object.assign(Error('raw-private-provider-secret'), { code });
const memoryReceipts = () => { const data = new Map(); return { get: id => data.get(id), set: (id, value) => data.set(id, value), data }; };
function fixture({ initial = snapshot(), read, start, stop, getRun, lookup, history, stream, receipts = memoryReceipts(), owner = projectId } = {}) {
  const calls = [], events = [], changes = [];
  const client = {
    read: async (...args) => { calls.push(['read', ...args]); return read ? read(...args) : structuredClone(initial); },
    lookup: async (...args) => { calls.push(['lookup', ...args]); if (lookup) return lookup(...args); throw error('AGENT_CHAT_NOT_FOUND'); },
    history: async (...args) => { calls.push(['history', ...args]); return history ? history(...args) : { instanceId, threadId, projectId: owner, revision: 0, runs: [], historyCursor: null }; },
    start: async (...args) => { calls.push(['start', ...args]); return start ? start(...args) : envelope(run({ userText: args[1].message })); },
    stop: async (...args) => { calls.push(['stop', ...args]); return stop ? stop(...args) : envelope(run({ status: 'stopped', assistantText: 'partial', lastEventId: 3 }), 2); },
    run: async (...args) => { calls.push(['run', ...args]); return getRun ? getRun(...args) : envelope(run()); },
    stream: (...args) => { calls.push(['stream', ...args.slice(0, 4)]); events.push(args[4]); return stream ? stream(...args) : new Promise(resolve => args[4].signal.addEventListener('abort', resolve, { once: true })); },
  };
  const session = createAgentChatSession({ projectId: owner, client, receipts, requestId: () => requestId, onChange: next => changes.push(structuredClone(next)) });
  return { client, session, calls, events, changes, receipts };
}
const ready = async f => { await f.session.load(); f.session.edit('A typed question'); f.session.approve(true); };
const frame = (patch = {}) => ({ id: 2, type: 'delta', instanceId, threadId, projectId, runId, revision: 1, text: 'Hello', ...patch });

test('safe DTO excludes arbitrary error bodies, internals and credentials, bounds output/history and enforces ownership', () => {
  const value = snapshot({ extra: 'raw-private', settings: settings({ value: 'raw-private' }), runs: [run({ apiKey: 'raw-private', error: { code: 'raw-private', message: 'raw-private', details: { value: 'raw-private' } } })] });
  assert.doesNotMatch(JSON.stringify(safeAgentChatSnapshot(value, projectId)), /raw-private|apiKey|details/);
  for (const patch of [{ mode: 'bypass' }, { persistence: 'durable' }, { projectId: 'other' }, { runs: Array(17).fill(run()) }, { runs: [run(), run()] }]) assert.throws(() => safeAgentChatSnapshot(snapshot(patch), projectId));
  assert.throws(() => safeAgentChatRun(run({ assistantText: '密'.repeat(50000) }), projectId));
  assert.throws(() => safeAgentChatRun(run({ userText: '密'.repeat(3000) }), projectId));
  assert.throws(() => safeAgentChatRun(run({ projectId: 'other' }), projectId));
  assert.match(agentChatErrorText('AGENT_CHAT_PROFILE_UNSUPPORTED'), /不支持/); assert.match(agentChatErrorText('AGENT_CHAT_TIMEOUT'), /超时/);
});

test('UTF-8 prompt bounds and control-character check preserve ordinary multiline text', () => {
  assert.equal(agentChatPromptIssue('hello\n\t世界'), '');
  for (const value of ['', ' ', 'a\u0000b', 'a\u007fb', 'x'.repeat(8193), '密'.repeat(2731)]) assert.notEqual(agentChatPromptIssue(value), '');
});

test('HTTP client routes only authenticated same-origin API, uses instance-bound reads and exact consent body', async () => {
  const calls = []; const values = [snapshot(), envelope(), envelope(), envelope(run({ status: 'stopped' }), 2)];
  const client = createAgentChatClient({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, data: values.shift() }) }; } });
  await client.read(projectId);
  const input = { requestId, instanceId, expectedSettingsRevision: 0, expectedConversationRevision: 0, message: 'typed only', consent: { destination: `${configuration.baseUrl}/chat/completions`, protocol: configuration.protocol, model: configuration.model, context: 'typed_chat_only' } };
  await client.start(projectId, input); await client.run(projectId, runId, instanceId); await client.stop(projectId, runId, instanceId);
  assert.deepEqual(calls.map(call => [call.method, call.credentials, call.cache]), [['GET', 'same-origin', 'no-store'], ['POST', 'same-origin', 'no-store'], ['GET', 'same-origin', 'no-store'], ['POST', 'same-origin', 'no-store']]);
  assert.deepEqual(JSON.parse(calls[1].body), input); assert.deepEqual(JSON.parse(calls[3].body), { instanceId });
  assert.equal(calls[2].url, `/api/agent/chat/${projectId}/runs/${runId}?instanceId=${instanceId}`);
});

test('HTTP errors and thrown provider text cannot leak; timeout never repeats a POST', async () => {
  const held = deferred(); let requests = 0, signal;
  const client = createAgentChatClient({ timeoutMs: 5, fetchImpl: (_, options) => { requests++; signal = options.signal; return held.promise; } });
  await assert.rejects(client.start(projectId, { instanceId }), value => value.code === 'NETWORK' && !value.message.includes('raw-private'));
  assert.equal(requests, 1); assert.equal(signal.aborted, true); held.resolve({ ok: true, json: async () => ({ ok: true, data: envelope() }) }); await flush(); assert.equal(requests, 1);
  const unsafe = createAgentChatClient({ fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'raw-private', message: 'raw-private' } }) }) });
  await assert.rejects(unsafe.read(projectId), value => !JSON.stringify(value).includes('raw-private') && !value.message.includes('raw-private'));
});

test('SSE parser handles every UTF-8 byte split, CRLF, comments and duplicate frames as data', async () => {
  const data = frame({ text: '你好 🎬' }); const wire = new TextEncoder().encode(`: keepalive\r\n\r\nid: 2\r\nevent: delta\r\ndata: ${JSON.stringify(data)}\r\n\r\n`);
  const frames = [], body = new ReadableStream({ start(controller) { for (const byte of wire) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  await readAgentChatSSE(body, value => frames.push(value)); assert.equal(frames.length, 1); assert.equal(frames[0].data.text, '你好 🎬');
  const broken = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"x":1}\n')); controller.close(); } });
  await assert.rejects(readAgentChatSSE(broken, () => assert.fail('incomplete frame dispatched')));
});

test('first send requires explicit revision-bound consent and forwards only exact typed text', async () => {
  const f = fixture(); await f.session.load(); f.session.edit('A typed question'); assert.equal(await f.session.send(), false);
  f.session.approve(true); assert.equal(agentChatCanSend(f.session.getState()), true); await f.session.send();
  const input = f.calls.find(call => call[0] === 'start')[2];
  assert.deepEqual(Object.keys(input).sort(), ['consent', 'expectedConversationRevision', 'expectedSettingsRevision', 'instanceId', 'message', 'requestId']);
  assert.deepEqual(input.consent, { destination: `${configuration.baseUrl}/chat/completions`, protocol: configuration.protocol, model: configuration.model, context: 'typed_chat_only' });
  assert.equal(input.message, 'A typed question'); assert.equal(f.session.getState().draft, ''); f.session.dispose();
});

test('double send is synchronously blocked and consent must be renewed after completion', async () => {
  const held = deferred(), f = fixture({ start: () => held.promise }); await ready(f); const first = f.session.send(); assert.equal(await f.session.send(), false);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); held.resolve(envelope()); await first;
  f.events[0].onEvent(frame()); f.events[0].onEvent(frame({ id: 3, type: 'terminal', revision: 2, run: run({ status: 'completed', assistantText: 'Hello', lastEventId: 3 }) }));
  f.session.edit('next'); assert.equal(agentChatCanSend(f.session.getState()), false); assert.equal(f.session.getState().phase, 'ready'); f.session.dispose();
});

test('duplicate SSE frames never duplicate output and out-of-order or cross-project callbacks cannot change another run', async () => {
  const f = fixture(); await ready(f); await f.session.send(); const listener = f.events[0].onEvent;
  listener(frame()); listener(frame()); listener(frame({ projectId: 'other', id: 3, text: 'wrong' })); listener(frame({ instanceId: nextInstance, id: 3, text: 'wrong' }));
  assert.equal(f.session.getState().snapshot.runs[0].assistantText, 'Hello');
  assert.throws(() => listener(frame({ id: 5, text: 'missing segment' }))); f.session.dispose();
});

test('closing detaches without stopping, and reopen reads/replays existing cursor without another send', async () => {
  const receipts = memoryReceipts(), f = fixture({ receipts }); await ready(f); await f.session.send(); f.events[0].onEvent(frame());
  const late = f.events[0].onEvent, count = f.changes.length; f.session.dispose(); late(frame({ id: 3, text: 'late' }));
  assert.equal(f.changes.length, count); assert.equal(f.events[0].signal.aborted, true); assert.equal(f.calls.some(call => call[0] === 'stop'), false);
  const g = fixture({ receipts, initial: snapshot({ revision: 1, runs: [run({ assistantText: 'Hello', lastEventId: 2 })] }) }); await g.session.load();
  assert.equal(g.calls.some(call => call[0] === 'start'), false); assert.equal(g.calls.find(call => call[0] === 'stream')[4], 2); g.session.dispose();
});

test('lost POST acknowledgement finds the same request via a safe read with no blind retry', async () => {
  let reads = 0; const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ revision: 1, runs: [run()] }), start: async () => { throw error('NETWORK'); } }); await ready(f); await f.session.send();
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(reads, 2); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().phase, 'streaming'); assert.equal(f.session.getState().draft, ''); f.session.dispose();
});

test('missing acknowledgement plus failed safe read stays blocked across dismiss/reopen without resubmission', async () => {
  const receipts = memoryReceipts(); let reads = 0;
  const f = fixture({ receipts, read: async () => { if (++reads > 1) throw error('NETWORK'); return snapshot(); }, start: async () => { throw error('NETWORK'); } }); await ready(f); await f.session.send();
  assert.equal(f.session.getState().phase, 'unknown'); assert.equal(agentChatCanSend(f.session.getState()), false); f.session.dispose();
  const g = fixture({ receipts }); await g.session.load(); assert.equal(g.session.getState().phase, 'unknown'); assert.match(g.session.getState().message, /不能证明请求未被接受/); assert.match(g.session.getState().message, /当前页面会话内保留，后端重启后仍可核对/); assert.doesNotMatch(g.session.getState().message, /跨重启保留/); assert.match(g.session.getState().message, /计费/); assert.equal(g.session.approve(true), false); assert.equal(await g.session.send(), false); assert.equal(g.calls.some(call => call[0] === 'start'), false); g.session.dispose();
});

test('receipt storage contains identities only and survives new reader without text or configuration', () => {
  let stored = ''; const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  createAgentChatReceipts(storage).set(projectId, { instanceId, requestId, message: 'private prompt', apiKey: 'private key', configuration });
  assert.doesNotMatch(stored, /private|configuration|apiKey/); assert.deepEqual(createAgentChatReceipts(storage).get(projectId), { instanceId, requestId });
});

test('backend restart preserves durable interrupted history and resolves a pending receipt without resending', async () => {
  const receipts = memoryReceipts(); receipts.set(projectId, { instanceId, requestId });
  const saved = run({ status: 'interrupted', assistantText: 'Saved partial answer', lastEventId: 3 });
  const f = fixture({ receipts, initial: snapshot({ instanceId: nextInstance, revision: 2, runs: [saved] }) }); await f.session.load();
  assert.equal(f.session.getState().sessionLost, true); assert.equal(f.session.getState().pending, null); assert.match(f.session.getState().message, /已保存的对话/);
  assert.equal(f.session.getState().snapshot.runs[0].assistantText, 'Saved partial answer');
  assert.equal(f.calls.some(call => ['start', 'stream', 'stop'].includes(call[0])), false); assert.equal(f.session.getState().consent, null); f.session.dispose();
});

test('changed destination response reloads settings, preserves unsent text and invalidates prior consent', async () => {
  let reads = 0; const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ settings: settings({ revision: 1, configuration: { ...configuration, baseUrl: 'https://changed.example.com/v1', model: 'changed-model' } }) }), start: async () => { throw error('AGENT_CHAT_SETTINGS_CONFLICT'); } });
  await ready(f); await f.session.send(); assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().consent, null);
  assert.match(f.session.getState().snapshot.settings.configuration.baseUrl, /changed/); assert.match(f.session.getState().message, /设置已改变/); assert.equal(await f.session.send(), false); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('Stop requests once with immutable identity, aborts display stream and retains partial output', async () => {
  const held = deferred(), f = fixture({ stop: () => held.promise }); await ready(f); await f.session.send(); f.events[0].onEvent(frame());
  const first = f.session.stop(); assert.equal(await f.session.stop(), false); assert.equal(f.events[0].signal.aborted, true);
  held.resolve(envelope(run({ status: 'stopped', assistantText: 'Hello', lastEventId: 3 }), 2)); await first;
  assert.equal(f.session.getState().snapshot.runs[0].assistantText, 'Hello'); assert.match(f.session.getState().message, /计费/);
  assert.deepEqual(f.calls.find(call => call[0] === 'stop').slice(1, 4), [projectId, runId, instanceId]); f.session.dispose();
});

test('stream ending without terminal rereads once and exposes disconnected state without POST or runaway reconnect', async () => {
  const f = fixture({ stream: async () => {} }); await ready(f); await f.session.send(); await flush();
  assert.equal(f.session.getState().phase, 'detached'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.calls.filter(call => call[0] === 'stream').length, 1); assert.equal(f.calls.filter(call => call[0] === 'run').length, 1); f.session.dispose();
});

test('late load, acknowledgement and stop cannot publish into a disposed project or alter its receipt', async () => {
  for (const stage of ['read', 'start', 'stop']) {
    const held = deferred(), f = fixture({ ...(stage === 'read' ? { read: () => held.promise } : stage === 'start' ? { start: () => held.promise } : { stop: () => held.promise }) });
    let pending;
    if (stage === 'read') pending = f.session.load(); else { await ready(f); pending = f.session.send(); if (stage === 'stop') { await pending; pending = f.session.stop(); } }
    const count = f.changes.length, previousReceipt = structuredClone(f.receipts.get(projectId)); f.session.dispose();
    held.resolve(stage === 'read' ? snapshot() : envelope(run({ status: 'completed' }), 2)); await pending; await flush();
    assert.equal(f.changes.length, count, stage); assert.deepEqual(f.receipts.get(projectId), previousReceipt); assert.equal(await f.session.send(), false); assert.equal(f.session.getState().snapshot, null);
  }
});

const source = readFileSync(new URL('../apps/web/src/AgentPanel.jsx', import.meta.url), 'utf8');
const transformed = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const element = (type, props = {}, ...children) => { const properties = { ...props, children: children.length === 1 ? children[0] : children }; return typeof type === 'function' && type.name === 'AgentRunActivity' ? type(properties) : { type, props: properties }; };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const depsEqual = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function uiHarness(client, receipts = memoryReceipts()) {
  const slots = [], dom = new Map(); let cursor = 0, effects = [], tree, closes = 0, settingsOpened = 0, currentProject = projectId, visible = true, hasDraft = false;
  const react = { createElement: element,
    useState(initial) { const i = cursor++; slots[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useMemo(callback, deps) { const i = cursor++; if (!slots[i] || !depsEqual(deps, slots[i].deps)) slots[i] = { value: callback(), deps }; return slots[i].value; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useLayoutEffect(callback, deps) { const i = cursor++, old = slots[i]; if (old && depsEqual(deps, old.deps)) return; slots[i] = { callback, deps, cleanup: old?.cleanup }; effects.push(i); },
  }; react.default = react;
  const module = { exports: {} }, primitive = new Proxy({}, { get: (_, key) => String(key) });
  const resolve = id => {
    if (id === './agent-timeline-context.js') return timing;
    if (id === './agent-timeline-gain-context.ts') return gainContext;
    if (id === './AgentTimelineGain.tsx') { const gain = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/AgentTimelineGain.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(gain, gain.exports, resolve); return gain.exports; }
    if (id === 'react') return react;
    if (id === './agent-chat.js') return { ...logic, createAgentChatSession: options => logic.createAgentChatSession({ ...options, client, receipts, requestId: () => requestId }) };
    if (id === './agent-tool-state.js') return toolLogic;
    if (id === './AgentEditProposal.jsx') return { __esModule: true, default: 'AgentEditProposal' };
    if (id === './AgentRunActivity.jsx') { const child = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/AgentRunActivity.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code)(child, child.exports, resolve); return child.exports; }
    if (id === './workspace-visibility.jsx') return { useWorkspaceVisibility: () => visible };
    if (id === './icons.jsx') return { default: 'Icon' };
    if (id === './agent-chat-history.css') return {};
    if (id.startsWith('@mioon/ui/') || id === './WorkspaceControls.jsx') return primitive;
    throw Error(id);
  };
  Function('module', 'exports', 'require', transformed)(module, module.exports, resolve);
  const h = {
    render(owner = currentProject) { currentProject = owner; cursor = 0; effects = []; tree = module.exports.default({ projectId: currentProject, projectName: 'Private Local Project', onClose: () => { closes++; }, onSettings: () => { settingsOpened++; }, onDraftChange: value => { hasDraft = value; } }); for (const node of nodes(tree)) if (node.props.ref) { const id = node.props.id || node.props['data-testid']; if (!dom.has(id)) dom.set(id, { value: '', scrollHeight: 100, scrollTop: 0 }); node.props.ref.current = dom.get(id); } for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } return tree; },
    find(id) { return nodes(tree).find(node => node.props['data-testid'] === id); },
    form() { return nodes(tree).find(node => node.type === 'form'); },
    change(id, value) { h.find(id).props.onChange({ target: { value, checked: value } }); h.render(); },
    setVisible(value) { visible = value; h.render(); },
    get hasDraft() { return hasDraft; },
    get closes() { return closes; }, get settingsOpened() { return settingsOpened; },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  }; return h;
}

test('actual component requires checkbox consent, shows simulated/local-only scope and renders output as escaped text', async () => {
  const f = fixture({ initial: snapshot({ revision: 2, runs: [run({ status: 'completed', assistantText: '<script>alert(1)</script> https://example.com', lastEventId: 3 })] }) }), h = uiHarness(f.client);
  h.render(); await flush(); h.render(); assert.ok(h.find('agent-chat-simulated')); assert.equal(h.find('agent-chat-send').props.disabled, true);
  assert.equal(h.find('agent-chat-response').props.children, '<script>alert(1)</script> https://example.com');
  h.change('agent-chat-prompt', 'A typed question'); h.change('agent-chat-consent', true); assert.equal(h.find('agent-chat-send').props.disabled, false);
  h.form().props.onSubmit({ preventDefault() {} }); await flush(); h.render(); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); h.unmount();
});

test('actual component collapse and settings transition invalidate old callbacks before parent navigation', async () => {
  const held = deferred(), f = fixture({ start: () => held.promise }), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'A typed question'); h.change('agent-chat-consent', true);
  const submit = h.form().props.onSubmit; submit({ preventDefault() {} }); h.render(); const oldClose = h.find('agent-chat-close').props.onClick;
  h.find('agent-chat-settings').props.onClick(); assert.equal(h.settingsOpened, 1); assert.equal(h.closes, 0);
  oldClose(); submit({ preventDefault() {} }); held.resolve(envelope()); await flush(); assert.equal(h.settingsOpened, 1); assert.equal(h.closes, 0); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); h.unmount();
});

test('actual project change makes all previous close, submit, edit and terminal callbacks inert', async () => {
  const f = fixture({ read: async owner => snapshot({ projectId: owner }) }), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'A typed question'); h.change('agent-chat-consent', true);
  const oldSubmit = h.form().props.onSubmit, oldClose = h.find('agent-chat-close').props.onClick, oldEdit = h.find('agent-chat-prompt').props.onChange;
  oldSubmit({ preventDefault() {} }); await flush(); h.render(); const event = f.events.at(-1).onEvent;
  h.render('project-two'); await flush(); h.render(); oldSubmit({ preventDefault() {} }); oldClose(); oldEdit({ target: { value: 'wrong project' } }); event(frame()); h.render();
  assert.equal(h.closes, 0); assert.equal(h.find('agent-chat-prompt').props.value, ''); assert.equal(h.find('agent-chat-page').props['data-project-id'], 'project-two'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); h.unmount();
});

test('integration preserves settings entry, the shared right dock, bounded history and app-local controls', () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /data-testid="agent-chat-open"/); assert.match(app, /data-testid="agent-settings-open"/); assert.match(app, /<AgentWorkspace navigationRegistry={settingsNavigation\.current} projectId={data.project\?\.id}/);
  assert.match(source, /from '\.\/WorkspaceControls\.jsx'/); assert.doesNotMatch(source, /DialogContent|<Dialog/);
  assert.match(source, /inspecting \? '新消息范围：当前项目只读检查'/); assert.match(source, /新消息范围：仅文字聊天/); assert.match(source, /不会发送/); assert.match(source, /保存在本地应用数据库/); assert.match(source, /并非密钥保险库加密/); assert.match(source, /请勿输入密钥或其他秘密/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|<a\s|<img\s|<iframe|fetch\(|rpc\(|localStorage|sessionStorage/);
});

test('receipt metadata handles prototype-shaped project IDs as own data, without prototype inheritance', () => {
  let stored = ''; const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  const receipts = createAgentChatReceipts(storage);
  for (const id of ['__proto__', 'constructor', 'toString']) {
    receipts.set(id, { instanceId, requestId });
    assert.deepEqual(createAgentChatReceipts(storage).get(id), { instanceId, requestId });
    assert.equal(Object.hasOwn(JSON.parse(stored), id), true);
  }
  assert.equal(Object.prototype.instanceId, undefined);
});

test('hiding detaches only display and blocks old actions; showing rereads without another model request', async () => {
  let reads = 0; const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ revision: 1, runs: [run({ assistantText: 'server progress', lastEventId: 2 })] }) });
  await ready(f); await f.session.send(); const old = f.events[0]; f.session.setVisible(false);
  assert.equal(old.signal.aborted, true); old.onEvent(frame()); assert.equal(f.session.getState().snapshot.runs[0].assistantText, ''); assert.equal(await f.session.stop(), false);
  f.session.setVisible(true); await flush(); assert.equal(reads, 2); assert.equal(f.session.getState().snapshot.runs[0].assistantText, 'server progress'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.calls.some(call => call[0] === 'stop'), false); f.session.dispose();
});

test('hiding during POST acknowledgement preserves receipt/identity and does not attach a hidden stream', async () => {
  const held = deferred(), f = fixture({ start: () => held.promise }); await ready(f); const pending = f.session.send(); f.session.setVisible(false); held.resolve(envelope()); await pending;
  assert.equal(f.session.getState().phase, 'detached'); assert.equal(f.session.getState().pending, null); assert.equal(f.calls.some(call => call[0] === 'stream'), false); f.session.dispose();
});


test('consent uses the shared Input checkbox and Label with explicit true/false native checked events', async () => {
  const f = fixture(), h = uiHarness(f.client); h.render(); await flush(); h.render();
  const control = h.find('agent-chat-consent');
  assert.equal(control.type, 'Input'); assert.equal(control.props.type, 'checkbox'); assert.equal(control.props.checked, false);
  assert.ok(nodes(h.render()).some(node => node.type === 'Label' && node.props.htmlFor === control.props.id));
  h.change('agent-chat-prompt', 'A typed question'); h.change('agent-chat-consent', true);
  assert.equal(h.find('agent-chat-consent').props.checked, true); assert.equal(h.find('agent-chat-send').props.disabled, false);
  h.change('agent-chat-consent', false); assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.find('agent-chat-send').props.disabled, true);
  h.form().props.onSubmit({ preventDefault() {} }); assert.equal(f.calls.some(call => call[0] === 'start'), false); h.unmount();
});

test('real shared Input preserves accessible native checkbox markup, checked state and disabling', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixture = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { Input } from './src/components/input.tsx';
    import { Label } from './src/components/label.tsx';
    export const html = renderToStaticMarkup(<Label htmlFor="consent-runtime"><Input id="consent-runtime" data-testid="agent-chat-consent" type="checkbox" checked disabled onChange={() => {}} />Confirm sending typed chat</Label>);
  `;
  const script = `
    import { build } from 'esbuild';
    import assert from 'node:assert/strict';
    const { outputFiles } = await build({ stdin: { contents: ${JSON.stringify(fixture)}, loader: 'tsx', resolveDir: ${JSON.stringify(root + '/packages/ui')} }, bundle: true, format: 'esm', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '\"production\"' } });
    const { html } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
    for (const expected of ['for="consent-runtime"', 'id="consent-runtime"', 'data-slot="input"', 'type="checkbox"', 'checked=""', 'disabled=""', 'Confirm sending typed chat']) assert.ok(html.includes(expected), 'Missing shared checkbox markup: ' + expected);
    process.stdout.write('Shared consent checkbox verified'); process.exit(0);
  `;
  assert.match(execFileSync(process.execPath, ['--input-type=module'], { cwd: root, input: script, encoding: 'utf8', timeout: 30000 }), /Shared consent checkbox verified/);
});

test('missing or malformed protocol fails closed in settings, runs and SSE snapshots without inference retries', async () => {
  for (const protocol of [undefined, null, '', 'auto', 'Responses', '__proto__', 1]) {
    const invalid = { ...configuration, protocol };
    assert.throws(() => safeAgentChatRun(run({ configuration: invalid }), projectId), value => value.code === 'INVALID_RESPONSE');
    assert.throws(() => safeAgentChatSnapshot(snapshot({ settings: settings({ configuration: invalid }) }), projectId));
    assert.throws(() => logic.safeAgentChatEvent(frame({ type: 'snapshot', id: 1, run: run({ configuration: invalid }) }), { type: 'snapshot', id: '1' }, projectId, instanceId, runId));
    const f = fixture({ initial: snapshot({ settings: settings({ configuration: invalid }) }) }); await f.session.load();
    assert.equal(f.session.getState().phase, 'load_error'); assert.equal(f.session.approve(true), false); assert.equal(await f.session.send(), false); assert.equal(f.calls.some(call => call[0] === 'start'), false); f.session.dispose();
  }
});

for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol} shows the exact protocol and derived endpoint before Send and transmits exact consent once`, async () => {
    const configured = { ...configuration, protocol }, initial = snapshot({ settings: settings({ configuration: configured }) });
    const f = fixture({ initial, start: async (_, input) => envelope(run({ configuration: configured, userText: input.message })) }), h = uiHarness(f.client);
    h.render(); await flush(); h.render();
    const destination = JSON.stringify(h.find('agent-chat-destination'));
    assert.ok(destination.includes(logic.deriveAgentEndpoint(configured))); assert.equal(h.find('agent-chat-protocol').props.children, logic.AGENT_PROTOCOLS[protocol].label);
    h.change('agent-chat-prompt', 'A typed question'); assert.equal(h.find('agent-chat-send').props.disabled, true); h.change('agent-chat-consent', true);
    h.form().props.onSubmit({ preventDefault() {} }); await flush(); h.render();
    const sends = f.calls.filter(call => call[0] === 'start'); assert.equal(sends.length, 1);
    assert.deepEqual(sends[0][2].consent, { destination: logic.deriveAgentEndpoint(configured), protocol, model: configured.model, context: 'typed_chat_only' });
    assert.match(JSON.stringify(h.find('agent-chat-run-destination')), new RegExp(protocol === 'responses' ? '/responses' : '/chat/completions')); h.unmount();
  });

  test(`${protocol} lost acknowledgement, hiding and re-showing recover only the original run`, async () => {
    const configured = { ...configuration, protocol }, active = run({ configuration: configured }); let reads = 0;
    const f = fixture({ read: async () => ++reads === 1 ? snapshot({ settings: settings({ configuration: configured }) }) : snapshot({ revision: 1, settings: settings({ configuration: configured }), runs: [active] }), start: async () => { throw error('NETWORK'); } });
    await ready(f); await f.session.send(); assert.equal(f.session.getState().pending, null);
    const listener = f.events[0]; f.session.setVisible(false); listener.onEvent(frame()); f.session.setVisible(true); await flush();
    assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.session.getState().snapshot.runs[0].configuration.protocol, protocol); assert.equal(f.session.getState().consent, null); f.session.dispose();
  });
}

test('consent binds full configuration and protocol-only revision change requires a fresh explicit confirmation', async () => {
  const first = snapshot(), changed = snapshot({ settings: settings({ revision: 1, configuration: { ...configuration, protocol: 'responses' } }) });
  assert.notEqual(logic.agentChatConsentKey(first), logic.agentChatConsentKey(changed));
  assert.notEqual(logic.agentChatConsentKey(first), logic.agentChatConsentKey(snapshot({ settings: settings({ configuration: { ...configuration, presetId: 'custom' } }) })));
  let reads = 0; const f = fixture({ read: async () => ++reads === 1 ? first : changed, start: async () => { throw error('AGENT_CHAT_SETTINGS_CONFLICT'); } });
  await ready(f); const previousConsent = f.session.getState().consent; await f.session.send();
  assert.equal(f.session.getState().snapshot.settings.configuration.protocol, 'responses'); assert.equal(f.session.getState().consent, null); assert.equal(await f.session.send(), false); assert.equal(f.session.getState().draft, 'A typed question');
  f.session.approve(true); assert.notEqual(f.session.getState().consent, previousConsent); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('wrong accepted protocol is not silently accepted, retried or substituted while reconciliation remains unresolved', async () => {
  const f = fixture({ start: async () => envelope(run({ configuration: { ...configuration, protocol: 'responses' } })) });
  await ready(f); await f.session.send(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(agentChatCanSend(f.session.getState()), false);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.session.getState().snapshot.runs.length, 0); f.session.dispose();
});

test('accepted Responses run stays immutable while settings change to CC; stale stream cannot retarget it', async () => {
  const configured = { ...configuration, protocol: 'responses' }, active = run({ configuration: configured }); let reads = 0;
  const f = fixture({ read: async () => ++reads === 1 ? snapshot({ settings: settings({ configuration: configured }) }) : snapshot({ revision: 1, settings: settings({ revision: 1 }), runs: [active] }), start: async () => envelope(active) });
  await ready(f); await f.session.send(); const accepted = f.session.getState().snapshot.runs[0]; assert.equal(Object.isFrozen(accepted.configuration), true);
  assert.throws(() => f.events[0].onEvent(frame({ id: 2, type: 'snapshot', run: run({ lastEventId: 2 }) })), value => value.code === 'INVALID_RESPONSE');
  f.session.setVisible(false); f.session.setVisible(true); await flush();
  assert.equal(f.session.getState().snapshot.settings.configuration.protocol, 'chat_completions'); assert.equal(f.session.getState().snapshot.runs[0].configuration.protocol, 'responses');
  assert.equal(f.calls.find(call => call[0] === 'start')[2].consent.protocol, 'responses'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('inline chat keeps unsent draft across tabs, settings, collapse and reveal, with stale hidden callbacks inert', async () => {
  const f = fixture(), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'Keep this draft'); h.change('agent-chat-consent', true); assert.equal(h.hasDraft, true);
  const oldEdit = h.find('agent-chat-prompt').props.onChange, oldSubmit = h.form().props.onSubmit, oldClose = h.find('agent-chat-close').props.onClick;
  h.setVisible(false); assert.equal(h.find('agent-chat-page').props.inert, true); assert.equal(h.find('agent-chat-prompt').props.disabled, true);
  oldEdit({ target: { value: 'stale' } }); oldSubmit({ preventDefault() {} }); oldClose();
  h.setVisible(true); await flush(); h.render(); oldEdit({ target: { value: 'still stale' } }); oldSubmit({ preventDefault() {} }); oldClose(); h.render();
  assert.equal(h.find('agent-chat-prompt').props.value, 'Keep this draft'); assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.hasDraft, true); assert.equal(h.closes, 0); assert.equal(f.calls.some(call => call[0] === 'start'), false); h.unmount();
});

test('inline hidden POST acknowledgement preserves original response without attaching a hidden stream', async () => {
  const configured = { ...configuration, protocol: 'responses' }, held = deferred();
  const f = fixture({ initial: snapshot({ settings: settings({ configuration: configured }) }), start: () => held.promise }); await ready(f); const pending = f.session.send(); f.session.setVisible(false);
  held.resolve(envelope(run({ configuration: configured }))); await pending;
  assert.equal(f.session.getState().phase, 'detached'); assert.equal(f.session.getState().snapshot.runs[0].configuration.protocol, 'responses'); assert.equal(f.calls.some(call => call[0] === 'stream'), false); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

const appSource = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
const actualFunction = (begin, end) => { const start = appSource.indexOf(begin), stop = appSource.indexOf(end, start); assert.ok(start >= 0 && stop > start); return appSource.slice(start, stop).trim(); };
const guardSource = actualFunction('  async function guardNavigation(', '  async function guardProjectNavigation(');
const projectGuardSource = actualFunction('  async function guardProjectNavigation(', '  async function prepareSettingsDeparture(');
const settingsDepartureSource = actualFunction('  async function prepareSettingsDeparture()', '  async function changeHomePage(');
const sessionReadySource = actualFunction('  function projectSessionReady()', '  const workbenchReady =');
const projectSource = actualFunction('  async function selectProject(', '  async function reloadPreferences(');
const navigationProjectId = '77000000-0000-4000-8000-000000000001', navigationNextId = '77000000-0000-4000-8000-000000000002', navigationLaterId = '77000000-0000-4000-8000-000000000003';
function projectNavigation({ draft = true, imageDraft = false, dirty = false, confirmation = true } = {}) {
  const calls = [], currentProject = { current: navigationProjectId }, navigationEpoch = { current: 0 }, projectEpoch = { current: 0 }, dirtyRef = { current: dirty }, formatState = {}, workspaceRef = { current: { restored: false } };
  const context = () => ({ projectId: currentProject.current, epoch: navigationEpoch.current, workspace: workspaceRef.current });
  const guardEnv = { localDeliveryRef: { current: null }, shotTextRef: { current: null }, clipDraftRef: { current: null }, deliveryNameRef: { current: null }, subtitlesRef: { current: { controller: { getState: () => null, hasUnsaved: () => false, discardDraft: () => calls.push(['discardSubtitles']) } } }, setSubtitleDirty: value => calls.push(['subtitleDirty', value]), context, dirtyRef, timelineFormatRef: { current: { controller: { getState: () => formatState, hasUnsaved: () => false, discardDraft: () => calls.push(['discardFormat']) } } }, confirm: async message => { calls.push(['confirm', message]); return confirmation; }, isCurrent: captured => captured.projectId === currentProject.current && captured.epoch === navigationEpoch.current && workspaceOriginScope(captured.workspace) === workspaceOriginScope(workspaceRef.current),
    setShotDirty: value => calls.push(['shotDirty', value]), setClipDirty: value => calls.push(['clipDirty', value]), setSourceDirty: value => calls.push(['sourceDirty', value]), setSubjectDirty: value => calls.push(['subjectDirty', value]), subjectsRef: { current: { state: { scope: 'fixture-subject-scope' }, controller: { discardDrafts: scope => calls.push(['discardSubjects', scope]) } } }, setInspectorEpoch: () => calls.push(['inspectorEpoch']) };
  const { guardNavigation, guardProjectNavigation } = Function(...Object.keys(guardEnv), `${guardSource}\n${projectGuardSource}\nreturn { guardNavigation, guardProjectNavigation };`)(...Object.values(guardEnv));
  const restored = { activeMode: 'canvas', canvas: { selectedId: null, viewport: { zoom: 1 } } };
  const env = { workspaceRef, workspaceOriginScope, projectOpenAttempt, canPublishProjectOpen, projectResponseMatches, projectOpenFailureKind,
    context, isCurrent: guardEnv.isCurrent, confirm: guardEnv.confirm, notify: (...args) => calls.push(['notify', ...args]), readableError: error => error.message,
    openedProject: { current: projectOpenAttempt(navigationProjectId, 0, 'normal') }, settingsNavigation: { current: createSettingsNavigationRegistry() },
    loading: false, importSession: { current: { active: true, selection: 0 } }, lastProjectRef: { current: { invalidateNavigation: () => {}, rememberOpened: () => {} } }, tasksRef: { current: { getState: () => ({ phase: 'idle', items: [] }), load: async id => { calls.push(['loadTasks', id]); } } }, currentProject, agentDraft: { current: draft }, imageDraft: { current: imageDraft }, guardNavigation, guardProjectNavigation, navigationEpoch, projectEpoch, requestCounter: { current: 0 }, preferencesRef: { current: { flush: () => calls.push(['flush']), load: async id => { calls.push(['load', id]); return restored; }, getStatus: () => ({ phase: 'ready' }) } }, viewReady: { current: true }, dataRef: { current: { project: { id: navigationProjectId } } }, emptyData: {}, pendingForProject: () => [], dragging: { current: false }, viewRef: { current: restored }, updateView: () => {}, URL,
    window: { location: { href: 'https://workbench.example.com/' }, history: { pushState: () => calls.push(['history']), replaceState: () => calls.push(['history']) } }, localStorage: { setItem: () => {} }, ...Object.fromEntries(['setProjectOpening', 'setHomePage', 'setAuth', 'setPropertiesPage', 'setTaskState', 'setPreferenceStatus', 'setPending', 'setShowProjects', 'setData', 'setNodes', 'setLoading', 'setShotDirty', 'setClipDirty', 'setSourceDirty', 'setSubjectDirty', 'setSubtitleDirty', 'setInspectorEpoch', 'setRightDockTab', 'setShowExports', 'setComparisonId', 'setPreviewAsset', 'setRealConfirm', 'setToast', 'setMobilePanel', 'setView', 'setZoom'].map(name => [name, value => calls.push([name, value])])) };
  env.refresh = async (id, _quiet, options) => { assert.equal(options?.opening, true); env.dataRef.current = { project: { id }, shots: [], nodes: [] }; return env.dataRef.current; };
  env.prepareSettingsDeparture = () => Function(...Object.keys(env), `${settingsDepartureSource}\nreturn prepareSettingsDeparture();`)(...Object.values(env));
  env.projectSessionReady = () => Function(...Object.keys(env), `${sessionReadySource}\nreturn projectSessionReady();`)(...Object.values(env));
  const selectProject = Function(...Object.keys(env), `return (${projectSource});`)(...Object.values(env));
  return { selectProject, guardNavigation, calls, currentProject, navigationEpoch, env };
}

test('actual App project guard Cancel retains unsent chat and current project without clearing any panel', async () => {
  const f = projectNavigation({ confirmation: false }); assert.equal(await f.selectProject(navigationNextId), false);
  assert.equal(f.currentProject.current, navigationProjectId); assert.equal(f.env.agentDraft.current, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'confirm'); assert.match(f.calls[0][1], /未发送的草稿/); assert.match(f.calls[0][1], /已发送的回复可能继续/);
});

test('actual App project guard Confirm permits project-key isolation; no draft or merely running reply needs no prompt', async () => {
  const f = projectNavigation(); assert.equal(await f.selectProject(navigationNextId), true); assert.equal(f.currentProject.current, navigationNextId); assert.equal(f.env.projectSessionReady(), true);
  assert.equal(f.calls.filter(call => call[0] === 'confirm').length, 1); assert.equal(f.calls.filter(call => call[0] === 'setData').length, 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'setSourceDirty'), [['setSourceDirty', false]]);
  const g = projectNavigation({ draft: false }); assert.equal(await g.selectProject(navigationNextId), true); assert.equal(g.calls.some(call => call[0] === 'confirm'), false);
  assert.doesNotMatch(projectSource, /activeAgentChatRun|\.stop\(|setRightDockTab\((?!value => value === 'tasks' \? 'properties' : value\))/);
  const resetTab = f.calls.find(call => call[0] === 'setRightDockTab')[1];
  assert.equal(resetTab('agent'), 'agent'); assert.equal(resetTab('tasks'), 'properties');
});

test('actual App image draft guard Cancel preserves project and Confirm changes it without stopping accepted work', async () => {
  const cancelled = projectNavigation({ draft: false, imageDraft: true, confirmation: false });
  assert.equal(await cancelled.selectProject(navigationNextId), false); assert.equal(cancelled.currentProject.current, navigationProjectId); assert.equal(cancelled.env.imageDraft.current, true);
  assert.equal(cancelled.calls.length, 1); assert.match(cancelled.calls[0][1], /图像工坊有未发送的草稿/);
  const confirmed = projectNavigation({ draft: false, imageDraft: true }); assert.equal(await confirmed.selectProject(navigationNextId), true); assert.equal(confirmed.currentProject.current, navigationNextId); assert.equal(confirmed.calls.filter(call => call[0] === 'confirm').length, 1);
  const both = projectNavigation({ imageDraft: true, confirmation: false }); await both.selectProject(navigationNextId); assert.match(both.calls[0][1], /Agent 和图像工坊都有未发送的草稿/);
  assert.doesNotMatch(projectSource, /image\.task\.|image\.generate|setRightDockTab\((?!value => value === 'tasks' \? 'properties' : value\))/);
  assert.equal(confirmed.calls.find(call => call[0] === 'setRightDockTab')[1]('image'), 'image');
});

test('actual App dirty-panel guard retains source drafts on Cancel and clears dirty state only after Confirm', async () => {
  const cancelled = projectNavigation({ draft: false, dirty: true, confirmation: false });
  assert.equal(await cancelled.guardNavigation(), false);
  assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.calls[0][0], 'confirm');
  const confirmed = projectNavigation({ draft: false, dirty: true });
  assert.equal(await confirmed.guardNavigation(), true);
  assert.deepEqual(confirmed.calls.filter(call => ['shotDirty', 'clipDirty', 'sourceDirty', 'subjectDirty', 'subtitleDirty'].includes(call[0])),
    [['shotDirty', false], ['clipDirty', false], ['sourceDirty', false], ['subjectDirty', false], ['subtitleDirty', false]]);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'discardSubtitles'), [['discardSubtitles']]);
  assert.deepEqual(confirmed.calls.filter(call => call[0] === 'discardSubjects'), [['discardSubjects', 'fixture-subject-scope']]);
  assert.equal(confirmed.calls.filter(call => call[0] === 'inspectorEpoch').length, 1);
});

test('actual App navigation rejects late discard confirmation after a newer project and mode switches ignore chat draft', async () => {
  const held = deferred(), f = projectNavigation({ confirmation: held.promise }); const pending = f.selectProject(navigationNextId);
  await flush(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'confirm');
  f.currentProject.current = navigationLaterId; f.navigationEpoch.current++; held.resolve(true); assert.equal(await pending, false); assert.equal(f.currentProject.current, navigationLaterId); assert.equal(f.calls.length, 1);
  const g = projectNavigation(); assert.equal(await g.guardNavigation(), true); assert.equal(g.calls.length, 0, 'Mode navigation only consults existing Inspector dirty state');
  const mode = actualFunction('  async function changeMode(', '  function revealCanvas('); assert.match(mode, /await guardNavigation\(\)/); assert.doesNotMatch(mode, /agentDraft|setRightDockTab|setAgentPage/);
});

const workspaceSource = readFileSync(new URL('../apps/web/src/AgentWorkspace.jsx', import.meta.url), 'utf8');
function workspaceHarness(exportName = 'default') {
  const slots = []; let cursor = 0, effects = [], visible = true;
  const react = { createElement: (type, props, ...children) => type === 'SettingsNavigationSlot' ? children[0](() => {}) : element(type, props, ...children), useRef: value => slots[cursor++] ||= { current: value }, useLayoutEffect(callback, deps) { const i = cursor++, old = slots[i]; if (old && depsEqual(deps, old.deps)) return; slots[i] = { deps, callback }; effects.push(i); } }; react.default = react;
  const module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(workspaceSource, { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, id => id === 'react' ? react : id === './AgentPanel.jsx' ? { __esModule: true, default: 'AgentPanel' } : id === './AgentSettings.jsx' ? { __esModule: true, default: 'AgentSettings' } : id === './SettingsNavigationSlot.tsx' ? { __esModule: true, default: 'SettingsNavigationSlot' } : { useWorkspaceVisibility: () => visible, WorkspaceVisibilityProvider: 'VisibilityProvider' });
  return { render(props) { cursor = 0; effects = []; const tree = module.exports[exportName](props); for (const i of effects) slots[i].callback(); return tree; }, setAncestorVisible(value) { visible = value; } };
}

test('actual dock workspace keeps chat and globally scoped settings mounted through page and project changes', () => {
  const h = workspaceHarness(), props = { projectId, projectName: 'Local label', page: 'chat', onPage() {}, onCollapse() {}, onDraftChange() {} };
  let tree = h.render(props); assert.equal(nodes(tree).filter(node => node.type === 'AgentPanel').length, 1); assert.equal(nodes(tree).some(node => node.type === 'AgentSettings'), false);
  tree = h.render({ ...props, page: 'settings' }); const chat = nodes(tree).find(node => node.type === 'AgentPanel'), settingsPage = nodes(tree).find(node => node.type === 'AgentSettings');
  assert.equal(chat.props.key, projectId); assert.ok(settingsPage); assert.equal(nodes(tree).find(node => node.props.id === 'agent-chat-pane').props.visible, false);
  tree = h.render(props); assert.equal(nodes(tree).filter(node => node.type === 'AgentPanel').length, 1); assert.equal(nodes(tree).filter(node => node.type === 'AgentSettings').length, 1);
  tree = h.render({ ...props, projectId: undefined }); assert.equal(nodes(tree).some(node => node.type === 'AgentPanel'), false); assert.equal(nodes(tree).filter(node => node.type === 'AgentSettings').length, 1);
  tree = h.render({ ...props, projectId: 'project-two' }); assert.equal(nodes(tree).find(node => node.type === 'AgentPanel').props.key, 'project-two'); assert.equal(nodes(tree).find(node => node.type === 'AgentSettings').props.key, undefined);
  assert.doesNotMatch(workspaceSource, /Dialog|localStorage|sessionStorage/);
});

test('actual nested dock page combines ancestor visibility, keeps children and marks hidden content inert', () => {
  const h = workspaceHarness('AgentDockPane'), child = element('Inspector', { draft: 'unchanged' });
  const props = { visible: true, id: 'right-dock-properties', labelledBy: 'right-dock-properties-tab', children: child };
  let tree = h.render(props), panel = nodes(tree).find(node => node.props.id === props.id); assert.equal(panel.props.hidden, false); assert.equal(panel.props.role, 'tabpanel'); assert.equal(panel.props['aria-labelledby'], props.labelledBy);
  h.setAncestorVisible(false); tree = h.render(props); panel = nodes(tree).find(node => node.props.id === props.id); assert.equal(panel.props.hidden, true); assert.equal(panel.props.inert, true); assert.equal(panel.props.children, child);
  h.setAncestorVisible(true); tree = h.render({ ...props, visible: false }); panel = nodes(tree).find(node => node.props.id === props.id); assert.equal(panel.props.hidden, true); assert.equal(panel.props.children, child);
});

test('App right-dock tabs preserve existing layout, resize and Inspector subtree and ordinary selection never changes tabs', () => {
  assert.match(appSource, /rightDockTab, setRightDockTab\] = useState\('properties'\)/);
  for (const id of ['right-dock-tab-properties', 'right-dock-tab-agent', 'right-dock-tab-image']) assert.ok(appSource.includes(`data-testid="${id}"`));
  assert.match(appSource, /<AgentDockPane id="right-dock-properties"[^>]+visible={rightDockTab === 'properties'}/);
  assert.match(appSource, /<AgentDockPane id="right-dock-agent"[^>]+visible={rightDockTab === 'agent'}/);
  assert.match(appSource, /<AgentDockPane id="right-dock-image"[^>]+visible={rightDockTab === 'image'}/);
  assert.match(appSource, /resizeHandle\('inspector', 'inspectorWidth'\)/);
  const inspectStart = appSource.indexOf('  async function inspect('), inspectEnd = appSource.indexOf('\n  async function ', inspectStart + 1);
  assert.ok(inspectStart > 0 && inspectEnd > inspectStart); assert.doesNotMatch(appSource.slice(inspectStart, inspectEnd), /setRightDockTab|setAgentPage/);
  assert.equal((appSource.match(/<AgentWorkspace /g) || []).length, 1); assert.doesNotMatch(appSource, /showAgentSettings|showAgentChat/);
  assert.equal((appSource.match(/<ImageGeneration /g) || []).length, 1);
});

const durableId = number => `a0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const savedRun = (number, patch = {}) => run({ id: durableId(number), requestId: durableId(number + 100000), status: 'completed', userText: `Saved question ${number}`, assistantText: `Saved answer ${number}`, lastEventId: 3, ...patch });
const savedRows = (start, count = 16) => Array.from({ length: count }, (_, index) => savedRun(start + index));
const page = (runs, patch = {}) => ({ instanceId, threadId, projectId, revision: 40, runs, historyCursor: runs[0]?.id ?? null, ...patch });

test('durable DTO requires matching stable thread IDs, bounded pages and strict cursors', () => {
  for (const patch of [{ threadId: undefined }, { threadId: 'bad' }, { historyCursor: undefined }, { historyCursor: 'bad' }, { historyCursor: runId }, { persistence: 'session' }]) {
    assert.throws(() => safeAgentChatSnapshot(snapshot(patch), projectId), value => value.code === 'INVALID_RESPONSE');
  }
  assert.throws(() => safeAgentChatSnapshot(snapshot({ runs: [run({ threadId: nextInstance })] }), projectId));
  assert.throws(() => safeAgentChatSnapshot(snapshot({ runs: [run(), run({ id: durableId(2), status: 'completed' })] }), projectId), 'Duplicate request IDs cannot be disguised as different runs');
  for (const patch of [{ threadId: undefined }, { projectId: 'other' }, { runs: savedRows(1, 17) }, { runs: [run()] }, { historyCursor: durableId(999) }, { runs: [savedRun(1), savedRun(1)] }, { runs: [savedRun(1, { threadId: nextInstance })] }]) {
    assert.throws(() => logic.safeAgentChatHistory(page(savedRows(1), patch), projectId, instanceId, threadId, durableId(17)));
  }
  assert.throws(() => logic.safeAgentChatHistory(page(savedRows(1)), projectId, nextInstance, threadId, durableId(17)));
  assert.throws(() => logic.safeAgentChatHistory(page(savedRows(1)), projectId, instanceId, threadId, durableId(1)));
  const clean = logic.safeAgentChatHistory(page(savedRows(1), { settings: { secret: 'not exposed' }, internal: 'not exposed' }), projectId, instanceId, threadId, durableId(17));
  assert.equal(clean.runs.length, 16); assert.doesNotMatch(JSON.stringify(clean), /settings|internal|not exposed/);
});

test('durable SSE DTO pins thread identity and never accepts a foreign-thread terminal run', () => {
  const event = frame({ type: 'terminal', run: run({ status: 'completed', lastEventId: 2 }) });
  assert.equal(logic.safeAgentChatEvent(event, { id: '2', type: 'terminal' }, projectId, instanceId, runId, threadId).threadId, threadId);
  for (const candidate of [{ ...event, threadId: undefined }, { ...event, threadId: nextInstance }, { ...event, run: { ...event.run, threadId: nextInstance } }]) {
    assert.throws(() => logic.safeAgentChatEvent(candidate, { id: '2', type: 'terminal' }, projectId, instanceId, runId, threadId));
  }
});

test('request lookup and older history are authenticated read-only routes without epoch query or settings bodies', async () => {
  const calls = [], values = [{ ...envelope(run({ status: 'interrupted' }), 40), instanceId: nextInstance }, page(savedRows(1), { historyCursor: null })];
  const client = createAgentChatClient({ fetchImpl: async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ ok: true, data: values.shift() }) }; } });
  const recovered = await client.lookup(projectId, requestId); await client.history(projectId, durableId(17));
  assert.equal(recovered.instanceId, nextInstance);
  assert.deepEqual(calls.map(({ url, method, body, credentials, cache }) => ({ url, method, body, credentials, cache })), [
    { url: `/api/agent/chat/${projectId}/requests/${requestId}`, method: 'GET', body: undefined, credentials: 'same-origin', cache: 'no-store' },
    { url: `/api/agent/chat/${projectId}/history?before=${durableId(17)}`, method: 'GET', body: undefined, credentials: 'same-origin', cache: 'no-store' },
  ]);
  const wrong = createAgentChatClient({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: envelope(run({ requestId: durableId(1) })) }) }) });
  await assert.rejects(wrong.lookup(projectId, requestId), value => value.code === 'INVALID_RESPONSE');
});

for (const protocol of ['chat_completions', 'responses']) test(`${protocol} lost acknowledgement is resolved after restart outside latest 16 without new inference or context expansion`, async () => {
  const configured = { ...configuration, protocol }; let reads = 0;
  const latest = savedRows(100), saved = run({ configuration: configured, status: 'interrupted', assistantText: 'Persisted partial' });
  const f = fixture({ read: async () => ++reads === 1 ? snapshot({ settings: settings({ configuration: configured }) }) : snapshot({ instanceId: nextInstance, revision: 40, runs: latest, historyCursor: latest[0].id, settings: settings({ configuration: configured }) }),
    start: async () => { throw error('NETWORK'); }, lookup: async () => ({ ...envelope(saved, 40), instanceId: nextInstance }) });
  await ready(f); await f.session.send(); const state = f.session.getState();
  assert.equal(state.pending, null); assert.equal(state.draft, ''); assert.equal(state.phase, 'ready'); assert.equal(state.sessionLost, true); assert.equal(state.recoveredRun.id, runId);
  assert.deepEqual(state.snapshot.runs.map(run => run.id), latest.map(run => run.id)); assert.equal(state.snapshot.runs.length, 16); assert.equal(state.consent, null);
  assert.equal(f.calls.filter(call => call[0] === 'lookup').length, 1); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.calls.some(call => ['stream', 'stop'].includes(call[0])), false); f.session.dispose();
});

test('restart with a still-missing request retains receipt and draft until explicit risk confirmation', async () => {
  let reads = 0; const f = fixture({ read: async () => snapshot({ instanceId: ++reads > 1 ? nextInstance : instanceId }), start: async () => { throw error('NETWORK'); } });
  await ready(f); await f.session.send(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'A typed question');
  assert.equal(f.receipts.get(projectId).requestId, requestId); assert.equal(await f.session.send(), false);
  assert.equal(f.session.abandonPending(requestId), false); f.session.confirmAbandonPending(true); f.session.confirmAbandonPending(false); assert.equal(f.session.abandonPending(requestId), false);
  f.session.confirmAbandonPending(true); assert.equal(f.session.abandonPending(durableId(999)), false); assert.equal(f.session.abandonPending(requestId), true);
  assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().consent, null); assert.equal(await f.session.send(), false);
  assert.match(f.session.getState().message, /重复回复或费用/); assert.equal(f.receipts.get(projectId).requestId, undefined); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('lookup racing another restart remains blocked, keeps draft and uses a later explicit read only', async () => {
  let reads = 0; const f = fixture({ read: async () => snapshot({ instanceId: ++reads >= 3 ? nextInstance : instanceId, revision: 1 }), start: async () => { throw error('NETWORK'); }, lookup: async () => ({ ...envelope(run({ status: 'interrupted' })), instanceId: nextInstance }) });
  await ready(f); await f.session.send(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().pending.requestId, requestId);
  await f.session.load(); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().recoveredRun.status, 'interrupted'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('successful request lookup with newer revision rereads latest context instead of patching stale consent', async () => {
  const receipts = memoryReceipts(); receipts.set(projectId, { instanceId, requestId }); let reads = 0;
  const f = fixture({ receipts, read: async () => ++reads === 1 ? snapshot() : snapshot({ revision: 2, runs: [run({ status: 'completed' })] }), lookup: async () => envelope(run({ status: 'completed' }), 2) });
  await f.session.load(); assert.equal(reads, 2); assert.equal(f.session.getState().snapshot.revision, 2); assert.equal(f.session.getState().snapshot.runs.length, 1); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().consent, null); assert.equal(f.calls.some(call => call[0] === 'start'), false); f.session.dispose();
});

test('failed lookup after renderer reopen preserves readable snapshot and pending identity for an honest user choice', async () => {
  const receipts = memoryReceipts(); receipts.set(projectId, { instanceId, requestId });
  const f = fixture({ receipts, lookup: async () => { throw error('AGENT_CHAT_STORAGE_UNAVAILABLE'); } }); await f.session.load();
  assert.equal(f.session.getState().snapshot.threadId, threadId); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().pending.requestId, requestId); assert.match(f.session.getState().message, /数据库暂不可用/); assert.equal(await f.session.send(), false); f.session.dispose();
});

test('malformed or foreign request recovery cannot clear pending, overwrite draft or repeat POST', async () => {
  for (const patch of [{ projectId: 'other' }, { threadId: nextInstance }, { requestId: durableId(999) }, { userText: 'foreign text' }, { configuration: { ...configuration, protocol: 'responses' } }]) {
    const f = fixture({ start: async () => { throw error('NETWORK'); }, lookup: async () => envelope(run({ status: 'completed', ...patch })) }); await ready(f); await f.session.send();
    assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().pending.requestId, requestId); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
  }
});

test('late acknowledgement or read recovery never clears a newer typed draft', async () => {
  for (const lost of [false, true]) {
    const held = deferred(), f = fixture({ initial: snapshot({ revision: 1 }), start: () => held.promise, lookup: async () => envelope(run({ status: 'completed' })) }); await ready(f);
    const sending = f.session.send(); f.session.edit('A newer unsent draft');
    if (lost) held.reject(error('NETWORK')); else held.resolve(envelope(run({ status: 'completed' })));
    await sending; assert.equal(f.session.getState().draft, 'A newer unsent draft'); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().consent, null); f.session.dispose();
  }
});

test('durable read, reconnect and backend epoch changes retain unsent drafts and revoke consent', async () => {
  let reads = 0; const f = fixture({ read: async () => snapshot({ instanceId: ++reads >= 3 ? nextInstance : instanceId }) }); await ready(f);
  await f.session.load(); assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().consent, null);
  f.session.approve(true); f.session.setVisible(false); f.session.setVisible(true); await flush();
  assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().sessionLost, true); assert.equal(f.session.getState().consent, null); assert.equal(f.calls.some(call => call[0] === 'start'), false); f.session.dispose();
});

test('storage limit preserves draft, requires renewed consent and never automatically retries', async () => {
  const f = fixture({ start: async () => { throw error('AGENT_CHAT_STORAGE_LIMIT'); } }); await ready(f); await f.session.send();
  assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().consent, null); assert.match(f.session.getState().message, /数据库容量已满/); assert.equal(await f.session.send(), false); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('storage-unavailable acknowledgement is uncertain admission and read-reconciles without retry', async () => {
  const f = fixture({ initial: snapshot({ revision: 1 }), start: async () => { throw error('AGENT_CHAT_STORAGE_UNAVAILABLE'); }, lookup: async () => envelope(run({ status: 'completed', assistantText: 'Persisted before acknowledgement failure' })) }); await ready(f); await f.session.send();
  assert.equal(f.session.getState().pending, null); assert.equal(f.session.getState().recoveredRun.assistantText, 'Persisted before acknowledgement failure'); assert.equal(f.calls.filter(call => call[0] === 'lookup').length, 1); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('history paging retains only one 16-run page and at most 32 back cursors without changing latest context or draft', async () => {
  const latest = savedRows(1000), f = fixture({ initial: snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }), history: async (_, before) => { const number = Number(before.slice(-12)); return page(savedRows(number - 16)); } });
  await ready(f); const consent = f.session.getState().consent;
  for (let i = 0; i < 40; i++) assert.equal(await f.session.earlier(), true);
  const state = f.session.getState(); assert.equal(state.history.page.runs.length, 16); assert.equal(state.history.trail.length, 32); assert.equal(state.history.before, durableId(376));
  assert.deepEqual(state.snapshot.runs, safeAgentChatSnapshot(snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }), projectId).runs); assert.equal(state.draft, 'A typed question'); assert.equal(state.consent, consent);
  await f.session.newer(); assert.equal(f.session.getState().history.before, durableId(392)); assert.equal(f.session.getState().history.trail.length, 31);
  f.session.closeHistory(); assert.deepEqual(f.session.getState().history, { phase: 'closed', page: null, before: null, trail: [], message: '' }); assert.equal(f.calls.some(call => ['start', 'stop'].includes(call[0])), false); f.session.dispose();
});

test('history paging and double clicks do not detach the live stream or overwrite its draft and output', async () => {
  const held = deferred(), latest = [...savedRows(100, 15), run()], f = fixture({ initial: snapshot({ revision: 1, runs: latest, historyCursor: latest[0].id }), history: () => held.promise });
  await f.session.load(); f.session.edit('Draft while streaming'); const stream = f.events[0], opening = f.session.earlier(); assert.equal(await f.session.earlier(), false);
  stream.onEvent(frame()); held.resolve(page(savedRows(84), { revision: 1 })); await opening;
  assert.equal(stream.signal.aborted, false); assert.equal(f.session.getState().phase, 'streaming'); assert.equal(f.session.getState().snapshot.runs.at(-1).assistantText, 'Hello'); assert.equal(f.session.getState().draft, 'Draft while streaming'); assert.equal(f.calls.filter(call => call[0] === 'history').length, 1); f.session.dispose();
});

test('late history after close, hide, reload or project disposal cannot repopulate an obsolete viewer', async () => {
  for (const action of ['close', 'hide', 'reload', 'dispose']) {
    const held = deferred(), latest = savedRows(100), f = fixture({ initial: snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }), history: () => held.promise }); await ready(f);
    const opening = f.session.earlier();
    if (action === 'close') f.session.closeHistory(); else if (action === 'hide') f.session.setVisible(false); else if (action === 'reload') await f.session.load(); else f.session.dispose();
    held.resolve(page(savedRows(84))); assert.equal(await opening, false); assert.equal(f.session.getState().history.page, null); assert.equal(f.session.getState().history.phase, 'closed'); assert.equal(f.calls.some(call => call[0] === 'start'), false); f.session.dispose();
  }
});

test('foreign, overlapping, malformed or old-epoch history never changes current project content', async () => {
  for (const patch of [{ projectId: 'other' }, { threadId: nextInstance }, { instanceId: nextInstance }, { revision: 39 }, { runs: savedRows(100) }, { runs: savedRows(84, 17) }, { historyCursor: durableId(999) }]) {
    const latest = savedRows(100), f = fixture({ initial: snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }), history: async () => page(savedRows(84), patch) }); await ready(f); const original = f.session.getState().snapshot;
    assert.equal(await f.session.earlier(), false); assert.equal(f.session.getState().history.phase, 'error'); assert.equal(f.session.getState().history.page, null); assert.equal(f.session.getState().snapshot, original); assert.equal(f.session.getState().draft, 'A typed question'); assert.equal(f.calls.some(call => call[0] === 'start'), false); f.session.dispose();
  }
});

test('hidden history navigation and pending-reset callbacks cannot dispatch or clear receipts', async () => {
  const receipts = memoryReceipts(); receipts.set(projectId, { instanceId, requestId }); const latest = savedRows(100), f = fixture({ receipts, initial: snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }) }); await f.session.load(); f.session.confirmAbandonPending(true); f.session.setVisible(false);
  assert.equal(await f.session.earlier(), false); assert.equal(await f.session.newer(), false); assert.equal(f.session.closeHistory(), false); assert.equal(f.session.abandonPending(requestId), false); assert.equal(f.session.confirmAbandonPending(false), false); assert.equal(f.receipts.get(projectId).requestId, requestId); assert.equal(f.calls.some(call => call[0] === 'history'), false); f.session.dispose();
});

test('actual durable panel prominently discloses plaintext local persistence and shows interrupted history without continuing', async () => {
  const f = fixture({ initial: snapshot({ revision: 2, runs: [run({ status: 'interrupted', assistantText: '<img src="https://hostile.example"> persisted text' })] }) }), h = uiHarness(f.client);
  h.render(); await flush(); h.render(); const text = JSON.stringify(h.find('agent-chat-persistence'));
  for (const pattern of [/本地应用数据库/, /并非密钥保险库加密/, /请勿输入密钥或其他秘密/, /刷新页面或退出应用会丢失未发送草稿/]) assert.match(text, pattern);
  assert.ok(h.find('agent-chat-interrupted')); assert.equal(h.find('agent-chat-response').props.children, '<img src="https://hostile.example"> persisted text'); assert.equal(f.calls.some(call => ['start', 'stop', 'stream'].includes(call[0])), false); h.unmount();
});

test('actual archive controls preserve composer and live history, and stale hidden controls are inert', async () => {
  const latest = savedRows(100), f = fixture({ initial: snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }), history: async () => page(savedRows(84), { historyCursor: null }) }), h = uiHarness(f.client);
  h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'Retain this draft'); const older = h.find('agent-chat-history-older').props.onClick; older(); await flush(); h.render();
  assert.ok(h.find('agent-chat-history-page')); assert.equal(h.find('agent-chat-prompt').props.value, 'Retain this draft'); assert.equal(h.find('agent-chat-response').props.children, 'Saved answer 100'); assert.equal(h.find('agent-chat-history-response').props.children, 'Saved answer 84'); assert.equal(h.find('agent-chat-history-older').props.disabled, true);
  const close = h.find('agent-chat-history-close').props.onClick; h.setVisible(false); older(); close(); h.setVisible(true); await flush(); h.render(); older(); close();
  assert.equal(f.calls.filter(call => call[0] === 'history').length, 1); assert.equal(h.find('agent-chat-prompt').props.value, 'Retain this draft'); assert.equal(f.calls.some(call => call[0] === 'start'), false); h.unmount();
});

test('actual pending release explains duplicate cost and requires explicit confirmation without sending', async () => {
  const f = fixture({ start: async () => { throw error('NETWORK'); } }), h = uiHarness(f.client); h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'A typed question'); h.change('agent-chat-consent', true); h.form().props.onSubmit({ preventDefault() {} }); await flush(); h.render();
  h.find('agent-chat-pending-reset').props.onClick(); h.render(); assert.match(JSON.stringify(h.find('agent-chat-pending-reset-warning')), /重复回复或计费/); h.find('agent-chat-pending-reset-cancel').props.onClick(); h.render(); assert.ok(h.find('agent-chat-pending'));
  h.find('agent-chat-pending-reset').props.onClick(); h.render(); h.find('agent-chat-pending-reset-confirm').props.onClick(); h.render(); assert.equal(h.find('agent-chat-pending'), undefined); assert.equal(h.find('agent-chat-send').props.disabled, true); assert.equal(h.find('agent-chat-prompt').props.value, 'A typed question'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); h.unmount();
});

test('lookup cannot hide a running request outside latest history and accidentally unlock another send', async () => {
  const receipts = memoryReceipts(); receipts.set(projectId, { instanceId, requestId });
  const f = fixture({ receipts, initial: snapshot({ revision: 1 }), lookup: async () => envelope(run()) }); await f.session.load();
  assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().pending.requestId, requestId); assert.equal(f.session.getState().recoveredRun, null); assert.equal(f.session.approve(true), false); assert.equal(await f.session.send(), false); f.session.dispose();
});

test('actual project switch during an older-page read discards the old result and makes its handlers inert', async () => {
  const held = deferred(), latest = savedRows(100), f = fixture({ read: async owner => owner === projectId ? snapshot({ revision: 40, runs: latest, historyCursor: latest[0].id }) : snapshot({ projectId: owner }), history: () => held.promise }), h = uiHarness(f.client);
  h.render(); await flush(); h.render(); const oldOlder = h.find('agent-chat-history-older').props.onClick; oldOlder(); h.render();
  const oldClose = h.find('agent-chat-history-close').props.onClick; h.render('project-two'); await flush(); h.render(); held.resolve(page(savedRows(84))); await flush(); oldOlder(); oldClose(); h.render();
  assert.equal(h.find('agent-chat-page').props['data-project-id'], 'project-two'); assert.equal(h.find('agent-chat-history-page'), undefined); assert.equal(h.find('agent-chat-archive'), undefined); assert.equal(h.find('agent-chat-prompt').props.value, ''); assert.equal(f.calls.filter(call => call[0] === 'history').length, 1); assert.equal(f.calls.some(call => call[0] === 'start'), false); h.unmount();
});
