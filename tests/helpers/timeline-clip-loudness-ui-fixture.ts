import { createTimelineClipLoudnessController } from '../../apps/web/src/timeline-clip-loudness-state.ts';
import { clipLoudnessInput, readyClipLoudness } from '../fixtures/timeline-clip-loudness-fixtures.ts';
export { readyClipLoudness, silentClipLoudness } from '../fixtures/timeline-clip-loudness-fixtures.ts';
export const input = () => ({ ...clipLoudnessInput });
export const id = n => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const report = readyClipLoudness;
export function context(patch = {}) {
  const i = readyClipLoudness().identity;
  return { scope: 'workspace:project:1', executionScope: 'selection:1', projectId: input().projectId, timelineId: input().timelineId,
    revision: 4, clipId: input().clipId, assetId: i.assetId, assetSha256: i.assetSha256, trackId: i.trackId,
    startFrame: i.startFrame, sourceInFrame: i.sourceInFrame, durationFrames: i.durationFrames, gain: i.gain,
    fadeInFrames: i.fadeInFrames, fadeOutFrames: i.fadeOutFrames, muted: false, audioSupported: true, sourceIdentity: 'saved-graph:1',
    connected: true, visible: true, restored: false, hasUnsavedDrafts: false, pending: false, ...patch };
}
export function fixture(patch = {}, overrides = {}) {
  let live = context(patch); const calls = [], reads = [], changes = [], auth = [];
  const controller = createTimelineClipLoudnessController({ getContext: () => live, getInvocation: () => ({ expectedWorkspaceOrigin: id(7) }),
    onChange: value => changes.push(value), onUnauthorized: () => auth.push(false),
    read(value, options) { calls.push({ input: value, options, context: structuredClone(live) }); const wait = deferred(); reads.push(wait); return wait.promise; }, ...overrides });
  controller.attach(live);
  const f = { controller, calls, reads, changes, auth, state: () => controller.getState(), live: () => live,
    set(patch, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live); },
    prepare() { return controller.prepare(f.state()); }, cancel() { controller.cancel(f.state()); },
    async ready(value) { const wait = f.prepare(); reads.at(-1).resolve(value ?? readyClipLoudness(calls.at(-1).input)); await wait; return f.state(); } };
  return f;
}
