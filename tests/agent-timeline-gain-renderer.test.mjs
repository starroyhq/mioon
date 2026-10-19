import {createAgentAuthorizationUiMock} from './helpers/agent-authorization-ui.mjs';
import { message } from './helpers/i18n.ts';
import { creationTestDependency } from './helpers/creation-i18n.ts';
import * as nativeCloseSources from '../apps/web/src/native-close-sources.ts';
import * as gainContext from '../apps/web/src/agent-timeline-gain-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as edits from '../apps/web/src/agent-edits.ts';
import * as chat from '../apps/web/src/agent-chat.ts';
import * as policy from '../apps/web/src/agent-tool-state.ts';
import * as timing from '../apps/web/src/agent-timeline-context.ts';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), instanceId = id(2), threadId = id(3), timelineId = id(4), clipId = id(5), trackId = id(6), runId = id(7), proposalId = id(8), requestId = id(9);
const at = '2026-10-12T00:00:00.000Z';
const moveSelection = { projectId, timelineId, clipId, trackId, expectedRevision: 4, clipName: 'Saved clip <script>text</script>', trackName: 'First video track', trackKind: 'video', fps: 30, width: 720, height: 1280, startFrame: 90, endFrame: 150, durationFrames: 60, timelineDurationFrames: 150, occupiedIntervals: [{ startFrame: 0, endFrame: 30 }] };
const selected = { projectId, timelineId, clipId, trackId, expectedRevision: 4, clipName: 'Saved music <script>text</script>', trackName: 'Music track', trackKind: 'audio', fps: 30, width: 720, height: 1280, trackMuted: false, hasAudio: true, gain: 1 };
const publicTarget = Object.fromEntries(Object.entries(selected).filter(([key]) => key !== 'gain'));
const moveTarget = Object.fromEntries(Object.entries(moveSelection).filter(([key]) => !['startFrame', 'endFrame', 'durationFrames', 'timelineDurationFrames', 'occupiedIntervals'].includes(key)));
const moveProposal = () => ({ ...proposal(), target: moveTarget, patch: { startFrame: 180 }, diff: { before: { startFrame: 90, endFrame: 150, durationFrames: 60, timelineDurationFrames: 150 }, after: { startFrame: 180, endFrame: 240, durationFrames: 60, timelineDurationFrames: 240 } }, provenance: { runId, toolCallId: 'move-call', toolName: 'mioon_propose_timeline_clip_move' } });
const configuration = { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.com/v1', model: 'gpt-4.1-mini', protocol: 'chat_completions' };
const settings = { revision: 0, configuration, secret: { configured: true, storage: 'session' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: 'WEB_SESSION_ONLY' }, presets: [{ id: 'openai', label: 'OpenAI', platforms: [{ id: 'global', label: 'Global', defaultProtocol: 'chat_completions', availableProtocols: ['chat_completions', 'responses'], ...configuration }] }], scope: 'settings_only', verification: 'not_tested' };
const snapshot = (patch = {}) => ({ instanceId, threadId, projectId, revision: 0, authorization:{revision:0,scopes:[]}, scope: 'chat_and_reviewed_timeline_edits', persistence: 'local_database', mode: 'simulated', timelineGainEdit: { available: true, ...policy.AGENT_TIMELINE_GAIN_POLICY, catalogHash: 'f'.repeat(64) }, timelineEdit: { available: true, ...policy.AGENT_TIMELINE_LIMITS, catalogHash: 'a'.repeat(64) }, edit: { available: true, ...policy.AGENT_EDIT_LIMITS, catalogHash: 'b'.repeat(64) }, inspection: { available: true, ...policy.AGENT_INSPECTION_LIMITS, catalogHash: 'c'.repeat(64) }, settings, runs: [], historyCursor: null, ...patch });
const run = (patch = {}) => ({ id: runId, requestId, threadId, projectId, status: 'completed', userText: 'Lower selected clip to 40%', assistantText: 'Already applied! <img src=x>', configuration, createdAt: at, updatedAt: at, lastEventId: 3, contextMode: policy.AGENT_TIMELINE_GAIN_CONTEXT, editTarget: selected, provenance: { category: 'project_selected_timeline_audio_gain', projectId, sourceRunIds: [] }, activity: [{ id: id(20), kind: 'model', ordinal: 1, status: 'completed' }], ...patch });
const proposal = (patch = {}) => ({ id: proposalId, projectId, runId, digest: 'd'.repeat(64), status: 'pending', runStatus: 'completed', operation: 'timeline.clip.update', target: publicTarget, patch: { gain: 0.4 }, diff: { before: { gain: 1 }, after: { gain: 0.4 } }, provenance: { runId, toolCallId: 'gain-call-1', toolName: 'mioon_propose_timeline_clip_gain' }, createdAt: at, updatedAt: at, ...patch });
const approval = { requestId: id(10), approvedAt: at };
const applied = () => proposal({ status: 'applied', approval, outcome: { status: 'applied', timelineId, clipId, revision: 5 } });
const envelope = (value, epoch = instanceId) => ({ instanceId: epoch, projectId, proposal: value });
const page = (values = [proposal()], patch = {}) => ({ instanceId, projectId, proposals: values, nextCursor: null, ...patch });
const error = code => Object.assign(new Error('Private unsafe error text'), { code });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const context = (patch = {}) => ({ target: selected, contextMode: policy.AGENT_TIMELINE_GAIN_CONTEXT, ...patch });
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
  const client = { ...createAgentAuthorizationUiMock(async () => value), start: async (_, input) => { calls.push(input); return options.start ? options.start(input) : { instanceId, threadId, projectId, revision: 1, run: run({ userText: input.message }) }; }, lookup: async () => { throw error('AGENT_CHAT_NOT_FOUND'); }, stream: async () => {} };
  return { calls, client, receipts, setSnapshot: next => { value = next; }, session: chat.createAgentChatSession({ projectId, client, receipts, requestId: () => requestId }) };
}

