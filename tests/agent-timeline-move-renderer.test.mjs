import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import * as gainContext from '../apps/web/src/agent-timeline-gain-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as edits from '../apps/web/src/agent-edits.js';
import * as chat from '../apps/web/src/agent-chat.js';
import * as policy from '../apps/web/src/agent-tool-state.js';
import * as timing from '../apps/web/src/agent-timeline-context.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), instanceId = id(2), threadId = id(3), timelineId = id(4), clipId = id(5), trackId = id(6), runId = id(7), proposalId = id(8), requestId = id(9);
const at = '2026-10-12T00:00:00.000Z';
const selected = { projectId, timelineId, clipId, trackId, expectedRevision: 4, clipName: 'Saved clip <script>text</script>', trackName: 'First video track', trackKind: 'video', fps: 30, width: 720, height: 1280, startFrame: 90, endFrame: 150, durationFrames: 60, timelineDurationFrames: 150, occupiedIntervals: [{ startFrame: 0, endFrame: 30 }] };
const publicTarget = Object.fromEntries(Object.entries(selected).filter(([key]) => !['startFrame', 'endFrame', 'durationFrames', 'timelineDurationFrames', 'occupiedIntervals'].includes(key)));
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions' };
const settings = { revision: 0, configuration, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], ...configuration }] }], scope: 'settings_only', verification: 'not_tested' };
const snapshot = (patch = {}) => ({ instanceId, threadId, projectId, revision: 0, scope: 'chat_and_reviewed_timeline_edits', persistence: 'local_database', mode: 'simulated', timelineEdit: { available: true, ...policy.AGENT_TIMELINE_LIMITS, catalogHash: 'a'.repeat(64) }, edit: { available: true, ...policy.AGENT_EDIT_LIMITS, catalogHash: 'b'.repeat(64) }, inspection: { available: true, ...policy.AGENT_INSPECTION_LIMITS, catalogHash: 'c'.repeat(64) }, settings, runs: [], historyCursor: null, ...patch });
const run = (patch = {}) => ({ id: runId, requestId, threadId, projectId, status: 'completed', userText: 'Move the selected clip to 6 seconds', assistantText: 'Already applied! <img src=x>', configuration, createdAt: at, updatedAt: at, lastEventId: 3, contextMode: policy.AGENT_TIMELINE_CONTEXT, editTarget: selected, provenance: { category: 'project_selected_timeline_timing', projectId, sourceRunIds: [] }, activity: [{ id: id(20), kind: 'model', ordinal: 1, status: 'completed' }], ...patch });
const proposal = (patch = {}) => ({ id: proposalId, projectId, runId, digest: 'd'.repeat(64), status: 'pending', runStatus: 'completed', operation: 'timeline.clip.update', target: publicTarget, patch: { startFrame: 180 }, diff: { before: { startFrame: 90, endFrame: 150, durationFrames: 60, timelineDurationFrames: 150 }, after: { startFrame: 180, endFrame: 240, durationFrames: 60, timelineDurationFrames: 240 } }, provenance: { runId, toolCallId: 'move-call-1', toolName: 'mioon_propose_timeline_clip_move' }, createdAt: at, updatedAt: at, ...patch });
const approval = { requestId: id(10), approvedAt: at };
const applied = () => proposal({ status: 'applied', approval, outcome: { status: 'applied', timelineId, clipId, revision: 5 } });
const envelope = (value, epoch = instanceId) => ({ instanceId: epoch, projectId, proposal: value });
const page = (values = [proposal()], patch = {}) => ({ instanceId, projectId, proposals: values, nextCursor: null, ...patch });
const error = code => Object.assign(new Error('Private unsafe error text'), { code });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const context = (patch = {}) => ({ target: selected, contextMode: policy.AGENT_TIMELINE_CONTEXT, ...patch });
function fixture(options = {}) {
  const calls = [], appliedCalls = [];
  const client = {
    list: async (...args) => { calls.push(['list', ...args]); return options.list ? options.list(...args) : page(); },
    get: async (...args) => { calls.push(['get', ...args]); return options.get ? options.get(...args) : envelope(proposal()); },
    act: async (...args) => { calls.push(['act', ...args]); return options.act ? options.act(...args) : envelope(applied()); },
  };
  const session = edits.createAgentEditsSession({ projectId, client, onApplied: (...args) => appliedCalls.push(args) }); session.setTimelineContext(context());
  return { calls, appliedCalls, client, session };
}
function chatFixture(options = {}) {
  const calls = []; let value = snapshot();
  const receipts = { get: () => null, set() {} };
  const client = { read: async () => value, start: async (_, input) => { calls.push(input); return options.start ? options.start(input) : { instanceId, threadId, projectId, revision: 1, run: run({ userText: input.message }) }; }, lookup: async () => { throw error('AGENT_CHAT_NOT_FOUND'); }, stream: async () => {} };
  return { calls, client, receipts, setSnapshot: next => { value = next; }, session: chat.createAgentChatSession({ projectId, client, receipts, requestId: () => requestId }) };
}

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const element = (type, props, ...children) => { const p = { ...props, children: children.length === 1 ? children[0] : children }; return typeof type === 'function' && ['AgentEditDiff', 'AgentTimelineMoveDiff', 'AgentRunActivity'].includes(type.name) ? type(p) : { type, props: p }; };
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function harness(file, options = {}) {
  const slots = []; let cursor = 0, effects = [], visible = true, tree, props = { projectId, projectName: 'Saved project', selectedTimelineClip: selected, contextMode: policy.AGENT_TIMELINE_CONTEXT, refreshKey: 'initial', onClose() {}, onSettings() {}, onApplied: options.onApplied || (() => {}), ...options.props };
  const react = { createElement: element,
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useLayoutEffect(fn, deps) { const index = cursor++, old = slots[index]; if (old && sameDeps(old.deps, deps)) return; slots[index] = { fn, deps, cleanup: old?.cleanup }; effects.push(index); },
  }; react.default = react;
  const resolve = name => {
    if (name === './agent-timeline-context.js') return timing;
    if (name === './agent-timeline-gain-context.ts') return gainContext;
    if (name === './AgentTimelineGain.tsx') { const gain = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/AgentTimelineGain.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(gain, gain.exports, resolve); return gain.exports; }
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

test('saved timeline selection projects explicit safe timing, excludes sources and is detached from drafts', () => {
  const clip = { id: clipId, trackId, assetId: id(99), name: selected.clipName, startFrame: 90, durationFrames: 60, sourceInFrame: 12, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain: 1 };
  const timeline = { id: timelineId, projectId, revision: 4, fps: 30, width: 720, height: 1280, durationFrames: 150, createdAt: at, updatedAt: at, tracks: [{ id: trackId, name: selected.trackName, kind: 'video', orderIndex: 0, hidden: false, muted: false }], clips: [clip, { ...clip, id: id(98), name: 'Other name not transmitted', startFrame: 0, durationFrames: 30 }] };
  const result = timing.makeAgentTimelineClipSelection(timeline, clipId, projectId);
  assert.deepEqual(result, selected); assert.equal(Object.isFrozen(result.occupiedIntervals[0]), true);
  assert.doesNotMatch(JSON.stringify(result), /assetId|sourceInFrame|Other name|gain|rect/);
  timeline.clips[0].startFrame = 100; assert.equal(result.startFrame, 90);
  assert.equal(timing.makeAgentTimelineClipSelection(timeline, clipId, id(77)), null);
});

test('timeline capability, provenance, tool and proposal discriminators fail closed while old shot policy survives', () => {
  const value = chat.safeAgentChatSnapshot(snapshot(), projectId);
  assert.equal(policy.agentEditAvailable(value), true); assert.equal(policy.agentInspectionAvailable(value), true); assert.equal(policy.agentTimelineAvailable(value), true);
  assert.equal(policy.agentTimelineAvailable({ ...value, scope: 'chat_and_reviewed_shot_edits' }), false);
  assert.throws(() => chat.safeAgentChatSnapshot(snapshot({ timelineEdit: { ...snapshot().timelineEdit, maxToolCalls: 2 } }), projectId));
  const safe = chat.safeAgentChatRun(run(), projectId); assert.equal(safe.editTarget.clipName, selected.clipName);
  assert.equal(policy.agentRunProvenanceEqual(safe, { ...safe, editTarget: { ...selected, occupiedIntervals: [] } }), false);
  for (const patch of [{ provenance: { category: 'project_selected_shot_text', projectId, sourceRunIds: [] } }, { contextMode: policy.AGENT_EDIT_CONTEXT }, { editTarget: { ...selected, path: '/private' } }, { activity: [...run().activity, { id: id(21), kind: 'tool', ordinal: 1, status: 'completed', name: 'mioon_propose_shot_update', operation: 'shot.update', resultJson: '{}' }] }]) assert.throws(() => chat.safeAgentChatRun(run(patch), projectId));
  assert.equal(Object.isFrozen(edits.safeAgentEditProposal(proposal(), projectId).diff.after), true);
  for (const patch of [{ patch: { startFrame: 180, trackId } }, { target: { ...publicTarget, clipId: id(88) }, outcome: applied().outcome, status: 'applied', approval }, { diff: { ...proposal().diff, after: { ...proposal().diff.after, durationFrames: 61 } } }, { status: 'applied' }]) assert.throws(() => edits.safeAgentEditProposal(proposal(patch), projectId));
});

test('timeline send consent binds full display, every fence and exact destination without widening the outbound schema', async () => {
  const f = chatFixture(); await f.session.load(); f.session.edit(run().userText); f.session.setTimelineTarget(selected); f.session.setContextMode(policy.AGENT_TIMELINE_CONTEXT); assert.equal(f.session.approve(true), true);
  const key = f.session.getState().consent;
  for (const target of [{ ...selected, expectedRevision: 5 }, { ...selected, clipName: 'New name' }, { ...selected, occupiedIntervals: [] }]) {
    f.session.setTimelineTarget(target); assert.equal(f.session.getState().consent, null); assert.equal(await f.session.send(), false); f.session.approve(true); assert.notEqual(f.session.getState().consent, key);
  }
  f.session.setTimelineTarget(selected, '存在未保存片段草稿'); assert.equal(f.session.approve(true), false); assert.equal(await f.session.send(), false);
  f.session.setTimelineTarget(selected); f.session.approve(true); assert.equal(await f.session.send(), true);
  assert.deepEqual(f.calls[0].consent, { destination: chat.deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model, context: policy.AGENT_TIMELINE_CONTEXT, projectId, ...policy.AGENT_TIMELINE_LIMITS, catalogHash: 'a'.repeat(64), timelineId, clipId, expectedRevision: 4 });
  assert.doesNotMatch(JSON.stringify(f.calls[0]), /assetId|sourceInFrame|occupiedIntervals|shotId/); f.session.dispose();
});

test('accepted run must match complete displayed timing even when identifiers and revision match', async () => {
  const f = chatFixture({ start: input => ({ instanceId, threadId, projectId, revision: 1, run: run({ userText: input.message, editTarget: { ...selected, occupiedIntervals: [] } }) }) });
  await f.session.load(); f.session.setTimelineTarget(selected); f.session.setContextMode(policy.AGENT_TIMELINE_CONTEXT); f.session.edit('Move it'); f.session.approve(true);
  assert.equal(await f.session.send(), false); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'Move it'); f.session.dispose();
});

test('fresh approval requires exact current saved selection and context; review does not silently rebase', async () => {
  const f = fixture(); await f.session.load(); const current = () => f.session.getState().proposals[0];
  for (const changed of [context({ target: null }), context({ contextMode: policy.AGENT_TYPED_CONTEXT }), context({ blockedReason: 'dirty' }), context({ target: { ...selected, expectedRevision: 5 } }), context({ target: { ...selected, clipId: id(77) } }), context({ target: { ...selected, startFrame: 91, endFrame: 151, timelineDurationFrames: 151 } })]) {
    f.session.setTimelineContext(changed); assert.equal(await f.session.act('approve', current()), false);
  }
  assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.setTimelineContext(context());
  assert.equal(await f.session.act('approve', current()), true); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); assert.equal(f.appliedCalls.length, 1); assert.deepEqual(f.calls.find(call => call[0] === 'act')[4], { instanceId, digest: proposal().digest }); f.session.dispose();
});

