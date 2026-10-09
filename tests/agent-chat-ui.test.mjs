import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import * as logic from '../apps/web/src/agent-chat.js';

const { createAgentChatClient, createAgentChatSession, createAgentChatReceipts, safeAgentChatSnapshot, safeAgentChatRun, readAgentChatSSE, agentChatCanSend, agentChatPromptIssue, agentChatErrorText } = logic;
const projectId = 'project-one', instanceId = '11111111-1111-4111-8111-111111111111', nextInstance = '99999999-9999-4999-8999-999999999999';
const runId = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333';
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://api.example.com/v1', model: 'gpt-4.1-mini' };
const settings = (patch = {}) => ({ revision: 0, configuration: { ...configuration }, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', ...configuration }] }], scope: 'settings_only', verification: 'not_tested', ...patch });
const run = (patch = {}) => ({ id: runId, requestId, projectId, status: 'running', userText: 'A typed question', assistantText: '', configuration: { ...configuration }, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', lastEventId: 1, ...patch });
const snapshot = (patch = {}) => ({ instanceId, projectId, revision: 0, scope: 'chat_only', persistence: 'session', mode: 'simulated', settings: settings(), runs: [], ...patch });
const envelope = (value = run(), revision = 1) => ({ instanceId, projectId, revision, run: value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const error = code => Object.assign(Error('raw-private-provider-secret'), { code });
const memoryReceipts = () => { const data = new Map(); return { get: id => data.get(id), set: (id, value) => data.set(id, value), data }; };
function fixture({ initial = snapshot(), read, start, stop, getRun, stream, receipts = memoryReceipts(), owner = projectId } = {}) {
  const calls = [], events = [], changes = [];
  const client = {
    read: async (...args) => { calls.push(['read', ...args]); return read ? read(...args) : structuredClone(initial); },
    start: async (...args) => { calls.push(['start', ...args]); return start ? start(...args) : envelope(run({ userText: args[1].message })); },
    stop: async (...args) => { calls.push(['stop', ...args]); return stop ? stop(...args) : envelope(run({ status: 'stopped', assistantText: 'partial', lastEventId: 3 }), 2); },
    run: async (...args) => { calls.push(['run', ...args]); return getRun ? getRun(...args) : envelope(run()); },
    stream: (...args) => { calls.push(['stream', ...args.slice(0, 4)]); events.push(args[4]); return stream ? stream(...args) : new Promise(resolve => args[4].signal.addEventListener('abort', resolve, { once: true })); },
  };
  const session = createAgentChatSession({ projectId: owner, client, receipts, requestId: () => requestId, onChange: next => changes.push(structuredClone(next)) });
  return { client, session, calls, events, changes, receipts };
}
const ready = async f => { await f.session.load(); f.session.edit('A typed question'); f.session.approve(true); };
const frame = (patch = {}) => ({ id: 2, type: 'delta', instanceId, projectId, runId, revision: 1, text: 'Hello', ...patch });

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
  const input = { requestId, instanceId, expectedSettingsRevision: 0, expectedConversationRevision: 0, message: 'typed only', consent: { destination: configuration.baseUrl, model: configuration.model, context: 'typed_chat_only' } };
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
  assert.deepEqual(input.consent, { destination: configuration.baseUrl, model: configuration.model, context: 'typed_chat_only' });
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
  const g = fixture({ receipts }); await g.session.load(); assert.equal(g.session.getState().phase, 'unknown'); assert.match(g.session.getState().message, /不能证明请求未被接受/); assert.match(g.session.getState().message, /重启后端或应用/); assert.match(g.session.getState().message, /所有临时对话会丢失/); assert.match(g.session.getState().message, /计费/); assert.equal(g.session.approve(true), false); assert.equal(await g.session.send(), false); assert.equal(g.calls.some(call => call[0] === 'start'), false); g.session.dispose();
});

test('receipt storage contains identities only and survives new reader without text or configuration', () => {
  let stored = ''; const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  createAgentChatReceipts(storage).set(projectId, { instanceId, requestId, message: 'private prompt', apiKey: 'private key', configuration });
  assert.doesNotMatch(stored, /private|configuration|apiKey/); assert.deepEqual(createAgentChatReceipts(storage).get(projectId), { instanceId, requestId });
});

test('backend restart identifies lost temporary session, clears pending and never repeats old request', async () => {
  const receipts = memoryReceipts(); receipts.set(projectId, { instanceId, requestId });
  const f = fixture({ receipts, initial: snapshot({ instanceId: nextInstance }) }); await f.session.load();
  assert.equal(f.session.getState().sessionLost, true); assert.equal(f.session.getState().pending, null); assert.match(f.session.getState().message, /旧对话/);
  assert.equal(f.calls.some(call => call[0] === 'start'), false); assert.equal(f.session.getState().consent, null); f.session.dispose();
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
const element = (type, props = {}, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const depsEqual = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function uiHarness(client, receipts = memoryReceipts()) {
  const slots = [], dom = new Map(); let cursor = 0, effects = [], tree, closes = 0, settingsOpened = 0, currentProject = projectId;
  const react = { createElement: element,
    useState(initial) { const i = cursor++; slots[i] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useLayoutEffect(callback, deps) { const i = cursor++, old = slots[i]; if (old && depsEqual(deps, old.deps)) return; slots[i] = { callback, deps, cleanup: old?.cleanup }; effects.push(i); },
  }; react.default = react;
  const module = { exports: {} }, primitive = new Proxy({}, { get: (_, key) => String(key) });
  Function('module', 'exports', 'require', transformed)(module, module.exports, id => {
    if (id === 'react') return react;
    if (id === './agent-chat.js') return { ...logic, createAgentChatSession: options => logic.createAgentChatSession({ ...options, client, receipts, requestId: () => requestId }) };
    if (id === './icons.jsx') return { default: 'Icon' };
    if (id.startsWith('@mioon/ui/') || id === './WorkspaceControls.jsx') return primitive;
    throw Error(id);
  });
  const h = {
    render(owner = currentProject) { currentProject = owner; cursor = 0; effects = []; tree = module.exports.default({ projectId: currentProject, projectName: 'Private Local Project', onClose: () => { closes++; }, onSettings: () => { settingsOpened++; } }); for (const node of nodes(tree)) if (node.props.ref) { const id = node.props.id || node.props['data-testid']; if (!dom.has(id)) dom.set(id, { value: '', scrollHeight: 100, scrollTop: 0 }); node.props.ref.current = dom.get(id); } for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].callback(); } return tree; },
    find(id) { return nodes(tree).find(node => node.props['data-testid'] === id); },
    form() { return nodes(tree).find(node => node.type === 'form'); },
    change(id, value) { h.find(id).props.onChange({ target: { value, checked: value } }); h.render(); },
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

test('actual component dismissal and settings transition dispose old callbacks before parent navigation', async () => {
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
  assert.equal(h.closes, 0); assert.equal(h.find('agent-chat-prompt').props.value, ''); assert.equal(h.find('agent-chat-dialog').props['data-project-id'], 'project-two'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); h.unmount();
});

test('integration preserves independent settings entry, one modal, bounded history and app-local controls', () => {
  const app = readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /data-testid="agent-chat-open"/); assert.match(app, /data-testid="agent-settings-open"/); assert.match(app, /showAgentChat && !showAgentSettings && data.project && <AgentPanel key={data.project.id}/);
  assert.match(source, /from '\.\/WorkspaceControls\.jsx'/); assert.match(source, /from '@mioon\/ui\/components\/dialog'/);
  assert.match(source, /无项目读取权限 · 无工具执行/); assert.match(source, /不会发送/); assert.match(source, /重启后丢失/);
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
