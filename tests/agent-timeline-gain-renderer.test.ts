import type {Module} from './helpers/strict-agent-ui-types.ts';
import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import { message,renderMessage as renderCoreMessage } from './helpers/i18n.ts';
import * as gainContext from '../apps/web/src/agent-timeline-gain-context.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as timing from '../apps/web/src/agent-timeline-context.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = id(1), timelineId = id(4), clipId = id(5), trackId = id(6), runId = id(7), proposalId = id(8);
const at = '2026-10-12T00:00:00.000Z';
const selected = { projectId, timelineId, clipId, trackId, expectedRevision: 4, clipName: 'Saved music <script>text</script>', trackName: 'Music track', trackKind: 'audio', fps: 30, width: 720, height: 1280, trackMuted: false, hasAudio: true, gain: 1 };
const publicTarget = Object.fromEntries(Object.entries(selected).filter(([key]) => key !== 'gain'));
const proposal = <Patch extends object = {}>(patch: Patch = {} as Patch) => ({ id: proposalId, projectId, runId, digest: 'd'.repeat(64), status: 'pending', runStatus: 'completed', operation: 'timeline.clip.update', target: publicTarget, patch: { gain: 0.4 }, diff: { before: { gain: 1 }, after: { gain: 0.4 } }, provenance: { runId, toolCallId: 'gain-call-1', toolName: 'mioon_propose_timeline_clip_gain' }, createdAt: at, updatedAt: at, ...patch });
const approval = { requestId: id(10), approvedAt: at };
const applied = () => proposal({ status: 'applied', approval, outcome: { status: 'applied', timelineId, clipId, revision: 5 } });
function savedTimeline({ kind = 'audio', muted = false, hidden = false, gain = 1 } = {}) {
  return { id: timelineId, projectId, revision: 4, fps: 30, width: 720, height: 1280, durationFrames: 150, createdAt: at, updatedAt: at,
    tracks: [{ id: trackId, name: selected.trackName, kind, orderIndex: 0, hidden, muted }], clips: [
      { id: clipId, trackId, assetId: id(99), name: selected.clipName, startFrame: 90, durationFrames: 60, sourceInFrame: 12, rect: { x: 0, y: 0, width: 720, height: 1280 }, gain, fadeInFrames: 3, fadeOutFrames: 4 },
    ] };
}
const savedAsset = <Patch extends object = {}>(patch: Patch = {} as Patch) => ({ id: id(99), projectId, sha256: 'b'.repeat(64), mimeType: 'audio/wav', hasAudio: true, name: 'Private source name', path: '/private/source.wav', ...patch });
test('saved gain selection requires saved owned audio metadata and never exposes source identity', () => {
  const timeline = (savedTimeline() as unknown as FixtureTimeline), result = timing.makeAgentTimelineGainSelection(timeline, clipId, projectId, [savedAsset()]);
  assert.deepEqual(result, selected); assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch((JSON.stringify(result) as string), /assetId|sourceInFrame|sha256|private|path|fadeInFrames|durationFrames|rect/);
  timeline.clips[0].gain = 0.75; assert.equal(result.gain, 1);
  for (const asset of [savedAsset({ hasAudio: false }), savedAsset({ hasAudio: undefined }), savedAsset({ mimeType: 'image/png' }), savedAsset({ sha256: '' }), savedAsset({ projectId: id(90) })] as const)
    assert.equal(timing.makeAgentTimelineGainSelection((savedTimeline() as unknown as FixtureTimeline), clipId, projectId, [asset]), null);
  assert.equal(timing.makeAgentTimelineGainSelection((savedTimeline() as unknown as FixtureTimeline), clipId, id(90), [savedAsset()]), null);
  assert.equal(timing.makeAgentTimelineGainSelection((savedTimeline() as unknown as FixtureTimeline), clipId, projectId, [savedAsset(), savedAsset()]), null);
  assert.equal(timing.makeAgentTimelineGainSelection(null, clipId, projectId, [savedAsset()]), null);
  const video = timing.makeAgentTimelineGainSelection((savedTimeline({ kind: 'video', hidden: true, muted: true, gain: 0 }) as unknown as FixtureTimeline), clipId, projectId, [savedAsset({ mimeType: 'video/mp4' })]);
  assert.equal(video!.trackMuted, true); assert.equal(video!.gain, 0); assert.equal(video!.hasAudio, true); assert.equal(video!.trackKind, 'video');
});
function appGainReviewContext(patch = {}): {selection:typeof selected|null;reason:string} {
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
  const from = source.indexOf('  const agentTimelineGainSelection ='), to = source.indexOf('  const agentTimelineBlockedReason =', from);
  const expression = source.slice(from, to);
  const build = (patch = {}) => {
    const env = { msg: message,renderCoreMessage,chosenClip:(savedTimeline() as unknown as FixtureTimeline).clips[0],lockedTrackIds:new Set(), workspaceMode: 'editing', propertiesPage: 'inspector', quickAssetId: null, makeAgentTimelineGainSelection: timing.makeAgentTimelineGainSelection,
      timeline: (savedTimeline() as unknown as FixtureTimeline), selectedClipId: clipId, data: { project: { id: projectId }, assets: [savedAsset()] }, agentTimelineGainBlockedReason: gainContext.agentTimelineGainBlockedReason, agentTimelineGainBlockedDescriptor: gainContext.agentTimelineGainBlockedDescriptor,
      workbenchReady: true, online: true, auth: true, loading: false, inspectorDirty: false, formatDirty: false, agentClipDraftBlocked: false, clipDraftRef: { current: { hasUnsaved: () => false, getState: () => ({ candidate: null }) } }, timelineBusy: false, ...patch };
    return Function(...Object.keys(env), `${expression}; return { selection: agentTimelineGainSelection, reason: gainBlockedReason };`)(...Object.values(env));
  };
  return build(patch) as {selection:typeof selected|null;reason:string};
}
test('actual App saved selection and review fences include connection, dirty forms, candidate and pending timeline actions', () => {
  const source=readFileSync(new URL('../apps/web/src/App.tsx',import.meta.url),'utf8');
  const build=appGainReviewContext;
  assert.deepEqual(build(), { selection: selected, reason: '' });
  for (const patch of [{ workbenchReady: false }, { online: false }, { auth: false }, { loading: true }, { inspectorDirty: true }, { formatDirty: true }, { timelineBusy: true }, { agentClipDraftBlocked: true }, { clipDraftRef: { current: { hasUnsaved: () => true, getState: () => ({ candidate: null }) } } }, { clipDraftRef: { current: { hasUnsaved: () => false, getState: () => ({ candidate: {} }) } } }] as const) assert.notEqual(build(patch).reason, '');
  for (const patch of [{ workspaceMode: 'canvas' }, { propertiesPage: 'subtitle' }, { quickAssetId: id(99) }, { data: { project: { id: projectId }, assets: [savedAsset({ hasAudio: false })] } }] as const) assert.equal(build(patch).selection, null);
  assert.match((source as string), /selectedTimelineGainClip=\{agentTimelineGainSelection\} timelineGainBlockedReason=\{gainBlockedReason\}/);
  assert.match((source as string), /onDraftController=\{registerClipDraft\} onReviewBlockedChange=\{setAgentClipDraftBlocked\}/);
  const appliedHandler = source.match(/onApplied=\{\(projectId: string\) => \{([^}]+)\}\}/)![1], calls: unknown[] = [];
  const apply = (Function('currentProject', 'refresh', `return projectId => { ${appliedHandler} };`)({ current: projectId }, (id: unknown) => calls.push(id)) as unknown as (projectId: string,...extra:unknown[])=>void);
  apply(projectId, applied()); apply(id(99), applied()); assert.deepEqual(calls, [projectId]); assert.doesNotMatch((appliedHandler as string), /setData|discard|save|render|draft|acknowledge/i);
});
test('actual clip draft hook separately fences loading/recovered candidates without changing ordinary dirty semantics', () => {
  const source = readFileSync(new URL('../apps/web/src/clip-draft-hook.ts', import.meta.url), 'utf8'); let changed; const blocked: unknown[] = [], dirty: unknown[] = [];
  const controller = { getState: () => ({}), setContext() {}, activate() {}, load() {}, dispose() {} };
  const react = { useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => {}], useLayoutEffect: (fn: () => void) => { fn(); } };
  const module: Module = { exports: {} } as Module; Function('module', 'exports', 'require', transformSync(source, { loader: 'ts', format: 'cjs' }).code)(module, module.exports, (name?: string|undefined) => name === 'react' ? react : name === './clip-draft-client.ts' ? { createClipDraftClient: () => ({}) } : name === './clip-draft-state.ts' ? { createClipDraftController: (options: { onChange: unknown; }) => { changed = options.onChange; return controller; } } : assert.fail(name));
  module.exports.useClipDraft!({ context: {}, onDirtyChange: (value: unknown) => dirty.push(value), onReviewBlockedChange: (value: unknown) => blocked.push(value), validateTimeline: () => true });
  changed!({ phase: 'ready', dirty: false, submitting: false, businessPending: false, candidate: {} }); assert.equal(blocked.at(-1), true); assert.equal(dirty.at(-1), false);
  changed!({ phase: 'saved', dirty: true, submitting: false, businessPending: false, candidate: null }); assert.equal(blocked.at(-1), true); assert.equal(dirty.at(-1), true);
  changed!({ phase: 'ready', dirty: false, submitting: false, businessPending: false, candidate: null }); assert.equal(blocked.at(-1), false); assert.equal(dirty.at(-1), false);
  changed!({ phase: 'error', dirty: false, submitting: false, businessPending: false, candidate: null }); assert.equal(blocked.at(-1), true);
});
test('locking the selected track blocks the App gain review context without changing its selection, and an unrelated lock does not',async()=>{
 const unlocked=appGainReviewContext(),locked=appGainReviewContext({lockedTrackIds:new Set([trackId])});
 assert.equal(unlocked.reason,'');assert.notEqual(locked.reason,'');assert.deepEqual(locked.selection,selected);
 assert.equal(appGainReviewContext({lockedTrackIds:new Set([id(88)])}).reason,'','an unrelated track lock must not block this gain target');
});