test('approved unknown discovery and reload stay GET-only; explicit historical recovery retains original keys despite new selection', async () => {
  const unknown = proposal({ status: 'unknown', approval }); const f = fixture({ list: () => page([unknown]) });
  await f.session.load(); f.session.setTimelineContext(context({ target: null, contextMode: policy.AGENT_TYPED_CONTEXT, blockedReason: 'New timeline draft' })); await f.session.load();
  assert.equal(f.calls.some(call => call[0] === 'act'), false); assert.equal(f.session.getState().proposals[0].approval.requestId, approval.requestId);
  assert.equal(await f.session.act('recover', f.session.getState().proposals[0]), true); assert.equal(f.appliedCalls[0][1].outcome.revision, 5); assert.deepEqual(f.calls.find(call => call[0] === 'act')[4], { instanceId, digest: proposal().digest }); f.session.dispose();
});

test('unknown remains visible across another window recovery dispatch, and stale GET cannot downgrade an applied receipt', async () => {
  let value = proposal({ status: 'unknown', approval }); const f = fixture({ list: () => page([value]), get: () => envelope(value) });
  await f.session.load(); value = proposal({ status: 'dispatching', approval }); await f.session.load(); assert.equal(f.session.getState().phase, 'ready'); assert.equal(f.session.getState().proposals[0].status, 'unknown');
  await f.session.inspect(proposalId); assert.equal(f.session.getState().proposals[0].status, 'unknown'); value = applied(); await f.session.inspect(proposalId); assert.equal(f.appliedCalls.length, 1);
  value = proposal({ status: 'unknown', approval }); assert.equal(await f.session.load(), false); assert.equal(f.session.getState().proposals[0].status, 'applied'); assert.equal(f.appliedCalls.length, 1); f.session.dispose();
});