const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : [];
const element = (type, props, ...children) => { const p = { ...props, children: children.length === 1 ? children[0] : children }; return typeof type === 'function' && ['AgentEditDiff', 'AgentTimelineMoveDiff', 'AgentRunActivity', 'AgentTimelineGainDiff', 'AgentTimelineGainSelection', 'AgentTimelineGainWarnings', 'AgentTimelineGainActivity'].includes(type.name) ? type(p) : { type, props: p }; };
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function harness(file, options = {}) {
  const slots = []; let cursor = 0, effects = [], visible = true, tree, props = { projectId, projectName: 'Saved project', selectedTimelineClip: moveSelection, selectedTimelineGainClip: selected, contextMode: policy.AGENT_TIMELINE_GAIN_CONTEXT, refreshKey: 'initial', onClose() {}, onSettings() {}, onApplied: options.onApplied || (() => {}), ...options.props };
  const react = { createElement: element,
    useState(initial) { const index = cursor++; slots[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useMemo(fn, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: fn(), deps }; return slots[index].value; },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useLayoutEffect(fn, deps) { const index = cursor++, old = slots[index]; if (old && sameDeps(old.deps, deps)) return; slots[index] = { fn, deps, cleanup: old?.cleanup }; effects.push(index); },
  }; react.default = react;
  const resolve = name => {
    const i18nDependency = creationTestDependency(name); if (i18nDependency) return i18nDependency;
    if (name === './agent-timeline-context.ts') return timing;
    if (name === './agent-timeline-gain-context.ts') return gainContext;
    if (name === './AgentTimelineGain.tsx') { const gain = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/AgentTimelineGain.tsx', import.meta.url), 'utf8'), { loader: 'tsx', format: 'cjs' }).code)(gain, gain.exports, resolve); return gain.exports; }
    if (name === './editor-settings-scope.ts') { const scope = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL('../apps/web/src/editor-settings-scope.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code)(scope, scope.exports, resolve); return scope.exports; }
    if (name === './native-close-sources.ts') return nativeCloseSources;
    if (name === 'react') return react;
    if (name === './agent-edits.ts') return { ...edits, createAgentEditsSession: input => edits.createAgentEditsSession({ ...input, client: options.client }) };
    if (name === './agent-chat.ts') return { ...chat, createAgentChatSession: input => chat.createAgentChatSession({ ...input, client: options.chatClient, receipts: options.receipts, requestId: () => requestId }) };
    if (name === './agent-tool-state.ts') return policy;
    if (name === './AgentAuthorizations.tsx') return {__esModule:true,default:'AgentAuthorizations'};
    if (name === './AgentEditProposal.tsx') return { __esModule: true, default: 'AgentEditProposal' };
    if (name === './AgentRunActivity.tsx') return load('AgentRunActivity');
    if (name === './workspace-visibility.tsx') return { useWorkspaceVisibility: () => visible };
    if (name === './icons.tsx') return { default: 'Icon' };
    if (name.endsWith('.css')) return {};
    if (name.startsWith('@mioon/ui/') || name === './WorkspaceControls.tsx') return new Proxy({}, { get: (_, key) => String(key) });
    throw Error(name);
  };
  const load = name => { const module = { exports: {} }; Function('module', 'exports', 'require', transformSync(readFileSync(new URL(`../apps/web/src/${name}.tsx`, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code)(module, module.exports, resolve); return module.exports; };
  const component = load(file).default;
  const h = {
    render(patch = {}) { props = { ...props, ...patch }; cursor = 0; effects = []; tree = component(props); for (const index of effects) { slots[index].cleanup?.(); slots[index].cleanup = slots[index].fn(); } return tree; },
    find: id => nodes(tree).find(node => node.props['data-testid'] === id),
    all: id => nodes(tree).filter(node => node.props['data-testid'] === id),
    change(id, value) { if(id==='agent-chat-consent'&&value){h.find('agent-chat-authorization-open')?.props.onClick();h.render();} h.find(id).props.onChange({ target: { value, checked: value } }); h.render(); if(id==='agent-chat-consent'&&value){h.find('agent-chat-authorization-confirm').props.onClick();h.render();} },
    click(id) { h.find(id).props.onClick(); h.render(); },
    submit() { nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); },
    hide(value = true) { visible = !value; h.render(); },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  }; return h;
}

function savedTimeline({ kind = 'audio', muted = false, hidden = false, gain = 1 } = {}) {
  return { id: timelineId, projectId, revision: 4, fps: 30, width: 720, height: 1280, durationFrames: 150, createdAt: at, updatedAt: at,
    tracks: [{ id: trackId, name: selected.trackName, kind, orderIndex: 0, hidden, muted }], clips: [
      { id: clipId, trackId, assetId: id(99), name: selected.clipName, startFrame: 90, durationFrames: 60, sourceInFrame: 12, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain, fadeInFrames: 3, fadeOutFrames: 4 },
    ] };
}
const savedAsset = (patch = {}) => ({ id: id(99), projectId, sha256: 'b'.repeat(64), mimeType: 'audio/wav', hasAudio: true, name: 'Private source name', path: '/private/source.wav', ...patch });

test('saved gain selection requires saved owned audio metadata and never exposes source identity', () => {
  const timeline = savedTimeline(), result = timing.makeAgentTimelineGainSelection(timeline, clipId, projectId, [savedAsset()]);
  assert.deepEqual(result, selected); assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), /assetId|sourceInFrame|sha256|private|path|fadeInFrames|durationFrames|rect/);
  timeline.clips[0].gain = 0.75; assert.equal(result.gain, 1);
  for (const asset of [savedAsset({ hasAudio: false }), savedAsset({ hasAudio: undefined }), savedAsset({ mimeType: 'image/png' }), savedAsset({ sha256: '' }), savedAsset({ projectId: id(90) })])
    assert.equal(timing.makeAgentTimelineGainSelection(savedTimeline(), clipId, projectId, [asset]), null);
  assert.equal(timing.makeAgentTimelineGainSelection(savedTimeline(), clipId, id(90), [savedAsset()]), null);
  assert.equal(timing.makeAgentTimelineGainSelection(savedTimeline(), clipId, projectId, [savedAsset(), savedAsset()]), null);
  assert.equal(timing.makeAgentTimelineGainSelection(null, clipId, projectId, [savedAsset()]), null);
  const video = timing.makeAgentTimelineGainSelection(savedTimeline({ kind: 'video', hidden: true, muted: true, gain: 0 }), clipId, projectId, [savedAsset({ mimeType: 'video/mp4' })]);
  assert.equal(video.trackMuted, true); assert.equal(video.gain, 0); assert.equal(video.hasAudio, true); assert.equal(video.trackKind, 'video');
});

test('gain capability is independent, exact, immutable and preserves old capabilities', () => {
  const value = chat.safeAgentChatSnapshot(snapshot(), projectId);
  assert.equal(policy.agentTimelineGainAvailable(value), true); assert.equal(policy.agentTimelineAvailable(value), true);
  assert.equal(policy.agentEditAvailable(value), true); assert.equal(policy.agentInspectionAvailable(value), true);
  assert.equal(policy.agentTimelineGainAvailable({ ...value, timelineGainEdit: undefined }), false);
  assert.equal(policy.agentTimelineGainAvailable({ ...value, scope: 'chat_and_reviewed_shot_edits' }), false);
  for (const capability of [{ ...value.timelineGainEdit, minGain: -1 }, { ...value.timelineGainEdit, maxGain: 3 }, { ...value.timelineGainEdit, maxToolCalls: 2 }, { ...value.timelineGainEdit, extra: true }]) assert.throws(() => chat.safeAgentChatSnapshot(snapshot({ timelineGainEdit: capability }), projectId));
  assert.equal(Object.isFrozen(value.timelineGainEdit), true);
});

test('gain provenance, tool and proposal shape cannot be confused with the same-operation move', () => {
  const safe = edits.safeAgentEditProposal(proposal(), projectId);
  assert.equal(Object.isFrozen(safe.diff.after), true); assert.equal(timing.isAgentTimelineGainProposal(safe), true); assert.equal(timing.isAgentTimelineMoveProposal(safe), false);
  assert.equal(timing.isAgentTimelineMoveProposal(moveProposal()), true); assert.equal(timing.isAgentTimelineGainProposal(moveProposal()), false);
  const bad = [{ patch: { startFrame: 90 } }, { patch: { gain: '0.4' } }, { patch: { gain: -0 } }, { patch: { gain: 1 }, diff: { before: { gain: 1 }, after: { gain: 1 } } }, { patch: { gain: 0.4, muted: true } }, { patch: { gain: 0.4, fadeInFrames: 1 } }, { provenance: moveProposal().provenance }, { target: { ...publicTarget, assetId: id(99) } }, { diff: { before: { gain: 1, startFrame: 90 }, after: { gain: 0.4 } } }];
  for (const patch of bad) assert.throws(() => edits.safeAgentEditProposal(proposal(patch), projectId));
  for (const patch of [{ provenance: { category: 'project_selected_timeline_timing', projectId, sourceRunIds: [] } }, { contextMode: policy.AGENT_TIMELINE_CONTEXT }, { contextMode: policy.AGENT_EDIT_CONTEXT }, { contextMode: policy.AGENT_PROJECT_CONTEXT }, { contextMode: policy.AGENT_TYPED_CONTEXT }, { editTarget: { ...selected, assetId: id(99) } }, { activity: [...run().activity, { id: id(21), kind: 'tool', ordinal: 1, status: 'completed', name: 'mioon_propose_timeline_clip_move', operation: 'timeline.clip.update', resultJson: '{}' }] }]) assert.throws(() => chat.safeAgentChatRun(run(patch), projectId));
  const activity = [...run().activity, { id: id(21), kind: 'tool', ordinal: 1, status: 'completed', name: 'mioon_propose_timeline_clip_gain', operation: 'timeline.clip.update', resultJson: '{"status":"pending"}' }];
  assert.equal(chat.safeAgentChatRun(run({ activity }), projectId).activity[1].name, 'mioon_propose_timeline_clip_gain');
});

test('gain authorization survives saved projection changes while each send binds the current complete projection', async () => {
  const f = chatFixture(); await f.session.load(); f.session.setTimelineGainTarget(selected); f.session.setContextMode(policy.AGENT_TIMELINE_GAIN_CONTEXT); f.session.edit('Lower to 40%');
  assert.equal(await f.session.approve(true), true); const original = f.session.getState().consent;
  for (const change of [{ expectedRevision: 5 }, { gain: 0.5 }, { trackMuted: true }, { clipName: 'Changed clip' }, { trackName: 'New track' }, { width: 1280, height: 720 }, { clipId: id(77) }, { timelineId: id(78) }, { trackKind: 'video' }]) {
    f.session.setTimelineGainTarget({ ...selected, ...change }); assert.equal(f.session.getState().consent, original); assert.equal(chat.agentChatCanSend(f.session.getState()), true);
  }
  f.session.setTimelineGainTarget(selected, '存在已恢复但未保存的片段草稿'); assert.equal(await f.session.approve(true), false); assert.equal(await f.session.send(), false);
  f.session.setTimelineGainTarget(selected); await f.session.approve(true); assert.equal(await f.session.send(), true);
  assert.deepEqual(f.calls[0].consent, { destination: chat.deriveAgentEndpoint(configuration), protocol: configuration.protocol, model: configuration.model, context: policy.AGENT_TIMELINE_GAIN_CONTEXT,
    projectId, ...policy.AGENT_TIMELINE_GAIN_POLICY, catalogHash: 'f'.repeat(64), timelineId, clipId, expectedRevision: 4, reviewTarget: selected });
  assert.doesNotMatch(JSON.stringify(f.calls[0]), /assetId|sha256|sourceInFrame|path|occupiedIntervals/); f.session.dispose();
});

test('accepted gain run must match displayed gain and mute even at identical project, clip and revision', async () => {
  for (const change of [{ gain: 0.5 }, { trackMuted: true }, { clipName: 'changed' }]) {
    const f = chatFixture({ start: input => ({ instanceId, threadId, projectId, revision: 1, run: run({ userText: input.message, editTarget: { ...selected, ...change } }) }) });
    await f.session.load(); f.session.setTimelineGainTarget(selected); f.session.setContextMode(policy.AGENT_TIMELINE_GAIN_CONTEXT); f.session.edit('Lower to 40%'); await f.session.approve(true);
    assert.equal(await f.session.send(), false); assert.equal(f.calls.length, 1); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'Lower to 40%'); f.session.dispose();
  }
});

test('gain sends invalidate on mode, settings, project selection and hidden panes without losing draft', async () => {
  const f = chatFixture(); await f.session.load(); f.session.setTimelineGainTarget(selected); f.session.setContextMode(policy.AGENT_TIMELINE_GAIN_CONTEXT); f.session.edit('Lower to 40%'); await f.session.approve(true);
  f.session.setContextMode(policy.AGENT_TYPED_CONTEXT); assert.equal(f.session.getState().consent, null); f.session.setContextMode(policy.AGENT_TIMELINE_GAIN_CONTEXT); await f.session.approve(true);
  f.session.setVisible(false); assert.equal(f.session.getState().consent, null); assert.equal(await f.session.approve(true), false); assert.equal(await f.session.send(), false);
  f.session.setVisible(true); await flush(); await f.session.approve(true);
  f.setSnapshot(snapshot({ settings: { ...settings, revision: 1, configuration: { ...configuration, protocol: 'responses', baseUrl: 'https://other.example/v1', model: 'gpt-4.1' } } })); await f.session.load(); assert.equal(f.session.getState().consent, null);
  f.session.setTimelineGainTarget({ ...selected, projectId: id(99) }); assert.equal(f.session.getState().timelineGainTarget, null); assert.equal(await f.session.approve(true), false);
  assert.equal(f.session.getState().draft, 'Lower to 40%'); assert.equal(f.calls.length, 0); f.session.dispose();
});

test('fresh gain approval requires exact saved project/clip/revision/gain/track and clean context', async () => {
  const f = fixture(); await f.session.load(); const current = () => f.session.getState().proposals[0];
  for (const changed of [context({ target: null }), context({ contextMode: policy.AGENT_TIMELINE_CONTEXT }), context({ contextMode: policy.AGENT_TYPED_CONTEXT }), context({ blockedReason: 'pending or dirty' }), ...[{ projectId: id(99) }, { clipId: id(88) }, { timelineId: id(89) }, { expectedRevision: 5 }, { gain: 0.8 }, { trackMuted: true }, { trackName: 'Renamed' }].map(change => context({ target: { ...selected, ...change } }))]) {
    f.session.setTimelineContext(changed); assert.equal(await f.session.act('approve', current()), false);
  }
  assert.equal(f.calls.some(call => call[0] === 'act'), false); f.session.setTimelineContext(context());
  assert.equal(await f.session.act('approve', current()), true); assert.deepEqual(f.calls.find(call => call[0] === 'act')[4], { instanceId, digest: proposal().digest }); assert.equal(f.appliedCalls.length, 1); f.session.dispose();
});

test('gain historical recovery and applied acknowledgement survive later edits, mute, deletion and another selected clip', async () => {
  const unknown = proposal({ status: 'unknown', approval }), f = fixture({ list: () => page([unknown]) });
  await f.session.load(); f.session.setTimelineContext(context({ target: null, contextMode: policy.AGENT_TYPED_CONTEXT, blockedReason: 'Another clip draft is unsaved' })); await f.session.load();
  assert.equal(f.calls.some(call => call[0] === 'act'), false); assert.equal(await f.session.act('recover', f.session.getState().proposals[0]), true);
  assert.equal(f.appliedCalls[0][1].outcome.revision, 5); assert.deepEqual(f.calls.find(call => call[0] === 'act')[4], { instanceId, digest: proposal().digest }); f.session.dispose();
  const historic = fixture({ list: () => page([applied()]) }); historic.session.setTimelineContext(context({ target: { ...selected, gain: 2, trackMuted: true, expectedRevision: 99, clipId: id(99) } }));
  await historic.session.load(); assert.equal(historic.session.getState().proposals[0].status, 'applied'); assert.equal(historic.appliedCalls.length, 0); assert.equal(historic.calls.some(call => call[0] === 'act'), false); historic.session.dispose();
});

test('gain unknown remains monotonic and late approved response cannot refresh a disposed project', async () => {
  let value = proposal({ status: 'unknown', approval }); const f = fixture({ list: () => page([value]), get: () => envelope(value) }); await f.session.load();
  value = proposal({ status: 'dispatching', approval }); await f.session.load(); assert.equal(f.session.getState().proposals[0].status, 'unknown');
  value = applied(); await f.session.inspect(proposalId); value = proposal({ status: 'unknown', approval }); assert.equal(await f.session.load(), false); assert.equal(f.session.getState().proposals[0].status, 'applied'); f.session.dispose();
  const held = deferred(), late = fixture({ act: () => held.promise }); await late.session.load(); const pending = late.session.act('approve', late.session.getState().proposals[0]); late.session.dispose(); held.resolve(envelope(applied())); await pending; assert.equal(late.appliedCalls.length, 0);
});

test('actual gain card renders immutable exact multipliers, friendly percents, saved identity and explicit dry-preview warning', async () => {
  const exact = 0.4000000000000001, value = proposal({ patch: { gain: exact }, diff: { before: { gain: 1 }, after: { gain: exact } } });
  const f = fixture({ list: () => page([value]) }), h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render();
  assert.equal(h.find('agent-edit-approve').props.disabled, false); assert.ok(h.find('agent-timeline-gain-diff')); assert.equal(h.find('agent-timeline-diff'), undefined);
  assert.match(JSON.stringify(h.find('agent-gain-before')), /1 \(100%\)/); assert.match(JSON.stringify(h.find('agent-gain-after')), /0.4000000000000001 \(40%\)/);
  const tree = JSON.stringify(h.render()); assert.match(tree, /Saved music|Music track|基准版本|线性振幅/); assert.match(tree, /原始源素材预览不会改变|不会自动渲染或播放/);
  assert.equal(nodes(h.render()).some(node => ['input', 'textarea', 'img', 'script', 'iframe', 'Dialog', 'Modal'].includes(node.type) || node.props.dangerouslySetInnerHTML), false);
  assert.equal(f.calls.some(call => call[0] === 'act'), false); h.unmount();
});

test('actual gain warnings disclose muted track, amplification risk and zero silence without calling it track mute', async () => {
  for (const gain of [0, 2]) {
    const value = proposal({ target: { ...publicTarget, trackMuted: true }, patch: { gain }, diff: { before: { gain: 1 }, after: { gain } } });
    const f = fixture({ list: () => page([value]) }), h = harness('AgentEditProposal', { client: f.client, props: { selectedTimelineGainClip: { ...selected, trackMuted: true } } }); h.render(); await flush(); h.render();
    assert.ok(h.find('agent-gain-track-muted')); assert.equal(Boolean(h.find('agent-gain-clipping-risk')), gain > 1); if (!gain) assert.match(JSON.stringify(h.find('agent-gain-after')), /0 \(0%\).*此片段静音/);
    assert.equal(h.find('agent-edit-approve').props.disabled, false); h.unmount();
  }
});

test('actual gain card stale selection/dirty/mode callbacks stay inert, while Reject remains reachable', async () => {
  const f = fixture(), h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render(); const oldApprove = h.find('agent-edit-approve').props.onClick;
  for (const props of [{ selectedTimelineGainClip: { ...selected, gain: 0.7 } }, { selectedTimelineGainClip: selected, timelineGainBlockedReason: '已恢复但未保存草稿' }, { timelineGainBlockedReason: '', contextMode: policy.AGENT_TIMELINE_CONTEXT }]) {
    h.render(props); assert.equal(h.find('agent-edit-approve').props.disabled, true); assert.equal(h.find('agent-edit-reject').props.disabled, false); oldApprove(); await flush(); assert.equal(f.calls.some(call => call[0] === 'act'), false);
  }
  h.render({ contextMode: policy.AGENT_TIMELINE_GAIN_CONTEXT, blockedRunIds: [runId] }); assert.equal(h.find('agent-edit-approve').props.disabled, true); assert.equal(h.find('agent-edit-reject').props.disabled, true);
  h.render({ blockedRunIds: [] }); h.hide(); oldApprove(); await flush(); assert.equal(f.calls.some(call => call[0] === 'act'), false); assert.equal(h.find('agent-timeline-gain-diff').props.tabIndex, -1); h.unmount();
});

test('actual gain composer keeps separate context consent, mute disclosure and dirty fences with stale callbacks rejected', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts, props: { selectedTimelineGainClip: { ...selected, trackMuted: true } } }); h.render(); await flush(); h.render();
  h.change('agent-chat-mode-gain', true); h.change('agent-chat-prompt', 'Lower this music to 40%'); assert.ok(h.find('agent-gain-selected-target')); assert.ok(h.find('agent-gain-track-muted'));
  assert.equal(h.find('agent-chat-consent').props.checked, false); assert.match(JSON.stringify(h.find('agent-chat-context')), /仅 gain|波形或响度测量/);
  h.change('agent-chat-consent', true); await flush(); h.render(); const staleConsent = h.find('agent-chat-consent').props.onChange, staleSubmit = nodes(h.render()).find(node => node.type === 'form').props.onSubmit;
  h.render({ timelineGainBlockedReason: '未保存源范围草稿' }); h.render(); staleConsent({ target: { checked: true } }); staleSubmit({ preventDefault() {} }); await flush(); h.render();
  assert.equal(f.calls.length, 0); assert.equal(h.find('agent-chat-consent').props.checked, true); assert.equal(h.find('agent-chat-consent').props.disabled, true); assert.equal(h.find('agent-chat-prompt').props.value, 'Lower this music to 40%');
  h.render({ timelineGainBlockedReason: '' }); h.render(); h.change('agent-chat-mode-typed', true); assert.equal(h.find('agent-gain-selected-target'), undefined); h.unmount();
});

