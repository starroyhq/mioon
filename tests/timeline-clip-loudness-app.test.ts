import type {TimelineClipLoudnessContext} from '../apps/web/src/timeline-clip-loudness-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { savedClipLoudnessFields } from '../apps/web/src/timeline-clip-loudness-context.ts';
import { createTimelineClipLoudnessController, timelineClipLoudnessAvailable } from '../apps/web/src/timeline-clip-loudness-state.ts';
import { timelineAudioPreviewSourceIdentity } from '../apps/web/src/use-timeline-audio-preview.ts';
import { workspaceOriginScope } from '../apps/web/src/workspace-origin.ts';
import { input, report, id, deferred } from './helpers/timeline-clip-loudness-ui-fixture.ts';
import { lenientFunction } from './helpers/eval-source.ts';
const Function = lenientFunction;
const app = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');
const segment = app.slice(app.indexOf('  function clipLoudnessContext()'), app.indexOf('  function timelineMixLoudnessContext()'));
function harness() {
  const i = report().identity, clip = { id: input().clipId, ...i };
  const refs = { dataRef: { current: { project: { id: input().projectId }, timeline: { id: input().timelineId, projectId: input().projectId, revision: 4, fps: 30, durationFrames: 47,
    clips: [clip], tracks: [{ id: i.trackId, kind: 'audio', orderIndex: 0, muted: false, hidden: false }] },
    assets: [{ id: i.assetId, projectId: input().projectId, sha256: i.assetSha256, mimeType: 'audio/wav', hasAudio: true, sizeBytes: i.sourceBytes, duration: 10 }] } },
    currentProject: { current: input().projectId }, projectEpoch: { current: 1 }, workspaceRef: { current: { restored: false } },
    viewRef: { current: { activeMode: 'editing', editing: { selectedClipId: clip.id as string | null, quickAssetId: null } } },
    navigationEpoch: { current: 1 }, panelIntent: { current: 1 }, clipLoudnessEpoch: { current: 1 },
    previewAssetRef: { current: null as string | null }, comparisonIdRef: { current: null as string | null }, clipDraftRef: { current: null }, subtitlesRef: { current: null }, timelineFormatRef: { current: null } };
  const env = { ...refs, savedClipLoudnessFields, workspaceOriginScope, timelineAudioPreviewSourceIdentity,
    projectSessionReady: () => true, inspectorEpoch: 1, online: true, auth: true, loading: false, workbenchReady: true,
    rightDockTab: 'properties', propertiesPage: 'inspector', panelVisible: () => true, webSettingsOpen: false,
    inspectorDirty: false, formatDirty: false, timelineBusy: false, isBusy: () => false };
  return { refs, env, read: () => Function(...Object.keys(env), `${segment}; return clipLoudnessContext();`)(...Object.values(env)) as TimelineClipLoudnessContext };
}
test('actual App getter binds saved selection/graph and masks comparison/source-modal/settings/hidden/recovery/pending contexts', () => {
  const h = harness(), c = h.read(); assert.equal(c.clipId, input().clipId); assert.equal(c.gain, .75); assert.equal(timelineClipLoudnessAvailable(c), true);
  for (const [key, val] of [['rightDockTab','delivery'], ['propertiesPage','subtitle'], ['webSettingsOpen',true], ['loading',true], ['online',false], ['timelineBusy',true], ['inspectorDirty',true]] as const) {
    const old = (h.env as Record<string, unknown>)[key]; (h.env as Record<string, unknown>)[key] = val; assert.equal(timelineClipLoudnessAvailable(h.read()), false, key); (h.env as Record<string, unknown>)[key] = old;
  }
  for (const ref of [h.refs.previewAssetRef, h.refs.comparisonIdRef]) { ref.current = id(8); assert.equal(h.read().visible, false); ref.current = null; }
  h.refs.workspaceRef.current = { restored: true }; assert.equal(timelineClipLoudnessAvailable(h.read()), false);
});
test('actual App getter and controller fence batched A→B→A and same-id source replacement before any render', async () => {
  const h = harness(), wait = deferred(); let signal: AbortSignal | undefined;
  const controller = createTimelineClipLoudnessController({ getContext: h.read, read: (_input, options) => { signal = options.signal; return wait.promise; } });
  controller.attach(h.read()); const captured = controller.getState(), work = controller.prepare(captured);
  h.refs.viewRef.current.editing.selectedClipId = id(7); h.refs.clipLoudnessEpoch.current++;
  h.refs.viewRef.current.editing.selectedClipId = captured.clipId; h.refs.clipLoudnessEpoch.current++;
  wait.resolve(report()); await work; assert.equal(signal!.aborted, true); assert.equal(controller.getState().report, null);
  assert.equal(await controller.prepare(captured), null);
  const before = h.read(); h.refs.dataRef.current.assets[0].sha256 = 'c'.repeat(64); const after = h.read();
  assert.notEqual(before.sourceIdentity, after.sourceIdentity); assert.notEqual(before.assetSha256, after.assetSha256);
});
test('actual video hasAudio false/unknown remains opt-in; only backend NO_AUDIO is presented as verified no stream', async () => {
  for (const hasAudio of [false, undefined]) {
    const h = harness(); Object.assign(h.refs.dataRef.current.assets[0], { mimeType: 'video/mp4', hasAudio });
    assert.equal(timelineClipLoudnessAvailable(h.read()), true);
    let calls = 0;
    const controller = createTimelineClipLoudnessController({ getContext: h.read, read: async () => { calls++; throw { code: hasAudio === false ? 'TIMELINE_CLIP_LOUDNESS_NO_AUDIO' : 'TIMELINE_CLIP_LOUDNESS_UNAVAILABLE' }; } });
    controller.attach(h.read()); assert.equal(calls, 0); await controller.prepare(controller.getState()); assert.equal(calls, 1);
    assert.equal(controller.getState().report, null);
    if (hasAudio === false) assert.match(controller.getState().error, /后端确认.*没有可测音轨/);
    else assert.doesNotMatch(controller.getState().error, /后端确认.*没有可测音轨/);
  }
});