test('lost ACK reads same proposal, never posts twice, and a late POST cannot refresh a disposed project', async () => {
  const f = fixture({ act: async () => { throw error('NETWORK'); }, get: () => envelope(proposal({ status: 'unknown', approval })) }); await f.session.load();
  await f.session.act('approve', f.session.getState().proposals[0]); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); assert.equal(f.calls.filter(call => call[0] === 'get').length, 1); assert.equal(f.appliedCalls.length, 0); assert.equal(f.session.getState().proposals[0].status, 'unknown'); f.session.dispose();
  const held = deferred(), late = fixture({ act: () => held.promise }); await late.session.load(); const pending = late.session.act('approve', late.session.getState().proposals[0]); late.session.dispose(); held.resolve(envelope(applied())); await pending; assert.equal(late.appliedCalls.length, 0);
});

test('actual timeline review renders names, immutable frames and seconds, unchanged fields and total-duration warning', async () => {
  const f = fixture(), h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render();
  assert.equal(h.find('agent-edit-approve').props.disabled, false); const tree = JSON.stringify(h.render());
  assert.match(tree, /Saved clip|First video track|90 帧 \/ 3.000 秒|180 帧 \/ 6.000 秒/);
  assert.match(tree, /非波纹|源素材、裁切|音量及淡入淡出|总时长/); assert.ok(h.find('agent-timeline-diff')); assert.equal(h.find('agent-edit-before-title'), undefined);
  assert.equal(nodes(h.render()).some(node => ['input', 'textarea', 'img', 'script', 'iframe', 'Dialog', 'Modal'].includes(node.type) || node.props.dangerouslySetInnerHTML), false);
  assert.equal(f.calls.some(call => call[0] === 'act'), false); h.unmount();
});

