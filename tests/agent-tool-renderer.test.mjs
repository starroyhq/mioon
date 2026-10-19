import {createAgentAuthorizationUiMock} from './helpers/agent-authorization-ui.mjs';
import {creationTestDependency} from './helpers/creation-i18n.ts';
import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import * as timing from '../apps/web/src/agent-timeline-context.ts';
import * as gainContext from '../apps/web/src/agent-timeline-gain-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as logic from '../apps/web/src/agent-chat.ts';
import * as tools from '../apps/web/src/agent-tool-state.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), instanceId = id(2), threadId = id(3), runId = id(4), requestId = id(5);
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions' };
const policy = (patch = {}) => ({ available: true, ...tools.AGENT_INSPECTION_LIMITS, catalogHash: 'a'.repeat(64), ...patch });
const settings = (config = configuration, revision = 0) => ({ revision, configuration: config, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], ...configuration }] }], scope: 'settings_only', verification: 'not_tested' });
const snapshot = (patch = {}) => ({ instanceId, threadId, projectId, revision: 0, authorization: {revision: 0, scopes: []}, scope: 'chat_and_project_inspection', persistence: 'local_database', mode: 'simulated', inspection: policy(), settings: settings(), runs: [], historyCursor: null, ...patch });
const model = (ordinal = 1, status = 'dispatch_started') => ({ id: id(10 + ordinal), kind: 'model', ordinal, status });
const tool = (patch = {}) => ({ id: id(20), kind: 'tool', ordinal: 1, status: 'completed', name: 'mioon_project_inspect', operation: 'project.inspect', resultJson: JSON.stringify({ name: 'Saved project', description: '<script>never execute</script> https://hostile.example' }), ...patch });
const run = (patch = {}) => ({ id: runId, requestId, threadId, projectId, status: 'running', userText: 'Read my saved project', assistantText: '', configuration, createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', lastEventId: 1, contextMode: 'project_inspection', provenance: { category: 'project_saved_text_metadata', projectId, sourceRunIds: [] }, activity: [model()], ...patch });
const typedRun = (patch = {}) => { const value = run(patch); delete value.contextMode; delete value.provenance; delete value.activity; return value; };
const envelope = (value, revision = 1) => ({ instanceId, threadId, projectId, revision, run: value });
const frame = (value, revision = 1, type = 'snapshot') => ({ instanceId, threadId, projectId, revision, type, runId, id: value.lastEventId, run: value });
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const error = code => Object.assign(new Error('private backend message'), { code });
const receipts = () => { const map = new Map(); return { get: id => map.get(id), set: (id, value) => map.set(id, value) }; };
function fixture({ initial = snapshot(), read, start, lookup, stop } = {}) {
  const calls = [], events = []; let accepted;
  const client = {
    ...createAgentAuthorizationUiMock(async owner => { calls.push(['read', owner]); return read ? read(owner) : structuredClone(initial); }),
    start: async (owner, input) => { calls.push(['start', owner, input]); const value = input.consent.context === 'project_inspection' ? run({ configuration: initial.settings.configuration, userText: input.message }) : typedRun({ configuration: initial.settings.configuration, userText: input.message }); accepted = value; return start ? start(owner, input) : envelope(value); },
    lookup: async (...args) => { calls.push(['lookup', ...args]); if (lookup) return lookup(...args); throw error('AGENT_CHAT_NOT_FOUND'); },
    run: async () => { calls.push(['run']); return envelope(accepted || run()); },
    stop: async (owner, id, epoch) => { calls.push(['stop', owner, id, epoch]); return stop ? stop(owner, id, epoch) : envelope({ ...accepted, status: 'stopped', lastEventId: 3 }, 2); },
    stream: async (...args) => { calls.push(['stream', ...args.slice(0, 4)]); const event = args[4]; events.push(event); await new Promise(resolve => event.signal.addEventListener('abort', resolve, { once: true })); },
  };
  const session = logic.createAgentChatSession({ projectId, client, receipts: receipts(), requestId: () => requestId });
  return { client, session, calls, events };
}
const choose = async f => { await f.session.load(); f.session.edit('Read my saved project'); assert.equal(f.session.setContextMode('project_inspection'), true); assert.equal(await f.session.approve(true), true); };
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const element = (type, props, ...children) => { const p = { ...props, children: children.length === 1 ? children[0] : children }; return typeof type === 'function' && type.name === 'AgentRunActivity' ? type(p) : { type, props: p }; };
const depsEqual = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function harness(client) {
  const slots = [], localReceipts = receipts(); let cursor = 0, effects = [], visible = true, owner = projectId, tree;
  const react = { createElement: element,
    useState(value) { const i = cursor++; slots[i] ||= { value: typeof value === 'function' ? value() : value }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !depsEqual(deps, slots[i].deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useRef(value) { const i = cursor++; return slots[i] ||= { current: value }; },
    useLayoutEffect(fn, deps) { const i = cursor++, old = slots[i]; if (old && depsEqual(deps, old.deps)) return; slots[i] = { fn, deps, cleanup: old?.cleanup }; effects.push(i); },
  }; react.default = react;
  const resolve = name => {
    const localized = creationTestDependency(name); if (localized) return localized;
    if (name === './agent-timeline-context.ts') return timing;
    if (name === './agent-timeline-gain-context.ts') return gainContext;
    if (name === './AgentTimelineGain.tsx') { const gain = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/AgentTimelineGain.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(gain, gain.exports, resolve); return gain.exports; }
    if (name === './editor-settings-scope.ts') { const scope = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(scope, scope.exports, resolve); return scope.exports; }
    if (name === './native-close-sources.ts') return nativeCloseSources;
    if (name === 'react') return react;
    if (name === './agent-chat.ts') return { ...logic, createAgentChatSession: input => logic.createAgentChatSession({ ...input, client, receipts: localReceipts, requestId: () => requestId }) };
    if (name === './agent-tool-state.ts') return tools;
    if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => visible };
    if (name === './icons.tsx') return { default: 'Icon' };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return new Proxy({}, { get: (_, key) => String(key) });
    if (name === './AgentEditProposal.tsx') return { __esModule: true, default: 'AgentEditProposal' };
    if (name === './AgentRunActivity.tsx') return load(name);
    throw Error(name);
  };
  const load = name => { const module = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL(`../apps/web/src/${name.slice(2)}`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, resolve); return module.exports; };
  const panel = load('./AgentPanel.tsx').default;
  const h = {
    render(project = owner) { owner = project; cursor = 0; effects = []; tree = panel({ projectId: owner, projectName: 'Chosen project', onClose() {}, onSettings() {} }); for (const i of effects) { slots[i].cleanup?.(); slots[i].cleanup = slots[i].fn(); } return tree; },
    find: id => nodes(tree).find(node => node.props['data-testid'] === id),
    all: id => nodes(tree).filter(node => node.props['data-testid'] === id),
    change(id, value) {
      if (id.startsWith('agent-chat-mode-') && h.find('agent-chat-composer-options')?.props.hidden) { h.find('agent-chat-target-disclosure').props.onOpenChange(true); h.render(); }
      if (id === 'agent-chat-consent' && value) { h.find('agent-chat-authorization-open')?.props.onClick(); h.render(); }
      h.find(id).props.onChange({ target: { value, checked: value } }); h.render();
      if (id === 'agent-chat-consent' && value) { h.find('agent-chat-authorization-confirm').props.onClick(); h.render(); }
    },
    submit() { nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    hide(value = true) { visible = !value; h.render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  }; return h;
}

for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol}: actual dock requires a destination/model/scope grant; opening/typing/toggling never sends`, async () => {
    const configured = { ...configuration, protocol }, f = fixture({ initial: snapshot({ settings: settings(configured) }) }), h = harness(f.client);
    h.render(); await flush(); h.render(); assert.equal(h.find('agent-chat-mode-typed').props.checked, true); assert.equal(h.find('agent-chat-consent').props.checked, false);
    h.change('agent-chat-prompt', 'Read my saved project'); h.change('agent-chat-consent', true); await flush(); h.render(); h.change('agent-chat-mode-project', true);
    assert.equal(h.find('agent-chat-consent').props.checked, false); h.submit(); assert.equal(f.calls.some(call => call[0] === 'start'), false);
    assert.match(JSON.stringify(h.render()), new RegExp(projectId)); const context = JSON.stringify(h.find('agent-chat-context')); for (const pattern of [/Chosen project/, /上方项目/, /2 次模型请求/, /1 次只读工具调用/, /8 KiB/, /关闭工具/]) assert.match(context, pattern);
    h.change('agent-chat-consent', true); await flush(); h.render(); h.submit(); h.submit(); await flush(); h.render();
    const sends = f.calls.filter(call => call[0] === 'start'); assert.equal(sends.length, 1);
    assert.deepEqual(sends[0][2].consent, { destination: logic.deriveAgentEndpoint(configured), protocol, model: configured.model, context: 'project_inspection', projectId, ...tools.AGENT_INSPECTION_LIMITS, catalogHash: policy().catalogHash });
    assert.equal(h.find('agent-chat-consent').props.checked, true); assert.equal(h.find('agent-chat-consent').props.disabled, true); assert.equal(h.find('agent-chat-composer-options').props.hidden, true); assert.ok(h.find('agent-run-activity')); h.unmount();
  });

  test(`${protocol}: immutable streamed tool activity and results remain inert text with no new inference`, async () => {
    const configured = { ...configuration, protocol }, f = fixture({ initial: snapshot({ settings: settings(configured) }) }), h = harness(f.client);
    h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'Read my saved project'); h.change('agent-chat-mode-project', true); h.change('agent-chat-consent', true); await flush(); h.render(); h.submit(); await flush(); h.render();
    const result = tool(), progressed = run({ configuration: configured, lastEventId: 2, activity: [model(1, 'completed'), result, model(2)] });
    f.events[0].onEvent(frame(progressed)); h.render();
    assert.equal(h.find('agent-tool-result').type, 'pre'); assert.equal(h.find('agent-tool-result').props.children, result.resultJson);
    assert.match(JSON.stringify(h.find('agent-run-activity')), /mioon_project_inspect|project.inspect|工具已关闭/);
    assert.equal(nodes(h.render()).some(node => ['a', 'img', 'script', 'iframe'].includes(node.type) || node.props.dangerouslySetInnerHTML), false);
    const parsed = logic.safeAgentChatEvent(frame(progressed), { id: '2', type: 'snapshot' }, projectId, instanceId, runId, threadId);
    assert.equal(parsed.run.activity[1].resultJson, result.resultJson); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
    f.events[0].onEvent(frame({ ...progressed, status: 'completed', assistantText: 'Saved result', lastEventId: 3, activity: [model(1, 'completed'), result, model(2, 'completed')] }, 2, 'terminal')); h.render();
    h.change('agent-chat-mode-typed', true); assert.match(JSON.stringify(h.find('agent-run-provenance')), /已保存文字与元数据/); assert.match(JSON.stringify(h.find('agent-chat-context')), /不含项目/); h.unmount();
  });

  test(`${protocol}: lost acknowledgement with wrong context never clears draft or silently resends`, async () => {
    const configured = { ...configuration, protocol }, f = fixture({ initial: snapshot({ settings: settings(configured) }), start: async () => { throw error('NETWORK'); }, lookup: async () => envelope(typedRun({ configuration: configured })) });
    await choose(f); await f.session.send(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'Read my saved project'); assert.equal(f.session.getState().pending.requestId, requestId); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
  });
}

test('old snapshots and absent/unavailable capability cannot enable project inspection', async () => {
  for (const patch of [{ scope: 'chat_only', inspection: undefined }, { inspection: undefined }, { inspection: policy({ available: false }) }, { scope: 'chat_only' }]) {
    const f = fixture({ initial: snapshot(patch) }); await f.session.load(); f.session.edit('typed'); assert.equal(f.session.setContextMode('project_inspection'), false); assert.equal(f.session.getState().contextMode, 'typed_chat_only'); assert.equal(f.calls.some(call => call[0] === 'start'), false); f.session.dispose();
  }
});

test('persistent grants bind endpoint/model/scope while exact outbound policy and malformed capability checks remain separate', async () => {
  const first = logic.safeAgentChatSnapshot(snapshot(), projectId), original = logic.agentChatConsentKey(first, 'project_inspection');
  // Project/conversation/settings revisions and inspected data do not revoke a
  // retained workspace grant; outbound request policy is still captured exactly.
  for (const patch of [{ projectId: id(90) }, { revision: 1 }, { settings: settings(configuration, 1) }, { inspection: policy({ catalogHash: 'b'.repeat(64) }) }]) assert.equal(logic.agentChatConsentKey({ ...first, ...patch }, 'project_inspection'), original);
  for (const patch of [{ model: 'different-model' }, { baseUrl: 'https://different.example/v1' }, { protocol: 'responses' }]) assert.notEqual(logic.agentChatConsentKey({ ...first, settings: settings({ ...configuration, ...patch }) }, 'project_inspection'), original);
  assert.equal(logic.agentChatConsentKey({ ...first, inspection: policy({ available: false }) }, 'project_inspection'), null);
  const changed = { ...first, projectId: id(90), inspection: policy({ catalogHash: 'b'.repeat(64) }) };
  const outbound = tools.agentChatOutboundConsent(changed, 'project_inspection', logic.deriveAgentEndpoint(configuration));
  assert.equal(outbound.projectId, id(90)); assert.equal(outbound.catalogHash, 'b'.repeat(64));
  assert.notEqual(logic.agentChatConsentKey(first, 'typed_chat_only'), original);
  for (const patch of [{ available: 1 }, { schemaVersion: 2 }, { maxModelRequests: 3 }, { maxToolCalls: 2 }, { maxResultBytes: 8193 }, { catalogHash: 'not-a-hash' }]) {
    const f = fixture({ initial: snapshot({ inspection: policy(patch) }) }); await f.session.load(); assert.equal(f.session.getState().phase, 'load_error'); assert.equal(await f.session.approve(true), false); assert.equal(await f.session.send(), false); f.session.dispose();
  }
});

test('changed permission reloads safely, preserves draft, returns to typed mode and requires explicit new consent', async () => {
  let reads = 0; const f = fixture({ read: async () => snapshot({ inspection: policy({ available: ++reads === 1 }) }), start: async () => { throw error('AGENT_CHAT_CONSENT_REQUIRED'); } });
  await choose(f); await f.session.send(); const state = f.session.getState(); assert.equal(state.phase, 'ready'); assert.equal(state.contextMode, 'typed_chat_only'); assert.equal(state.consent, null); assert.equal(state.draft, 'Read my saved project'); assert.equal(state.message, logic.agentChatErrorText('AGENT_CHAT_CONSENT_REQUIRED')); assert.equal(await f.session.send(), false); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('retained project-derived reply remains labelled when typed mode is selected; typed send has no project fields', async () => {
  const saved = run({ status: 'completed', assistantText: 'Project-derived answer', activity: [model(1, 'completed')] }), f = fixture({ initial: snapshot({ revision: 2, runs: [saved] }), start: async (_, input) => envelope(typedRun({ id: id(40), requestId, userText: input.message }), 3) }), h = harness(f.client);
  h.render(); await flush(); h.render(); assert.equal(h.find('agent-chat-mode-typed').props.checked, true); assert.match(JSON.stringify(h.find('agent-run-provenance')), /不会加入后续/); assert.equal(h.find('agent-chat-response').props.children, saved.assistantText);
  h.change('agent-chat-prompt', 'Only my typed text'); h.change('agent-chat-consent', true); await flush(); h.render(); h.submit(); await flush();
  assert.deepEqual(f.calls.find(call => call[0] === 'start')[2].consent, { destination: logic.deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model, context: 'typed_chat_only' }); h.unmount();
});

test('run projection rejects foreign/forged provenance, excess sources, ambiguous activity and oversized or malformed results', () => {
  const invalid = [
    { contextMode: 'unknown' }, { contextMode: null }, { provenance: null }, { provenance: { category: 'project_saved_text_metadata', projectId: id(99), sourceRunIds: [] } },
    { provenance: { category: 'project_saved_text_metadata', projectId, sourceRunIds: Array.from({ length: 13 }, (_, index) => id(100 + index)) } },
    { contextMode: 'typed_chat_only' }, { activity: [] }, { activity: [model(), model()] }, { activity: [model(2)] },
    { activity: [model(1, 'intent')] }, { activity: [model(), tool({ name: 'arbitrary_fetch' })] }, { activity: [model(), tool({ operation: 'project.get' })] },
    { activity: [model(), tool({ ordinal: 2 })] }, { activity: [model(), tool({ id: 'provider-id' })] },
    { activity: [model(), tool({ resultJson: '密'.repeat(3000) })] }, { activity: [model(), tool({ resultJson: '<script>not JSON</script>' })] },
    { activity: [model(), tool({ resultJson: undefined })] }, { activity: [model(), tool({ status: 'intent' })] },
  ];
  for (const patch of invalid) assert.throws(() => logic.safeAgentChatRun(run(patch), projectId), value => value.code === 'INVALID_RESPONSE');
  const projected = logic.safeAgentChatRun(run({ credential: 'SECRET', activity: [{ ...model(), providerBody: 'SECRET' }, { ...tool(), arguments: 'SECRET', rawOutput: 'SECRET' }] }), projectId);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|credential|arguments|providerBody|rawOutput/); assert.equal(Object.isFrozen(projected.provenance), true);
});

test('later snapshots cannot relabel provenance, replace step IDs or change a saved result', async () => {
  const f = fixture(); await choose(f); await f.session.send(); const listener = f.events[0].onEvent;
  listener(frame(run({ lastEventId: 2, activity: [model(1, 'completed'), tool()] })));
  for (const patch of [{ provenance: { category: 'project_saved_text_metadata', projectId, sourceRunIds: [id(80)] } }, { activity: [{ ...model(), id: id(77) }] }, { activity: [model(), tool({ resultJson: '{"changed":true}' })] }, { activity: [model()] }]) assert.throws(() => listener(frame(run({ ...patch, lastEventId: 3 }))), value => value.code === 'INVALID_RESPONSE');
  assert.equal(f.session.getState().snapshot.runs[0].activity[1].resultJson, tool().resultJson); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); f.session.dispose();
});

test('hidden acceptance preserves run identity, blocks stale mode/consent/send/stop, and reopening only reads', async () => {
  const held = deferred(); let reads = 0; const f = fixture({ read: async () => ++reads === 1 ? snapshot() : snapshot({ revision: 1, runs: [run()] }), start: () => held.promise }), h = harness(f.client);
  h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'Read my saved project'); h.change('agent-chat-mode-project', true); h.change('agent-chat-consent', true); await flush(); h.render();
  const oldMode = h.find('agent-chat-mode-typed').props.onChange, oldConsent = h.find('agent-chat-consent').props.onChange; h.submit(); h.hide();
  oldMode({ target: { checked: true } }); oldConsent({ target: { checked: true } }); h.submit(); held.resolve(envelope(run())); await flush(); h.render();
  assert.equal(f.calls.some(call => ['stream', 'stop'].includes(call[0])), false); assert.equal(h.find('agent-chat-page').props.inert, true);
  h.hide(false); await flush(); h.render(); oldMode({ target: { checked: true } }); oldConsent({ target: { checked: true } }); h.submit();
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(h.find('agent-chat-consent').props.checked, true); assert.equal(h.find('agent-chat-consent').props.disabled, true); assert.equal(h.find('agent-run-inspection').props['data-context-mode'], 'project_inspection'); h.unmount();
});

test('project navigation resets choice and makes old tool events and controls inert without stopping the accepted run', async () => {
  const f = fixture({ read: async owner => snapshot({ projectId: owner }) }), h = harness(f.client);
  h.render(); await flush(); h.render(); h.change('agent-chat-prompt', 'Read my saved project'); h.change('agent-chat-mode-project', true); h.change('agent-chat-consent', true); await flush(); h.render(); h.submit(); await flush(); h.render();
  const oldConsent = h.find('agent-chat-consent').props.onChange, oldMode = h.find('agent-chat-mode-project').props.onChange, oldStop = h.find('agent-chat-stop').props.onClick, oldEvent = f.events[0].onEvent;
  h.render(id(88)); await flush(); h.render(); oldConsent({ target: { checked: true } }); oldMode({ target: { checked: true } }); oldStop(); oldEvent(frame(run({ lastEventId: 2, activity: [model(1, 'completed'), tool()] }))); h.render();
  assert.equal(h.find('agent-chat-mode-typed').props.checked, true); assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.find('agent-run-activity'), undefined); assert.equal(f.calls.some(call => call[0] === 'stop'), false); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
  h.change('agent-chat-mode-project', true); assert.equal(h.find('agent-chat-consent').props.checked, true, 'same destination/model/scope grant survives project navigation'); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); h.unmount();
});

test('Stop uses the accepted identity once and never starts a continuation in the renderer', async () => {
  const f = fixture(); await choose(f); await f.session.send(); await f.session.stop(); assert.equal(await f.session.stop(), false);
  assert.deepEqual(f.calls.find(call => call[0] === 'stop'), ['stop', projectId, runId, instanceId]); assert.match(f.session.getState().message, /停止后续步骤/); assert.match(f.session.getState().message, /计费/); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.session.getState().consent, logic.agentChatConsentKey(f.session.getState().snapshot, 'project_inspection')); assert.equal(logic.agentChatCanSend(f.session.getState()), false); f.session.dispose();
});

test('inspection disclosures retain unencrypted storage, no secrets, bounded billing and continued hidden-run behavior', async () => {
  const f = fixture(), h = harness(f.client); h.render(); await flush(); h.render(); h.change('agent-chat-mode-project', true);
  const page = JSON.stringify(h.render()); for (const pattern of [/本地应用数据库/, /并非密钥保险库加密/, /请勿输入密钥或其他秘密/, /2 次模型请求/, /模型调用可能计费/, /确认一次/, /隐藏窗口、切换页签、收起面板或切换项目/, /重启不会自动续接/]) assert.match(page, pattern);
  const trigger = h.find('agent-chat-details-toggle'); assert.equal(trigger.type, 'CollapsibleTrigger'); assert.equal(f.calls.some(call => call[0] === 'start'), false); h.unmount();
});

// These are pure policy/parser modules; this check cannot contact a provider.
test('renderer consent matches the authoritative fixed catalog for both protocols and every public read operation', async () => {
  const { readToolCapability, READ_TOOL_OPERATIONS } = await import('../packages/business/src/agent/read-tool-policy.ts');
  const { parseChatConsent } = await import('../packages/business/src/agent/chat-context.ts');
  for (const protocol of ['chat_completions', 'responses']) {
    const current = logic.safeAgentChatSnapshot(snapshot({ settings: settings({ ...configuration, protocol }), inspection: readToolCapability(true) }), projectId);
    const consent = tools.agentChatOutboundConsent(current, 'project_inspection', logic.deriveAgentEndpoint(current.settings.configuration));
    assert.deepEqual(parseChatConsent(consent), consent);
    for (const [name, operation] of Object.entries(READ_TOOL_OPERATIONS)) {
      const projected = logic.safeAgentChatRun(run({ configuration: current.settings.configuration, activity: [model(1, 'completed'), tool({ name, operation })] }), projectId);
      assert.equal(projected.activity[1].operation, operation);
    }
  }
});
