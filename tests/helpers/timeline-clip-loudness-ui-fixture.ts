import { createTimelineClipLoudnessController } from '../../apps/web/src/timeline-clip-loudness-state.ts';
import { clipLoudnessInput, readyClipLoudness } from '../fixtures/timeline-clip-loudness-fixtures.ts';
export { readyClipLoudness, silentClipLoudness } from '../fixtures/timeline-clip-loudness-fixtures.ts';
export const input = () => ({ ...clipLoudnessInput });
export const id = (n: number): string => `ca000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
interface Deferred<T> {readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void}
export const deferred = <T = unknown>(): Deferred<T> => { let resolve!: (value: T)=>void, reject!: (error: unknown)=>void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const report = readyClipLoudness;
export function context(patch: Record<string, unknown> = {}) {
  const i = readyClipLoudness().identity;
  return { scope: 'workspace:project:1', executionScope: 'selection:1', projectId: input().projectId, timelineId: input().timelineId,
    revision: 4, clipId: input().clipId, assetId: i.assetId, assetSha256: i.assetSha256, trackId: i.trackId,
    startFrame: i.startFrame, sourceInFrame: i.sourceInFrame, durationFrames: i.durationFrames, gain: i.gain,
    fadeInFrames: i.fadeInFrames, fadeOutFrames: i.fadeOutFrames, muted: false, audioSupported: true, sourceIdentity: 'saved-graph:1',
    connected: true, visible: true, restored: false, hasUnsavedDrafts: false, pending: false, ...patch };
}
type LoudnessController = ReturnType<typeof createTimelineClipLoudnessController>
interface FixtureCall {input: unknown; options: unknown; context: unknown}
export function fixture(patch: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  let live = context(patch); const calls: FixtureCall[] = [], reads: Deferred<unknown>[] = [], changes: unknown[] = [], auth: boolean[] = [];
  const controller = createTimelineClipLoudnessController({ getContext: () => live, getInvocation: () => ({ expectedWorkspaceOrigin: id(7) }),
    onChange: (value: unknown) => changes.push(value), onUnauthorized: () => auth.push(false),
    read(value: unknown, options: unknown) { calls.push({ input: value, options, context: structuredClone(live) }); const wait = deferred(); reads.push(wait); return wait.promise; }, ...overrides } as never);
  controller.attach(live);
  const f = { controller, calls, reads, changes, auth, state: () => controller.getState(), live: () => live,
    set(patch: Record<string, unknown>, notify = true) { live = { ...live, ...patch }; if (notify) controller.setContext(live as never); },
    prepare() { return controller.prepare(f.state()); }, cancel() { controller.cancel(f.state()); },
    async ready(value?: unknown) { const wait = f.prepare(); reads.at(-1)?.resolve(value ?? readyClipLoudness(calls.at(-1)?.input as never)); await wait; return f.state(); } };
  return f;
}