test('actual timeline review disables stale selection/draft/context callbacks, preserves Reject and gates Stop', async () => {
  const f = fixture(), h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render(); const oldApprove = h.find('agent-edit-approve').props.onClick;
  for (const props of [{ selectedTimelineClip: { ...selected, expectedRevision: 5 } }, { selectedTimelineClip: selected, timelineEditBlockedReason: '未保存草稿' }, { timelineEditBlockedReason: '', contextMode: policy.AGENT_TYPED_CONTEXT }]) {
    h.render(props); assert.equal(h.find('agent-edit-approve').props.disabled, true); assert.equal(h.find('agent-edit-reject').props.disabled, false); oldApprove(); await flush(); assert.equal(f.calls.some(call => call[0] === 'act'), false);
  }
  h.render({ contextMode: policy.AGENT_TIMELINE_CONTEXT, blockedRunIds: [runId] }); assert.equal(h.find('agent-edit-approve').props.disabled, true); assert.equal(h.find('agent-edit-reject').props.disabled, true);
  h.render({ blockedRunIds: [] }); h.hide(); oldApprove(); await flush(); assert.equal(f.calls.some(call => call[0] === 'act'), false); h.unmount();
});

test('actual timeline composer requires separate consent, bounds intervals, clears consent on dirty and preserves draft', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); h.render(); await flush(); h.render();
  h.change('agent-chat-mode-timeline', true); h.change('agent-chat-prompt', 'Move this saved clip'); assert.ok(h.find('agent-timeline-selected-target')); assert.equal(h.find('agent-chat-consent').props.checked, false);
  assert.match(JSON.stringify(h.find('agent-timeline-occupied-intervals')), /0|30/); assert.equal(h.find('agent-timeline-selected-disclosure').props.open, true);
  h.change('agent-chat-consent', true); const staleConsent = h.find('agent-chat-consent').props.onChange, oldSubmit = nodes(h.render()).find(node => node.type === 'form').props.onSubmit;
  h.render({ timelineEditBlockedReason: '时间线有未保存草稿' }); h.render(); staleConsent({ target: { checked: true } }); oldSubmit({ preventDefault() {} }); await flush(); h.render();
  assert.equal(f.calls.length, 0); assert.equal(h.find('agent-chat-consent').props.checked, false); assert.equal(h.find('agent-chat-consent').props.disabled, true); assert.equal(h.find('agent-chat-prompt').props.value, 'Move this saved clip');
  h.render({ timelineEditBlockedReason: '' }); h.render(); h.change('agent-chat-mode-typed', true); assert.match(JSON.stringify(h.find('agent-chat-context')), /不含项目/); h.unmount();
});