test('actual gain activity distinguishes saved proposal from application with no media or authority controls', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts }); f.setSnapshot(snapshot({ runs: [run()] })); h.render(); await flush();
  const tree = JSON.stringify(h.render()); assert.match(tree, /片段音量提议|不代表已应用|保存版本|100%/); assert.doesNotMatch(tree, /sourceInFrame|assetId|dangerouslySetInnerHTML/); h.unmount();
});

test('actual App saved selection and review fences include connection, dirty forms, candidate and pending timeline actions', () => {
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const from = source.indexOf('  const agentTimelineGainSelection ='), to = source.indexOf('  const agentTimelineBlockedReason =', from);
  const expression = source.slice(from, to);
  const build = (patch = {}) => {
    const env = { msg: message, workspaceMode: 'editing', propertiesPage: 'inspector', quickAssetId: null, makeAgentTimelineGainSelection: timing.makeAgentTimelineGainSelection,
      timeline: savedTimeline(), selectedClipId: clipId, data: { project: { id: projectId }, assets: [savedAsset()] }, agentTimelineGainBlockedReason: gainContext.agentTimelineGainBlockedReason, agentTimelineGainBlockedDescriptor: gainContext.agentTimelineGainBlockedDescriptor,
      workbenchReady: true, online: true, auth: true, loading: false, inspectorDirty: false, formatDirty: false, agentClipDraftBlocked: false, clipDraftRef: { current: { hasUnsaved: () => false, getState: () => ({ candidate: null }) } }, timelineBusy: false, ...patch };
    return Function(...Object.keys(env), `${expression}; return { selection: agentTimelineGainSelection, reason: gainBlockedReason };`)(...Object.values(env));
  };
  assert.deepEqual(build(), { selection: selected, reason: '' });
  for (const patch of [{ workbenchReady: false }, { online: false }, { auth: false }, { loading: true }, { inspectorDirty: true }, { formatDirty: true }, { timelineBusy: true }, { agentClipDraftBlocked: true }, { clipDraftRef: { current: { hasUnsaved: () => true, getState: () => ({ candidate: null }) } } }, { clipDraftRef: { current: { hasUnsaved: () => false, getState: () => ({ candidate: {} }) } } }]) assert.notEqual(build(patch).reason, '');
  for (const patch of [{ workspaceMode: 'canvas' }, { propertiesPage: 'subtitle' }, { quickAssetId: id(99) }, { data: { project: { id: projectId }, assets: [savedAsset({ hasAudio: false })] } }]) assert.equal(build(patch).selection, null);
  assert.match(source, /selectedTimelineGainClip=\{agentTimelineGainSelection\} timelineGainBlockedReason=\{gainBlockedReason\}/);
  assert.match(source, /onDraftController=\{registerClipDraft\} onReviewBlockedChange=\{setAgentClipDraftBlocked\}/);
  const appliedHandler = source.match(/onApplied=\{projectId => \{([^}]+)\}\}/)[1], calls = [];
  const apply = Function('currentProject', 'refresh', `return projectId => { ${appliedHandler} };`)({ current: projectId }, id => calls.push(id));
  apply(projectId, applied()); apply(id(99), applied()); assert.deepEqual(calls, [projectId]); assert.doesNotMatch(appliedHandler, /setData|discard|save|render|draft|acknowledge/i);
});