test('actual timeline activity safely separates proposal from application and never displays media or authority buttons', () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts });
  f.setSnapshot(snapshot({ runs: [run()] })); h.render(); return flush().then(() => { const tree = JSON.stringify(h.render()); assert.match(tree, /片段移动提议|不代表已应用|同轨其他片段数值区间/); assert.doesNotMatch(tree, /sourceInFrame|assetId|dangerouslySetInnerHTML/); h.unmount(); });
});

test('durable unknown discovered on reload cannot disappear silently when another window finishes recovery', async () => {
  let reads = 0;
  const f = fixture({ list: () => ++reads === 1 ? page([proposal({ status: 'unknown', approval })]) : page([]), get: () => envelope(applied()) });
  await f.session.load(); await f.session.load();
  assert.equal(f.session.getState().proposals[0].status, 'applied'); assert.equal(f.appliedCalls.length, 1); assert.equal(f.calls.filter(call => call[0] === 'get').length, 1); assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.dispose();
});

test('legacy shot unknown also reconciles disappearance by exact GET while historical applied discovery stays read-only', async () => {
  const shotId = id(45), legacy = { id: proposalId, projectId, runId, digest: 'e'.repeat(64), status: 'unknown', runStatus: 'completed', operation: 'shot.update', target: { projectId, shotId, expectedRevision: 4 }, patch: { title: 'New title' }, diff: { before: { title: 'Saved title', prompt: 'Saved prompt' }, after: { title: 'New title', prompt: 'Saved prompt' } }, provenance: { runId, toolCallId: 'legacy-call-1', toolName: 'mioon_propose_shot_update' }, createdAt: at, updatedAt: at, approval };
  const saved = { ...legacy, status: 'applied', outcome: { status: 'applied', shotId, revision: 5 } };
  let reads = 0; const f = fixture({ list: () => ++reads === 1 ? page([legacy]) : page([]), get: () => envelope(saved) });
  await f.session.load(); await f.session.load(); assert.equal(f.session.getState().proposals[0].status, 'applied'); assert.equal(f.appliedCalls.length, 1); assert.equal(f.calls.filter(call => call[0] === 'get').length, 1); assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.dispose();
  const historical = fixture({ list: () => page([saved]) }); await historical.session.load(); assert.equal(historical.appliedCalls.length, 0); assert.equal(historical.calls.some(call => call[0] === 'act'), false); historical.session.dispose();
});

test('three-page discovery of 60 mixed unknown proposals never pins old pages over fetched rows', async () => {
  const records = Array.from({ length: 60 }, (_, index) => {
    const identity = { id: id(100 + index), runId: id(200 + index), digest: index.toString(16).padStart(64, '0'), approval: { requestId: id(300 + index), approvedAt: at } };
    const source = { runId: identity.runId, toolCallId: `saved-call-${index}` };
    if (index % 2) return proposal({ ...identity, status: 'unknown', provenance: { ...source, toolName: 'mioon_propose_timeline_clip_move' } });
    return { ...proposal(), ...identity, status: 'unknown', operation: 'shot.update', target: { projectId, shotId: id(400 + index), expectedRevision: 4 }, patch: { title: 'New title' }, diff: { before: { title: 'Saved title', prompt: '' }, after: { title: 'New title', prompt: '' } }, provenance: { ...source, toolName: 'mioon_propose_shot_update' } };
  });
  let dropThirdPageHead = false;
  const f = fixture({ list: (_, { cursor }) => {
    const offset = cursor === 'page-3' ? 40 : cursor === 'page-2' ? 20 : 0;
    return page(records.slice(offset + (offset === 40 && dropThirdPageHead ? 1 : 0), offset + 20), { nextCursor: offset === 40 ? null : `page-${offset === 0 ? 2 : 3}` });
  }, get: (_, proposalId) => {
    const record = records.find(value => value.id === proposalId), shotId = record.target.shotId;
    return envelope({ ...record, status: 'applied', outcome: shotId ? { status: 'applied', shotId, revision: 5 } : { status: 'applied', timelineId, clipId, revision: 5 } });
  } });
  const ids = () => f.session.getState().proposals.map(value => value.id);
  await f.session.load(); assert.deepEqual(ids(), records.slice(0, 20).map(value => value.id));
  await f.session.older(); assert.deepEqual(ids(), records.slice(20, 40).map(value => value.id));
  await f.session.older(); assert.deepEqual(ids(), records.slice(40, 60).map(value => value.id));
  assert.equal(f.calls.filter(call => call[0] === 'get').length, 0); assert.equal(f.appliedCalls.length, 0);
  dropThirdPageHead = true; await f.session.load();
  assert.equal(f.calls.filter(call => call[0] === 'get').length, 1); assert.equal(f.session.getState().proposals.find(value => value.id === records[40].id).status, 'applied'); assert.equal(f.appliedCalls.length, 1);
  await f.session.newer(); assert.deepEqual(ids(), records.slice(20, 40).map(value => value.id));
  await f.session.newer(); assert.deepEqual(ids(), records.slice(0, 20).map(value => value.id));
  await f.session.chooseView('all'); assert.deepEqual(ids(), records.slice(0, 20).map(value => value.id));
  assert.equal(f.calls.filter(call => call[0] === 'get').length, 1); assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.dispose();
});