test('actual clip draft hook separately fences loading/recovered candidates without changing ordinary dirty semantics', () => {
  const source = readFileSync(new URL('../apps/web/src/clip-draft-hook.ts', import.meta.url), 'utf8'); let changed; const blocked = [], dirty = [];
  const controller = { getState: () => ({}), setContext() {}, activate() {}, load() {}, dispose() {} };
  const react = { useRef: value => ({ current: value }), useState: value => [value, () => {}], useLayoutEffect: fn => { fn(); } };
  const module = { exports: {} }; Function('module', 'exports', 'require', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module, module.exports, name => name === 'react' ? react : name === './clip-draft-client.ts' ? { createClipDraftClient: () => ({}) } : name === './clip-draft-state.ts' ? { createClipDraftController: options => { changed = options.onChange; return controller; } } : assert.fail(name));
  module.exports.useClipDraft({ context: {}, onDirtyChange: value => dirty.push(value), onReviewBlockedChange: value => blocked.push(value), validateTimeline: () => true });
  changed({ phase: 'ready', dirty: false, submitting: false, businessPending: false, candidate: {} }); assert.equal(blocked.at(-1), true); assert.equal(dirty.at(-1), false);
  changed({ phase: 'saved', dirty: true, submitting: false, businessPending: false, candidate: null }); assert.equal(blocked.at(-1), true); assert.equal(dirty.at(-1), true);
  changed({ phase: 'ready', dirty: false, submitting: false, businessPending: false, candidate: null }); assert.equal(blocked.at(-1), false); assert.equal(dirty.at(-1), false);
  changed({ phase: 'error', dirty: false, submitting: false, businessPending: false, candidate: null }); assert.equal(blocked.at(-1), true);
});