test('local transport uncertainty never displaces a fetched full page when advancing the cursor', async () => {
  const first = proposal(), next = Array.from({ length: 50 }, (_, index) => proposal({ id: id(500 + index), status: 'unknown', approval: { requestId: id(600 + index), approvedAt: at } }));
  const f = fixture({ list: (_, { cursor }) => cursor ? page(next) : page([first], { nextCursor: 'older-page' }), act: async () => { throw error('NETWORK'); }, get: () => envelope(first) });
  await f.session.load(); await f.session.act('approve', f.session.getState().proposals[0]);
  assert.deepEqual(f.session.getState().uncertainIds, [first.id]); await f.session.older();
  assert.deepEqual(f.session.getState().proposals.slice(0, 50).map(value => value.id), next.map(value => value.id));
  assert.equal(f.session.getState().proposals.length, 51); assert.equal(f.session.getState().proposals[50].id, first.id); assert.equal(f.session.getState().proposals[50].digest, first.digest); assert.deepEqual(f.session.getState().pinnedIds, [first.id]);
  assert.deepEqual(f.session.getState().uncertainIds, [first.id]); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); f.session.dispose();
});

test('50 local pins block a new approval without losing keys, while exact existing recovery clears a pin', async () => {
  const records = Array.from({ length: 51 }, (_, index) => proposal({ id: id(700 + index) }));
  const known = new Map(records.map(item => [item.id, item]));
  const f = fixture({ list: (_, { cursor }) => cursor ? page([records[50]]) : page(records.slice(0, 50), { nextCursor: 'last-page' }), get: (_, id) => envelope(known.get(id)), act: async (_, id, action) => {
    if (action !== 'recover') throw error('NETWORK');
    const saved = { ...known.get(id), status: 'applied', outcome: { status: 'applied', timelineId, clipId, revision: 5 } }; known.set(id, saved); return envelope(saved);
  } });
  await f.session.load();
  for (const record of records.slice(0, 50)) await f.session.act('approve', f.session.getState().proposals.find(item => item.id === record.id));
  assert.equal(f.session.getState().pinnedIds.length, 50); assert.equal(f.calls.filter(call => call[0] === 'act').length, 50);
  await f.session.older(); assert.equal(f.session.getState().proposals.length, 51);
  assert.equal(await f.session.act('approve', f.session.getState().proposals[0]), false); assert.match(f.session.getState().message, /50 份原操作待核对/);
  assert.equal(f.calls.filter(call => call[0] === 'act').length, 50); assert.deepEqual(new Set(f.session.getState().pinnedIds), new Set(records.slice(0, 50).map(item => item.id)));
  known.set(records[0].id, { ...records[0], status: 'unknown', approval }); await f.session.inspect(records[0].id);
  assert.equal(await f.session.act('recover', f.session.getState().proposals.find(item => item.id === records[0].id)), true); assert.equal(f.appliedCalls.length, 1); assert.equal(f.session.getState().pinnedIds.length, 49);
  await f.session.load(); assert.equal(f.session.getState().proposals.some(item => item.id === records[0].id), false); assert.equal(f.session.getState().pinnedIds.length, 49); assert.equal(f.appliedCalls.length, 1); f.session.dispose();
});

test('actual review labels an off-page local uncertainty and retains its exact identity beside all fetched rows', async () => {
  const first = proposal(), next = Array.from({ length: 50 }, (_, index) => proposal({ id: id(800 + index), status: 'unknown', approval: { requestId: id(900 + index), approvedAt: at } }));
  const f = fixture({ list: (_, { cursor }) => cursor ? page(next) : page([first], { nextCursor: 'older-page' }), act: async () => { throw error('NETWORK'); }, get: () => envelope(first) });
  const h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render(); h.click('agent-edit-approve'); await flush(); h.render(); h.click('agent-edits-older'); await flush(); h.render();
  assert.equal(h.all('agent-edit-proposal').length, 51); assert.equal(h.all('agent-edit-pinned').length, 1); assert.match(JSON.stringify(h.find('agent-edit-pinned')), /原操作待核对/);
  const card = h.all('agent-edit-proposal').find(item => item.props['data-proposal-id'] === first.id); assert.ok(card); assert.match(JSON.stringify(card), new RegExp(first.digest)); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); h.unmount();
});