test('three-page discovery of 60 mixed shot/move/gain unknown proposals never pins old pages over fetched rows', async () => {
  const records = Array.from({ length: 60 }, (_, index) => {
    const identity = { id: id(100 + index), runId: id(200 + index), digest: index.toString(16).padStart(64, '0'), approval: { requestId: id(300 + index), approvedAt: at } };
    const source = { runId: identity.runId, toolCallId: `saved-call-${index}` };
    if (index % 3 === 1) return { ...moveProposal(), ...identity, status: 'unknown', provenance: { ...source, toolName: 'mioon_propose_timeline_clip_move' } };
    if (index % 3 === 2) return proposal({ ...identity, status: 'unknown', provenance: { ...source, toolName: 'mioon_propose_timeline_clip_gain' } });
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

test('gain local transport uncertainty never displaces a fetched full page when advancing the cursor', async () => {
  const first = proposal(), next = Array.from({ length: 50 }, (_, index) => proposal({ id: id(500 + index), status: 'unknown', approval: { requestId: id(600 + index), approvedAt: at } }));
  const f = fixture({ list: (_, { cursor }) => cursor ? page(next) : page([first], { nextCursor: 'older-page' }), act: async () => { throw error('NETWORK'); }, get: () => envelope(first) });
  await f.session.load(); await f.session.act('approve', f.session.getState().proposals[0]);
  assert.deepEqual(f.session.getState().uncertainIds, [first.id]); await f.session.older();
  assert.deepEqual(f.session.getState().proposals.slice(0, 50).map(value => value.id), next.map(value => value.id));
  assert.equal(f.session.getState().proposals.length, 51); assert.equal(f.session.getState().proposals[50].id, first.id); assert.equal(f.session.getState().proposals[50].digest, first.digest); assert.deepEqual(f.session.getState().pinnedIds, [first.id]);
  assert.deepEqual(f.session.getState().uncertainIds, [first.id]); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); f.session.dispose();
});

test('50 local gain pins block a new approval without losing keys, while exact existing recovery clears a pin', async () => {
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

test('actual gain review labels an off-page local uncertainty and retains its exact identity beside all fetched rows', async () => {
  const first = proposal(), next = Array.from({ length: 50 }, (_, index) => proposal({ id: id(800 + index), status: 'unknown', approval: { requestId: id(900 + index), approvedAt: at } }));
  const f = fixture({ list: (_, { cursor }) => cursor ? page(next) : page([first], { nextCursor: 'older-page' }), act: async () => { throw error('NETWORK'); }, get: () => envelope(first) });
  const h = harness('AgentEditProposal', { client: f.client }); h.render(); await flush(); h.render(); h.click('agent-edit-approve'); await flush(); h.render(); h.click('agent-edits-older'); await flush(); h.render();
  assert.equal(h.all('agent-edit-proposal').length, 51); assert.equal(h.all('agent-edit-pinned').length, 1); assert.match(JSON.stringify(h.find('agent-edit-pinned')), /原操作待核对/);
  const card = h.all('agent-edit-proposal').find(item => item.props['data-proposal-id'] === first.id); assert.ok(card); assert.match(JSON.stringify(card), new RegExp(first.digest)); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); h.unmount();
});


test('real installed React renders the typed gain diff as escaped inert HTML with exact raw values', () => {
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url)), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const source = readFileSync(new URL('../apps/web/src/AgentTimelineGain.tsx', import.meta.url), 'utf8'), module = { exports: {} };
  Function('module', 'exports', 'require', transformSync(source, { loader: 'tsx', format: 'cjs' }).code)(module, module.exports,
    name => creationTestDependency(name) || (name === 'react' ? React : name === './agent-timeline-gain-context.ts' ? gainContext : assert.fail(name)));
  const value = proposal({ target: { ...publicTarget, trackMuted: true }, patch: { gain: 2 }, diff: { before: { gain: 0.4000000000000001 }, after: { gain: 2 } } });
  const html = renderToStaticMarkup(React.createElement(module.exports.AgentTimelineGainDiff, { proposal: value, visible: false }));
  assert.match(html, /0.4000000000000001 \(40%\)/); assert.match(html, /2 \(200%\)/); assert.match(html, /tabindex="-1"/);
  assert.match(html, /削波失真风险|轨道已静音|原始源素材预览不会改变/); assert.doesNotMatch(html, /<input|<textarea|<video|<audio|<script|<iframe/);
  const disclosure = renderToStaticMarkup(React.createElement(module.exports.AgentTimelineGainSelection, { target: selected }));
  assert.match(disclosure, /&lt;script&gt;text&lt;\/script&gt;/); assert.doesNotMatch(disclosure, /<script>/);
});

test('actual gain review survives complete recreation without POST and only explicit matching approval applies', async () => {
  const f = fixture(), first = harness('AgentEditProposal', { client: f.client, props: { contextMode: policy.AGENT_TYPED_CONTEXT } });
  first.render(); await flush(); first.render(); assert.equal(first.find('agent-edit-approve').props.disabled, true); first.unmount();
  const again = harness('AgentEditProposal', { client: f.client, props: { contextMode: policy.AGENT_TYPED_CONTEXT } }); again.render(); await flush(); again.render();
  assert.ok(again.find('agent-timeline-gain-diff')); assert.equal(f.calls.some(call => call[0] === 'act'), false);
  again.render({ contextMode: policy.AGENT_TIMELINE_GAIN_CONTEXT }); assert.equal(again.find('agent-edit-approve').props.disabled, false);
  again.click('agent-edit-approve'); await flush(); again.render(); assert.equal(f.calls.filter(call => call[0] === 'act').length, 1); assert.match(JSON.stringify(again.find('agent-edit-applied')), /历史回执/);
  again.unmount();
});

test('unavailable or unsupported selected source leaves the gain mode unoffered for sending', async () => {
  const f = chatFixture(), h = harness('AgentPanel', { chatClient: f.client, receipts: f.receipts, props: { selectedTimelineGainClip: null } }); h.render(); await flush(); h.render();
  assert.equal(h.find('agent-chat-mode-gain').props.disabled, true); assert.equal(f.calls.length, 0); h.unmount();
});
